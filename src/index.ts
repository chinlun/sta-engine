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

// Create a custom Google provider that strips the aggressive 60s timeout
// so that generating massive SPA layouts (which take 90+ seconds) doesn't silently fail.
const customGoogle = createGoogleGenerativeAI({
    fetch: (url, options) => {
        // Remove the abort signal if it exists because @ai-sdk/google injects a 60s timeout signal
        const customOptions = { ...options };
        if (customOptions.signal) {
            delete customOptions.signal;
        }
        return fetch(url, customOptions as any);
    }
});

dotenv.config();

const app = express();
const port = 8080;

app.use(cors());
app.use(express.json());

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
        const result = await streamText({
            model: customGoogle('gemini-2.5-flash'),
            system: systemPrompt,
            messages,
            tools: {
                build_theme: tool({
                    description: "Builds a Shopify theme based on the plan. Call this AFTER explaining your thinking as text.",
                    parameters: BuildThemeToolSchema,
                    execute: async (rawArgs: any) => {
                        console.log(`\n[${requestId}] 🐛 RAW LLM PAYLOAD:`, JSON.stringify(rawArgs, null, 2));
                        const args = rawArgs as BuildThemeToolParams;
                        const toolStart = Date.now();
                        console.log(`\n[${requestId}] 🔧 ===== TOOL CALL: build_theme =====`);
                        console.log(`[${requestId}] 🎨 Global settings:`, JSON.stringify(args.globalSettings || {}));
                        console.log(`[${requestId}] 📝 Modifications: ${args.modifications?.length || 0} files`);
                        args.modifications?.forEach((mod: any, i: number) => {
                            const { filePath, action, content } = normalizeMod(mod);
                            console.log(`[${requestId}]   [${i}] ${action.toUpperCase()} ${filePath} (${content.length} chars)`);
                        });

                        sendEvent({ type: 'tool_start', tool: 'build_theme' });

                        try {
                            // Stage 0: Validate & Auto-Repair (Item 4: Zero Broken Themes)
                            sendEvent({ type: 'progress', stage: 'validating', message: 'Validating theme modifications...' });
                            const validation = validateAndRepair(args as ThemePlan);

                            // Log repairs and warnings
                            for (const repair of validation.repairs) {
                                console.log(`[${requestId}] 🔧 [Auto-Repair] ${repair}`);
                            }
                            for (const warning of validation.warnings) {
                                console.warn(`[${requestId}] ⚠️ [Validation] ${warning}`);
                            }

                            // Block deploy on critical errors
                            if (!validation.valid) {
                                const errorMsg = `Theme validation failed: ${validation.errors.join('; ')}`;
                                console.error(`[${requestId}] ❌ [Validation] ${errorMsg}`);
                                sendEvent({ type: 'error', message: errorMsg });
                                return { error: errorMsg };
                            }

                            if (validation.repairs.length > 0) {
                                sendEvent({ type: 'progress', stage: 'validating', message: `Auto-repaired ${validation.repairs.length} issue(s)` });
                            }

                            // Stage 0.5: Gate Validator (Item 6: Cheap Clerk check)
                            sendEvent({ type: 'progress', stage: 'gate_check', message: 'Running gate validation...' });
                            const gateResult = await gateValidate(args.modifications || []);
                            if (!gateResult.passed) {
                                console.warn(`[${requestId}] ⚠️ [GateValidator] Issues found: ${gateResult.issues.join('; ')}`);
                                sendEvent({ type: 'progress', stage: 'gate_check', message: `Gate flagged issues: ${gateResult.issues.join('; ')}` });
                                // Log but don't block — the gate is advisory for now
                                // TODO: In future, feed issues back for retry
                            }

                            // Stage 1: Ensure theme slot (SPEC §4.4 — 20-theme limit)
                            sendEvent({ type: 'progress', stage: 'cleaning', message: 'Checking theme capacity...' });
                            await ensureThemeSlot();

                            // Stage 2: Build
                            const modCount = args.modifications?.length || 0;
                            sendEvent({ type: 'progress', stage: 'building', message: `Building theme with ${modCount} modifications...` });
                            const zipBuffer = await buildTheme(args as ThemePlan);
                            console.log(`[${requestId}] [Builder] Theme zip built, size: ${zipBuffer.length} bytes`);

                            // Stage 3: Upload to R2 (returns signed URL per SPEC §4.3)
                            sendEvent({ type: 'progress', stage: 'uploading', message: 'Uploading theme to cloud storage...' });
                            const r2SignedUrl = await uploadToR2(`theme-${Date.now()}.zip`, zipBuffer, 'application/zip');
                            console.log(`[${requestId}] [R2] Upload complete, signed URL generated`);

                            // Stage 3: Deploy to Shopify
                            sendEvent({ type: 'progress', stage: 'deploying', message: 'Deploying theme to Shopify...' });
                            const shopifyResult = await uploadThemeToShopify(`AI Generated - ${Date.now()}`, r2SignedUrl);
                            console.log(`[${requestId}] [Shopify] Deploy complete:`, shopifyResult);

                            // Stage 5: Wait for Shopify to process the theme
                            sendEvent({ type: 'progress', stage: 'processing', message: 'Waiting for Shopify to process theme...' });
                            await waitForThemeReady(shopifyResult.id, (msg) => {
                                sendEvent({ type: 'progress', stage: 'processing', message: msg });
                            });

                            // Stage 6: Publish the theme as live
                            sendEvent({ type: 'progress', stage: 'publishing', message: 'Publishing theme as live...' });
                            await publishTheme(shopifyResult.id);

                            const toolDuration = ((Date.now() - toolStart) / 1000).toFixed(1);
                            console.log(`[${requestId}] ✅ build_theme completed in ${toolDuration}s`);
                            sendEvent({
                                type: 'tool_result', result: {
                                    ...shopifyResult,
                                    preview_url: `http://localhost:${port}/api/preview/${shopifyResult.id}`
                                }
                            });
                            return shopifyResult;
                        } catch (error) {
                            console.error(`[${requestId}] ❌ [build_theme error]`, error);
                            sendEvent({ type: 'error', message: String(error) });
                        }
                    }
                } as any)
            }
        });

        // Use fullStream to get both text deltas and tool events
        let textChunkCount = 0;
        let totalTextLength = 0;

        for await (const chunk of result.fullStream) {
            switch (chunk.type) {
                case 'text-delta':
                    textChunkCount++;
                    totalTextLength += chunk.text.length;
                    sendEvent({ type: 'thinking', content: chunk.text });
                    break;
                case 'tool-call':
                    console.log(`[${requestId}] 📞 [Stream] Tool call: ${chunk.toolName}`);
                    console.log(`[${requestId}]    Text streamed so far: ${textChunkCount} chunks, ${totalTextLength} chars`);
                    break;
                case 'tool-result':
                    console.log(`[${requestId}] 📦 [Stream] Tool result received`);
                    break;
                case 'error':
                    console.error(`[${requestId}] ❌ [Stream] Error:`, chunk.error);
                    sendEvent({ type: 'error', message: String(chunk.error) });
                    break;
                default:
                    if (chunk.type === 'finish') {
                        console.log(`[${requestId}] 🏁 [Stream] Finish: reason=${(chunk as any).finishReason}, usage=${JSON.stringify((chunk as any).usage)}`);
                    } else if (chunk.type === 'finish-step') {
                        console.log(`[${requestId}] 🏁 [Stream] Finish step`);
                    } else if (chunk.type !== 'start' && chunk.type !== 'start-step' && chunk.type !== 'text-start' && chunk.type !== 'text-end') {
                        console.log(`[${requestId}] ❓ [Stream] Unhandled chunk type:`, chunk.type);
                    }
                    break;
            }
        }

        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${requestId}] ✅ Request complete in ${totalDuration}s (${textChunkCount} text chunks, ${totalTextLength} chars streamed)`);
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

// Magic authenticating preview redirect
app.get('/api/preview/:themeId', createMagicPreviewHandler());

app.listen(port, () => {
    console.log(`sta-engine listening on port ${port}`);
});
