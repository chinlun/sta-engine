import { z } from 'zod';

// Full schema per SPEC §3 (used for type definitions and documentation)
export const ThemePlanSchema = z.object({
    thoughtProcess: z.string().describe("Real-time stream of the AI's logical reasoning and progress."),
    globalSettings: z.object({
        primaryColor: z.string().optional().describe("Primary brand color as hex (e.g., '#C9A96E'). Used to update color_schemes in settings_data.json."),
        fontFamily: z.string().optional().describe("Shopify font handle (e.g., 'playfair_display_n4', 'montserrat_n4'). Format: <family>_<style> where style is n4, n7, i4, etc."),
    }).describe("Tracking global brand state to prevent amnesia."),
    modifications: z.array(
        z.object({
            filePath: z.string().optional().describe(
                "Full relative file path in the theme. Must start with a folder name, never with '/'. " +
                "Examples: 'templates/index.json', 'sections/hero-banner.liquid', 'config/settings_data.json', 'assets/custom.css'. " +
                "Section filenames use hyphens: 'image-banner.liquid', NOT 'image_banner.liquid'."
            ),
            action: z.string().optional().describe(
                "Action to perform: 'create' (new file), 'update' (replace existing file content), or 'delete' (remove file). " +
                "Default: 'update'. Use 'create' for new sections, 'update' for modifying index.json or settings_data.json."
            ),
            content: z.string().optional().describe(
                "The COMPLETE file content — not a diff or partial snippet. " +
                "For .liquid files: must include {% schema %} block with 'presets' array at the bottom. " +
                "For .json files (index.json, settings_data.json): must be valid JSON. " +
                "For templates/index.json: must include BOTH the 'sections' object AND the 'order' array."
            ),
            // Catch-all for hallucinated keys so Zod passes them through to our normalizer
            file: z.string().optional(),
            file_path: z.string().optional(),
            type: z.string().optional(),
            code: z.string().optional(),
        })
    ),
});

// Tool-specific schema: omits thoughtProcess (streamed as text-delta, not a tool param).
// This schema is used directly with the Vercel AI SDK `tool()` — NO `as any` cast needed.
export const BuildThemeToolSchema = ThemePlanSchema.omit({ thoughtProcess: true });

export type ThemePlan = z.infer<typeof ThemePlanSchema>;
export type BuildThemeToolParams = z.infer<typeof BuildThemeToolSchema>;
