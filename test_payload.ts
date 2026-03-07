import { config } from 'dotenv';
config();
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { buildSystemPrompt, extractFileFromBaseTheme } from './src/services/prompt-builder';
import { BuildThemeToolSchema } from './src/schema';

const google = createGoogleGenerativeAI();

async function run() {
    const currentIndexJson = extractFileFromBaseTheme('templates/index.json');
    const currentSettingsData = extractFileFromBaseTheme('config/settings_data.json');
    const systemPrompt = buildSystemPrompt(currentIndexJson, currentSettingsData);

    console.log("Generating...");

    const result = await generateText({
        model: google('gemini-2.5-flash'),
        system: systemPrompt,
        messages: [{ role: 'user', content: "Create a luxury fashion store with a dark theme, warm gold accents, and elegant italic typography. Include a premium hero banner." }],
        tools: {
            build_theme: {
                description: "Builds a Shopify theme based on the plan. Call this AFTER explaining your thinking as text.",
                parameters: BuildThemeToolSchema,
                execute: async (args: any) => args
            }
        }
    });

    console.log("Thought Process:\n" + result.text);
    console.log("Tool Calls:");
    result.toolCalls.forEach(call => {
        if (call.toolName === 'build_theme') {
            const args = call.args as any;
            console.log("- Global settings:", args.globalSettings);
            console.log("\nModifications:");
            args.modifications?.forEach((mod: any) => {
                console.log(`  -> ${mod.filePath} (${mod.action}) - ${mod.content.length} chars`);
                if (mod.filePath.includes('settings_data.json')) {
                    const sample = mod.content.substring(0, 500);
                    console.log(`     Data sample: \n${sample}`);
                    // Check if it's changing the background
                    if (mod.content.includes('#0A0A0A') || mod.content.includes('#000000') || mod.content.includes('scheme-1')) {
                        console.log(`     Contains dark color!`);
                    }
                }
            });
        }
    });
}
run().catch(console.error);
