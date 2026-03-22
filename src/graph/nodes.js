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
        system: "You are an elite Art Director and UX Expert. Translate the user prompt into a strict designBrief JSON. Define an exact typography hierarchy, a 5-color hex palette, and padding rules adhering to Shopify Polaris. Reject generic styles.",
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
    console.log("[Graph] Node: coderNode");
    const { userPrompt, designBrief, tsErrors, designErrors } = state;

    const errors = [...(tsErrors || []), ...(designErrors || [])];
    const errorContext = errors.length > 0
        ? `\n\n### CRITICAL: FIX THESE ERRORS FROM PREVIOUS ATTEMPT:\n${errors.join("\n")}`
        : "";

    const { object } = await generateObject({
        model: gemini31Pro,
        system: "You are a master Shopify Liquid developer.",
        prompt: `Theme Request: ${userPrompt}\n\nDesign Brief: ${JSON.stringify(designBrief)}${errorContext}`,
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
        system: "You are a strict Lead Designer. Review the generated Liquid/CSS against the designBrief. Reject the code and output errors if: (1) It violates Polaris contrast ratios, (2) Paddings clash, (3) It fails to use the brief's exact hex codes, or (4) The layout looks like unstructured 'AI slop'.",
        prompt: `Design Brief: ${JSON.stringify(designBrief)}\n\nGenerated Code for Review:\n${JSON.stringify(generatedFiles)}`,
        schema: z.object({
            passed: z.boolean(),
            errors: z.array(z.string())
        }),
    });

    return { designErrors: object.passed ? [] : object.errors };
}

module.exports = {
    classifierNode,
    plannerNode,
    coderNode,
    tsQcNode,
    agenticQcNode
};
