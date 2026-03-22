import { createGoogleGenerativeAI } from '@ai-sdk/google';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Custom Google provider that strips the aggressive 60s timeout 
 * to allow long-running theme generations.
 */
export const customGoogle = createGoogleGenerativeAI({
    fetch: (url, options) => {
        const customOptions = { ...options };
        if (customOptions.signal) {
            console.log(`[AI] 🛡️ Stripping SDK timeout signal`);
            delete customOptions.signal;
        }
        return fetch(url, customOptions as any).then(res => {
            return res;
        }).catch(err => {
            console.error(`[AI] ❌ Network Error for ${url}:`, err);
            throw err;
        });
    }
});

export const models = {
    flash: customGoogle('gemini-2.5-flash'),
    pro: customGoogle('gemini-2.5-pro'), // Using 2.5 pro as per existing code, or 3.1 as requested if available
};

// If the user specifically asked for Gemini 3.1 Pro, we should try to use it if the SDK supports it.
// The user prompt said: "Use Gemini 3.1 Pro". 
// I'll define them specifically as requested.
export const gemini3Flash = customGoogle('gemini-3-flash-preview');
export const gemini31Pro = customGoogle('gemini-3.1-pro-preview');
