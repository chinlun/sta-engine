import { z } from 'zod';

// Full schema per SPEC §3 (used for type definitions and documentation)
export const ThemePlanSchema = z.object({
    thoughtProcess: z.string().describe("Real-time stream of the AI's logical reasoning and progress."),
    globalSettings: z.object({
        primaryColor: z.string().optional().describe("Primary brand color as hex (e.g., '#C9A96E'). Used to update color_schemes in settings_data.json."),
        secondaryColor: z.string().optional().describe("Secondary supporting color as hex."),
        accentColor: z.string().optional().describe("Accent/CTA color as hex."),
        backgroundColor: z.string().optional().describe("Base background color as hex."),
        fontFamily: z.string().optional().describe("Shopify body font handle (e.g., 'playfair_display_n4', 'montserrat_n4'). Format: <family>_<style> where style is n4, n7, i4, etc."),
        headingFont: z.string().optional().describe("Shopify heading font handle."),
        designStyle: z.string().optional().describe("The design intent or vibe (e.g., 'luxury minimalist with warm metallics').")
    }).describe("Tracking global brand state and design intent to prevent amnesia."),
    modifications: z.array(
        z.object({
            filePath: z.string().describe(
                "Full relative file path in the theme. Must start with a folder name, never with '/'. " +
                "Examples: 'templates/index.json', 'sections/hero-banner.liquid', 'assets/custom.css'. " +
                "Section filenames use hyphens: 'image-banner.liquid', NOT 'image_banner.liquid'. " +
                "CRITICAL: DO NOT modify 'config/settings_data.json' here. Use globalSettings instead."
            ),
            action: z.string().describe(
                "Action to perform: 'create' (new file), 'update' (replace existing file content), or 'delete' (remove file). " +
                "Default: 'update'. Use 'create' for new sections, 'update' for modifying index.json."
            ),
            contentSource: z.array(z.string()).describe(
                "The COMPLETE file content provided as an array of strings (one string per line). " +
                "DO NOT use a single massive string — break it into lines to prevent JSON escaping errors. " +
                "For .liquid files: must include {% schema %} block with 'presets' array at the bottom. " +
                "For .json files (index.json): must represent valid JSON when joined. " +
                "If action is 'delete', provide an empty array []."
            )
        })
    ).describe("List of file modifications to execute. Must be valid JSON."),
});

// Tool-specific schema: omits thoughtProcess (streamed as text-delta, not a tool param).
// This schema is used directly with the Vercel AI SDK `tool()` — NO `as any` cast needed.
export const BuildThemeToolSchema = ThemePlanSchema.omit({ thoughtProcess: true });

export type ThemePlan = z.infer<typeof ThemePlanSchema>;
export type BuildThemeToolParams = z.infer<typeof BuildThemeToolSchema>;
