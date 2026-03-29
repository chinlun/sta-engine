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
import { logger } from './lib/logger';


dotenv.config();

console.log("========================================");
console.log("🚀 STA-ENGINE SERVER STARTING...");
console.log("========================================");

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

    console.log(`[BuildRequest] 📥 Received /api/build request: ${requestId}`);
    logger.info(`[${requestId}] 📨 New build request received`);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data: object) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        let { messages, machineId, referenceHtml, referenceImageBase64 } = req.body;
        logger.info(`[/api/build] 📥 Received build request (HTML=${!!referenceHtml}, Image=${!!referenceImageBase64})`);

        // --- Auto-Discovery for Tri-Modal context if missing from request ---
        if (!referenceHtml || !referenceImageBase64) {
            // Update discovery path to point to the active editorial design system
            const curatedPath = path.join(process.cwd(), 'docs/design-system/the-minimalist/home_desktop_1440px');
            const localHtmlPath = path.join(curatedPath, 'code.html');
            const localImagePath = path.join(curatedPath, 'screen.png');

            if (!referenceHtml && fs.existsSync(localHtmlPath)) {
                logger.info(`[Build] 📂 Auto-loading active HTML reference: ${localHtmlPath}`);
                referenceHtml = fs.readFileSync(localHtmlPath, 'utf8');
            }
            if (!referenceImageBase64 && fs.existsSync(localImagePath)) {
                logger.info(`[Build] 📂 Auto-loading active Image reference: ${localImagePath}`);
                referenceImageBase64 = fs.readFileSync(localImagePath).toString('base64');
            }
        }

        let designBrief = req.body.designBrief;
        const userPrompt = messages[messages.length - 1]?.content || "";

        // If it's a tablet-focused prompt, auto-load the strict JSON blueprint
        if (!designBrief && userPrompt.toLowerCase().includes('tablet')) {
            const blueprintPath = path.join(process.cwd(), 'docs/design-system/single-page-app/tablet_collection_blueprint.json');
            if (fs.existsSync(blueprintPath)) {
                logger.info(`[Build] 📜 Injecting strict JSON blueprint for Tablet: ${blueprintPath}`);
                designBrief = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
            }
        }

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
        const inputs = {
            userPrompt,
            tsErrors: [],
            designErrors: [],
            generatedFiles: [],
            referenceHtml,
            referenceImageBase64,
            designBrief // Pass through the injected/explicit blueprint
        };

        const stream = await themeWorkflow.stream(inputs, {
            recursionLimit: 100, // Increased for complex self-healing
            configurable: {
                sendEvent: (e: any) => sendEvent(e)
            }
        });

        let finalState: any = null;

        for await (const chunk of stream) {
            const node = Object.keys(chunk)[0];
            const output = chunk[node];

            const prevGeneratedFiles = finalState?.generatedFiles || [];
            finalState = { ...finalState, ...output };

            // Replicate LangGraph's array appending reducer for generatedFiles
            if (output.generatedFiles) {
                const merged = [...prevGeneratedFiles];
                for (const newFile of output.generatedFiles) {
                    const idx = merged.findIndex((f: any) => f.path === newFile.path);
                    if (idx >= 0) merged[idx] = newFile;
                    else merged.push(newFile);
                }
                finalState.generatedFiles = merged;
            }

            // Stream reasoning/thinking if present
            if (output.reasoning) {
                sendEvent({
                    type: 'thinking',
                    node: output.reasoning.node,
                    content: output.reasoning.text
                });
            }

            if (node === 'classifier') {
                sendEvent({ type: 'progress', stage: 'classifier', message: `Archetype: ${output.catalogSize}...` });
            } else if (node === 'designer') {
                sendEvent({ type: 'progress', stage: 'designer', message: `Selected palette: ${output.designTokens?.colors?.primary}...` });
            } else if (node === 'planner') {
                sendEvent({ type: 'progress', stage: 'planner', message: `Architected ${output.components?.length} components...` });
            } else if (node === 'contentWriter') {
                sendEvent({ type: 'progress', stage: 'content', message: `Generated sophisticated copy for sections...` });
            } else if (node === 'structural') {
                sendEvent({ type: 'progress', stage: 'structural', message: `Created global CSS and layout shell...` });
            } else if (node === 'coder') {
                sendEvent({ type: 'progress', stage: 'coder', message: `Building component files...` });
                if (output.currentComponentFiles) {
                    for (const file of output.currentComponentFiles) {
                        sendEvent({ type: 'text', content: `\n### \`${file.path}\`\n\`\`\`liquid\n${file.content.substring(0, 500)}...\n\`\`\`\n` });
                    }
                }
            } else if (node === 'assembler') {
                sendEvent({ type: 'progress', stage: 'assembler', message: `Assembling finalized theme structure...` });
                if (output.generatedFiles) {
                    for (const file of output.generatedFiles) {
                        sendEvent({ type: 'text', content: `\n### \`${file.path}\`\n\`\`\`liquid\n${file.content.substring(0, 500)}...\n\`\`\`\n` });
                    }
                }
            } else if (node === 'tsQc') {
                if (output.tsErrors && output.tsErrors.length > 0) {
                    sendEvent({ type: 'progress', stage: 'ts_qc', message: `⚠️ Syntax issues found (${output.tsErrors.length}). Retrying...` });
                } else {
                    sendEvent({ type: 'progress', stage: 'ts_qc', message: `✅ Syntax check passed.` });
                }
            } else if (node === 'assemblyQc') {
                if (output.assemblyErrors && output.assemblyErrors.length > 0) {
                    sendEvent({ type: 'progress', stage: 'assembly_qc', message: `⚠️ Assembly issues found (${output.assemblyErrors.length}). Retrying...` });
                } else {
                    sendEvent({ type: 'progress', stage: 'assembly_qc', message: `✅ Assembly check passed.` });
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

            globalSettings = finalState.designTokens || {};

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

                console.log("[Sync] DEBUG FINAL FILES TO SYNC:", orderedMods.map(m => m.filePath));

                const nonJsonMods = orderedMods.filter(m => !m.filePath!.endsWith('.json'));
                const jsonMods = orderedMods.filter(m => m.filePath!.endsWith('.json'));

                const syncWithMonitoring = async (mods: any[]) => {
                    logger.info(`[Sync] 🚀 syncWithMonitoring entering with ${mods.length} files. Machine: ${machineId}`);
                    const { executeCorrectionLoop } = require('./lib/correction-loop');
                    let retryCounts = new Map<string, number>();

                    return new Promise<void>((resolve, reject) => {
                        let isResolved = false;

                        const cleanup = () => {
                            isResolved = true;
                        };

                        // Start Log Monitoring (Gate B+ / Remote Error Detection)
                        const stopMonitoring = flyMachineService.monitorLogs(machineId, async (remoteError) => {
                            if (isResolved) return;

                            sendEvent({ type: 'progress', stage: 'REMOTE_ERROR_DETECTED', message: `🔍 Remote error: ${remoteError.message}` });

                            // Find the file that caused the error (robust matching)
                            const mod = mods.find(m =>
                                remoteError.message.toLowerCase().includes(m.filePath.toLowerCase()) ||
                                remoteError.message.toLowerCase().includes(path.basename(m.filePath).toLowerCase())
                            );

                            if (mod) {
                                const currentRetries = retryCounts.get(mod.filePath) || 0;
                                if (currentRetries < 3) {
                                    retryCounts.set(mod.filePath, currentRetries + 1);

                                    sendEvent({ type: 'progress', stage: 'AI_CORRECTING', message: `🛠️ Correcting ${mod.filePath} (Attempt ${currentRetries + 1})...` });

                                    // Extract line number if possible from message
                                    const lineMatch = remoteError.message.match(/line (\d+)/i) || remoteError.message.match(/:(\d+):/);
                                    const lineNumber = lineMatch ? parseInt(lineMatch[1]) : undefined;

                                    const { fixedContent, success } = await executeCorrectionLoop({
                                        message: remoteError.message,
                                        filePath: mod.filePath,
                                        line: lineNumber
                                    }, mod.content, currentRetries);

                                    if (success) {
                                        mod.content = fixedContent;
                                        // Re-sync the fixed file
                                        sendEvent({ type: 'progress', stage: 'FLY_PUSHING', message: `📤 Re-syncing fixed ${mod.filePath}...` });
                                        await flyMachineService.syncFile(machineId, mod.filePath, mod.content);
                                    }
                                } else {
                                    stopMonitoring();
                                    cleanup();
                                    reject(new Error(`Max retries reached for ${mod.filePath}: ${remoteError.message}`));
                                }
                            }
                        });

                        // Initial Sync
                        sendEvent({ type: 'progress', stage: 'FLY_PUSHING', message: `📤 Pushing ${mods.length} files to preview...` });
                        flyMachineService.syncBulk(machineId, mods.map(m => ({ filePath: m.filePath!, content: m.content })))
                            .then(async () => {
                                // Wait a grace period for remote errors to surface
                                for (let i = 0; i < 10; i++) {
                                    if (isResolved) return;
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                                stopMonitoring();
                                cleanup();
                                resolve();
                            })
                            .catch(err => {
                                stopMonitoring();
                                cleanup();
                                reject(err);
                            });
                    });
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

            sendEvent({ type: 'progress', stage: 'SUCCESS', message: 'Theme successfully built and synced!' });
            sendEvent({ type: 'done' });
            logger.info(`[${requestId}] ✅ LangGraph Build successful`);
        } else {
            throw new Error("LangGraph finished without generating files.");
        }
        res.end();
    } catch (error) {
        logger.error({ error }, `[${requestId}] ❌ Request failed:`);
        sendEvent({ type: 'error', message: String(error) });
        res.end();
    }
});

app.get('/health', (req, res) => res.send('OK'));
app.get('/api/preview/:themeId', createMagicPreviewHandler());

const server = app.listen(port, () => {
    logger.info(`sta-engine listening on port ${port}`);
});
