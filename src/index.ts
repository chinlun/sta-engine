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
import { previewProxy } from './middleware/preview-proxy';
import { flyMachineService } from './services/fly-machine-service';
import path from 'path';

// Create a custom Google provider that strips the aggressive 60s timeout
// so that generating massive SPA layouts (which take 90+ seconds) doesn't silently fail.
const customGoogle = createGoogleGenerativeAI({
    fetch: (url, options) => {
        // Remove the abort signal if it exists because @ai-sdk/google injects a 60s timeout signal
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

// Mount proxy at root to catch root-level assets (/cdn/..., etc.)
// The proxy itself will handle filtering based on machineId presence
app.use('/', previewProxy);

app.use(express.json());

app.use('/api/preview', previewRoutes);

app.post('/api/build', async (req, res) => {
    const { messages } = req.body;
    const requestId = `req-${Date.now()}`;
    const startTime = Date.now();

    console.log(`\n${'='.repeat(70)}`);
    console.log(`[${requestId}] 📨 New build request received`);
    console.log(`[${requestId}] 💬 Messages: ${messages?.length || 0} total`);
    messages?.forEach((m: any, i: number) => {
        const preview = typeof m.content === 'string' ? m.content.substring(0, 120) : JSON.stringify(m.content).substring(0, 120);
        console.log(`[${requestId}]   [${i}] ${m.role}: "${preview}${m.content?.length > 120 ? '...' : ''}"`);
    });
    console.log(`${'='.repeat(70)}`);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data: object) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        // SPEC §5.2: Inject current index.json and settings_data.json as primary context
        sendEvent({ type: 'progress', stage: 'context', message: 'Loading theme context & reference docs...' });
        const currentIndexJson = extractFileFromBaseTheme('templates/index.json');
        const currentSettingsData = extractFileFromBaseTheme('config/settings_data.json');
        console.log(`[${requestId}] 📄 State injection: index.json=${currentIndexJson ? `${currentIndexJson.length} chars` : 'NOT FOUND'}, settings_data.json=${currentSettingsData ? `${currentSettingsData.length} chars` : 'NOT FOUND'}`);

        // SPEC §5.1: Build system prompt with cheat sheet injection
        sendEvent({ type: 'progress', stage: 'context', message: 'Building system prompt with CAT context layers...' });
        const systemPrompt = buildSystemPrompt(currentIndexJson, currentSettingsData);
        console.log(`[${requestId}] 🧠 System prompt built: ${systemPrompt.length} chars`);

        sendEvent({ type: 'progress', stage: 'ai_call', message: `Calling Gemini (${Math.round(systemPrompt.length / 4).toLocaleString()} tokens context)...` });
        console.log(`[${requestId}] 🚀 Calling Gemini (gemini-2.5-flash)...`);
        console.log(`[${requestId}] 📦 LLM Request Payload (Messages):`, JSON.stringify(messages, null, 2));
        const result = await streamText({
            model: (customGoogle as any)('gemini-2.5-flash', {
                structuredOutputs: false,
                safetySettings: [
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
                ]
            }),
            system: systemPrompt,
            messages,
            // tools removed
        });

        // Use fullStream to get both text deltas and tool events
        let textChunkCount = 0;
        let totalTextLength = 0;
        let fullText = "";

        for await (const chunk of result.fullStream) {
            switch (chunk.type) {
                case 'text-delta':
                    textChunkCount++;
                    totalTextLength += chunk.text.length;
                    fullText += chunk.text;
                    sendEvent({ type: 'text', content: chunk.text });
                    break;
                case 'error':
                    console.error(`[${requestId}] ❌ [Stream] SDK Error:`, chunk.error);
                    sendEvent({ type: 'error', message: `AI Stream Error: ${String(chunk.error)}` });
                    break;
                default:
                    if (chunk.type === 'finish') {
                        console.log(`[${requestId}] 🏁 [Stream] Finish step`);
                        if ((chunk as any).finishReason === 'error') {
                            console.error(`[${requestId}] ❌ [Stream] Terminal error detected. Full chunk:`, JSON.stringify(chunk, null, 2));
                        }
                    }
                    break;
            }
        }

        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${requestId}] ✅ Request complete in ${totalDuration}s (${textChunkCount} text chunks, ${totalTextLength} chars streamed)`);
        console.log(`[${requestId}] 📥 LLM Raw Response:\n${fullText}\n------------------------------------------------------`);

        // --- PARSE MARKDOWN ---
        console.log(`[${requestId}] 🧠 Parsing markdown for theme files...`);

        let globalSettings = {};
        try {
            const globalSettingsMatch = fullText.match(/###\s*`globalSettings`\s*```(?:json)?\n([\s\S]*?)```/);
            if (globalSettingsMatch) {
                globalSettings = JSON.parse(globalSettingsMatch[1].trim());
            }
        } catch (e) {
            console.warn(`[${requestId}] ⚠️ Failed to parse globalSettings JSON`);
        }

        const modifications: any[] = [];
        const fileRegex = /###\s*`([^`]+)`\s*```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
        let match;
        while ((match = fileRegex.exec(fullText)) !== null) {
            const filePath = match[1].trim();
            if (filePath === 'globalSettings' || filePath.includes(' ')) continue;
            const content = match[2];
            modifications.push({ filePath, action: 'update', content });
        }

        if (modifications.length > 0) {
            const toolStart = Date.now();
            console.log(`\n[${requestId}] 🔧 ===== VIRTUAL TOOL CALL: build_theme =====`);
            console.log(`[${requestId}] 🎨 Global settings:`, JSON.stringify(globalSettings || {}));
            console.log(`[${requestId}] 📝 Modifications: ${modifications.length} files`);

            const args = { globalSettings, modifications };

            // Send synthetic tool_call event to frontend to trigger boot & sync!
            sendEvent({ type: 'tool_call', toolName: 'build_theme', args });

            // RUN THE BUILD PIPELINE DIRECTLY
            // Server-side sync fallback
            const machineId = req.body.machineId;

            if (machineId && modifications.length) {
                console.log(`[${requestId}] 🚢 Server-side syncing to machine: ${machineId}`);
                try {
                    let script = "";
                    for (const mod of modifications) {
                        const { filePath, content } = normalizeMod(mod);
                        if (!filePath || !content) continue;

                        const escapedContent = Buffer.from(content).toString('base64');
                        const fullPath = path.join("/theme", filePath);
                        const dir = path.dirname(fullPath);
                        script += `mkdir -p ${dir} && echo "${escapedContent}" | base64 -d > ${fullPath}\n`;
                    }
                    const command = [
                        "bash", "-c",
                        `echo "${Buffer.from(script).toString('base64')}" | base64 -d | bash`
                    ];
                    await flyMachineService.execCommand(machineId, command);
                    console.log(`[${requestId}] ✅ Server-side sync complete`);
                } catch (syncErr: any) {
                    console.error(`[${requestId}] ⚠️ Server-side sync failed:`, syncErr.message);
                }
            } else {
                console.log(`[${requestId}] ℹ️ Skipping server-side sync (No machineId in session)`);
            }

            sendEvent({ type: 'tool_start', tool: 'build_theme' });
            sendEvent({ type: 'progress', stage: 'syncing', message: 'Syncing changes to live preview...' });

            try {
                // Stage 0: Validate & Auto-Repair
                sendEvent({ type: 'progress', stage: 'validating', message: 'Validating theme modifications...' });
                const validation = validateAndRepair(args as ThemePlan);

                for (const repair of validation.repairs) {
                    console.log(`[${requestId}] 🔧 [Auto-Repair] ${repair}`);
                }
                for (const warning of validation.warnings) {
                    console.warn(`[${requestId}] ⚠️ [Validation] ${warning}`);
                }

                if (!validation.valid) {
                    const errorMsg = `Theme validation failed: ${validation.errors.join('; ')}`;
                    console.error(`[${requestId}] ❌ [Validation] ${errorMsg}`);
                    sendEvent({ type: 'error', message: errorMsg });
                } else {
                    if (validation.repairs.length > 0) {
                        sendEvent({ type: 'progress', stage: 'validating', message: `Auto-repaired ${validation.repairs.length} issue(s)` });
                    }

                    // Stage 0.5: Gate Validator
                    sendEvent({ type: 'progress', stage: 'gate_check', message: 'Running gate validation...' });
                    const gateResult = await gateValidate(args.modifications || []);
                    if (!gateResult.passed) {
                        console.warn(`[${requestId}] ⚠️ [GateValidator] Issues found: ${gateResult.issues.join('; ')}`);
                        sendEvent({ type: 'progress', stage: 'gate_check', message: `Gate flagged issues: ${gateResult.issues.join('; ')}` });
                    }

                    const toolDuration = ((Date.now() - toolStart) / 1000).toFixed(1);
                    console.log(`[${requestId}] ✅ build_theme completed in ${toolDuration}s`);
                    // Since we are leveraging Docker sync exclusively, we do not need to push to Shopify.
                    // We simply return a success event to the frontend so it finishes loading.
                    sendEvent({
                        type: 'tool_result', result: {
                            id: 'docker-preview',
                            name: `AI Preview`,
                            role: 'development',
                            preview_url: `http://localhost:${port}/api/preview/${machineId}`
                        }
                    });
                }
            } catch (error) {
                console.error(`[${requestId}] ❌ [build_theme error]`, error);
                sendEvent({ type: 'error', message: String(error) });
            }
        } else {
            console.log(`[${requestId}] ℹ️ No file modifications found in AI response.`);
        }

        console.log(`${'='.repeat(70)}\n`);
        sendEvent({ type: 'done' });
        res.end();
    } catch (error) {
        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`[${requestId}] ❌ Request failed after ${totalDuration}s:`, error);
        sendEvent({ type: 'error', message: String(error) });
        res.end();
    }
});

app.get('/health', (req, res) => {
    res.send('OK');
});

// Mock Shopify telemetry and tracking endpoints to silence noise in development
app.all(['/api/collect', '/.well-known/shopify/monorail/*'], (req, res) => {
    res.status(200).send();
});

// Magic authenticating preview redirect
app.get('/api/preview/:themeId', createMagicPreviewHandler());

const server = app.listen(port, () => {
    console.log(`sta-engine listening on port ${port}`);
});

// Handle WebSocket upgrades for the Shopify CLI hot-reloading proxy
server.on('upgrade', (req, socket, head) => {
    // Forward all upgrades to proxy - it will only handle them if it found a machineId
    (previewProxy as any).upgrade(req, socket, head);
});
