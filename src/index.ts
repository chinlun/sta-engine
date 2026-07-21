import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { uploadToR2, uploadThemeState, getThemeState } from './services/r2-service';
import { ensureThemeSlot, uploadThemeToShopify, waitForThemeReady, publishTheme } from './services/shopify-service';
import { createMagicPreviewHandler } from './services/preview-service';
import { buildTheme, normalizeMod, validateAndRepair } from './services/builder';
import { gateValidate } from './services/validator-service';
import { buildSystemPrompt, extractFileFromBaseTheme } from './services/prompt-builder';
import { BuildThemeToolSchema, BuildThemeToolParams, ThemePlan } from './schema';
import dotenv from 'dotenv';
import { streamText, tool } from 'ai';
import { themeWorkflow, modifierWorkflow } from './graph';
import { gemini3Flash } from './lib/ai';
import previewRoutes from './routes/preview-routes';
import { flyMachineService } from './services/fly-machine-service';
import { syncOrchestrator } from './services/sync-orchestrator';
import { IntegrityManager, ValidationError } from './services/integrity-manager';
import path from 'path';
import fs from 'fs';
import { logger } from './lib/logger';

// --- Save & Resume Services ---
import { 
    initPostgres,
    getCheckpointer,
    createProject, 
    updateProject, 
    getProject, 
    listProjects, 
    deleteProject,
    Project
} from './services/postgres-service';
import { projectFeedAccumulator } from './services/project-feed-accumulator';


dotenv.config();

console.log("========================================");
console.log("🚀 STA-ENGINE SERVER STARTING...");
console.log("========================================");

const app = express();
const port = 8080;

