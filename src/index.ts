import express from 'express';
import cors from 'cors';
import { uploadToR2, uploadThemeState, getThemeState } from './services/r2-service';
import { ensureThemeSlot, uploadThemeToShopify, waitForThemeReady, publishTheme } from './services/shopify-service';
import { createMagicPreviewHandler } from './services/preview-service';
import { buildTheme, normalizeMod, validateAndRepair } from './services/builder';
import { gateValidate } from './services/validator-service';
import { buildSystemPrompt, extractFileFromBaseTheme } from './services/prompt-builder';
import { BuildThemeToolSchema, BuildThemeToolParams, ThemePlan } from './schema';
import dotenv from 'dotenv';
import { streamText, tool, generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { themeWorkflow, modifierWorkflow } from './graph';
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
        let { messages, machineId, themeId, referenceHtml, referenceImageBase64 } = req.body;
        const targetThemeId = themeId || machineId || `theme-${Date.now()}`;
        logger.info(`[/api/build] 📥 Received build request (ID=${targetThemeId}, HTML=${!!referenceHtml}, Image=${!!referenceImageBase64})`);

        // --- Auto-Discovery for Tri-Modal context if missing from request ---
        // (Removed: We now rely exclusively on the user prompt/request data for palette and style)

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
            designBrief, // Pass through the injected/explicit blueprint
            themeId: targetThemeId
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
                                    }, mod.content, mods.map(m => m.filePath));

                                    if (success) {
                                        mod.content = fixedContent;

                                        // Update the original modifications array so the final save gets it too
                                        const origIdx = modifications.findIndex((m: any) => m.filePath === mod.filePath);
                                        if (origIdx >= 0) modifications[origIdx].content = fixedContent;

                                        // Re-sync the fixed file
                                        sendEvent({ type: 'progress', stage: 'FLY_PUSHING', message: `📤 Re-syncing fixed ${mod.filePath}...` });
                                        await flyMachineService.syncFile(machineId, mod.filePath, mod.content);

                                        // Incremental R2 upload
                                        if (targetThemeId) {
                                            try {
                                                const { uploadThemeState, getThemeState } = require('./services/r2-service');
                                                const existingState = await getThemeState(targetThemeId);
                                                const updatedState = [...existingState];
                                                const idx = updatedState.findIndex((f: any) => (f.filePath || f.path) === mod.filePath);
                                                if (idx >= 0) updatedState[idx] = { filePath: mod.filePath, content: fixedContent, action: 'update', path: mod.filePath };
                                                else updatedState.push({ filePath: mod.filePath, content: fixedContent, action: 'update', path: mod.filePath });

                                                await uploadThemeState(targetThemeId, updatedState);
                                                logger.info(`[R2] ☁️ Persisting repaired file ${mod.filePath} to R2 for ${targetThemeId}`);
                                            } catch (e) {
                                                logger.warn(`[R2] Failed incremental update during repair: ${e}`);
                                            }
                                        }
                                    }
                                } else {
                                    stopMonitoring();
                                    cleanup();
                                    reject(new Error(`Max retries reached for ${mod.filePath}: ${remoteError.message}`));
                                }
                            }
                        });

                        // Initial Sync - SECURE SEQUENTIAL PUSH (Prevents malformed headers)
                        sendEvent({ type: 'progress', stage: 'FLY_PUSHING', message: `📤 Syncing ${mods.length} files to preview...` });

                        (async () => {
                            try {
                                for (let i = 0; i < mods.length; i++) {
                                    if (isResolved) break;
                                    const mod = mods[i];
                                    sendEvent({ type: 'progress', stage: 'FLY_PUSHING', message: `📤 [${i + 1}/${mods.length}] ${mod.filePath}...` });
                                    await flyMachineService.syncFile(machineId, mod.filePath, mod.content);
                                }

                                if (isResolved) return;

                                // Wait a grace period for remote errors to surface
                                for (let i = 0; i < 10; i++) {
                                    if (isResolved) return;
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                                stopMonitoring();
                                cleanup();
                                resolve();
                            } catch (err) {
                                stopMonitoring();
                                cleanup();
                                reject(err);
                            }
                        })();
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

            try {
                const targetThemeId = req.body.themeId || machineId;
                if (targetThemeId && modifications.length > 0) {
                    sendEvent({ type: 'progress', stage: 'SAVING_STATE', message: 'Saving session state...' });
                    await uploadThemeState(targetThemeId, modifications);
                }
            } catch (e) {
                logger.warn(`[Sync] Failed to upload theme state: ${e}`);
            }

            sendEvent({ type: 'progress', stage: 'SUCCESS', message: 'Theme successfully built and synced!' });
            sendEvent({ type: 'done' });
            logger.info(`[${requestId}] ✅ LangGraph Build successful`);
        } else {
            throw new Error("LangGraph finished without generating files.");
        }
        res.end();
    } catch (error: any) {
        logger.error(error, `[${requestId}] ❌ Request failed: ${error.message}`);
        sendEvent({ type: 'error', message: String(error) });
        res.end();
    }
});

