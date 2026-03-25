import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

export interface ErrorContext {
    message: string;
    filePath: string;
    line?: number;
    column?: number;
}

/**
 * Extracts 5 lines of code surrounding the reported error line.
 */
export function extractErrorContextSnippet(content: string, line: number): string {
    const lines = content.split('\n');
    const start = Math.max(0, line - 5);
    const end = Math.min(lines.length, line + 6);

    return lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join('\n');
}

/**
 * High-priority correction prompt for malformed tool calls.
 */
const MALFORMED_RECOVERY_PROMPT = `Your previous tool call was syntactically invalid (MALFORMED_FUNCTION_CALL). 
Output ONLY the corrected tool call using the valid schema. Do not include any other text or explanations.`;

/**
 * Expert Correction Loop for Shopify Theme generation.
 * Enforces max 3 retries and provides enriched context to the AI.
 */
export async function executeCorrectionLoop(
    error: ErrorContext,
    fileContent: string,
    attemptCount: number = 0
): Promise<{ fixedContent: string; success: boolean }> {
    if (attemptCount >= 3) {
        console.error(`[CorrectionLoop] ❌ Max retries (3) reached for ${error.filePath}`);
        return { fixedContent: fileContent, success: false };
    }

    console.log(`[CorrectionLoop] 🛠️ Attempting correction for ${error.filePath} (Attempt ${attemptCount + 1})...`);

    const snippet = error.line ? extractErrorContextSnippet(fileContent, error.line) : "Full file content: \n" + fileContent;

    const prompt = `You are a Shopify Theme Expert. A file you generated contains an error.
    
    FILE: ${error.filePath}
    ERROR: ${error.message}
    
    CONTEXT SNIPPET:
    ${snippet}
    
    TASK: Fix the error and return the FULL corrected content for the entire file.
    Output ONLY the corrected code. No explanations.`;

    try {
        const { text } = await generateText({
            model: google('gemini-2.0-flash'), // Using a fast, reliable model for corrections
            prompt,
        });

        const fixedContent = text.trim();

        // Return for validation in the next step of the pipeline
        return { fixedContent, success: true };
    } catch (err: any) {
        console.error(`[CorrectionLoop] ❌ Correction failed: ${err.message}`);
        return { fixedContent: fileContent, success: false };
    }
}

/**
 * Handles recovery from malformed AI tool calls.
 */
export async function recoverMalformedCall(): Promise<string> {
    console.log(`[CorrectionLoop] 🩹 Recovering from MALFORMED_FUNCTION_CALL...`);

    try {
        const { text } = await generateText({
            model: google('gemini-2.0-flash'),
            prompt: MALFORMED_RECOVERY_PROMPT,
        });

        return text.trim();
    } catch (err) {
        console.error(`[CorrectionLoop] ❌ Malformed recovery failed.`);
        throw err;
    }
}
