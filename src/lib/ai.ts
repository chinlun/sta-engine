import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { wrapLanguageModel } from 'ai';
import { Agent, setGlobalDispatcher } from 'undici';
import * as dotenv from 'dotenv';

dotenv.config();

// Completely disable timeouts to allow massive multimodal generations
const globalAgent = new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 60 * 1000,
    keepAliveTimeout: 10 * 60 * 1000,
});
setGlobalDispatcher(globalAgent);

/**
 * Custom Google provider that strips the aggressive 60s timeout 
 */
export const customGoogle = createGoogleGenerativeAI({
    fetch: (url, options) => {
        const customOptions = { ...options, dispatcher: globalAgent };
        if (customOptions.signal) {
            console.log(`[AI] 🛡️ Stripping SDK timeout signal`);
            delete customOptions.signal;
        }
        return (globalThis.fetch as any)(url, customOptions).then((res: any) => {
            return res;
        }).catch((err: any) => {
            console.error(`[AI] ❌ Network Error for ${url}:`, err);
            throw err;
        });
    }
});

/**
 * High-Availability Wrapper
 * Supports a chain of fallbacks. If the first fails with 503/429, it tries the next, and so on.
 */
function wrapResilientModel(modelIds: string[]) {
    if (modelIds.length === 0) throw new Error("At least one model ID is required");

    const models = modelIds.map(id => customGoogle(id));

    return wrapLanguageModel({
        model: models[0],
        middleware: {
            specificationVersion: 'v3',
            wrapGenerate: async ({ params, doGenerate }) => {
                let lastErr: any;
                for (let i = 0; i < models.length; i++) {
                    try {
                        const result = i === 0 ? await doGenerate() : await models[i].doGenerate(params);

                        // Detect "silent failures": model returns OK but with empty content
                        const hasContent = result.content.some(part =>
                            part.type === 'text' ||
                            part.type === 'tool-call' ||
                            part.type === 'reasoning'
                        );

                        if (!hasContent && result.finishReason.unified === 'other' && i < models.length - 1) {
                            console.warn(`[AI] ⚠️ ${modelIds[i]} returned empty (finishReason: other). Falling back to ${modelIds[i + 1]}...`);
                            continue;
                        }
                        return result;
                    } catch (err: any) {
                        lastErr = err;
                        const isRetryable = err.statusCode === 503 || err.statusCode === 429 ||
                            err.status === 503 || err.status === 429 ||
                            (err.data?.error?.code === 503 || err.data?.error?.code === 429);

                        if (isRetryable && i < models.length - 1) {
                            console.warn(`[AI] ⚠️ ${modelIds[i]} unavailable (${err.statusCode || err.status || '503'}). Falling back to ${modelIds[i + 1]}...`);
                            continue;
                        }
                        throw err;
                    }
                }
                throw lastErr;
            },
            wrapStream: async ({ params, doStream }) => {
                let lastErr: any;
                for (let i = 0; i < models.length; i++) {
                    try {
                        if (i === 0) return await doStream();
                        return await models[i].doStream(params);
                    } catch (err: any) {
                        lastErr = err;
                        const isRetryable = err.statusCode === 503 || err.statusCode === 429 ||
                            err.status === 503 || err.status === 429 ||
                            (err.data?.error?.code === 503 || err.data?.error?.code === 429);

                        if (isRetryable && i < models.length - 1) {
                            console.warn(`[AI] ⚠️ ${modelIds[i]} unavailable (${err.statusCode || err.status || '503'}). Falling back to ${modelIds[i + 1]}...`);
                            continue;
                        }
                        throw err;
                    }
                }
                throw lastErr;
            }
        }
    });
}

export const gemini31Pro = wrapResilientModel([
    'gemini-3.1-pro-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash'
]);
export const gemini3Flash = customGoogle('gemini-3-flash-preview');