app.post('/api/modify', async (req, res) => {
    const { messages, machineId, themeId: reqThemeId } = req.body;
    const themeId = reqThemeId || machineId;
    const requestId = `mod-${Date.now()}`;

    console.log(`[ModifyRequest] 📥 Received /api/modify request: ${requestId} for theme ${themeId}`);
    logger.info(`[${requestId}] 📨 New modify request received`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        if (!themeId) throw new Error("themeId or machineId is required for modification");
        const userPrompt = messages[messages.length - 1]?.content || "";

        sendEvent({ type: 'progress', stage: 'LOADING_STATE', message: 'Retrieving theme state from R2...' });
        const baseFiles = await getThemeState(themeId);
        if (!baseFiles || baseFiles.length === 0) {
            throw new Error(`No existing theme state found for ${themeId}. Cannot modify.`);
        }

        const stream = await modifierWorkflow.stream({
            userPrompt,
            themeId,
            baseFiles,
            tsErrors: []
        }, {
            recursionLimit: 50,
            configurable: { sendEvent: (e: any) => sendEvent(e) }
        });

        let finalState: any = null;

        for await (const chunk of stream) {
            const node = Object.keys(chunk)[0];
            const output = chunk[node];
            finalState = { ...finalState, ...output };

            if (output.reasoning) {
                const rList = Array.isArray(output.reasoning) ? output.reasoning : [output.reasoning];
                const lastReasoning = rList[rList.length - 1];
                if (lastReasoning) {
                    sendEvent({ type: 'thinking', node: lastReasoning.node, content: lastReasoning.text });
                }
            }
        }

        if (finalState && finalState.modifiedFiles && finalState.modifiedFiles.length > 0) {
            const mod = finalState.modifiedFiles[0];
            sendEvent({ type: 'progress', stage: 'FLY_PUSHING', message: `Syncing ${mod.path} to preview...` });

            if (machineId) {
                await flyMachineService.syncFile(machineId, mod.path, mod.content);
                try {
                    await flyMachineService.execCommand(machineId, [
                        "bash", "-c",
                        "wget -qO- --post-data='' http://127.0.0.1:9295/notify?source=engine || curl -s -X POST http://127.0.0.1:9295/notify?source=engine || echo 'Signaler not available'"
                    ]);
                } catch (e) { }
            }

            sendEvent({ type: 'progress', stage: 'SAVING_STATE', message: 'Saving updated theme state...' });
            const updatedBaseFiles = [...baseFiles];
            const idx = updatedBaseFiles.findIndex((f: any) => (f.filePath || f.path) === mod.path);
            if (idx >= 0) {
                updatedBaseFiles[idx] = { filePath: mod.path, content: mod.content, action: 'update', path: mod.path };
            } else {
                updatedBaseFiles.push({ filePath: mod.path, content: mod.content, action: 'update', path: mod.path });
            }
            await uploadThemeState(themeId, updatedBaseFiles);

            sendEvent({ type: 'progress', stage: 'SUCCESS', message: 'Modification successfully deployed!' });
            sendEvent({ type: 'done' });
        } else {
            throw new Error("Modifier workflow finished without generating modifications.");
        }
    } catch (err: any) {
        logger.error(err, `[${requestId}] ❌ Modification request failed: ${err.message}`);
        sendEvent({ type: 'error', message: String(err) });
    }
    res.end();
});

app.get('/health', (req, res) => res.send('OK'));
app.get('/api/preview/:themeId', createMagicPreviewHandler());

const server = app.listen(port, () => {
    logger.info(`sta-engine listening on port ${port}`);
});
