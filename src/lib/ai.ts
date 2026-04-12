import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { wrapLanguageModel } from 'ai';
import { LanguageModelV3 } from '@ai-sdk/provider';
import { Agent, setGlobalDispatcher } from 'undici';
import * as dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

// 10-minute maximum ceiling for complex planning/coding tasks
const AI_TIMEOUT_MS = 10 * 60 * 1000;
// 60-second 'Time to First Byte' (TTFB) grace period
const TTFB_TIMEOUT_MS = 60 * 1000;

// Vercel AI SDK streams occasionally leak internal background promises when fetch fails (e.g. 503 or TTFB).
// Since we strictly wrap all nodes in robust try/catch blocks, we can safely trap the leaked rejections here
// to prevent them from catastrophically crashing the STA-ENGINE Node process.
process.on('unhandledRejection', (reason: any) => {
    if (reason && (reason.name === 'AI_APICallError' || reason.name === 'AI_RetryError')) {
        logger.debug(`[AI] System intercepted leaked Vercel SDK promise rejection to prevent crash: ${reason.message}`);
        return;
    }
    logger.error(`[System] Unhandled Rejection:`, reason);
});

const globalAgent = new Agent({
    headersTimeout: TTFB_TIMEOUT_MS, // Hard abort if headers take > 60s
    bodyTimeout: AI_TIMEOUT_MS,      // Max time for full stream
    connectTimeout: 30 * 1000,
    keepAliveTimeout: 15 * 60 * 1000,
    keepAliveMaxTimeout: 20 * 60 * 1000,
    pipelining: 0,
});
setGlobalDispatcher(globalAgent);

