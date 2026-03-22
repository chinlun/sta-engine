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
import { google, createGoogleGenerativeAI } from '@ai-sdk/google';
import previewRoutes from './routes/preview-routes';
import { flyMachineService } from './services/fly-machine-service';
import { IntegrityManager, ValidationError } from './services/integrity-manager';
import path from 'path';
import fs from 'fs';

// Create a custom Google provider that strips the aggressive 60s timeout
const customGoogle = createGoogleGenerativeAI({
    fetch: (url, options) => {
        const customOptions = { ...options };
        if (customOptions.signal) {
            console.log(`[Fetch] 🛡️ Stripping SDK timeout signal to allow long-running generations (>60s)`);
            delete customOptions.signal;
        }
        return fetch(url, customOptions as any).then(res => {
            console.log(`[Fetch] 🌐 ${url} -> ${res.status} ${res.statusText}`);
            return res;
        }).catch(err => {
            console.error(`[Fetch] ❌ Network Error for ${url}:`, err);
            throw err;
        });
    }
});

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

        while (retryCount <= maxRetries && !buildSuccessful) {
            if (retryCount > 0) {
                sendEvent({ type: 'progress', stage: 'ai_call', message: `Self-healing retry ${retryCount}/${maxRetries}...` });
            } else {
                sendEvent({ type: 'progress', stage: 'ai_call', message: `Calling Gemini...` });
            }

            const result = await streamText({
                model: (customGoogle as any)('gemini-2.5-flash', { structuredOutputs: false }),
                system: systemPrompt,
                messages: currentMessages,
            });

            let fullText = "";
            for await (const chunk of result.fullStream) {
                if (chunk.type === 'text-delta') {
                    fullText += chunk.text;
                    sendEvent({ type: 'text', content: chunk.text });
                }
            }

            try {
                const globalSettingsMatch = fullText.match(/###\s*`globalSettings`\s*```(?:json)?\n([\s\S]*?)```/);
                if (globalSettingsMatch) {
                    globalSettings = { ...globalSettings, ...JSON.parse(globalSettingsMatch[1].trim()) };
                }
            } catch (e) { }

            const fileRegex = /###\s*`([^`]+)`\s*```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
            let match;
            const newModifications: any[] = [];
            while ((match = fileRegex.exec(fullText)) !== null) {
                const filePath = match[1].trim();
                if (filePath === 'globalSettings' || filePath.includes(' ')) continue;
                newModifications.push({ filePath, action: 'update', content: match[2] });
            }

            for (const newMod of newModifications) {
                const existingIndex = modifications.findIndex(m => m.filePath === newMod.filePath);
                if (existingIndex > -1) {
                    modifications[existingIndex] = newMod;
                } else {
                    modifications.push(newMod);
                }
            }

            if (modifications.length === 0) {
                buildSuccessful = true;
                continue;
            }

            try {
                sendEvent({ type: 'progress', stage: 'validating', message: 'Validating and auto-repairing theme integrity...' });
                const newPlan: any = { thoughtProcess: fullText.substring(0, 500), globalSettings, modifications };
                const repairResult = validateAndRepair(newPlan);

                if (repairResult.errors.length > 0) {
                    throw new ValidationError("ThemePlan", repairResult.errors.join(", "));
                }

                IntegrityManager.validate(newPlan.modifications!);

                const args = { globalSettings: newPlan.globalSettings, modifications: newPlan.modifications };
                sendEvent({ type: 'tool_call', toolName: 'build_theme', args });

                if (machineId && newPlan.modifications!.length) {
                    sendEvent({ type: 'progress', stage: 'syncing', message: 'Syncing changes to live preview...' });
                    modifications = newPlan.modifications!;
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

                        // Start monitoring in the background
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
                                            controller.abort(); // Stop monitoring once we have an error
                                            break;
                                        }
                                    }
                                }
                            } catch (e) {
                                if (e.name !== 'AbortError') console.error("[Sync] Monitor error:", e);
                            }
                        })();

                        try {
                            // 1. Perform the actual HTTP sync
                            await flyMachineService.syncBulk(machineId, mods.map(m => ({ filePath: m.filePath!, content: m.content })));

                            // 2. MANDATORY GRACE PERIOD: Wait to see if Shopify CLI rejects it after the write.
                            // We wait up to 5 seconds, checking periodically if an error was caught.
                            for (let i = 0; i < 10; i++) {
                                if (syncError) throw syncError;
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                        } finally {
                            controller.abort(); // Ensure monitor is cleaned up
                            await monitorPromise; // Wait for it to settle
                        }
                    };

                    // Pass 1: Sync all non-JSON files (sections, snippets, etc.) first
                    if (nonJsonMods.length > 0) {
                        try {
                            await syncWithMonitoring(nonJsonMods);
                            // Wait for Shopify CLI to start processing these files
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        } catch (e) {
                            if (e instanceof ValidationError) throw e;
                            console.error("[Sync] Non-critical error during Non-JSON monitoring:", e);
                        }
                    }

                    // Pass 2: Sync all JSON files (templates, config, etc.)
                    if (jsonMods.length > 0) {
                        try {
                            await syncWithMonitoring(jsonMods);
                        } catch (e) {
                            if (e instanceof ValidationError) throw e;
                            console.error("[Sync] Non-critical error during JSON monitoring:", e);
                        }
                    }

                    // Guaranteed Reload: Tell the browser to refresh after both passes are complete.
                    // This is a fallback in case the Shopify CLI's own --notify flag is delayed or missed.
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

                buildSuccessful = true;
                sendEvent({ type: 'done' });
                console.log(`[${requestId}] ✅ Build & Sync successful`);

            } catch (error) {
                if (error instanceof ValidationError && retryCount < maxRetries) {
                    console.warn(`[${requestId}] ⚠️ Validation failed, triggering self-healing: ${error.message}`);
                    currentMessages.push({ role: 'assistant', content: fullText });
                    currentMessages.push({ role: 'user', content: buildCurativePrompt(error.reason) });
                    retryCount++;
                } else {
                    throw error;
                }
            }
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
