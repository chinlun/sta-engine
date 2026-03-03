import { z } from 'zod';

export const ThemePlanSchema = z.object({
    thoughtProcess: z.string().describe("The reasoning behind the theme changes."),
    globalSettings: z.object({
        primaryColor: z.string().optional().describe("Primary color hex code"),
        fontFamily: z.string().optional().describe("Font family string"),
    }).describe("Global theme settings to persist."),
    modifications: z.array(z.object({
        filePath: z.string().describe("Path to the file to modify or create"),
        action: z.enum(['update', 'create']).describe("Action to perform on the file"),
        content: z.string().describe("The content of the file"),
    })).describe("List of file modifications to apply."),
});

export type ThemePlan = z.infer<typeof ThemePlanSchema>;
