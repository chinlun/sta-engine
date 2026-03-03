import express from 'express';
import cors from 'cors';
import { uploadToR2 } from './services/r2-service';
import { uploadThemeToShopify } from './services/shopify-service';
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

    try {
        const result = await streamText({
            model: google('gemini-2.5-flash'),
            messages,
            tools: {
                build_theme: tool({
                    description: "Builds a Shopify theme based on the plan",
                    parameters: z.object({
                        thoughtProcess: z.string(),
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
                        const zipBuffer = await buildTheme(args);
                        const r2Url = await uploadToR2(`theme-${Date.now()}.zip`, zipBuffer, 'application/zip');
                        const shopifyResult = await uploadThemeToShopify(`AI Generated - ${Date.now()}`, r2Url);
                        return shopifyResult;
                    }
                } as any)
            }
        });

        result.pipeTextStreamToResponse(res);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/health', (req, res) => {
    res.send('OK');
});

app.listen(port, () => {
    console.log(`sta-engine listening on port ${port}`);
});
