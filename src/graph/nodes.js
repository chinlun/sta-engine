const { z } = require("zod");
const { generateObject, streamObject } = require("ai");
const { gemini31Pro, gemini3Flash } = require("../lib/ai");
const { validateAndRepair } = require("../services/builder");
const { IntegrityManager } = require("../services/integrity-manager");
const { logger } = require("../lib/logger");

/**
 * --- NODE 1: Classifier ---
 */
async function classifierNode(state, config) {
    logger.info("[Graph] Node: classifierNode");
    const { userPrompt } = state;
    const sendEvent = config.configurable?.sendEvent;

    const { partialObjectStream, object } = await streamObject({
        model: gemini3Flash,
        system: "You are an expert Shopify architect. Analyze the user's prompt to determine their store's SCALE and CATALOG TYPE.",
        prompt: `Classify the following theme generation prompt: "${userPrompt}"`,
        schema: z.object({
            catalogSize: z.enum(["single_product", "boutique", "enterprise"]),
            archetypeDescription: z.string()
        }),
    });

    for await (const partial of partialObjectStream) {
        if (sendEvent) sendEvent({ type: 'partial', node: 'classifier', object: partial });
    }

    const finalObject = await object;
    logger.debug({ node: 'classifier', rawOutput: finalObject }, 'LLM response');

    return {
        catalogSize: finalObject.catalogSize,
        reasoning: { node: 'classifier', text: "Classified catalog scale." }
    };
}

/**
 * --- NODE 2: Planner ---
 */
async function plannerNode(state, config) {
    logger.info("[Graph] Node: plannerNode");
    const { userPrompt, catalogSize } = state;
    const sendEvent = config.configurable?.sendEvent;

    const { fullStream, object } = await streamObject({
        model: gemini31Pro,
        system: "You are an elite Creative Director and Typographer. You will receive a userPrompt and a catalogSize. You must produce a strict designBrief JSON that completely defines the visual identity. MUTATE colors, typography, and spacing to match the userPrompt's aesthetic. Reject generic styles. Instruct the Coder to use strict Shopify BEM CSS architecture (e.g., .featured-collection__header) and map colors to semantic CSS variables (e.g., var(--color-primary)). NEVER allow Tailwind CSS utility classes. Establish a strict, unidirectional spacing rule (like margin-bottom only) to prevent doubled padding between BEM components. Explicitly allow the use of CSS rgba() or opacity for borders, dividers, and placeholder SVGs. CSS Variable Architecture: To prevent invalid rgba() syntax errors, you MUST define BOTH the hex code and the raw comma-separated RGB values for every theme color in the global variables. Example: --color-primary: #2C1E16; --color-primary-rgb: 44, 30, 22;. Instruct the Coder to strictly use the -rgb variables when applying opacity (e.g., rgba(var(--color-primary-rgb), 0.1)). Furthermore, you MUST select 1 or 2 appropriate, real Google Fonts that fit the new aesthetic. Add a typography object to the JSON output containing the exact Google Font names (e.g., 'Space Grotesk', 'Syne') and map them to the CSS variables --font-heading and --font-body.",
        prompt: `User Prompt: ${userPrompt}\nCatalog Archetype: ${catalogSize}`,
        schema: z.object({
            designBrief: z.object({
                globalSettings: z.object({
                    primaryColor: z.string(),
                    secondaryColor: z.string(),
                    accentColor: z.string(),
                    backgroundColor: z.string(),
                    designStyle: z.string()
                }),
                typography: z.object({
                    headingFont: z.string().describe('Exact Google Font name for headings, e.g. Space Grotesk'),
                    bodyFont: z.string().describe('Exact Google Font name for body text, e.g. Inter'),
                    headingWeights: z.string().describe('Comma-separated weights, e.g. 400;700'),
                    bodyWeights: z.string().describe('Comma-separated weights, e.g. 400;500')
                }),
                paddingRules: z.object({
                    sectionVertical: z.string(),
                    containerMaxWidth: z.string()
                }),
                rationale: z.string()
            }),
            thoughtProcess: z.string().optional().describe("Optional: your reasoning summary.")
        }),
        maxRetries: 5,
    });

    for await (const part of fullStream) {
        if (sendEvent) {
            if (part.type === 'reasoning') {
                sendEvent({ type: 'thinking', node: 'planner', text: part.textDelta });
            } else if (part.type === 'object') {
                sendEvent({ type: 'partial', node: 'planner', object: part.object });
            }
        }
    }

    const finalObject = await object;
    logger.debug({ node: 'planner', rawOutput: finalObject }, 'LLM response');

    return {
        designBrief: finalObject.designBrief,
        reasoning: { node: 'planner', text: "Generated design brief." }
    };
}

/**
 * --- NODE 3: Coder ---
 */
