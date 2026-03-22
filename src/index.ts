import express from 'express';
import cors from 'cors';
import { uploadToR2 } from './services/r2-service';
import { ensureThemeSlot, uploadThemeToShopify, waitForThemeReady, publishTheme } from './services/shopify-service';
import { createMagicPreviewHandler } from './services/preview-service';
import { buildTheme, normalizeMod, validateAndRepair } from './services/builder';
import { gateValidate } from './services/validator-service';
import { buildSystemPrompt, extractFileFromBaseTheme } from './services/prompt-builder';
import { BuildThemeToolSchema, BuildThemeToolParams, ThemePlan } from './schema';
import dotenv from 'dotenv';
import { streamText, tool, generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { themeWorkflow } from './graph';
import { customGoogle } from './lib/ai';
import previewRoutes from './routes/preview-routes';
import { flyMachineService } from './services/fly-machine-service';
import { IntegrityManager, ValidationError } from './services/integrity-manager';
import path from 'path';
import fs from 'fs';


dotenv.config();

const app = express();
const port = 8080;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/api/preview', previewRoutes);

function buildCurativePrompt(errorMessage: string): string {
    const context = fs.readFileSync(path.join(process.cwd(), 'docs/liquid-cheat-sheet.md'), 'utf-8');
    return `Your previous output failed validation with this error: [${errorMessage}]. 

IMPORTANT:
1. If you intended to use a built-in Dawn section (like 'featured-collection', 'image-banner'), ensure the 'type' in index.json matches the base theme exactly.
2. If you are creating a NEW section, you MUST include the ### \`sections/filename.liquid\` block with valid schema JSON.
3. Ensure no Liquid tags are inside stylesheet/javascript blocks.

Please provide ONLY the missing or corrected files to fix the theme integrity.${context}`;
}

app.post('/api/build', async (req, res) => {
    const { messages } = req.body;
    const requestId = `req-${Date.now()}`;
    const startTime = Date.now();

    console.log(`\n${'='.repeat(70)}`);
    console.log(`[${requestId}] 📨 New build request received`);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data: object) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        sendEvent({ type: 'progress', stage: 'context', message: 'Loading theme context & reference docs...' });
        const currentIndexJson = extractFileFromBaseTheme('templates/index.json');
        const currentSettingsData = extractFileFromBaseTheme('config/settings_data.json');

        const systemPrompt = buildSystemPrompt(currentIndexJson, currentSettingsData);
        let currentMessages = [...messages];
        let globalSettings = {};
        let modifications: any[] = [];
        let retryCount = 0;
        const maxRetries = 2;
        let buildSuccessful = false;

        const { machineId } = req.body;
        const inputs = {
            userPrompt: messages[messages.length - 1]?.content || "",
            tsErrors: [],
            designErrors: [],
            generatedFiles: []
        };

        const stream = await themeWorkflow.stream(inputs, {
            recursionLimit: 20,
        });

        let finalState: any = null;

        for await (const chunk of stream) {
            const node = Object.keys(chunk)[0];
            const output = chunk[node];
            finalState = { ...finalState, ...output };

            if (node === 'classifier') {
                sendEvent({ type: 'progress', stage: 'classifier', message: `Archetype: ${output.catalogSize}...` });
            } else if (node === 'planner') {
                sendEvent({ type: 'progress', stage: 'planner', message: `Design Brief: ${output.designBrief.rationale.substring(0, 100)}...` });
            } else if (node === 'coder') {
                sendEvent({ type: 'progress', stage: 'coder', message: `Syncing ${output.generatedFiles.length} files...` });
                // We stream the text content of the files to show progress
                for (const file of output.generatedFiles) {
                    sendEvent({ type: 'text', content: `\n### \`${file.path}\`\n\`\`\`liquid\n${file.content.substring(0, 500)}...\n\`\`\`\n` });
                }
            } else if (node === 'tsQc') {
                if (output.tsErrors && output.tsErrors.length > 0) {
                    sendEvent({ type: 'progress', stage: 'ts_qc', message: `⚠️ Syntax issues found (${output.tsErrors.length}). Retrying...` });
                } else {
                    sendEvent({ type: 'progress', stage: 'ts_qc', message: `✅ Syntax check passed.` });
                }
            } else if (node === 'agenticQc') {
                if (output.designErrors && output.designErrors.length > 0) {
                    sendEvent({ type: 'progress', stage: 'design_qc', message: `🎨 Design review failed. Refined styles required...` });
                } else {
                    sendEvent({ type: 'progress', stage: 'design_qc', message: `💎 Design review passed.` });
                }
            }
        }

        if (finalState && finalState.generatedFiles && finalState.generatedFiles.length > 0) {
            modifications = finalState.generatedFiles.map((f: any) => ({
                filePath: f.path,
                action: 'update',
                content: f.content
            }));

            globalSettings = finalState.designBrief?.globalSettings || {};

            sendEvent({ type: 'progress', stage: 'validating', message: 'Final assembly and sync...' });

            const args = { globalSettings, modifications };
            sendEvent({ type: 'tool_call', toolName: 'build_theme', args });

            if (machineId && modifications.length) {
                sendEvent({ type: 'progress', stage: 'syncing', message: 'Syncing changes to live preview...' });
                const orderedMods = [...modifications].map(mod => normalizeMod(mod))
                    .filter(mod => mod.filePath && mod.content)
                    .sort((a, b) => {
                        const aIsJson = a.filePath!.endsWith('.json');
                        const bIsJson = b.filePath!.endsWith('.json');
                        if (aIsJson && !bIsJson) return 1;
                        if (!aIsJson && bIsJson) return -1;
                        return 0;
                    });

                const nonJsonMods = orderedMods.filter(m => !m.filePath!.endsWith('.json'));
                const jsonMods = orderedMods.filter(m => m.filePath!.endsWith('.json'));

                const syncWithMonitoring = async (mods: any[]) => {
                    const appName = process.env.FLY_APP_NAME;
                    const controller = new AbortController();
                    let syncError: ValidationError | null = null;
                    const monitorPromise = (async () => {
                        try {
                            const response = await fetch(`https://${appName}.fly.dev/reload-events`, {
                                headers: { "fly-force-instance-id": machineId },
                                signal: controller.signal
                            });
                            if (!response.body) return;
                            const reader = response.body.getReader();
                            const decoder = new TextDecoder();
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                const chunk = decoder.decode(value);
                                if (chunk.includes('sync_error')) {
                                    const eventLine = chunk.split('\n').find(l => l.includes('sync_error'));
                                    if (eventLine) {
                                        const event = JSON.parse(eventLine.replace('data: ', '').trim());
                                        syncError = new ValidationError(event.filePath, event.reason);
                                        controller.abort();
                                        break;
                                    }
                                }
                            }
                        } catch (e: any) {
                            if (e.name !== 'AbortError') console.error("[Sync] Monitor error:", e);
                        }
                    })();

                    try {
                        await flyMachineService.syncBulk(machineId, mods.map(m => ({ filePath: m.filePath!, content: m.content })));
                        for (let i = 0; i < 10; i++) {
                            if (syncError) throw syncError;
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    } finally {
                        controller.abort();
                        await monitorPromise;
                    }
                };

                if (nonJsonMods.length > 0) {
                    await syncWithMonitoring(nonJsonMods);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                if (jsonMods.length > 0) {
                    await syncWithMonitoring(jsonMods);
                }

                try {
                    await flyMachineService.execCommand(machineId, [
                        "bash", "-c",
                        "wget -qO- --post-data='' http://127.0.0.1:9295/notify?source=engine || curl -s -X POST http://127.0.0.1:9295/notify?source=engine || echo 'Signaler not available'"
                    ]);
                } catch (e) { }
            }

            sendEvent({
                type: 'tool_result', result: {
                    id: 'docker-preview',
                    name: `AI Preview`,
                    role: 'development',
                    preview_url: `http://localhost:${port}/api/preview/${machineId}?machine_id=${machineId}`
                }
            });

            sendEvent({ type: 'done' });
            console.log(`[${requestId}] ✅ LangGraph Build successful`);
        } else {
            throw new Error("LangGraph finished without generating files.");
        }
        res.end();
    } catch (error) {
        console.error(`[${requestId}] ❌ Request failed:`, error);
        sendEvent({ type: 'error', message: String(error) });
        res.end();
    }
});

app.get('/health', (req, res) => res.send('OK'));
app.get('/api/preview/:themeId', createMagicPreviewHandler());

const server = app.listen(port, () => {
    console.log(`sta-engine listening on port ${port}`);
});
