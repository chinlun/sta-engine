import { streamText } from 'ai';
import { gemini31Pro } from './ai';
import { logger } from './logger';

export interface ErrorContext {
    message: string;
    filePath: string;
    line?: number;
    column?: number;
}

/**
 * Strips markdown code fences from LLM output.
 * AI models often wrap code in ```liquid or ```json blocks.
 */
function stripCodeFences(text: string): string {
    const fenceRegex = /```[a-z]*\n?([\s\S]*?)\n?```/;
    const match = text.match(fenceRegex);
    return match ? match[1] : text.trim();
}

/**
 * Expert Correction Loop for Shopify Theme files.
 * Sends the error + file content to Gemini Flash and returns the corrected file.
 * The caller is responsible for retry logic and re-sync.
 */
export async function executeCorrectionLoop(
    error: ErrorContext,
    fileContent: string,
    availableFiles: string[] = [],
    onThinking?: (text: string) => void
): Promise<{ fixedContent: string; success: boolean }> {

    logger.info(`[CorrectionLoop] 🛠️ LLM correction for "${error.filePath}": ${error.message}`);

    const isJson = error.filePath.endsWith('.json');
    const isLiquid = error.filePath.endsWith('.liquid');

    const sectionsList = availableFiles
        .filter(f => f.startsWith('sections/') && f.endsWith('.liquid'))
        .map(f => f.replace('sections/', '').replace('.liquid', ''))
        .join(', ');

    const prompt = `You are a Shopify Theme Expert. A theme file was rejected by Shopify CLI with the following error.

FILE: ${error.filePath}
ERROR: ${error.message}

FULL FILE CONTENT:
${fileContent}

${sectionsList ? `AVAILABLE SECTIONS: ${sectionsList}\n` : ''}

RULES:
${isLiquid ? `- This is a Liquid template file. It MUST contain valid Liquid syntax.
- Ensure all string parameters in Liquid filters (e.g. split: ',', split: '"') have properly balanced single or double quotes.
- Section files MUST retain their {% schema %} and {% endschema %} blocks with valid JSON inside.
- Schema "name" must be ≤25 characters.
- Do NOT use "product_picker" type. Use "product" instead.
- Schema must NOT have both "default" and "presets".
- Schema settings of type "url", "image_picker", "product", "collection" etc. must have a string default (like "") or no default at all. NEVER use booleans (true/false) as defaults for these types.
- Do NOT use invalid Liquid filters or pipes in {% if %} tags.` : ''}
${isJson ? `- This is a JSON config file. It MUST be valid JSON.
- For settings_schema.json: theme_info must have EITHER "theme_support_email" OR "theme_support_url", NOT both.
- For templates/*.json: All section types referenced must correspond to actual section files.
- "order" array must list all section keys.` : ''}

FIX the error and output ONLY the corrected file content. No explanations, no markdown fences, no commentary.`;

    try {
        const { fullStream, text } = await streamText({
            model: gemini31Pro, // Upgrade to Pro for better corrections
            prompt,
        });

        for await (const part of fullStream) {
            const delta = (part as any).textDelta || (part as any).reasoning || (part as any).thought || (part as any).text || "";
            if (delta && onThinking) {
                onThinking(delta);
            }
        }

        const fixedContent = stripCodeFences((await text).trim());

        // Basic sanity check: content should not be empty
        if (!fixedContent || fixedContent.length < 10) {
            logger.warn(`[CorrectionLoop] ⚠️ LLM returned empty/tiny content. Keeping original.`);
            return { fixedContent: fileContent, success: false };
        }

        // For JSON files, validate that the output is valid JSON
        if (isJson) {
            try {
                JSON.parse(fixedContent);
            } catch (e) {
                logger.warn(`[CorrectionLoop] ⚠️ LLM returned invalid JSON. Keeping original.`);
                return { fixedContent: fileContent, success: false };
            }
        }

        // For Liquid files, ensure schema block exists
        if (isLiquid && error.filePath.startsWith('sections/')) {
            if (!fixedContent.includes('{% schema %}') || !fixedContent.includes('{% endschema %}')) {
                logger.warn(`[CorrectionLoop] ⚠️ LLM output missing schema block. Keeping original.`);
                return { fixedContent: fileContent, success: false };
            }
        }

        logger.info(`[CorrectionLoop] ✅ LLM correction successful for "${error.filePath}" (${fixedContent.length} bytes)`);
        return { fixedContent, success: true };
    } catch (err: any) {
        logger.error(`[CorrectionLoop] ❌ LLM correction failed: ${err.message}`);
        return { fixedContent: fileContent, success: false };
    }
}
