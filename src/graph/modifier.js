const { StateGraph, START, END, Annotation } = require("@langchain/langgraph");
const { z } = require("zod");
const { generateObject, streamObject, streamText } = require("ai");

// Make sure to import the correct instances from lib/ai if this is node
const { gemini31Pro, gemini3Flash } = require("../lib/ai");
const { logger } = require("../lib/logger");
const { validateAndRepair } = require("../services/builder");
const { IntegrityManager } = require("../services/integrity-manager");
const path = require("path");
const fs = require("fs");

// Extract helper from earlier nodes
function extractJsonFromText(text) {
    if (!text) return null;
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        try { return JSON.parse(match[1].trim()); } catch (e) { }
    }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        try { return JSON.parse(text.substring(firstBrace, lastBrace + 1)); } catch (e) { }
    }
    return null;
}

const ThemeModificationState = Annotation.Root({
    userPrompt: Annotation(),
    themeId: Annotation(),
    editHistory: Annotation({              // NEW: prior conversation turns
        reducer: (x, y) => y,
        default: () => []
    }),
    designTokens: Annotation({             // NEW: design DNA for consistency
        reducer: (x, y) => y,
        default: () => ({})
    }),
    baseFiles: Annotation({
        reducer: (x, y) => y,
        default: () => []
    }),
    targetFile: Annotation(),
    modifiedFiles: Annotation({
        reducer: (x, y) => y,
        default: () => []
    }),
    tsErrors: Annotation({
        reducer: (x, y) => y,
        default: () => []
    }),
    reasoning: Annotation({
        reducer: (x, y) => [...(x || []), y],
        default: () => []
    })
});

/**
 * NODE 1: Intent Analyzer
 * Determines which file needs to be modified based on the user's prompt.
 */
