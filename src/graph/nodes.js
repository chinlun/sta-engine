const { generateObject } = require("ai");
const { gemini31Pro, gemini3Flash } = require("../lib/ai");
const { z } = require("zod");
const { validateAndRepair } = require("../services/builder");
const { IntegrityManager } = require("../services/integrity-manager");

/**
 * --- NODE 1: Classifier ---
 */
async function classifierNode(state) {
    console.log("[Graph] Node: classifierNode");
    const { userPrompt } = state;
    const { object } = await generateObject({
        model: gemini3Flash,
        system: "You are an expert Shopify architect. Analyze the user's prompt to determine their store's SCALE and CATALOG TYPE.",
        prompt: `Classify the following theme generation prompt: "${userPrompt}"`,
        schema: z.object({
            catalogSize: z.enum(["single_product", "boutique", "enterprise"]),
            archetypeDescription: z.string()
        }),
    });
    return { catalogSize: object.catalogSize };
}

/**
 * --- NODE 2: Planner ---
 */
async function plannerNode(state) {
    console.log("[Graph] Node: plannerNode");
    const { userPrompt, catalogSize } = state;
    const { object } = await generateObject({
        model: gemini31Pro,
        system: "You are an elite Art Director and UX Expert. Translate the user prompt into a strict designBrief JSON. Define an exact typography hierarchy, a 5-color hex palette, and padding rules adhering to Shopify Polaris. Reject generic styles. Instruct the Coder to use strict Shopify BEM CSS architecture (e.g., .featured-collection__header) and map colors to semantic CSS variables (e.g., var(--color-primary)). NEVER allow Tailwind CSS utility classes. Establish a strict, unidirectional spacing rule (like margin-bottom only) to prevent doubled padding between BEM components. Explicitly allow the use of CSS rgba() or opacity for borders, dividers, and placeholder SVGs. CSS Variable Architecture: To prevent invalid rgba() syntax errors, you MUST define BOTH the hex code and the raw comma-separated RGB values for every theme color in the global variables. Example: --color-primary: #2C1E16; --color-primary-rgb: 44, 30, 22;. Instruct the Coder to strictly use the -rgb variables when applying opacity (e.g., rgba(var(--color-primary-rgb), 0.1)).",
        prompt: `User Prompt: ${userPrompt}\nCatalog Archetype: ${catalogSize}`,
        schema: z.object({
            designBrief: z.object({
                globalSettings: z.object({
                    primaryColor: z.string(),
                    secondaryColor: z.string(),
                    accentColor: z.string(),
                    backgroundColor: z.string(),
                    fontFamily: z.string(),
                    headingFont: z.string(),
                    designStyle: z.string()
                }),
                paddingRules: z.object({
                    sectionVertical: z.string(),
                    containerMaxWidth: z.string()
                }),
                rationale: z.string()
            })
        }),
    });
    return { designBrief: object.designBrief };
}

/**
 * --- NODE 3: Coder ---
 */
async function coderNode(state) {
    const {
        userPrompt,
        designBrief,
        tsErrors,
        designErrors,
        referenceHtml,
        referenceImageBase64
    } = state;

    console.log(`[Graph] Node: coderNode (Context: HTML=${!!referenceHtml}, Image=${!!referenceImageBase64})`);

    const errors = [...(tsErrors || []), ...(designErrors || [])];
    const messageContent = [];

    // 1. Errors first (Highest Priority for Correction)
    if (errors.length > 0) {
        console.log(`[Graph] 🚨 Coder Node is processing ${errors.length} validation errors.`);
        messageContent.push({
            type: 'text',
            text: `### CRITICAL: FIX THESE ERRORS FROM PREVIOUS ATTEMPT:\n${errors.join("\n")}\n\nYou MUST fix these errors in the code while strictly adhering to the design requirements below.`
        });
    }

    // 2. Core Instructions & JSON Blueprint
    messageContent.push({
        type: 'text',
        text: "Convert the provided reference HTML into a dynamic Shopify Liquid theme. You MUST strictly adhere to the structural constraints and Tailwind class boundaries defined in this JSON Blueprint: " + JSON.stringify(designBrief)
    });

    if (referenceHtml) {
        messageContent.push({ type: 'text', text: "Reference HTML Structure:\n" + referenceHtml });
    }

    if (referenceImageBase64) {
        messageContent.push({ type: 'image', image: referenceImageBase64 });
    }

    const { object } = await generateObject({
        model: gemini31Pro,
        system: "You are a master Shopify Liquid developer. Your code is clean, valid, and adheres to the provided design brief. You use strict Shopify BEM conventions and Polaris design principles. NEVER use or output Tailwind CSS utility classes. Write and apply standard custom CSS within the files. CRITICAL RESTRICTION: You MUST ALWAYS generate and output these 3 architectural files: 1. `templates/index.json` (maps your custom homepage sections), 2. `layout/theme.liquid` (the global wrapper defining CSS variables via schema settings), 3. `config/settings_schema.json` (defines global theme settings). Do not skip these, or the theme will break.",

        messages: [
            {
                role: 'user',
                content: messageContent
            }
        ],
        schema: z.object({
            files: z.array(z.object({
                path: z.string(),
                content: z.string()
            }))
        }),
    });

    return {
        generatedFiles: object.files,
        tsErrors: [],
        designErrors: []
    };
}