/** Custom fetch with binary timeout strategy (TTFB + Max Duration) */
const timeoutFetch = (url: any, options: any) => {
    const controller = new AbortController();
    const globalTimeoutId = setTimeout(() => {
        logger.error(`[AI] ⏰ Total Request Timeout (10m) reached for ${url}`);
        controller.abort();
    }, AI_TIMEOUT_MS);

    const customOptions: any = {
        ...options,
        dispatcher: globalAgent,
        signal: controller.signal
    };

    return (globalThis.fetch as any)(url, customOptions).then((res: any) => {
        clearTimeout(globalTimeoutId);
        return res;
    }).catch((err: any) => {
        clearTimeout(globalTimeoutId);
        const isTimeout = err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.name === 'HPE_HEADER_TIMEOUT' || err.message?.includes('headers timeout') || err.cause?.code === 'UND_ERR_HEADERS_TIMEOUT';

        const errorDetail = {
            name: err.name,
            code: err.code || err.cause?.code,
            message: err.message,
            isTTFB: err.message?.includes('headers timeout') || err.name === 'HPE_HEADER_TIMEOUT' || err.cause?.code === 'UND_ERR_HEADERS_TIMEOUT'
        };

        if (errorDetail.isTTFB) {
            logger.warn(`[AI] ⏰ TTFB Timeout (60s) for ${url}. Failing over to next model...`);
        } else {
            logger.error(`[AI] ${isTimeout ? '⏰ Timeout' : '❌ Network Error'} for ${url} | Detail: ${JSON.stringify(errorDetail)}`);
        }
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
const deepseekV4Flash: NamedModel = { name: 'deepseek-v4-flash', model: customDeepSeek('deepseek-v4-flash') };
const deepseekV4Pro: NamedModel = { name: 'deepseek-v4-pro', model: customDeepSeek('deepseek-v4-pro') };

/**
 * High-Availability Wrapper (Multi-Provider)
 * Accepts pre-built model instances from ANY provider.
 * If the first fails with 503/429/timeout, it tries the next, and so on.
 */
/**
 * High-Availability Wrapper (Multi-Provider)
 * Accepts pre-built model instances from ANY provider.
 * If includeFallback is true, it tries the next model in the chain on failure.
 */
function wrapResilientModel(chain: NamedModel[], includeFallback = true, maxRetries = 2) {
    if (chain.length === 0) throw new Error("At least one model is required");

    const isRetryableError = (err: any) => {
        if (!err) return false;

        // Detailed logging for AI_APICallError to help diagnose recurring failures
        if (err.name === 'AI_APICallError' && err.statusCode === undefined) {
            logger.error(`[AI] 🚨 Network Failure / Fetch Failed detected. Retrying...`);
        }

        // Blanket Retry Strategy:
        // We retry on almost everything except obvious configuration errors.
        const msg = (err.message || "").toLowerCase();

        // Don't retry if the API key is clearly missing/invalid (unless it's a transient 401)
        if (msg.includes('api key') && msg.includes('not found')) return false;

        return true;
    };

    const withRetry = async (fn: () => Promise<any>, modelName: string) => {
        let lastError: any;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err: any) {
                lastError = err;
                if (isRetryableError(err) && attempt < maxRetries) {
                    const delay = Math.pow(2, attempt + 1) * 2000; // Increased base delay for high demand
                    logger.warn(`[AI] ⚠️ ${modelName} attempt ${attempt + 1} failed. Retrying in ${delay}ms...`);
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
                const limit = includeFallback ? chain.length : 1;
                for (let i = 0; i < limit; i++) {
                    try {
                        const result = await withRetry(
                            async () => i === 0 ? await doGenerate() : await chain[i].model.doGenerate(params),
                            chain[i].name
                        );

                        const hasContent = result.content.some((part: any) =>
                            part.type === 'text' ||
                            part.type === 'tool-call' ||
                            part.type === 'reasoning'
                        );

                        if (!hasContent && result.finishReason.unified === 'other' && includeFallback && i < chain.length - 1) {
                            logger.warn(`[AI] ⚠️ ${chain[i].name} returned empty. Falling back to ${chain[i + 1].name}...`);
                            continue;
                        }
                        return result;
                    } catch (err: any) {
                        lastErr = err;
                        if (isRetryableError(err) && includeFallback && i < chain.length - 1) {
                            logger.warn(`[AI] ⚠️ ${chain[i].name} exhausted retries. Falling back to ${chain[i + 1].name}...`);
                            continue;
                        }
                        throw err;
                    }
                }
                throw lastErr;
            },
            wrapStream: async ({ params, doStream }) => {
                let lastErr: any;
                const limit = includeFallback ? chain.length : 1;
                for (let i = 0; i < limit; i++) {
                    try {
                        return await withRetry(
                            async () => i === 0 ? await doStream() : await chain[i].model.doStream(params),
                            chain[i].name
                        );
                    } catch (err: any) {
                        lastErr = err;
                        if (isRetryableError(err) && includeFallback && i < chain.length - 1) {
                            logger.warn(`[AI] ⚠️ ${chain[i].name} exhausted retries. Falling back to ${chain[i + 1].name}...`);
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

/** 
 * Public models with FULL fallback chains (Used for Chat / Tools) 
 * These handle their own cross-model transitions seamlessly.
 */
// export const gemini31Pro = wrapResilientModel([google31Pro, google3Flash, google31FlashLite]);
// export const gemini3Flash = wrapResilientModel([google3Flash, google31FlashLite]);
export const gemini31Pro = wrapResilientModel([deepseekV4Pro]);
export const gemini3Flash = wrapResilientModel([deepseekChat]);


/**
 * Sticky-aware models with NO internal fallback (Used for Graph Nodes)
 * These allow the Graph to detect failure and set the global 'isFallback' flag.
 * We use maxRetries = 0 to ensure immediate switch to 'fast' models on failure.
 */
// export const google31ProSticky = wrapResilientModel([google3Flash], false, 6);
// export const google3FlashSticky = wrapResilientModel([google3Flash], false, 6);
export const google31ProSticky = wrapResilientModel([deepseekV4Pro], false, 6);
export const google3FlashSticky = wrapResilientModel([deepseekV4Flash], false, 6);