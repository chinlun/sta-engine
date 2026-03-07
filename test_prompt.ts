import { config } from 'dotenv';
config();
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { buildSystemPrompt, extractFileFromBaseTheme } from './src/services/prompt-builder';
import { ThemePlanSchema } from './src/schema';

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
    });
    
    console.log("Thought process lengths:", result.text.length);
    console.log("Result text:", result.text.slice(0, 500));
}
run();
