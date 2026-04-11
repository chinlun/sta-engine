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
import { syncOrchestrator } from './services/sync-orchestrator';
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

            if (!machineId && modifications.length) {
                const storeUrl = process.env.SHOPIFY_STORE_DOMAIN;
                const themeToken = process.env.SHOPIFY_THEME_ACCESS_PASSWORD;

                if (storeUrl && themeToken) {
                    sendEvent({ type: 'progress', stage: 'CLI_BOOTING', message: 'No preview machine found. Provisioning new one...' });
                    try {
                        machineId = await flyMachineService.createMachine(storeUrl, themeToken);
                        logger.info(`[Build] 🤖 Auto-provisioned Machine: ${machineId}`);
                        await flyMachineService.waitForMachine(machineId);
                    } catch (e: any) {
                        logger.error(`[Build] ❌ Auto-provisioning failed: ${e.message}`);
                        sendEvent({ type: 'progress', stage: 'SYNC_ERROR', message: 'Failed to provision preview machine.' });
                    }
                }
            }

            if (machineId && modifications.length) {
                // 1. Wait for CLI readiness (Signal driven)
                sendEvent({ type: 'progress', stage: 'CLI_BOOTING', message: 'Waiting for Shopify CLI to prepare preview...' });
                await syncOrchestrator.waitForCLIReady(machineId);
                sendEvent({ type: 'progress', stage: 'CLI_READY', message: 'Shopify CLI is ready. Starting sync...' });

                // 2. Order files: .liquid first, then .json, with templates/index.json absolutely last
                const orderedMods = syncOrchestrator.orderFilesForSync(modifications);
                const availableFiles = orderedMods.map(m => m.filePath);

                // 3. Sequential per-file sync-and-verify loop
                for (let i = 0; i < orderedMods.length; i++) {
                    const mod = orderedMods[i];
                    sendEvent({ type: 'progress', stage: 'FLY_PUSHING', message: `📤 [${i + 1}/${orderedMods.length}] ${mod.filePath}` });

                    const result = await syncOrchestrator.syncFileWithRetry(
                        machineId, mod.filePath, mod.content, availableFiles, targetThemeId
                    );

                    if (!result.success) {
                        logger.error(`[Sync] ❌ Failed to sync ${mod.filePath} after multiple attempts and AI repairs.`);
                        sendEvent({ type: 'progress', stage: 'SYNC_ERROR', message: `⚠️ ${mod.filePath} failed sync` });
                    } else if (result.fixedContent) {
                        // Keep our local state in sync with any AI repairs
                        mod.content = result.fixedContent;
                        const origIdx = modifications.findIndex((m: any) => m.filePath === mod.filePath);
                        if (origIdx >= 0) modifications[origIdx].content = result.fixedContent;
                    }
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
                    preview_url: `https://${process.env.FLY_APP_NAME}.fly.dev/?machine_id=${machineId}`
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
                const result = await syncOrchestrator.syncFileWithRetry(
                    machineId, mod.path, mod.content, baseFiles.map(f => f.filePath || f.path), themeId
                );
                if (result.fixedContent) mod.content = result.fixedContent;
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