app.use(cors({
    origin: ['http://localhost:3000', 'https://sta-previewer.fly.dev'],
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use('/api/preview', previewRoutes);

// Global Request Logger
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info(`[API] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
    });
    next();
});

function buildCurativePrompt(errorMessage: string): string {
    const context = fs.readFileSync(path.join(process.cwd(), 'docs/liquid-cheat-sheet.md'), 'utf-8');
    return `Your previous output failed validation with this error: [${errorMessage}]. 

IMPORTANT:
1. If you intended to use a built-in Dawn section (like 'featured-collection', 'image-banner'), ensure the 'type' in index.json matches the base theme exactly.
2. If you are creating a NEW section, you MUST include the ### \`sections/filename.liquid\` block with valid schema JSON.
3. Ensure no Liquid tags are inside stylesheet/javascript blocks.

Please provide ONLY the missing or corrected files to fix the theme integrity.${context}`;
}

// --- PROJECT MANAGEMENT ENDPOINTS ---

app.get('/api/projects', async (req, res) => {
    const userId = (req.query.userId as string) || "anonymous-user"; // MVP: localStorage UUID
    try {
        const projects = await listProjects(userId);
        res.json(projects);
    } catch (error: any) {
        logger.error(`[API] Failed to list projects: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:id', async (req, res) => {
    try {
        const project = await getProject(req.params.id);
        if (!project) return res.status(404).json({ error: "Project not found" });
        res.json(project);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/projects/:id', async (req, res) => {
    try {
        await deleteProject(req.params.id);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:id/live', (req, res) => {
    const projectId = req.params.id;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Catch up existing feed items
    const feed = projectFeedAccumulator.get(projectId);
    feed.forEach(item => {
        res.write(`data: ${JSON.stringify(item)}\n\n`);
    });

    // Note: To keep the connection alive for new events, 
    // we'd need a PubSub or shared event emitter in a multi-pod environment.
    // For now, if the user reconnects, they at least get the full caught-up feed.
});

// --- DISCOVERY PHASE (POST /api/chat) ---

app.post('/api/chat', async (req, res) => {
    const { messages, userId: reqUserId } = req.body;
    let projectId: string = req.body.projectId;
    const userId = (reqUserId as string) || "anonymous-user";

    try {
        if (!projectId) {
            projectId = await createProject({
                userId,
                title: messages[0]?.content?.substring(0, 50) || "New Theme Project",
                phase: 'discovery',
                designTokens: {},
                feed: messages
            });
        }

        const project = await getProject(projectId);
        if (!project) throw new Error("Project not found");

        let wasBuildTriggered = false;

        const result = await streamText({
            model: gemini3Flash,
            system: `You are a helpful Shopify AI assistant. Your goal is to help the user build their store.
            For now, you MUST ask for the NAME OF THE SHOP if you don't have it.
            Once you have the name and a general sense of the business, call the 'start_build' tool.
            Be concise and professional.`,
            messages,
            tools: {
                start_build: tool({
                    description: 'Call this when you have the shop name and enough context to build.',
                    inputSchema: z.object({
                        storeName: z.string().describe('The name of the shop'),
                        summary: z.string().describe('Brief summary of the business requirements gathered')
                    }),
                    execute: async ({ storeName, summary }) => {
                        if (!projectId) throw new Error("Project not found in context");
                        wasBuildTriggered = true;
                        // Prepare transition to building phase
                        logger.info(`[Discovery] Preparing phase transition to building for project ${projectId}`);
                        // We transition to building phase
                        await updateProject(projectId, { 
                            title: storeName,
                            phase: 'building',
                            requirements: summary
                        });
                        
                        // We return a "trigger" event that tells the frontend to start listening to the build SSE
                        return { status: 'BUILD_STARTED', projectId };
                    }
                })
            }
        });

        // We don't use SSE for the simple chat response to keep it simple, 
        // but we return the projectId so the frontend can track it.
        logger.info(`[Chat] 🤖 AI is generating response for project: ${projectId}...`);
        const { text, toolResults: toolResultsPromise } = result;
        const textValue = await text;
        const toolResults = (await toolResultsPromise) || [];
        
        const finalPhase = wasBuildTriggered ? 'building' : 'discovery';
        const finalText = (textValue || !wasBuildTriggered) ? textValue : "Great! I'll start building your Shopify theme now. Please wait a moment...";

        logger.info(`[Chat] ✅ AI Response: "${finalText?.substring(0, 50)}..." [Build Triggered: ${wasBuildTriggered}]`);
        
        // Append assistant message to feed
        const assistantMessage = { role: 'assistant', content: finalText || "Analyzing..." };
        const updatedFeed = [...messages, assistantMessage];
        
        await updateProject(projectId, { feed: updatedFeed });

        res.json({ 
            projectId, 
            text: finalText, 
            phase: finalPhase,
            toolResults 
        });

    } catch (error: any) {
        logger.error(`[Chat] Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/build', async (req, res) => {
    const { messages, projectId } = req.body;
    const requestId = `req-${Date.now()}`;
    const startTime = Date.now();

    logger.info(`[BuildRequest] 📥 Received /api/build request: ${requestId} for project ${projectId}`);
    
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Wrapper to both stream SSE AND accumulate in memory
    const sendEvent = (data: any) => {
        if (projectId) projectFeedAccumulator.append(projectId, data);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    try {
        let { machineId, themeId, referenceHtml, referenceImageBase64 } = req.body;
        const targetThemeId = themeId || machineId || `theme-${Date.now()}`;
        
        // Load stored requirements and existing feed from discovery phase
        const project = await getProject(projectId);
        const requirements = project?.requirements || '';

        if (projectId) {
            // We initialize the accumulator with both the existing firestore feed 
            // AND any new messages from the request body.
            projectFeedAccumulator.create(projectId, project?.feed || []);
            projectFeedAccumulator.create(projectId, messages || []);
            
            // Send initial projectId event so frontend knows we're active
            sendEvent({ type: 'project', projectId });
        }

        let designBrief = req.body.designBrief;
        
        // Aggregate ALL user messages so the designer sees the full context
        const allUserMessages = (messages || [])
            .filter((m: any) => m.role === 'user' || m.kind === 'user_message')
            .map((m: any) => m.content)
            .join('\n');
        const userPrompt = requirements 
            ? `## Discovery Requirements\n${requirements}\n\n## User Messages\n${allUserMessages}`
            : allUserMessages;
        sendEvent({ type: 'progress', stage: 'context', message: 'Initializing store context...' });
        const inputs = {
            userPrompt,
            tsErrors: [],
            designErrors: [],
            generatedFiles: [],
            referenceHtml,
            referenceImageBase64,
            designBrief,
            themeId: targetThemeId,
            shopName: project?.title || 'Shopify Store'
        };

        const stream = await themeWorkflow.stream(inputs, {
            recursionLimit: 100,
            configurable: {
                thread_id: projectId,
                sendEvent: async (e: any) => {
                    sendEvent(e);
                    // Milestone flushes: Ensure every block of progress is saved during critical assembly/sync
                    const persistenceStages = ['structural', 'coder', 'assembler', 'validating', 'CLI_BOOTING', 'FLY_PUSHING', 'SAVING_STATE'];
                    if (projectId && (persistenceStages.includes(e.stage) || e.type === 'tool_result')) {
                        await projectFeedAccumulator.flush(projectId);
                    }
                }
            }
        });

        let finalState: any = null;

        for await (const chunk of stream) {
            const node = Object.keys(chunk)[0];
            const output = chunk[node];

            const prevGeneratedFiles = finalState?.generatedFiles || [];
            finalState = { ...finalState, ...output };

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
            const modifications = finalState.generatedFiles.map((f: any) => ({
                filePath: f.path,
                action: 'update',
                content: f.content
            }));

            const globalSettings = finalState.designTokens || {};

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
                        await flyMachineService.waitForMachine(machineId);
                    } catch (e: any) {
                        logger.error(`[Build] ❌ Auto-provisioning failed: ${e.message}`);
                        sendEvent({ type: 'progress', stage: 'SYNC_ERROR', message: 'Failed to provision preview machine.' });
                        machineId = null;
                        throw e;
                    }
                }
            }

            if (machineId && modifications.length) {
                sendEvent({ type: 'progress', stage: 'CLI_BOOTING', message: 'Waiting for Shopify CLI and ordering files...' });
                await syncOrchestrator.waitForCLIReady(machineId);
                
                const orderedMods = syncOrchestrator.orderFilesForSync(modifications);
                const availableFiles = orderedMods.map(m => m.filePath);

                for (let i = 0; i < orderedMods.length; i++) {
                    const mod = orderedMods[i];
                    sendEvent({ type: 'progress', stage: 'FLY_PUSHING', message: `📤 [${i + 1}/${orderedMods.length}] ${mod.filePath}` });

                    const result = await syncOrchestrator.syncFileWithRetry(
                        machineId, mod.filePath, mod.content, availableFiles, targetThemeId
                    );

                    if (result.fixedContent) {
                        mod.content = result.fixedContent;
                        const origIdx = modifications.findIndex((m: any) => m.filePath === mod.filePath);
                        if (origIdx >= 0) modifications[origIdx].content = result.fixedContent;
                    }
                }

                try {
                    await flyMachineService.execCommand(machineId, ["bash", "-c", "wget -qO- --post-data='' http://127.0.0.1:9295/notify?source=engine || curl -s -X POST http://127.0.0.1:9295/notify?source=engine || echo 'Signaler not available'"]);
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

            // Final R2 sync
            const targetThemeIdForR2 = themeId || machineId;
            if (targetThemeIdForR2 && modifications.length > 0) {
                sendEvent({ type: 'progress', stage: 'SAVING_STATE', message: 'Saving theme state to R2...' });
                await uploadThemeState(targetThemeIdForR2, modifications);
            }

            if (projectId) {
                await updateProject(projectId, { 
                    phase: 'editing', 
                    themeId: targetThemeIdForR2, 
                    machineId,
                    designTokens: globalSettings 
                });
            }

            sendEvent({ type: 'progress', stage: 'SUCCESS', message: 'Theme successfully built and synced!' });
            sendEvent({ type: 'done' });
            
            if (projectId) {
                await projectFeedAccumulator.flush(projectId);
                projectFeedAccumulator.destroy(projectId);
            }
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
    const { messages, machineId, themeId: reqThemeId, projectId } = req.body;
    const themeId = reqThemeId || machineId;
    const requestId = `mod-${Date.now()}`;

    logger.info(`[ModifyRequest] 📥 Received /api/modify request: ${requestId} for theme ${themeId} (Project: ${projectId})`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data: any) => {
        if (projectId) projectFeedAccumulator.append(projectId, data);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    try {
        if (!themeId) throw new Error("themeId or machineId is required for modification");
        const userPrompt = messages[messages.length - 1]?.content || "";

        // Load Project Context
        let designTokens = {};
        let editHistory: any[] = [];
        if (projectId) {
            const project = await getProject(projectId);
            if (project) {
                designTokens = project.designTokens || {};
                // Filter feed for just user/assistant messages for the AI context
                editHistory = (project.feed || [])
                    .filter(m => m.role === 'user' || m.role === 'assistant' || m.kind === 'user_message' || m.kind === 'assistant_message')
                    .map(m => ({ 
                        role: m.role || (m.kind === 'user_message' ? 'user' : 'assistant'), 
                        content: m.content 
                    }));
                
                projectFeedAccumulator.create(projectId, project.feed || []);
            }
        }

        sendEvent({ type: 'progress', stage: 'LOADING_STATE', message: 'Retrieving theme state from R2...' });
        const baseFiles = await getThemeState(themeId);
        if (!baseFiles || baseFiles.length === 0) {
            throw new Error(`No existing theme state found for ${themeId}. Cannot modify.`);
        }

        const stream = await modifierWorkflow.stream({
            userPrompt,
            themeId,
            baseFiles,
            designTokens,
            editHistory,
            tsErrors: []
        }, {
            recursionLimit: 50,
            configurable: { 
                thread_id: projectId || themeId,
                sendEvent: (e: any) => sendEvent(e) 
            }
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
                    await flyMachineService.execCommand(machineId, ["bash", "-c", "wget -qO- --post-data='' http://127.0.0.1:9295/notify?source=engine || curl -s -X POST http://127.0.0.1:9295/notify?source=engine || echo 'Signaler not available'"]);
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

            if (projectId) {
                // Add the user message and assistant final response to the project feed
                const userMsg = { kind: 'user_message', role: 'user', content: userPrompt };
                const assistMsg = { kind: 'assistant_message', role: 'assistant', content: `Modified ${mod.path} based on your request.` };
                projectFeedAccumulator.append(projectId, userMsg);
                projectFeedAccumulator.append(projectId, assistMsg);
                
                await projectFeedAccumulator.flush(projectId);
                projectFeedAccumulator.destroy(projectId);
            }

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

const server = app.listen(port, async () => {
    try {
        await initPostgres();
        const checkpointer = getCheckpointer();
        await checkpointer.setup();
        logger.info(`sta-engine listening on port ${port} and database initialized`);
    } catch (err) {
        logger.error(`Failed to initialize database: ${err}`);
        process.exit(1);
    }
});
