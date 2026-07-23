import { generateObject } from 'ai';
import { z } from 'zod';
import { gemini3Flash } from '../lib/ai';
import { logger } from '../lib/logger';

export interface Signal {
  value: string;
  confidence: number;
  evidence: string;
}

export interface ExtractedSignals {
  brand_style: Signal;
  target_audience: Signal;
  industry_category: Signal;
  brand_tone: Signal;
  visual_density: Signal;
  extracted_facts: string[];
}

export const SignalSchema = z.object({
  value: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().describe("Direct phrase citation or logical implication from the brief.")
});

export const ExtractedSignalsSchema = z.object({
  brand_style: SignalSchema,
  target_audience: SignalSchema,
  industry_category: SignalSchema,
  brand_tone: SignalSchema,
  visual_density: SignalSchema,
  extracted_facts: z.array(z.string())
});

export async function extractBriefSignals(userPrompt: string): Promise<ExtractedSignals> {
  logger.info("[SignalExtractor] Stage A: Extracting signals from design brief...");

  try {
    const { object } = await generateObject({
      model: gemini3Flash,
      system: `You are an expert E-Commerce Brand Analyst. Normalize the user's design brief into 5 normalized signals:
1. brand_style
2. target_audience
3. industry_category
4. brand_tone
5. visual_density

For EACH signal:
- Assign a confidence score between 0.0 and 1.0:
  * 0.8 - 1.0: Explicitly stated or strongly implied by explicit brand keywords.
  * 0.4 - 0.79: Moderately implied by category/vibe.
  * 0.0 - 0.39: Vague or completely unspecified in brief.
- Provide a brief evidence string (exact phrase or strong implication).

Also extract any explicit business facts (shipping policy, founder names, guarantees, address, phone) to protect them from hallucination.`,
      prompt: `Design Brief:\n"${userPrompt}"`,
      schema: ExtractedSignalsSchema as any,
      maxOutputTokens: 2048,
    });

    const typedObject = object as ExtractedSignals;
    logger.info(`[SignalExtractor] Stage A Complete. Brand Style: ${typedObject.brand_style.value} (${typedObject.brand_style.confidence})`);
    return typedObject;
  } catch (error: any) {
    logger.error(`[SignalExtractor] Error extracting signals: ${error.message}. Falling back to default signals.`);
    return {
      brand_style: { value: 'modern_minimal', confidence: 0.5, evidence: 'Default fallback' },
      target_audience: { value: 'general_consumers', confidence: 0.5, evidence: 'Default fallback' },
      industry_category: { value: 'general_retail', confidence: 0.5, evidence: 'Default fallback' },
      brand_tone: { value: 'sophisticated', confidence: 0.5, evidence: 'Default fallback' },
      visual_density: { value: 'spacious', confidence: 0.5, evidence: 'Default fallback' },
      extracted_facts: []
    };
  }
}
