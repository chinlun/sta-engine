import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { wrapLanguageModel } from 'ai';
import { Agent, setGlobalDispatcher } from 'undici';
import * as dotenv from 'dotenv';

dotenv.config();

// 10-minute safe timeout for massive AI responses (multimodal/Thinking)
const AI_TIMEOUT_MS = 10 * 60 * 1000;

const globalAgent = new Agent({
    headersTimeout: 5 * 60 * 1000, // 5 minutes to get headers
    bodyTimeout: 0,               // Allow slow body streaming for long thoughts
    connectTimeout: 60 * 1000,
    keepAliveTimeout: 15 * 60 * 1000,
});
setGlobalDispatcher(globalAgent);

/**
 * Custom Google provider that provides a generous 5-minute timeout 
 */
export const customGoogle = createGoogleGenerativeAI({
    fetch: (url, options) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

        const customOptions: any = {
            ...options,
            dispatcher: globalAgent,
            signal: controller.signal
        };

        return (globalThis.fetch as any)(url, customOptions).then((res: any) => {
            clearTimeout(timeoutId);
            return res;
        }).catch((err: any) => {
            clearTimeout(timeoutId);
            const isTimeout = err.name === 'AbortError';
            console.error(`[AI] ${isTimeout ? '⏰ Timeout' : '❌ Network Error'} for ${url}:`, err);
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

    const isRetryableError = (err: any) => {
        // Detailed logging for AI_APICallError to help diagnose recurring failures
        if (err.name === 'AI_APICallError') {
            console.error(`[AI] 🚨 AI_APICallError Details: status=${err.status}, data=`, JSON.stringify(err.data || {}));
        }

        return err.statusCode === 503 || err.statusCode === 429 ||
            err.status === 503 || err.status === 429 ||
            err.code === 'UND_ERR_HEADERS_TIMEOUT' ||
            err.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
            err.name === 'AbortError' ||
            (err.data?.error?.code === 503 || err.data?.error?.code === 429);
    };

    const withRetry = async (fn: () => Promise<any>, modelName: string, maxRetries = 2) => {
        let lastError: any;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err: any) {
                lastError = err;
                if (isRetryableError(err) && attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * 1000;
                    console.warn(`[AI] ⚠️ ${modelName} attempt ${attempt + 1} failed. Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw err;
            }
        }
        throw lastError;
    };

    return wrapLanguageModel({
        model: models[0],
        middleware: {
            specificationVersion: 'v3',
            wrapGenerate: async ({ params, doGenerate }) => {
                let lastErr: any;
                for (let i = 0; i < models.length; i++) {
                    try {
                        const result = await withRetry(
                            async () => i === 0 ? await doGenerate() : await models[i].doGenerate(params),
                            modelIds[i]
                        );

                        // Detect "silent failures": model returns OK but with empty content
                        const hasContent = result.content.some((part: any) =>
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
                        if (isRetryableError(err) && i < models.length - 1) {
                            console.warn(`[AI] ⚠️ ${modelIds[i]} exhausted retries. Falling back to ${modelIds[i + 1]}...`);
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
                        return await withRetry(
                            async () => i === 0 ? await doStream() : await models[i].doStream(params),
                            modelIds[i]
                        );
                    } catch (err: any) {
                        lastErr = err;
                        if (isRetryableError(err) && i < models.length - 1) {
                            console.warn(`[AI] ⚠️ ${modelIds[i]} exhausted retries. Falling back to ${modelIds[i + 1]}...`);
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

// export const gemini31Pro = wrapResilientModel([
//     'gemini-3.1-pro-preview',
//     'gemini-2.5-pro',
//     'gemini-2.5-flash'
// ]);
export const gemini31Pro = wrapResilientModel([
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
]);
export const gemini3Flash = wrapResilientModel([
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    // 'gemini-2.5-flash'
]);
