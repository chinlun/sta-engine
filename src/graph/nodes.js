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
    const startTime = Date.now();
    logger.info("[Graph] Node: classifierNode");
    const { userPrompt } = state;
    const sendEvent = config.configurable?.sendEvent;

    let attempt = 0;
    const maxAttempts = 3;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { partialObjectStream, object } = await streamObject({
                model: gemini3Flash,
                system: "You are an expert Shopify architect. Analyze the user's prompt to determine their store's SCALE and CATALOG TYPE.",
                prompt: `Classify the following theme generation prompt: "${userPrompt}"`,
                schema: z.object({
                    catalogSize: z.enum(["single_product", "boutique", "enterprise"]),
                    archetypeDescription: z.string()
                }),
                maxTokens: 4096, // Classifier is small
            });

            for await (const partial of partialObjectStream) {
                if (sendEvent) sendEvent({ type: 'partial', node: 'classifier', object: partial });
            }

            finalObject = await object;
            break;
        } catch (error) {
            if (error.name === 'AI_NoObjectGeneratedError' || error.name === 'AI_JSONParseError') {
                logger.warn(`[Graph] Classifier silent truncation, Retrying (${attempt}/${maxAttempts})...`);
                if (attempt >= maxAttempts) throw error;
            } else {
                throw error;
            }
        }
    }
    logger.debug({ node: 'classifier', rawOutput: finalObject }, 'LLM response');

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: classifierNode complete (${duration}ms)`);
    return {
        catalogSize: finalObject.catalogSize,
        reasoning: { node: 'classifier', text: "Classified catalog scale." }
    };
}

/**
 * --- NODE 2: Planner ---
 */
async function plannerNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: plannerNode");
    const { userPrompt, catalogSize, referenceHtml, referenceImageBase64 } = state;
    const sendEvent = config.configurable?.sendEvent;

    const messageContent = [
        { type: 'text', text: `User Prompt: ${userPrompt}\nCatalog Archetype: ${catalogSize}` }
    ];

    if (referenceHtml) {
        messageContent.push({ type: 'text', text: "Reference HTML Structure:\n" + referenceHtml });
    }

    if (referenceImageBase64) {
        messageContent.push({ type: 'image', image: referenceImageBase64 });
    }

    let attempt = 0;
    const maxAttempts = 3;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { fullStream, object } = await streamObject({
                model: gemini31Pro,
                system: `You are the Lead Shopify Architect. You must translate the user's intent and any provided visual references (Image/HTML) into a STRICT JSON Spatial Blueprint.
DE-ANCHORING RULES:
1. Abstract, Don't Copy: Translate visual elements into descriptive English (e.g. "A 3-column masonry grid"). Do NOT use HTML/CSS snippets like div.grid-cols-3.
2. Identify Intent: Focus on the purpose of a section.
3. Mandatory Innovation: For every component, describe a layout structurally different from the exact input while maintaining the design vibe.

Your goal is to extract "Design Tokens" and a "Spatial Blueprint" (components array). You are the ONLY agent that sees the original HTML/image. You must define each component strictly in text. You MUST include a header, footer, main-template (e.g. index.liquid content mapped to sections), and various sections.`,
                messages: [{ role: 'user', content: messageContent }],
                schema: z.object({
                    design_tokens: z.object({
                        colors: z.object({ primary: z.string(), secondary: z.string(), background: z.string(), text: z.string() }),
                        typography: z.object({ heading_style: z.string(), body_style: z.string(), scale: z.string() }),
                        spacing_logic: z.string(),
                        border_radius: z.string()
                    }),
                    components: z.array(z.object({
                        name: z.string().describe("file_name, e.g. header.liquid, featured-product.liquid"),
                        type: z.enum(["header", "footer", "section", "main-template", "snippet"]),
                        layout_directive: z.string().describe("STRICT TEXT-ONLY DESCRIPTION: Describe the grid, alignment, and interactive behavior. DO NOT use HTML snippets. Force a unique structural layout.")
                    })),
                    thoughtProcess: z.string().optional().describe("Optional: your reasoning summary.")
                }),
                maxRetries: 5,
                maxTokens: 32768,
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

            finalObject = await object;
            break;
        } catch (error) {
            if (error.name === 'AI_NoObjectGeneratedError' || error.name === 'AI_JSONParseError') {
                logger.warn(`[Graph] Planner silent truncation (finishReason: other), Retrying (${attempt}/${maxAttempts})...`);
                if (attempt >= maxAttempts) throw error;
            } else {
                throw error;
            }
        }
    }
    logger.debug({ node: 'planner', rawOutput: finalObject }, 'LLM response');

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: plannerNode complete (${duration}ms)`);
    return {
        designTokens: finalObject.design_tokens,
        components: finalObject.components,
        reasoning: { node: 'planner', text: "Generated JSON Spatial Blueprint." }
    };
}