async function intentAnalyzerNode(state, config) {
    const startTime = Date.now();
    logger.info("[ModifierGraph] Node: intentAnalyzerNode");
    const { userPrompt, baseFiles } = state;
    const sendEvent = config.configurable?.sendEvent;

    // Find templates/index.json to see what sections exist
    const indexJsonFile = baseFiles.find(f => (f.filePath || f.path) === 'templates/index.json');
    let sectionMapText = "No index.json found.";
    if (indexJsonFile) {
        try {
            const indexJson = JSON.parse(indexJsonFile.content);
            const sections = indexJson.sections || {};
            // Gather section types/names
            const sectionArray = Object.keys(sections).map(k => `sections/${sections[k].type}.liquid`);
            sectionMapText = `Existing custom sections in layout:\n${sectionArray.join('\n')}`;
        } catch (e) { }
    }

    if (sendEvent) sendEvent({ type: 'progress', stage: 'intent', message: 'Analyzing modification intent...' });

    const editHistoryText = state.editHistory && state.editHistory.length > 0
        ? `Edit History:\n${state.editHistory.map(m => `- ${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n')}`
        : "No prior edit history.";

    const { object } = await generateObject({
        model: gemini3Flash,
        system: "You are a Shopify architect identifying which section file an edit applies to. Determine the exact path of the file that needs changing.",
        prompt: `Conversation Context:\n${editHistoryText}\n\nLatest User Modification Request: "${userPrompt}"\n\n${sectionMapText}\n\nGlobal layout modifications apply to "layout/theme.liquid". CSS variables apply to "assets/base.css".`,
        schema: z.object({
            targetFilePath: z.string().describe("The full path of the Shopify file to modify, e.g. sections/header.liquid"),
            reasoning: z.string()
        }),
        maxTokens: 1024,
    });

    const duration = Date.now() - startTime;
    logger.info(`[AI] Intent Analyzer Reasoning: ${object.reasoning}`);
    logger.info(`[ModifierGraph] ✅ Intent Analyzer complete (${duration}ms): Target ${object.targetFilePath}`);

    return {
        targetFile: object.targetFilePath,
        reasoning: { node: 'intentAnalyzer', text: object.reasoning }
    };
}

/**
 * NODE 2: Modifier
 * Applies the user's request to the specific file.
 */
async function modifierNode(state, config) {
    const startTime = Date.now();
    logger.info("[ModifierGraph] Node: modifierNode");
    const { userPrompt, targetFile, baseFiles, tsErrors } = state;
    const sendEvent = config.configurable?.sendEvent;

    // Pull the original file from baseFiles
    const originalFile = baseFiles.find(f => (f.filePath || f.path) === targetFile);
    if (!originalFile) {
        logger.warn(`[ModifierGraph] Target file ${targetFile} not found in baseFiles.`);
        // Fallback or handle missing file
        return { modifiedFiles: [] };
    }

    const errors = [...(tsErrors || [])];
    const messageContent = [];

    if (errors.length > 0) {
        messageContent.push({
            type: 'text',
            text: `### CRITICAL: FIX THESE ERRORS FROM PREVIOUS ATTEMPT:\n${errors.join("\n")}\n\nYou MUST fix these errors in the code.`
        });
    }

    const editHistoryText = state.editHistory && state.editHistory.length > 0
        ? `Conversation History:\n${state.editHistory.map(m => `- ${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n')}`
        : "No prior history.";

    messageContent.push({
        type: 'text',
        text: `Design Tokens (Design DNA): ${JSON.stringify(state.designTokens || {})}\n\n${editHistoryText}\n\nTarget File: ${targetFile}\n\nOriginal Content:\n\`\`\`liquid\n${originalFile.content}\n\`\`\`\n\nUser Request: ${userPrompt}\n\nApply the changes strictly to this file while maintaining standard Shopify/Vanilla CSS architectural rules and keeping aesthetic consistency with the Design DNA. Return the FULL patched file.`
    });

    if (sendEvent) sendEvent({ type: 'progress', stage: 'modifying', message: `Modifying ${targetFile}...` });

    let finalObject;
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { fullStream, text } = await streamText({
                model: gemini31Pro,
                system: `You are a Senior Frontend Engineer. Your task is to modify a single Shopify Liquid/CSS file based on the user's request.
OUTPUT FORMAT:
Return a JSON object inside a \`\`\`json code block.
Schema:
{
  "modifiedContent": "string (the fully replaced content)",
  "thoughtProcess": "string"
}`,
                messages: [{ role: 'user', content: messageContent }],
                maxTokens: 16384,
            });

            let streamBuffer = "";
            let partCount = 0;
            let hasStartedStream = false;

            for await (const part of fullStream) {
                partCount++;
                const delta = part.textDelta || part.reasoning || part.thought || part.text || "";

                if (!hasStartedStream && delta) {
                    logger.info(`[AI] modifierNode stream started...`);
                    hasStartedStream = true;
                }

                if (delta) {
                    streamBuffer += delta;
                    if (sendEvent && part.type === 'text-delta') {
                        const delta = part.textDelta;
                        if (sendEvent) sendEvent({ type: 'thinking', node: 'modifier', text: delta, component: 'Theme Modification' });
                    }

                    if (streamBuffer.length > 50 || streamBuffer.includes('\n')) {
                        logger.info(`[AI] ${streamBuffer}`);
                        streamBuffer = "";
                    }
                }
            }
            if (streamBuffer) logger.info(`[AI] ${streamBuffer}`);

            const finalText = await text;
            finalObject = extractJsonFromText(finalText);

            if (!finalObject || !finalObject.modifiedContent) {
                throw new Error("Failed to extract valid JSON from modifier stream");
            }
            break;
        } catch (error) {
            logger.warn(`[ModifierGraph] Modifier error, Retrying (${attempt}/${maxAttempts})...`);
            if (attempt >= maxAttempts) throw error;
        }
    }

    const duration = Date.now() - startTime;
    logger.info(`[ModifierGraph] ✅ Node: modifierNode complete (${duration}ms)`);

    // Incremental R2 Update
    const { themeId } = state;
    if (themeId) {
        (async () => {
            try {
                const { uploadThemeState, getThemeState } = require("../services/r2-service");
                const currentState = await getThemeState(themeId);
                const updatedState = [...currentState];
                const idx = updatedState.findIndex(s => (s.filePath || s.path) === targetFile);
                const mod = { filePath: targetFile, content: finalObject.modifiedContent, action: 'update', path: targetFile };
                if (idx >= 0) updatedState[idx] = mod;
                else updatedState.push(mod);
                await uploadThemeState(themeId, updatedState);
                logger.info(`[R2] Incremental update saved for modifierNode: ${targetFile}`);
            } catch (e) { logger.warn(`[R2] Failed incremental update: ${e.message}`); }
        })();
    }

    return {
        modifiedFiles: [{ path: targetFile, content: finalObject.modifiedContent }],
        tsErrors: [],
        reasoning: { node: 'modifier', text: "Modified file contents successfully." }
    };
}