/**
 * --- NODE 4: TS QC Node ---
 */
async function tsQcNode(state) {
    console.log("[Graph] Node: tsQcNode");
    const { generatedFiles } = state;
    const errors = [];

    const mods = (generatedFiles || []).map(f => ({
        filePath: f.path,
        action: 'update',
        content: f.content
    }));

    const planData = { modifications: mods };

    try {
        const repairResult = validateAndRepair(planData);
        if (repairResult.errors.length > 0) {
            errors.push(...repairResult.errors.map(err => `[Syntax Error] ${err}`));
        }
        IntegrityManager.validate(mods);
    } catch (e) {
        errors.push(`[Integrity Error] ${e.message || String(e)}`);
    }

    if (errors.length > 0) {
        console.log(`[Graph] ❌ TS QC produced ${errors.length} errors:\n${errors.join('\n')}`);
    } else {
        console.log(`[Graph] ✅ TS QC passed.`);
    }

    return { tsErrors: errors };
}

/**
 * --- NODE 5: Agentic QC Node ---
 */
async function agenticQcNode(state) {
    console.log("[Graph] Node: agenticQcNode");
    const { generatedFiles, designBrief } = state;

    if (state.tsErrors && state.tsErrors.length > 0) {
        return { designErrors: [] };
    }

    const { object } = await generateObject({
        model: gemini31Pro,
        system: "You are a Pragmatic Senior Lead Designer. Your goal is to ensure the theme matches the provided design brief and reference image, but you must allow standard functional CSS utilities (like rgba() for SVG placeholders or subtle borders) even if they slightly deviate from strict WCAG contrast ratios in non-text UI elements. If you find a structural error, an unapproved color, or ANY Tailwind CSS class usage (which is strictly forbidden), you MUST provide the Coder Node with the exact standard CSS or Liquid code snippet required to fix it. Do not just describe the error; provide the solution. Pragmatic Approvals & Overrides: You must prioritize visual accuracy over pedantic rules. Accessibility Blindspot: You MUST completely IGNORE WCAG guidelines and Shopify Polaris contrast ratios for borders, dividers, placeholders, and background elements. The low-opacity rules (like 5% or 10% borders) defined in the Design Brief are intentional. Do not flag low-contrast UI boundaries as errors. Spacing Pragmatism: You MAY allow margin-top or hardcoded spacing if it successfully achieves the layout shown in the reference image. Do not reject code solely for violating 'unidirectional spacing'. Color Fallbacks: You MAY allow pure white (#fff) or pure black (#000) for standard text or shadows if the primary theme colors do not provide enough contrast. Loop Breaker: If you find yourself repeatedly flagging the same color or spacing issue across multiple loops, you MUST approve the file to prevent an infinite deadlock, provided the code is syntactically valid.",
        prompt: `Design Brief: ${JSON.stringify(designBrief)}\n\nGenerated Code for Review:\n${JSON.stringify(generatedFiles)}`,
        schema: z.object({
            passed: z.boolean(),
            errors: z.array(z.string())
        }),
    });

    if (!object.passed && object.errors.length > 0) {
        console.log(`[Graph] ❌ Agentic QC produced ${object.errors.length} errors:\n${object.errors.join('\n')}`);
    } else {
        console.log(`[Graph] ✅ Agentic QC passed.`);
    }

    return { designErrors: object.passed ? [] : object.errors };
}

module.exports = {
    classifierNode,
    plannerNode,
    coderNode,
    tsQcNode,
    agenticQcNode
};
