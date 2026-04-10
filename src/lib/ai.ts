import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { wrapLanguageModel } from 'ai';
import { LanguageModelV3 } from '@ai-sdk/provider';
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

/** Custom fetch with generous timeout for AI providers */
const timeoutFetch = (url: any, options: any) => {
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
};

/**
 * Custom Google provider with generous timeout 
 */
export const customGoogle = createGoogleGenerativeAI({
    fetch: timeoutFetch
});

/**
 * Custom DeepSeek provider with generous timeout
 * Uses DEEPSEEK_GENERATIVE_AI_API_KEY env var (non-standard name)
 */
export const customDeepSeek = createDeepSeek({
    apiKey: process.env.DEEPSEEK_GENERATIVE_AI_API_KEY ?? '',
    fetch: timeoutFetch
});

// ── Named model instances ────────────────────────────────────────────
// These can be mixed across providers in the resilient fallback chains

interface NamedModel {
    name: string;
    model: LanguageModelV3;
}

const google31Pro: NamedModel = { name: 'gemini-3.1-pro-preview', model: customGoogle('gemini-3.1-pro-preview') };
const google3Flash: NamedModel = { name: 'gemini-3-flash-preview', model: customGoogle('gemini-3-flash-preview') };
const google31FlashLite: NamedModel = { name: 'gemini-3.1-flash-lite-preview', model: customGoogle('gemini-3.1-flash-lite-preview') };
const deepseekChat: NamedModel = { name: 'deepseek-chat', model: customDeepSeek('deepseek-chat') };

/**
 * High-Availability Wrapper (Multi-Provider)
 * Accepts pre-built model instances from ANY provider.
 * If the first fails with 503/429/timeout, it tries the next, and so on.
 */
function wrapResilientModel(chain: NamedModel[]) {
    if (chain.length === 0) throw new Error("At least one model is required");

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
            err.name === 'AI_JSONParseError' ||
            err.name === 'AI_NoObjectGeneratedError' ||
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
        model: chain[0].model,
        middleware: {
            specificationVersion: 'v3',
            wrapGenerate: async ({ params, doGenerate }) => {
                let lastErr: any;
                for (let i = 0; i < chain.length; i++) {
                    try {
                        const result = await withRetry(
                            async () => i === 0 ? await doGenerate() : await chain[i].model.doGenerate(params),
                            chain[i].name
                        );

                        // Detect "silent failures": model returns OK but with empty content
                        const hasContent = result.content.some((part: any) =>
                            part.type === 'text' ||
                            part.type === 'tool-call' ||
                            part.type === 'reasoning'
                        );

                        if (!hasContent && result.finishReason.unified === 'other' && i < chain.length - 1) {
                            console.warn(`[AI] ⚠️ ${chain[i].name} returned empty (finishReason: other). Falling back to ${chain[i + 1].name}...`);
                            continue;
                        }
                        return result;
                    } catch (err: any) {
                        lastErr = err;
                        if (isRetryableError(err) && i < chain.length - 1) {
                            console.warn(`[AI] ⚠️ ${chain[i].name} exhausted retries. Falling back to ${chain[i + 1].name}...`);
                            continue;
                        }
                        throw err;
                    }
                }
                throw lastErr;
            },
            wrapStream: async ({ params, doStream }) => {
                let lastErr: any;
                for (let i = 0; i < chain.length; i++) {
                    try {
                        return await withRetry(
                            async () => i === 0 ? await doStream() : await chain[i].model.doStream(params),
                            chain[i].name
                        );
                    } catch (err: any) {
                        lastErr = err;
                        if (isRetryableError(err) && i < chain.length - 1) {
                            console.warn(`[AI] ⚠️ ${chain[i].name} exhausted retries. Falling back to ${chain[i + 1].name}...`);
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

// ── Exported resilient models ────────────────────────────────────────
// DeepSeek sits at the end of each chain as a cross-provider safety net
// when Gemini is overloaded (503/429).

export const gemini31Pro = wrapResilientModel([
    // deepseekChat,       // 🆕 Last-resort cross-provider fallback
    google31Pro,
    google3Flash,
    google31FlashLite,

]);
export const gemini3Flash = wrapResilientModel([
    // deepseekChat,       // 🆕 Last-resort cross-provider fallbacks
    google3Flash,
    google31FlashLite,

]);