/**
 * NODE 3: TS QC Node (Component Level checks)
 */
async function tsQcNode(state, config) {
    const startTime = Date.now();
    logger.info("[ModifierGraph] Node: tsQcNode");
    const { modifiedFiles, targetFile } = state;
    const sendEvent = config.configurable?.sendEvent;
    const errors = [];

    if (sendEvent) sendEvent({ type: 'progress', stage: 'COMPONENT_LINTING', message: `Linting modified ${targetFile}...` });

    const mods = (modifiedFiles || []).map(f => ({
        filePath: f.path,
        action: 'update',
        content: f.content
    }));

    try {
        const repairResult = validateAndRepair({ modifications: mods });
        if (repairResult.errors.length > 0) {
            errors.push(...repairResult.errors.map(err => `[Syntax Error] ${err}`));
        }

        const { ThemeCheckService } = require("../services/theme-check-service");
        const fsPromises = fs.promises;
        const os = require('os');
        const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sta-lint-'));
        try {
            for (const mod of mods) {
                const fullPath = path.join(tempDir, mod.filePath);
                await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
                await fsPromises.writeFile(fullPath, mod.content);
            }
            const gateAResult = await ThemeCheckService.runGateA(tempDir);
            if (!gateAResult.passed) {
                errors.push(...gateAResult.errors.map(e => `[Gate A Error] ${e}`));
            }
        } finally {
            await fsPromises.rm(tempDir, { recursive: true, force: true });
        }

        IntegrityManager.validate(mods);
    } catch (e) {
        errors.push(`[Integrity Error] ${e.message || String(e)}`);
    }

    const duration = Date.now() - startTime;
    if (errors.length > 0) {
        logger.error(`[ModifierGraph] ❌ TS QC produced ${errors.length} errors`);
        if (sendEvent) sendEvent({ type: 'progress', stage: 'AI_CORRECTING', message: `Self-healing modified ${targetFile}...` });
        return { tsErrors: errors };
    } else {
        logger.info(`[ModifierGraph] ✅ TS QC passed for ${targetFile}.`);
        return { tsErrors: [] };
    }
}

/**
 * Compile Graph
 */
const workflow = new StateGraph(ThemeModificationState)
    .addNode("intentAnalyzer", intentAnalyzerNode)
    .addNode("modifier", modifierNode)
    .addNode("tsQc", tsQcNode)
    .addEdge(START, "intentAnalyzer")
    .addEdge("intentAnalyzer", "modifier")
    .addEdge("modifier", "tsQc");

workflow.addConditionalEdges(
    "tsQc",
    (state) => {
        if (state.tsErrors && state.tsErrors.length > 0) {
            return "modifier";
        }
        return END;
    },
    {
        modifier: "modifier",
        [END]: END
    }
);
const { getCheckpointer } = require("../services/postgres-service");
const checkpointer = getCheckpointer();
const modifierWorkflow = workflow.compile({ checkpointer });

module.exports = { modifierWorkflow };

