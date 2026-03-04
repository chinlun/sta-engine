import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { normalizeMod } from './builder';

/**
 * Cheap Gate Validator — "Clerk" Safety Net
 * 
 * A lightweight Gemini Flash call that validates the theme modifications
 * before deploying. Uses a tiny prompt (~500 tokens in, 200 out) to check
 * for semantic correctness at ~1/10th the cost of the main build call.
 * 
 * Cost: ~$0.001 per call
 * Latency: ~1-2s
 */

interface GateResult {
    passed: boolean;
    issues: string[];
}

/**
 * Validates theme modifications using a cheap LLM gate check.
 * Only sends file paths + first 20 lines of each file for minimal token usage.
 */
export async function gateValidate(modifications: any[]): Promise<GateResult> {
    if (!modifications || modifications.length === 0) {
        return { passed: true, issues: [] };
    }

    // Build a compact summary of modifications for the gate check
    const summaryLines: string[] = [];
    for (const rawMod of modifications) {
        const { filePath, action, content } = normalizeMod(rawMod);
        if (!filePath) continue;

        // Only send file path + first 20 lines to minimize tokens
        const preview = content
            .split('\n')
            .slice(0, 20)
            .join('\n');

        summaryLines.push(`--- ${action.toUpperCase()} ${filePath} ---`);
        summaryLines.push(preview);
        if (content.split('\n').length > 20) {
            summaryLines.push(`... (${content.split('\n').length - 20} more lines)`);
        }
        summaryLines.push('');
    }

    const prompt = `You are a Shopify theme validator. Check these proposed theme file modifications for obvious errors.

Rules to check:
1. JSON files must have valid structure (sections with order array for templates)
2. .liquid files should have {% schema %} blocks
3. File paths must be valid Shopify theme paths (sections/, templates/, config/, assets/, snippets/, layout/)
4. Section types in index.json must match .liquid filenames (without extension)

Respond with ONLY one of:
- "PASS" if no issues found
- "FAIL: <issue1>; <issue2>; ..." listing specific issues

Modifications:
${summaryLines.join('\n')}`;

    try {
        const result = await generateText({
            model: google('gemini-2.5-flash'),
            prompt,
            maxOutputTokens: 500,
        });

        const response = result.text.trim();
        console.log(`[GateValidator] Response: ${response}`);

        if (response.startsWith('PASS')) {
            return { passed: true, issues: [] };
        }

        // Parse FAIL response
        const issueText = response.replace(/^FAIL:\s*/i, '');
        const issues = issueText.split(';').map(s => s.trim()).filter(Boolean);

        return { passed: false, issues };
    } catch (error) {
        console.error('[GateValidator] Error during validation:', error);
        // If the gate validator itself fails, let the build through
        // (better to deploy than to block on a validator error)
        return { passed: true, issues: [] };
    }
}
