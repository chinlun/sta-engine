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

app.use(express.json());

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
    console.log(`[${requestId}] 💬 Messages: ${messages?.length || 0} total`);
    messages?.forEach((m: any, i: number) => {
        const preview = typeof m.content === 'string' ? m.content.substring(0, 120) : JSON.stringify(m.content).substring(0, 120);
        console.log(`[${requestId}]   [${i}] ${m.role}: "${preview}${m.content?.length > 120 ? '...' : ''}"`);
    });
    console.log(`${'repeat(requestId)'}`);

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
                console.log(`[${requestId}] � Self-healing retry ${retryCount}/${maxRetries}`);
            } else {
                sendEvent({ type: 'progress', stage: 'ai_call', message: `Calling Gemini...` });
                console.log(`[${requestId}] � Calling Gemini (gemini-2.5-flash)...`);
            }

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
                messages: currentMessages,
            });

            let fullText = "";
            for await (const chunk of result.fullStream) {
                if (chunk.type === 'text-delta') {
                    fullText += chunk.text;
                    sendEvent({ type: 'text', content: chunk.text });
                }
            }

            // --- PARSE MARKDOWN ---
            try {
                const globalSettingsMatch = fullText.match(/###\s*`globalSettings`\s*```(?:json)?\n([\s\S]*?)```/);
                if (globalSettingsMatch) {
                    globalSettings = { ...globalSettings, ...JSON.parse(globalSettingsMatch[1].trim()) };
                }
            } catch (e) {
                console.warn(`[${requestId}] ⚠️ Failed to parse globalSettings JSON`);
            }

            const fileRegex = /###\s*`([^`]+)`\s*```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
            let match;
            const newModifications: any[] = [];
            while ((match = fileRegex.exec(fullText)) !== null) {
                const filePath = match[1].trim();
                if (filePath === 'globalSettings' || filePath.includes(' ')) continue;
                newModifications.push({ filePath, action: 'update', content: match[2] });
            }

            // Merge modifications: existing ones are updated or kept, new ones are added
            for (const newMod of newModifications) {
                const existingIndex = modifications.findIndex(m => m.filePath === newMod.filePath);
                if (existingIndex > -1) {
                    modifications[existingIndex] = newMod;
                } else {
                    modifications.push(newMod);
                }
            }

            if (modifications.length === 0) {
                console.log(`[${requestId}] ℹ️ No file modifications found.`);
                buildSuccessful = true;
                continue;
            }

            try {
                // --- VALIDATE ---
                sendEvent({ type: 'progress', stage: 'validating', message: 'Validating theme integrity...' });
                IntegrityManager.validate(modifications);

                // If validation passes, proceed to sync
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

                    await flyMachineService.syncBulk(machineId, orderedMods.map(m => ({ filePath: m.filePath!, content: m.content })));
                    try {
                        // Use wget as a fallback if curl is missing
                        await flyMachineService.execCommand(machineId, [
                            "bash", "-c",
                            "wget -qO- --post-data='' http://127.0.0.1:9295/notify || curl -s -X POST http://127.0.0.1:9295/notify || echo 'Signaler not available'"
                        ]);
                    } catch (e) { }
                }

                sendEvent({
                    type: 'tool_result', result: {
                        id: 'docker-preview',
                        name: `AI Preview`,
                        role: 'development',
                        preview_url: `http://localhost:${port}/api/preview/${machineId}`
                    }
                });

                buildSuccessful = true;
                sendEvent({ type: 'done' });
                console.log(`[${requestId}] ✅ Build & Sync successful after ${retryCount + 1} pass(es)`);

            } catch (error) {
                if (error instanceof ValidationError && retryCount < maxRetries) {
                    console.warn(`[${requestId}] ⚠️ Validation failed, triggering self-healing: ${error.message}`);
                    currentMessages.push({ role: 'assistant', content: fullText });
                    currentMessages.push({
                        role: 'user',
                        content: buildCurativePrompt(error.reason)
                    });
                    retryCount++;
                } else {
                    throw error;
                }
            }
        }
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

// Final fallthrough handler for any requests not handled by routes
app.use((req, res) => {
    res.status(404).send('Not Found');
});

const server = app.listen(port, () => {
    console.log(`sta-engine listening on port ${port}`);
});