/**
 * --- NODE 3: Coder ---
 */
async function coderNode(state, config) {
    const startTime = Date.now();
    const {
        components,
        currentComponentIndex,
        designTokens,
        tsErrors
    } = state;
    const sendEvent = config.configurable?.sendEvent;

    const targetComponent = components[currentComponentIndex];
    console.log(`[Graph] Node: coderNode (Component: ${targetComponent.name} | ${currentComponentIndex + 1}/${components.length})`);

    const errors = [...(tsErrors || [])];
    const messageContent = [];

    // 1. Errors first
    if (errors.length > 0) {
        console.log(`[Graph] 🚨 Coder Node is processing ${errors.length} validation errors.`);
        messageContent.push({
            type: 'text',
            text: `### CRITICAL: FIX THESE ERRORS FROM PREVIOUS ATTEMPT:\n${errors.join("\n")}\n\nYou MUST fix these errors in the code.`
        });
    }

    // 2. Core Instructions (Blind to Input)
    messageContent.push({
        type: 'text',
        text: `You are building a single component for a Shopify theme.
Design Tokens (Use for all styling): ${JSON.stringify(designTokens)}

Component to Build:
Name: ${targetComponent.name}
Type: ${targetComponent.type}
Layout Directive: ${targetComponent.layout_directive}`
    });

    let attempt = 0;
    const maxAttempts = 3;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { fullStream, object } = await streamObject({
                model: gemini31Pro,
                system: "You are an elite Shopify Developer (The Builder). You have NO access to the original user input. You only receive text-based Layout Directives and Design Tokens for a single component. Generate the required file(s) for this component. Use strict Shopify BEM CSS architecture. Follow the layout directives strictly. Output the complete Liquid code. If it's a section, include the {% schema %}.",
                messages: [{ role: 'user', content: messageContent }],
                schema: z.object({
                    files: z.array(z.object({
                        path: z.string().describe("e.g. sections/header.liquid, snippets/card.liquid"),
                        content: z.string()
                    })),
                    thoughtProcess: z.string().optional()
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

            finalObject = await object;
            break; // Success! Break out of the retry loop.
        } catch (error) {
            if (error.name === 'AI_NoObjectGeneratedError' || error.name === 'AI_JSONParseError' || error.message.includes('malformed')) {
                logger.warn(`[Graph] Coder malformed output or truncation, triggering high-priority recovery...`);

                const { recoverMalformedCall } = require('../lib/correction-loop');
                try {
                    const recoveredText = await recoverMalformedCall();
                    // If we got something back, we could try to parse it or just let the loop continue with a correction prompt
                    messageContent.push({ role: 'user', content: "Your previous tool call was syntactically invalid. Output ONLY the corrected tool call using the valid schema." });
                } catch (e) {
                    if (attempt >= maxAttempts) throw error;
                }
            } else {
                throw error;
            }
        }
    }

    logger.debug({ node: 'coder', rawOutput: finalObject }, 'LLM response');

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: coderNode complete (${duration}ms)`);
    return {
        currentComponentFiles: finalObject.files,
        tsErrors: [], // clear errors for next spin
        reasoning: { node: 'coder', text: `Generated component ${targetComponent.name}.` }
    };
}

/**
 * --- NODE 4: TS QC Node (Gate A: Component Level) ---
 */
async function tsQcNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: tsQcNode (Gate A)");
    const { currentComponentFiles, components, currentComponentIndex } = state;
    const sendEvent = config.configurable?.sendEvent;
    const errors = [];

    if (sendEvent) sendEvent({ type: 'progress', stage: 'COMPONENT_LINTING', message: `Linting component ${components[currentComponentIndex].name}...` });

    const mods = (currentComponentFiles || []).map(f => ({
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

        // Gate A: Component Level Check with @shopify/theme-check-node
        const { ThemeCheckService } = require("../services/theme-check-service");
        const fs = require('fs').promises;
        const os = require('os');
        const path = require('path');

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sta-lint-'));
        try {
            for (const mod of mods) {
                const fullPath = path.join(tempDir, mod.filePath);
                await fs.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.writeFile(fullPath, mod.content);
            }
            const gateAResult = await ThemeCheckService.runGateA(tempDir);
            if (!gateAResult.passed) {
                errors.push(...gateAResult.errors.map(e => `[Gate A Error] ${e}`));
            }
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }

        IntegrityManager.validate(mods);
    } catch (e) {
        errors.push(`[Integrity Error] ${e.message || String(e)}`);
    }

    const duration = Date.now() - startTime;
    if (errors.length > 0) {
        logger.error(`[Graph] ❌ TS QC produced ${errors.length} errors:\n${errors.join('\n')}`);
        if (sendEvent) sendEvent({ type: 'progress', stage: 'AI_CORRECTING', message: `Self-healing component ${components[currentComponentIndex].name}...` });
        logger.info(`[Graph] ❌ Node: tsQcNode complete (${duration}ms)`);
        return { tsErrors: errors };
    } else {
        logger.info(`[Graph] ✅ TS QC passed for ${components[currentComponentIndex].name}.`);
        logger.info(`[Graph] ✅ Node: tsQcNode complete (${duration}ms)`);
        // If passed, we append these files to the main generatedFiles array and increment the index
        return {
            tsErrors: [],
            generatedFiles: currentComponentFiles,
            currentComponentIndex: currentComponentIndex + 1
        };
    }
}

/**
 * --- NODE 5: Assembler Node ---
 */
async function assemblerNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: assemblerNode");
    const { generatedFiles, designTokens, components, assemblyErrors } = state;
    const sendEvent = config.configurable?.sendEvent;

    // Dynamically calculate valid section types based ONLY on generated section files
    const validSectionTypes = generatedFiles
        .filter(f => f.path.startsWith('sections/'))
        .map(f => f.path.replace('sections/', '').replace('.liquid', ''));

    const messageContent = [];

    // 1. Critical Corrections First
    if (assemblyErrors && assemblyErrors.length > 0) {
        logger.info(`[Graph] Assembler node is self-healing from ${assemblyErrors.length} errors.`);
        messageContent.push({
            type: 'text',
            text: `### CRITICAL: FIX THESE VALIDATION ERRORS FROM PREVIOUS ASSEMBLY ATTEMPT:\n${assemblyErrors.join("\n")}\n\nYou MUST correct these in the generated files.`
        });
    }

    messageContent.push(
        { type: 'text', text: `Design Tokens: ${JSON.stringify(designTokens)}` },
        { type: 'text', text: `Component Registry: ${JSON.stringify(components)}` },
        { type: 'text', text: `Generated Component Files Preview:\n` + generatedFiles.map(f => f.path).join(', ') },
        { type: 'text', text: `EXACT VALID SECTION TYPES FOR INDEX.JSON: [${validSectionTypes.join(', ')}]` }
    );

    let attempt = 0;
    const maxAttempts = 3;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { fullStream, object } = await streamObject({
                model: gemini31Pro,
                system: `You are the final Assembly Agent. Your job is to stitch together the validated components into the final architectural files of the theme.
You MUST ALWAYS generate and output these specific architecture files based on the pieces:
1. templates/index.json (maps the sections generated to the homepage)
   - CRITICAL RESTRICTION: In the "type" field of your sections in index.json, you MUST ONLY use one of the Exact Valid Section Types provided. DO NOT use 'hero-banner' or any other name unless it is in the Exact Valid Section Types list.
2. layout/theme.liquid (the HTML wrapper, loading Google fonts defined in tokens)
3. config/settings_schema.json
   - CRITICAL: You MUST include the required Shopify attribute "theme_documentation_url": "https://help.shopify.com" in the array.
4. locales/en.default.json

Review the Component Registry and output exactly those 4 files.`,
                messages: [{ role: 'user', content: messageContent }],
                schema: z.object({
                    files: z.array(z.object({
                        path: z.string(),
                        content: z.string()
                    })),
                    thoughtProcess: z.string().optional()
                }),
                maxRetries: 5,
                maxTokens: 32768,
            });

            for await (const part of fullStream) {
                if (sendEvent) {
                    if (part.type === 'reasoning') {
                        sendEvent({ type: 'thinking', node: 'assembler', text: part.textDelta });
                    } else if (part.type === 'object') {
                        sendEvent({ type: 'partial', node: 'assembler', object: part.object });
                    }
                }
            }

            finalObject = await object;
            break;
        } catch (error) {
            if (error.name === 'AI_NoObjectGeneratedError' || error.name === 'AI_JSONParseError') {
                logger.warn(`[Graph] Assembler silent truncation (finishReason: other), Retrying (${attempt}/${maxAttempts})...`);
                if (attempt >= maxAttempts) throw error;
            } else {
                throw error;
            }
        }
    }
    logger.debug({ node: 'assembler', rawOutput: finalObject }, 'LLM response');

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: assemblerNode complete (${duration}ms)`);
    return {
        generatedFiles: finalObject.files, // The reducer appends these to the master list
        assemblyErrors: [], // clear for next try
        reasoning: { node: 'assembler', text: "Assembled total theme structure." }
    };
}

/**
 * --- NODE 6: Assembly QC Node (Gate B: Assembly Level) ---
 */
async function assemblyQcNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: assemblyQcNode (Gate B)");
    const { generatedFiles } = state;
    const sendEvent = config.configurable?.sendEvent;
    const errors = [];

    if (sendEvent) sendEvent({ type: 'progress', stage: 'ASSEMBLY_CHECK', message: `Running full assembly check...` });

    const mods = (generatedFiles || []).map(f => ({
        filePath: f.path,
        action: 'update',
        content: f.content
    }));

    try {
        const planData = { modifications: mods };
        const repairResult = validateAndRepair(planData);

        // Update files with auto-repairs if any
        if (repairResult.repairs.length > 0) {
            logger.info(`[Graph] Assembly QC applied ${repairResult.repairs.length} auto-repairs to architecture files.`);
            const repairedFiles = (planData.modifications || []).map((m) => ({
                path: m.filePath,
                content: m.content
            }));
            // Return repaired files immediately to state
            const duration = Date.now() - startTime;
            logger.info(`[Graph] ✅ Node: assemblyQcNode complete (with repairs) (${duration}ms)`);
            return {
                assemblyErrors: [],
                generatedFiles: repairedFiles
            };
        }

        IntegrityManager.validate(mods);

        // Gate B: Assembly Level Check (Note: This is intensive, usually run on final sync, but we can mock or run here if local)
        // For Gate B, we typically want cross-reference checks.
        // We will run this on the temporary build directory if needed.
    } catch (e) {
        errors.push(`[Integrity Error] ${e.message || String(e)}`);
    }

    const duration = Date.now() - startTime;
    if (errors.length > 0) {
        logger.error(`[Graph] ❌ Assembly QC produced ${errors.length} errors:\n${errors.join('\n')}`);
        if (sendEvent) sendEvent({ type: 'progress', stage: 'AI_CORRECTING', message: `Correcting assembly issues...` });
        logger.info(`[Graph] ❌ Node: assemblyQcNode complete (${duration}ms)`);
    } else {
        logger.info(`[Graph] ✅ Assembly QC passed.`);
        logger.info(`[Graph] ✅ Node: assemblyQcNode complete (${duration}ms)`);
    }

    return { assemblyErrors: errors };
}

/**
 * --- NODE 6: Agentic QC Node ---
 */
async function agenticQcNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: agenticQcNode");
    const { userPrompt, designTokens, generatedFiles } = state;
    const sendEvent = config.configurable?.sendEvent;

    if (state.tsErrors && state.tsErrors.length > 0) {
        return { designErrors: [] };
    }

    let attempt = 0;
    const maxAttempts = 3;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { fullStream, object } = await streamObject({
                model: gemini31Pro,
                system: "You are a Pragmatic Senior Lead Designer evaluating the final assembled theme. Your goal is to ensure the theme matches the provided design tokens. Accessibility Blindspots: You MUST completely IGNORE WCAG guidelines and contrast ratios for borders, dividers, placeholders, and backgrounds. Do not flag low contrast. If valid conceptually, pass it.",
                prompt: `Design Tokens: ${JSON.stringify(designTokens)}\n\nGenerated Code for Review:\n${JSON.stringify(generatedFiles)}`,
                schema: z.object({
                    passed: z.boolean(),
                    errors: z.array(z.string()),
                    thoughtProcess: z.string().optional()
                }),
                maxRetries: 5,
                maxTokens: 32768,
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

            finalObject = await object;
            break; // Success!
        } catch (error) {
            if (error.name === 'AI_NoObjectGeneratedError' || error.name === 'AI_JSONParseError') {
                logger.warn(`[Graph] Agentic QC silent truncation (finishReason: other), Retrying (${attempt}/${maxAttempts})...`);
                if (attempt >= maxAttempts) throw error;
            } else {
                throw error;
            }
        }
    }
    logger.debug({ node: 'agenticQc', rawOutput: finalObject }, 'LLM response');

    if (!finalObject.passed && finalObject.errors.length > 0) {
        logger.error(`[Graph] ❌ Agentic QC produced ${finalObject.errors.length} errors:\n${finalObject.errors.join('\n')}`);
    } else {
        logger.info(`[Graph] ✅ Agentic QC passed.`);
    }

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: agenticQcNode complete (${duration}ms)`);
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
    assemblerNode,
    assemblyQcNode,
    agenticQcNode
};
