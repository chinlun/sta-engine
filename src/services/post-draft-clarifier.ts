import { generateObject } from 'ai';
import { z } from 'zod';
import { gemini3Flash } from '../lib/ai';
import { logger } from '../lib/logger';
import { MappedThemeSettings } from './schema-mapper';
import { ExtractedSignals } from './signal-extractor';

export interface ClarificationQuestion {
  field: string;
  question: string;
  suggested_options?: string[];
}

export interface ClarificationQuestions {
  questions: ClarificationQuestion[];
}

export const ClarificationQuestionsSchema = z.object({
  questions: z.array(
    z.object({
      field: z.string().describe("Setting field path e.g. color_schemes.primary or layout.container_width"),
      question: z.string().describe("Targeted, high-impact question to resolve low-confidence setting"),
      suggested_options: z.array(z.string()).optional()
    })
  ).min(2).max(3)
});

export async function generatePostDraftQuestions(
  signals: ExtractedSignals,
  mappedSchema: MappedThemeSettings
): Promise<ClarificationQuestions> {
  logger.info("[PostDraftClarifier] Generating 2-3 targeted clarification questions for low confidence fields...");

  const lowConfidenceList = mappedSchema.lowConfidenceFields || [];

  if (lowConfidenceList.length === 0) {
    logger.info("[PostDraftClarifier] No low-confidence fields identified. Providing standard high-impact options.");
    return {
      questions: [
        {
          field: 'color_schemes.primary',
          question: 'Would you prefer a darker, more dramatic primary accent color or a softer neutral palette?',
          suggested_options: ['Darker & Dramatic', 'Soft & Neutral']
        },
        {
          field: 'typography.heading_font',
          question: 'Would you like to keep the serif editorial typography or switch to a modern geometric sans-serif font?',
          suggested_options: ['Keep Editorial Serif', 'Switch to Sans-Serif']
        }
      ]
    };
  }

  try {
    const { object } = await generateObject({
      model: gemini3Flash,
      system: `You are an expert Shopify UX Consultant. The initial draft theme has been generated non-blockingly.
Review the low confidence fields in the mapping and construct EXACTLY 2 to 3 targeted, high-impact clarifying questions to refine the design choices.

Rules:
- Generate EXACTLY 2 or 3 questions.
- Focus strictly on the low confidence fields provided.
- Each question must be clear, concise, and offer 2-3 concrete suggested choices.`,
      prompt: `Signals:\n${JSON.stringify(signals, null, 2)}\n\nLow Confidence Fields:\n${JSON.stringify(lowConfidenceList)}`,
      schema: ClarificationQuestionsSchema as any,
      maxOutputTokens: 1024,
    });

    const typedObject = object as ClarificationQuestions;
    logger.info(`[PostDraftClarifier] Generated ${typedObject.questions.length} post-draft clarification questions.`);
    return typedObject;
  } catch (error: any) {
    logger.error(`[PostDraftClarifier] Error generating questions: ${error.message}`);
    return {
      questions: [
        {
          field: 'color_schemes.primary',
          question: 'How would you like to refine the brand primary color scheme?',
          suggested_options: ['Dark & Elegant', 'Vibrant & Bold', 'Minimal Monochromatic']
        },
        {
          field: 'layout.container_width',
          question: 'Which layout density fits your catalog best?',
          suggested_options: ['Full-bleed Spacious', 'Standard Compact Container']
        }
      ]
    };
  }
}
