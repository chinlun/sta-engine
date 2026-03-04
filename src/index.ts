import express from 'express';
import cors from 'cors';
import { uploadToR2 } from './services/r2-service';
import { uploadThemeToShopify, waitForThemeReady } from './services/shopify-service';
import { createProxyHandler } from './services/preview-service';
import { buildTheme } from './services/builder';
import dotenv from 'dotenv';
import { streamText, tool } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';

dotenv.config();

const app = express();
const port = 8080;

app.use(cors());
app.use(express.json());

app.post('/api/build', async (req, res) => {
    const { messages } = req.body;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data: object) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const systemPrompt = `You are a Shopify theme builder assistant. When the user describes what they want for their store, follow this exact pattern:

1. FIRST, write out your design thinking and rationale as text. Explain what colors, fonts, layout choices you're making and why. Stream this naturally so the user can follow your thought process.

2. THEN, immediately call the build_theme tool with the actual modifications. Do NOT ask for confirmation.

When calling build_theme:
- globalSettings: Set colors and fonts based on the user's request
- modifications: Provide an array of file modifications to apply to the Dawn base theme. Each modification needs a filePath (relative to the theme root, e.g. "sections/header.liquid"), action ("update" or "create"), and the full file content.

Always write your thinking first, then call build_theme. Never just ask if the user wants to proceed.`;

        const result = await streamText({
            model: google('gemini-2.5-flash'),
            system: systemPrompt,
            messages,
            tools: {
                build_theme: tool({
                    description: "Builds a Shopify theme based on the plan. Call this AFTER explaining your thinking as text.",
                    parameters: z.object({
                        globalSettings: z.object({
                            primaryColor: z.string().optional(),
                            fontFamily: z.string().optional()
                        }).optional(),
                        modifications: z.array(z.object({
                            filePath: z.string(),
                            action: z.enum(['update', 'create']),
                            content: z.string()
                        }))
                    }),
                    execute: async (args: any) => {
                        console.log("Executing build_theme tool...");

                        sendEvent({ type: 'tool_start', tool: 'build_theme' });

                        try {
                            // Stage 1: Build
                            sendEvent({ type: 'progress', stage: 'building', message: `Building theme with ${args.modifications.length} modifications...` });
                            const zipBuffer = await buildTheme(args);
                            console.log("[Builder] Theme zip built, size:", zipBuffer.length);

                            // Stage 2: Upload to R2
                            sendEvent({ type: 'progress', stage: 'uploading', message: 'Uploading theme to cloud storage...' });
                            const r2Url = await uploadToR2(`theme-${Date.now()}.zip`, zipBuffer, 'application/zip');
                            console.log("[R2] Upload complete:", r2Url);

                            // Stage 3: Deploy to Shopify
                            sendEvent({ type: 'progress', stage: 'deploying', message: 'Deploying theme to Shopify...' });
                            const shopifyResult = await uploadThemeToShopify(`AI Generated - ${Date.now()}`, r2Url);
                            console.log("[Shopify] Deploy complete:", shopifyResult);

                            // Stage 4: Wait for Shopify to process the theme
                            sendEvent({ type: 'progress', stage: 'processing', message: 'Waiting for Shopify to process theme...' });
                            await waitForThemeReady(shopifyResult.id, (msg) => {
                                sendEvent({ type: 'progress', stage: 'processing', message: msg });
                            });

                            sendEvent({
                                type: 'tool_result', result: {
                                    ...shopifyResult,
                                    preview_url: `http://localhost:${port}/api/preview/${shopifyResult.id}/`
                                }
                            });
                            return shopifyResult;
                        } catch (error) {
                            console.error("[build_theme error]", error);
                            sendEvent({ type: 'error', message: String(error) });
                            return { error: String(error) };
                        }
                    }
                } as any)
            }
        });

        // Use fullStream to get both text deltas and tool events
        for await (const chunk of result.fullStream) {
            switch (chunk.type) {
                case 'text-delta':
                    sendEvent({ type: 'thinking', content: chunk.text });
                    break;
                case 'tool-call':
                    console.log(`[Tool Call] ${chunk.toolName}`);
                    break;
                case 'tool-result':
                    console.log(`[Tool Result] done`);
                    break;
                case 'error':
                    sendEvent({ type: 'error', message: String(chunk.error) });
                    break;
            }
        }

        sendEvent({ type: 'done' });
        res.end();
    } catch (error) {
        console.error(error);
        sendEvent({ type: 'error', message: String(error) });
        res.end();
    }
});

app.get('/health', (req, res) => {
    res.send('OK');
});

// Preview proxy — authenticates with store password server-side
app.get('/api/preview/:themeId/*', createProxyHandler());
app.get('/api/preview/:themeId', createProxyHandler());

app.listen(port, () => {
    console.log(`sta-engine listening on port ${port}`);
});