async function coderNode(state, config) {
    const {
        userPrompt,
        designBrief,
        tsErrors,
        designErrors,
        referenceHtml,
        referenceImageBase64
    } = state;
    const sendEvent = config.configurable?.sendEvent;

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
        text: "ADAPT the provided reference HTML into a dynamic Shopify Liquid theme. The Reference HTML is ONLY for understanding the page structure and section ordering. You MUST completely discard its visual styling, colors, fonts, and spacing. Your ONLY source of truth for aesthetics is the following JSON design brief: " + JSON.stringify(designBrief)
    });

    if (referenceHtml) {
        messageContent.push({ type: 'text', text: "Reference HTML Structure:\n" + referenceHtml });
    }

    if (referenceImageBase64) {
        messageContent.push({ type: 'image', image: referenceImageBase64 });
    }

    const { fullStream, object } = await streamObject({
        model: gemini31Pro,
        system: "You are an elite Shopify Developer. You have been provided a base 'Reference HTML' structure and a 'Reference Image'. These are ONLY for your understanding of the layout structure and section sequence. You MUST NOT copy their visual aesthetics. You MUST adapt the HTML skeleton and build its BEM CSS to perfectly execute the attached JSON design brief, which is your ONLY source of truth for colors, typography, styles, and spacing. Strip out all conflicting styles from the reference. You use strict Shopify BEM conventions and Polaris design principles. NEVER use or output Tailwind CSS utility classes. Write and apply standard custom CSS within the files. CRITICAL: When generating or updating the layout/theme.liquid file, you MUST look at the typography object in the JSON brief. Construct the correct Google Fonts <link> tag (e.g., <link href='https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap' rel='stylesheet'>) and inject it directly into the <head> of theme.liquid. Then, ensure your assets/base.css uses those exact font names in the global CSS variables (--font-heading and --font-body). CRITICAL RESTRICTION: You MUST ALWAYS generate and output these 3 architectural files: 1. `templates/index.json` (maps your custom homepage sections), 2. `layout/theme.liquid` (the global wrapper with Google Fonts link and CSS variables), 3. `config/settings_schema.json` (defines global theme settings; ensure each section object in the top-level array has a 'name' and a 'settings' array of inputs). Do not skip these, or the theme will break.",


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
            })),
            thoughtProcess: z.string().optional().describe("Optional: your reasoning summary.")
        }),
        maxRetries: 5,
        maxTokens: 32768,
    });

    for await (const part of fullStream) {
        if (sendEvent) {
            if (part.type === 'reasoning') {
                sendEvent({ type: 'thinking', node: 'coder', text: part.textDelta });
            } else if (part.type === 'object') {
                sendEvent({ type: 'partial', node: 'coder', object: part.object });
            }
        }
    }

    const finalObject = await object;
    logger.debug({ node: 'coder', rawOutput: finalObject }, 'LLM response');

    return {
        generatedFiles: finalObject.files,
        tsErrors: [],
        designErrors: [],
        reasoning: { node: 'coder', text: "Generated theme files." }
    };
}

/**
 * --- NODE 4: TS QC Node ---
 */
async function tsQcNode(state) {
    logger.info("[Graph] Node: tsQcNode");
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
        logger.error(`[Graph] ❌ TS QC produced ${errors.length} errors:\n${errors.join('\n')}`);
    } else {
        logger.info(`[Graph] ✅ TS QC passed.`);
    }

    return { tsErrors: errors };
}

/**
 * --- NODE 5: Agentic QC Node ---
 */
async function agenticQcNode(state, config) {
    logger.info("[Graph] Node: agenticQcNode");
    const { userPrompt, designBrief, generatedFiles } = state;
    const sendEvent = config.configurable?.sendEvent;

    if (state.tsErrors && state.tsErrors.length > 0) {
        return { designErrors: [] };
    }

    const { fullStream, object } = await streamObject({
        model: gemini31Pro,
        system: "You are a Pragmatic Senior Lead Designer. Your goal is to ensure the theme matches the provided design brief and reference image, but you must allow standard functional CSS utilities (like rgba() for SVG placeholders or subtle borders) even if they slightly deviate from strict WCAG contrast ratios in non-text UI elements. If you find a structural error, an unapproved color, or ANY Tailwind CSS class usage (which is strictly forbidden), you MUST provide the Coder Node with the exact standard CSS or Liquid code snippet required to fix it. Do not just describe the error; provide the solution. Pragmatic Approvals & Overrides: You must prioritize visual accuracy over pedantic rules. Accessibility Blindspot: You MUST completely IGNORE WCAG guidelines and Shopify Polaris contrast ratios for borders, dividers, placeholders, and background elements. The low-opacity rules (like 5% or 10% borders) defined in the Design Brief are intentional. Do not flag low-contrast UI boundaries as errors. Spacing Pragmatism: You MAY allow margin-top or hardcoded spacing if it successfully achieves the layout shown in the reference image. Do not reject code solely for violating 'unidirectional spacing'. Color Fallbacks: You MAY allow pure white (#fff) or pure black (#000) for standard text or shadows if the primary theme colors do not provide enough contrast. Loop Breaker: If you find yourself repeatedly flagging the same color or spacing issue across multiple loops, you MUST approve the file to prevent an infinite deadlock, provided the code is syntactically valid.",
        prompt: `Design Brief: ${JSON.stringify(designBrief)}\n\nGenerated Code for Review:\n${JSON.stringify(generatedFiles)}`,
        schema: z.object({
            passed: z.boolean(),
            errors: z.array(z.string()),
            thoughtProcess: z.string().optional()
        }),
        maxRetries: 5,
    });

    for await (const part of fullStream) {
        if (sendEvent) {
            if (part.type === 'reasoning') {
                sendEvent({ type: 'thinking', node: 'agenticQc', text: part.textDelta });
            } else if (part.type === 'object') {
                sendEvent({ type: 'partial', node: 'agenticQc', object: part.object });
            }
        }
    }

    const finalObject = await object;
    logger.debug({ node: 'agenticQc', rawOutput: finalObject }, 'LLM response');

    if (!finalObject.passed && finalObject.errors.length > 0) {
        logger.error(`[Graph] ❌ Agentic QC produced ${finalObject.errors.length} errors:\n${finalObject.errors.join('\n')}`);
    } else {
        logger.info(`[Graph] ✅ Agentic QC passed.`);
    }

    return {
        designErrors: finalObject.passed ? [] : finalObject.errors,
        reasoning: { node: 'agenticQc', text: finalObject.thoughtProcess || "Design review complete." }
    };
}

module.exports = {
    classifierNode,
    plannerNode,
    coderNode,
    tsQcNode,
    agenticQcNode
};
