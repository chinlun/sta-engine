const { z } = require("zod");
const { generateObject, streamObject, streamText } = require("ai");
const { google31ProSticky, google3FlashSticky } = require("../lib/ai");
const { validateAndRepair } = require("../services/builder");
const { IntegrityManager } = require("../services/integrity-manager");
const { logger } = require("../lib/logger");
const fs = require('fs');
const path = require('path');
const { uploadThemeState, getThemeState } = require("../services/r2-service");

/**
 * Helper to sleep with exponential backoff and jitter
 */
async function sleepWithJitter(attempt) {
    const baseDelay = Math.pow(2, attempt) * 3000;
    const jitter = Math.random() * 2000;
    const totalDelay = baseDelay + jitter;
    logger.debug(`[Graph] Sleeping for ${Math.round(totalDelay)}ms before next attempt...`);
    return new Promise(resolve => setTimeout(resolve, totalDelay));
}

// --- CONTEXT BANK: Adaptive Documentation Pruning ---
class ContextBank {
    constructor() {
        this.docs = {};
        this.basePath = path.join(__dirname, "../../docs");
        this.loadAll();
    }

    loadAll() {
        const files = [
            { id: 'design', path: 'design-system/the-minimalist/DESIGN.md' },
            { id: 'component', path: 'design-system/the-minimalist/component.md' },
            { id: 'cheat_sheet', path: 'liquid-cheat-sheet.md' },
            { id: 'liquid_ref', path: 'reference/shopify-liquid-reference.md' },
            { id: 'architecture', path: 'reference/shopify-os2-architecture.md' },
            { id: 'schema', path: 'reference/shopify-schema-settings.md' },
            { id: 'file_map', path: 'reference/skeleton-file-map.md' }
        ];

        files.forEach(f => {
            try {
                const fullPath = path.join(this.basePath, f.path);
                const content = fs.readFileSync(fullPath, "utf8");
                this.docs[f.id] = this.partitionMarkdown(content);
            } catch (e) {
                logger.warn(`Failed to load doc ${f.id}: ${e.message}`);
                this.docs[f.id] = { _full: "" };
            }
        });
    }

    partitionMarkdown(content) {
        const sections = { _full: content };
        const lines = content.split('\n');
        let currentHeader = null;
        let currentContent = [];

        lines.forEach(line => {
            const match = line.match(/^##?\s+(.+)/);
            if (match) {
                if (currentHeader) {
                    sections[currentHeader] = currentContent.join('\n').trim();
                }
                currentHeader = match[1].trim();
                currentContent = [];
            } else if (currentHeader) {
                currentContent.push(line);
            }
        });

        if (currentHeader) {
            sections[currentHeader] = currentContent.join('\n').trim();
        }

        return sections;
    }

    /**
     * returns a pruned context string tailored for a specific node and component.
     */
    getPrunedContext(nodeName, targetComponent = null) {
        let parts = [];

        if (nodeName === 'designer') {
            const design = this.docs['design'] || {};
            parts.push("## DESIGN SYSTEM (VIBE & TOKENS)");
            parts.push(design['1. The North Star'] || "");
            parts.push(design['2. Colors & Surface Logic'] || "");
            parts.push(design['3. Typography'] || "");
        }

        if (nodeName === 'planner') {
            const arch = this.docs['architecture'] || {};
            parts.push("## SHOPIFY OS 2.0 ARCHITECTURE");
            parts.push(arch['1. Theme File Hierarchy'] || "");
            parts.push(arch['2. JSON Template Structure (Critical)'] || "");

            const comp = this.docs['component'] || {};
            parts.push("## COMPONENT BLUEPRINTS");
            parts.push(comp['_full'] || ""); // Planner needs the full overview of what's possible
        }

        if (nodeName === 'coder') {
            // 1. Minimal Design Rules
            const design = this.docs['design'] || {};
            parts.push("## DESIGN RULES\n" + (design['4. Elevation & Depth'] || "") + "\n" + (design['6. Do\'s and Don\'ts'] || ""));

            // 2. Targeted Component Spec
            const comp = this.docs['component'] || {};
            if (targetComponent) {
                // Find section matching component type (e.g. "Hero Section", "Product Section")
                const sectionKey = Object.keys(comp).find(k => k.toLowerCase().includes(targetComponent.type?.toLowerCase()));
                if (sectionKey) {
                    parts.push(`## COMPONENT SPEC: ${sectionKey}\n${comp[sectionKey]}`);
                }
            }

            // 3. Technical Guardrails (The missing piece)
            const cheat = this.docs['cheat_sheet'] || {};
            parts.push("## LIQUID GUARDRAILS");
            parts.push(cheat['3. Liquid Syntax & Section Guardrails'] || "");
            parts.push(cheat['4. CSS & Styling Standards'] || "");

            const schema = this.docs['schema'] || {};
            parts.push("## VALID SCHEMA TYPES");
            parts.push(schema['2. Valid Input Setting Types (Complete & Official)'] || "");

            const liquidRef = this.docs['liquid_ref'] || {};
            parts.push("## CRITICAL TAG RULES");
            parts.push(liquidRef['1. Critical Liquid Tag Rules'] || "");
        }

        if (nodeName === 'assembler') {
            parts.push("## THEME ARCHITECTURE\n" + (this.docs['architecture']?._full || ""));
            parts.push("## SKELETON FILE MAP\n" + (this.docs['file_map']?._full || ""));
        }

        const finalContext = parts.filter(p => p.trim().length > 0).join('\n\n');
        logger.info(`[ContextBank] Generated context for ${nodeName}. Size: ${finalContext.length} chars.`);
        return finalContext;
    }
}

const contextBank = new ContextBank();

// --- BLUEPRINTS MANIFEST ---
let blueprintsManifest = [];
try {
    const manifestPath = path.join(__dirname, "../../blueprints/manifest.json");
    blueprintsManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e) {
    logger.warn(`Blueprints manifest not found: ${e.message}`);
}

/**
 * Helper to determine model and adaptive instructions based on fallback state and retry counts.
 */
function getLLMConfig(state, attempt = 1) {
    let adaptiveInstructions = "";

    // 1. Fallback Mode Instructions
    if (state.isFallback) {
        adaptiveInstructions += `
[ADAPTIVE INSTRUCTION MODE: ACTIVE]
You are operating in high-efficiency fallback mode.
- BE EXTREMELY EXPLICIT in your reasoning and architectural plan.
- DO NOT SKIP any code sections or take shortcuts in Liquid/CSS generation.
- ENSURE all JSON keys are strictly followed without hallucination.
- Prioritize structural integrity and standard Shopify compliance for every file.
`;
    }

    // 2. Retry Adaptation (Truncation/Parse failure mitigation)
    if (attempt > 1) {
        adaptiveInstructions += `
[RETRY ADAPTATION: ACTIVE (Attempt ${attempt})]
The previous attempt failed, likely due to output length or formatting.
- BE CONCISE while maintaining high quality.
- AVOID long comments or excessive descriptive text.
- ENSURE the final JSON block is complete and valid.
`;
    }

    return {
        model: state.isFallback ? google3FlashSticky : google31ProSticky,
        adaptiveInstructions: adaptiveInstructions.trim()
    };
}

/**
 * Helper to detect if an error is a timeout, service-overloaded, or generation failure.
 * All of these indicate that the current model/service is unstable and should potentially trigger a fallback.
 */
function isResilienceError(error) {
    if (!error) return false;
    // Blanket coverage: Any error in the generation pipeline should trigger a retry/fallback.
    // This includes network errors, parsing errors, safety filters, and opaque API failures.
    return true;
}

/**
 * --- UTILITIES: Shared Generation Helpers ---
 */
function getStructuralSkeleton(html) {
    if (!html) return "";
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, "") // Remove styles
        .replace(/<script[\s\S]*?<\/script>/gi, "") // Remove scripts
        .replace(/<!--[\s\S]*?-->/g, "") // Remove comments
        .replace(/>\s+</g, "><") // Remove whitespace between tags
        .replace(/<([a-z0-9]+)([^>]*?)>/gi, (match, tag, attrs) => {
            const id = (attrs.match(/id=["']([^"']+)["']/) || [])[1];
            const cls = (attrs.match(/class=["']([^"']+)["']/) || [])[1];
            let minimal = `<${tag}`;
            if (id) minimal += ` id="${id}"`;
            if (cls) minimal += ` class="${cls}"`;
            return minimal + ">";
        })
        .replace(/>[^<]+</g, "><") // Remove text content
        .trim();
}

function repairJson(text) {
    if (!text) return null;

    // 1. Try standard extraction first
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        const candidate = match[1].trim();
        try { return JSON.parse(candidate); } catch (e) {
            // If it fails, try to balance it
            const repaired = balanceJson(candidate);
            try { return JSON.parse(repaired); } catch (e2) { }
        }
    }

    // 2. Try raw brace extraction
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1) {
        let candidate = text.substring(firstBrace, (lastBrace !== -1 && lastBrace > firstBrace) ? lastBrace + 1 : text.length);
        try { return JSON.parse(candidate); } catch (e) {
            const repaired = balanceJson(candidate);
            try { return JSON.parse(repaired); } catch (e2) { }
        }
    }
    return null;
}

function balanceJson(json) {
    let stack = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < json.length; i++) {
        const char = json[i];
        if (char === '"' && !escaped) inString = !inString;
        if (inString) {
            if (char === '\\') escaped = !escaped;
            else escaped = false;
            continue;
        }
        if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
        else if (char === '}' || char === ']') {
            if (stack.length > 0 && stack[stack.length - 1] === char) stack.pop();
        }
    }

    let repaired = json;
    // Close trailing string if needed
    if (inString) repaired += '"';

    // Close open structures in reverse order
    while (stack.length > 0) {
        repaired += stack.pop();
    }
    return repaired;
}

function extractJsonFromText(text) {
    return repairJson(text);
}

/**
 * Normalizes a component name to strictly follow Shopify and project rules.
 * @param {string} name Raw name
 * @param {string} type Component type (header, footer, section, etc.)
 * @param {boolean} fullPath If true, returns 'sections/name.liquid'. If false, returns just 'name'.
 */
function normalizeFilename(name, type, fullPath = false) {
    const t = (type || '').toLowerCase();

    // 1. Standardize the base name (kebab-case)
    let baseName = name
        .replace(/^sections\//, '')
        .replace(/^layout\//, '')
        .replace(/^snippets\//, '')
        .replace(/\.liquid$/, '')
        .replace(/\.json$/, '')
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()
        .replace(/^-+|-+$/g, '');

    // 2. Strict type-based normalization for globals. 
    // We only force 'header' if the type is explicitly 'header'.
    if (t === 'header') baseName = 'header';
    if (t === 'footer') baseName = 'footer';

    if (!fullPath) return baseName;

    // 3. Map to Shopify Category Prefix
    if (t === 'header' || t === 'footer') return `sections/${baseName}.liquid`;
    if (t === 'layout') return `layout/${baseName}.liquid`;
    return `sections/${baseName}.liquid`;
}

/**
 * --- NODE 1: Classifier ---
 */
async function classifierNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: classifierNode");
    const { userPrompt } = state;
    const sendEvent = config.configurable?.sendEvent;
    if (sendEvent) sendEvent({ type: 'progress', stage: 'classifier', message: 'Analyzing your store concept...', component: 'Store Discovery' });

    let attempt = 0;
    const maxAttempts = 10;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            if (attempt > 1) {
                logger.warn(`[Graph] Classifier retrying (Attempt ${attempt}/${maxAttempts})...`);
            }

            const { partialObjectStream, object } = await streamObject({
                model: google3FlashSticky,
                maxRetries: 0,
                mode: 'json',
                system: "You are an expert Shopify architect. Analyze the user's prompt to determine their store's SCALE and CATALOG TYPE. Return ONLY valid JSON.",
                prompt: `Classify the following theme generation prompt in JSON format: "${userPrompt}"`,
                schema: z.object({
                    archetypeDescription: z.string(),
                    catalogSize: z.enum(["single_product", "boutique", "enterprise"])
                }),
                maxTokens: 4096, // Classifier is small
            });

            object.catch(() => {}); // Prevent unhandled promise rejection if stream throws
            let previousLength = 0;
            for await (const partial of partialObjectStream) {
                if (partial.archetypeDescription && partial.archetypeDescription.length > previousLength) {
                    const delta = partial.archetypeDescription.substring(previousLength);
                    if (sendEvent) sendEvent({ type: 'thinking', node: 'classifier', text: delta, component: 'Store Discovery' });
                    previousLength = partial.archetypeDescription.length;
                }
            }

            finalObject = await object;
            break;
        } catch (error) {
            logger.error(`[Graph] Classifier error (Attempt ${attempt}/${maxAttempts}): ${error.message}`);

            if (isResilienceError(error)) {
                if (attempt >= maxAttempts) throw error;
                await sleepWithJitter(attempt);
                continue;
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
 * --- NODE 1.5: Designer Agent ---
 * Selects a palette and design tokens based on user input. (Step 1)
 */
async function designerNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: designerNode");
    const { userPrompt, referenceImageBase64 } = state;
    const sendEvent = config.configurable?.sendEvent;
    if (sendEvent) sendEvent({ type: 'progress', stage: 'designer', message: 'Crafting your design system...', component: 'Design Strategy' });

    let localIsFallback = state.isFallback;
    let attempt = 0;
    const maxAttempts = 10;
    let lastError = null;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        const { adaptiveInstructions } = getLLMConfig({ ...state, isFallback: localIsFallback }, attempt);
        const model = google3FlashSticky; // Force Flash for Design Node

        try {
            if (lastError) {
                logger.warn(`[Graph] Designer retrying (Attempt ${attempt}/${maxAttempts}) after error: ${lastError.message}`);
            }

            const prunedContext = contextBank.getPrunedContext('designer');

            const { partialObjectStream, object } = await streamObject({
                model,
                maxRetries: 0,
                mode: 'json',
                system: `You are the Lead Designer Agent. Your goal is to select a curated, high-end color palette and design tokens. Return ONLY valid JSON.
                
${adaptiveInstructions}

${prunedContext}

AESTHETIC RULES:
1. "Sophisticated" & Premium: Avoid basic colors. Use HSL-tailored, harmonious palettes.
2. Editorial Design: Prioritize typography and white space. No rounded corners (0px).`,
                prompt: `User Prompt: ${userPrompt}\n\nSelect design tokens in JSON format based on the prompt.`,
                schema: z.object({
                    reasoning: z.string().describe("Your thought process. MUST BE FIRST."),
                    palette: z.object({
                        primary: z.string(),
                        secondary: z.string(),
                        accent: z.string(),
                        background: z.string(),
                        text: z.string(),
                    }),
                    typography: z.object({
                        heading_font: z.string(),
                        body_font: z.string(),
                        base_size: z.string(),
                    }),
                    ui: z.object({
                        border_radius: z.string(),
                        button_style: z.enum(["pill", "sharp", "soft"]),
                    })
                }),
                maxTokens: 4096,
            });

            object.catch(() => {});
            let previousLength = 0;
            for await (const partial of partialObjectStream) {
                if (partial.reasoning && partial.reasoning.length > previousLength) {
                    const delta = partial.reasoning.substring(previousLength);
                    if (sendEvent) sendEvent({ type: 'thinking', node: 'designer', text: delta, component: 'Design Strategy' });
                    previousLength = partial.reasoning.length;
                }
            }
            finalObject = await object;
            break; // Success!
        } catch (error) {
            logger.error(`[Graph] Designer error (Attempt ${attempt}/${maxAttempts}): ${error.message}`);
            lastError = error;

            if (isResilienceError(error) && !localIsFallback) {
                logger.error(`[Graph] 🚨 Sticky Fallback Triggered in designerNode.`);
                localIsFallback = true;
                await sleepWithJitter(attempt);
                continue;
            }

            if (attempt >= maxAttempts) throw error;
            await sleepWithJitter(attempt);
        }
    }

    logger.debug({ node: 'designer', rawOutput: finalObject }, 'LLM response');

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: designerNode complete (${duration}ms)`);

    return {
        designTokens: finalObject,
        reasoning: { node: 'designer', text: finalObject.reasoning },
        isFallback: localIsFallback
    };
}

/**
 * --- NODE 2: Planner (Component Breakdown) ---
 * Breaks down the home page into components. (Step 2)
 */
async function plannerNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: plannerNode");
    const { userPrompt, designTokens, catalogSize } = state;
    const sendEvent = config.configurable?.sendEvent;
    if (sendEvent) sendEvent({ type: 'progress', stage: 'planner', message: 'Architecting your storefront...', component: 'Architectural Planning' });

    let localIsFallback = state.isFallback;
    let attempt = 0;
    const maxAttempts = 10;
    let lastError = null;

    const manifestSummary = blueprintsManifest.map(bp => `- ID: ${bp.blueprint_id} | Vibe: ${bp.vibe} | Description: ${bp.visual_description} | Best For: ${bp.best_for.join(", ")}`).join('\n');

    while (attempt < maxAttempts) {
        attempt++;
        const { model, adaptiveInstructions } = getLLMConfig({ ...state, isFallback: localIsFallback }, attempt);

        try {
            if (lastError) {
                logger.warn(`[Graph] Planner retrying (Attempt ${attempt}/${maxAttempts}) after error: ${lastError.message}`);
            }

            const prunedContext = contextBank.getPrunedContext('planner');

            const { partialObjectStream, object } = await streamObject({
                model,
                maxRetries: 0,
                mode: 'json',
                system: `You are the Lead Shopify Architect. Based on the selected design tokens, break down the home page into a list of components. Return ONLY valid JSON.
                
${adaptiveInstructions}

${prunedContext}

BLUEPRINTS:
${manifestSummary}

RULES:
1. Editorial Hierarchy: Start with a strong visual hook (Hero), followed by product discovery, then brand story.
2. Global Layout Elements: Always include exactly one "header.liquid" and one "footer.liquid". EXPLICITLY set their type to "header" and "footer" and mark them as isGlobal: true.
3. Page Template Sections: All other components should be tagged as type "section" and will be part of the Home Page Template (index.json).
4. No HTML/CSS: Describe layouts in English.
5. Hero Blueprint: Select the most appropriate Hero Blueprint ID from the manifest.`,
                prompt: `User Prompt: ${userPrompt}\nCatalog Size: ${catalogSize}\nDesign System Tokens: ${JSON.stringify(designTokens)}\n\nGenerate the component plan in JSON format.`,
                schema: z.object({
                    reasoning: z.string().describe("Your thought process. MUST BE FIRST."),
                    blueprint_id: z.string().optional(),
                    components: z.array(z.object({
                        name: z.string(),
                        type: z.enum(["header", "footer", "section"]),
                        isGlobal: z.boolean(),
                        layout_directive: z.string()
                    }))
                }),
                maxTokens: 8192,
            });

            object.catch(() => {});
            let previousLength = 0;
            for await (const partial of partialObjectStream) {
                if (partial.reasoning && partial.reasoning.length > previousLength) {
                    const delta = partial.reasoning.substring(previousLength);
                    if (sendEvent) sendEvent({ type: 'thinking', node: 'planner', text: delta, component: 'Architectural Planning' });
                    previousLength = partial.reasoning.length;
                }
            }

            const finalObject = await object;

            if (!finalObject || !finalObject.components) {
                throw new Error("Failed to extract valid JSON from planner stream");
            }

            const duration = Date.now() - startTime;
            if (finalObject.blueprint_id) {
                logger.info(`[Graph] Selected Hero Blueprint: ${finalObject.blueprint_id}`);
            }

            // NORMALIZE AT SOURCE: Force all names to FULL PATH identifiers immediately.
            // This ensures the state and events use the exact same key.
            const normalizedComponents = finalObject.components.map(c => ({
                ...c,
                name: normalizeFilename(c.name, c.type, true)
            }));

            logger.info(`[Graph] ✅ Node: plannerNode complete (${duration}ms)`);
            return {
                components: normalizedComponents,
                selectedBlueprintId: finalObject.blueprint_id,
                reasoning: { node: 'planner', text: finalObject.reasoning },
                isFallback: localIsFallback
            };
        } catch (error) {
            logger.error(`[Graph] Planner error (Attempt ${attempt}/${maxAttempts}): ${error.message}`);
            lastError = error;

            if (isResilienceError(error) && !localIsFallback) {
                logger.error(`[Graph] 🚨 Sticky Fallback Triggered in plannerNode.`);
                localIsFallback = true;
                await sleepWithJitter(attempt);
                continue;
            }

            if (attempt >= maxAttempts) throw error;
            await sleepWithJitter(attempt);
        }
    }
}

// (Utilities moved to top)

/**
 * --- NODE 2.5: Content Writer ---
 * Generates sophisticated copy for planned components. (Step 3)
 */
async function contentWriterNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: contentWriterNode");
    const { userPrompt, components, designTokens } = state;
    const sendEvent = config.configurable?.sendEvent;
    if (sendEvent) sendEvent({ type: 'progress', stage: 'content', message: 'Generating section copy...', component: 'Content Generation' });

    let attempt = 0;
    const maxAttempts = 10;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { partialObjectStream, object } = await streamObject({
                model: google3FlashSticky,
                maxRetries: 0,
                mode: 'json',
                system: `You are a High-End Editorial Copywriter. Return ONLY valid JSON.
                
TONE OF VOICE: "Sophisticated"
- Authoritative yet graceful.
- Concise, poetic, and evocative.
- Avoid marketing clichés.`,
                schema: z.object({
                    reasoning: z.string().describe("Your thought process. MUST BE FIRST."),
                    sectionContent: z.array(z.object({
                        componentName: z.string(),
                        heading: z.string(),
                        subheading: z.string(),
                        body: z.string(),
                        cta_label: z.string(),
                        marketing_hooks: z.array(z.string())
                    }))
                }),
                prompt: `User Prompt: ${userPrompt}\nPlanned Components: ${JSON.stringify(components)}\nDesign Vibe: ${designTokens.typography.heading_font}\n\nWrite the copy for these components in JSON format.`,
                maxTokens: 16384,
            });

            object.catch(() => {});
            let previousLength = 0;
            for await (const partial of partialObjectStream) {
                if (partial.reasoning && partial.reasoning.length > previousLength) {
                    const delta = partial.reasoning.substring(previousLength);
                    if (sendEvent) sendEvent({ type: 'thinking', node: 'contentWriter', text: delta, component: 'Content Generation' });
                    previousLength = partial.reasoning.length;
                }
            }

            finalObject = await object;

            if (!finalObject || !finalObject.sectionContent) {
                throw new Error("Failed to extract valid JSON from content writer stream");
            }
            break; // Success!
        } catch (error) {
            logger.error(`[Graph] ContentWriter error (Attempt ${attempt}/${maxAttempts}): ${error.message}`);

            if (isResilienceError(error)) {
                if (attempt >= maxAttempts) throw error;
                await sleepWithJitter(attempt);
                continue;
            } else {
                throw error;
            }
        }
    }

    // Convert array back to record for the state if needed, but we can also just use the array
    // To maintain compatibility with existing coderNode which expects sectionContent[targetComponent.name]
    const contentRecord = {};
    for (const item of finalObject.sectionContent) {
        contentRecord[item.componentName] = item;
    }

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: contentWriterNode complete (${duration}ms)`);
    return {
        sectionContent: contentRecord,
        reasoning: { node: 'contentWriter', text: finalObject.reasoning }
    };
}

/**
 * --- NODE 2.7: Structural Agent ---
 * Generates Global CSS and Layout Shell. (Steps 4 & 5)
 * Refactored: Deterministic Template approach for Shopify Store Compliance.
 */
async function structuralNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: structuralNode (Deterministic)");
    const { designTokens } = state;
    const sendEvent = config.configurable?.sendEvent;
    if (sendEvent) sendEvent({ type: 'progress', stage: 'structural', message: 'Building global layout shell...', component: 'layout/theme.liquid' });

    // 1. Generate base.css with design tokens
    const c = designTokens.colors || {};
    const baseCss = `
:root {
  --color-primary: ${c.primary || designTokens.primary_color || '#000000'};
  --color-secondary: ${c.secondary || designTokens.secondary_color || '#999999'};
  --color-background: ${c.background || designTokens.background_color || '#ffffff'};
  --color-surface: ${c.surface || designTokens.surface_color || '#f4f4f4'};
  --color-text: ${c.text || designTokens.text_color || '#111111'};
  --font-heading: 'Playfair Display', serif;
  --font-body: 'Inter', sans-serif;
  --spacing-base: 0.5rem;
  --elevation-subtle: 0 4px 12px rgba(0,0,0,0.05);
}

body {
  margin: 0;
  font-family: var(--font-body);
  background-color: var(--color-background);
  color: var(--color-text);
  line-height: 1.6;
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading);
  margin-top: 0;
  color: var(--color-primary);
}

main {
  min-height: 50vh;
}
    `.trim();

    // 2. Generate theme.liquid (Fixed Store-Compliant Template)
    const themeLiquid = `
<!doctype html>
<html class="no-js" lang="{{ request.locale.iso_code }}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
  
  <title>{{ page_title }}</title>

  {% if page_description %}
    <meta name="description" content="{{ page_description | escape }}">
  {% endif %}

  {{ content_for_header }}

  {{ 'base.css' | asset_url | stylesheet_tag }}
</head>
<body class="gradient">
  {% section 'header' %}

  <main id="MainContent" class="content-for-layout focus-none" role="main" tabindex="-1">
    {{ content_for_layout }}
  </main>

  {% section 'footer' %}
</body>
</html>
    `.trim();

    const files = [
        { path: 'layout/theme.liquid', content: themeLiquid },
        { path: 'assets/base.css', content: baseCss }
    ];

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: structuralNode complete (${duration}ms)`);

    // Incremental R2 Update
    const { themeId } = state;
    if (themeId) {
        (async () => {
            try {
                const currentState = await getThemeState(themeId);
                const updatedState = [...currentState];
                files.forEach(f => {
                    const idx = updatedState.findIndex(s => (s.filePath || s.path) === f.path);
                    if (idx >= 0) updatedState[idx] = { ...f, filePath: f.path, action: 'update' };
                    else updatedState.push({ ...f, filePath: f.path, action: 'update' });
                });
                await uploadThemeState(themeId, updatedState);
                logger.info(`[R2] Incremental update saved for structuralNode`);
            } catch (e) { logger.warn(`[R2] Failed incremental update: ${e.message}`); }
        })();
    }

    return {
        layoutShell: themeLiquid,
        generatedFiles: files,
        reasoning: { node: 'structural', text: "Generated deterministic store-compliant layout and CSS variables." }
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
        sectionContent,
        layoutShell,
        tsErrors,
        selectedBlueprintId
    } = state;
    const sendEvent = config.configurable?.sendEvent;

    let localIsFallback = state.isFallback;
    // Component Identification: In the state, components[i].name is ALREADY a full path.
    const targetComponent = components[currentComponentIndex];
    const componentNameFull = targetComponent.name;

    if (sendEvent) sendEvent({ type: 'progress', stage: 'coder', message: `Generating ${componentNameFull}...`, component: componentNameFull });
    logger.info(`[Graph] Node: coderNode (Component: ${componentNameFull} | ${currentComponentIndex + 1}/${components.length})`);

    const errors = [...(tsErrors || [])];

    // Blueprint Check
    const isHero = (targetComponent.layout_directive && targetComponent.layout_directive.toLowerCase().includes('hero')) || targetComponent.name.toLowerCase().includes('hero');
    let blueprintDoc = "";
    if (isHero && selectedBlueprintId) {
        const blueprint = blueprintsManifest.find(bp => bp.blueprint_id === selectedBlueprintId);
        if (blueprint) {
            try {
                const blueprintsDir = path.join(__dirname, "../../blueprints");
                const desktopHtml = fs.readFileSync(path.join(blueprintsDir, blueprint.paths.desktop), 'utf8');
                const mobileHtml = fs.readFileSync(path.join(blueprintsDir, blueprint.paths.mobile), 'utf8');

                blueprintDoc = `### STRUCTURAL BLUEPRINT (HERO)
Use the following Desktop and Mobile HTML structures purely as **reference and inspiration** to create a completely customized section for the user based on their prompt. 
Do NOT copy this HTML exactly as is.

CRITICAL REQUIREMENTS:
- You MUST perfectly JIT Liquid-ize this to make it Shopify compatible.
- Merge the conceptual structures from desktop/mobile into one responsive \`.liquid\` file.
- Use \`{% schema %}\` to make every text and image field editable in Shopify.
- CRITICAL: Scope all your CSS using \`#shopify-section-{{ section.id }}\`.

DESKTOP STRUCTURE REFERENCE:
${getStructuralSkeleton(desktopHtml)}

MOBILE STRUCTURE REFERENCE:
${getStructuralSkeleton(mobileHtml)}`;
                logger.info(`[Graph] Injected Hero Blueprint (${selectedBlueprintId}) into code generation context.`);
            } catch (err) {
                logger.warn(`[Graph] Failed to load blueprint HTML for ${selectedBlueprintId}, falling back to standard generation: ${err.message}`);
            }
        }
    }


    let attempt = 0;
    const maxAttempts = 10;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        const { model, adaptiveInstructions } = getLLMConfig({ ...state, isFallback: localIsFallback }, attempt);

        try {
            if (attempt > 1) {
                logger.warn(`[Graph] Coder retrying (Attempt ${attempt}/${maxAttempts}) due to previous failure.`);
            }

            const shellSummary = layoutShell ? getStructuralSkeleton(layoutShell) : "Not Provided";

            const fullPrompt = [
                errors.length > 0 ? `### CRITICAL: FIX THESE ERRORS FROM PREVIOUS ATTEMPT:\n${errors.join("\n")}\n\nYou MUST fix these errors in the code.` : "",
                `You are building a single component for a Shopify theme.
Design Tokens: ${JSON.stringify(designTokens)}
Global Layout Shell Context (Structural Skeleton): 
${shellSummary}

Component to Build:
Name: ${targetComponent.name}
Type: ${targetComponent.type}
Layout Directive: ${targetComponent.layout_directive}
Sophisticated Content: ${JSON.stringify(sectionContent[targetComponent.name] || {})} `,
                blueprintDoc,
                "\n\nGenerate the component code in JSON format."
            ].filter(Boolean).join("\n\n");

            const { partialObjectStream, object } = await streamObject({
                model,
                maxRetries: 0,
                mode: 'json',
                system: `# MISSION: GENERATE HIGH-END SHOPIFY SECTION (VANILLA CSS SPEC)
Goal: Prioritize architectural, editorial beauty using STANDARD CSS (No Tailwind). Return ONLY valid JSON.
- QUALITY OVER SPEED: Do not take shortcuts. Prioritize high-fidelity, editorial design that feels premium and custom.

${adaptiveInstructions}

${contextBank.getPrunedContext('coder', targetComponent)}

## THE ARCHITECTURAL RULES
You are a Senior Frontend Engineer. Build a stunning, bespoke editorial eCommerce section.
- STYLING: EXCLUSIVELY use Vanilla CSS inside a <style> tag within the section. Use the CSS variables provided in :root (--color-primary, --font-heading, etc.).
- NO TAILWIND: Do NOT use Tailwind utility classes (py-10, flex, etc.) in the HTML. Use standard CSS classes.
- CONTENT: Use the provided "Sophisticated" content exactly. Do NOT hallucinate generic copy.
- TECH STACK: Shopify Liquid + Vanilla JS Web Components (Light DOM) for interactivity.
- LAYOUT: Use the "Intentional Asymmetry" and "No-Line" rules from the design system.`,
                prompt: fullPrompt,
                schema: z.object({
                    thoughtProcess: z.string().describe("Your thought process. MUST BE FIRST. Detail your architectural approach, aesthetic choices, and how you are implementing the design tokens for this specific component."),
                    files: z.array(z.object({
                        path: z.string(),
                        content: z.string()
                    }))
                }),
                maxTokens: 32768,
            });

            object.catch(() => {});
            let previousLength = 0;
            let partCount = 0;
            let lastLogTime = Date.now();
            for await (const partial of partialObjectStream) {
                partCount++;
                const now = Date.now();
                if (now - lastLogTime >= 2000) {
                    logger.info(`[AI] coderNode: Recvd ${partCount} parts (Alive)...`);
                    lastLogTime = now;
                }

                if (partial.thoughtProcess && partial.thoughtProcess.length > previousLength) {
                    const delta = partial.thoughtProcess.substring(previousLength);
                    if (sendEvent) sendEvent({ type: 'thinking', component: componentNameFull, node: 'Coding', text: delta });
                    previousLength = partial.thoughtProcess.length;
                }
            }

            finalObject = await object;

            if (!finalObject || !finalObject.files) {
                throw new Error("Failed to extract valid JSON from coder stream");
            }
            break; // Success!
        } catch (error) {
            logger.error(`[Graph] Coder error (Attempt ${attempt}/${maxAttempts}): ${error.message}`);

            if (isResilienceError(error) && !localIsFallback) {
                logger.error(`[Graph] 🚨 Sticky Fallback Triggered in coderNode.`);
                localIsFallback = true;
                await sleepWithJitter(attempt);
                continue;
            }

            if (attempt >= maxAttempts) throw error;
            await sleepWithJitter(attempt);
        }
    }

    logger.debug({ node: 'coder', rawOutput: finalObject }, 'LLM response');

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: coderNode complete (${duration}ms)`);

    const cleanFilePath = componentNameFull;
    if (finalObject.files && finalObject.files[0]) {
        finalObject.files[0].path = cleanFilePath;
    }

    // Incremental R2 Update (Synchronous)
    const { themeId } = state;
    if (themeId) {
        try {
            const filePath = cleanFilePath;
            const content = finalObject.files && finalObject.files[0] ? finalObject.files[0].content : "";
            const currentState = await getThemeState(themeId);
            const updatedState = [...currentState];
            const idx = updatedState.findIndex(s => (s.filePath || s.path) === filePath);
            const mod = { filePath, content, action: 'update', path: filePath };
            if (idx >= 0) updatedState[idx] = mod;
            else updatedState.push(mod);
            await uploadThemeState(themeId, updatedState);
            logger.info(`[R2] Incremental update saved for coderNode: ${filePath}`);
        } catch (e) { logger.warn(`[R2] Failed incremental update: ${e.message}`); }
    }

    return {
        currentComponentFiles: finalObject.files,
        tsErrors: [],
        reasoning: { node: 'coder', text: `Generated ${targetComponent.name} section.` },
        isFallback: localIsFallback // Persist fallback state
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

    const targetComp = components[currentComponentIndex];
    const componentNameFull = targetComp.name;

    if (sendEvent) sendEvent({ type: 'progress', stage: 'COMPONENT_LINTING', message: `Linting component ${componentNameFull}...`, component: componentNameFull });

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
        if (sendEvent) sendEvent({ type: 'progress', stage: 'AI_CORRECTING', message: `Self-healing component ${targetComp.name}...`, component: componentNameFull });
        logger.info(`[Graph] ❌ Node: tsQcNode complete (${duration}ms)`);
        return { tsErrors: errors };
    } else {
        logger.info(`[Graph] ✅ TS QC passed for ${targetComp.name}.`);
        if (sendEvent) sendEvent({ type: 'progress', stage: 'ts_qc', message: `✅ Syntax check passed.`, component: componentNameFull });
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
    const { components } = state;
    const sendEvent = config.configurable?.sendEvent;
    if (sendEvent) sendEvent({ type: 'progress', stage: 'assembler', message: 'Assembling finalized theme structure...' });

    // Filter out global components (header, footer, announcement-bar) because they are in theme.liquid
    const pageSections = components.filter(c => {
        const name = c.name.toLowerCase();
        const type = (c.type || '').toLowerCase();

        // 1. Strict name-based blocklist (most reliable for Shopify)
        const blocklist = ['header', 'footer', 'announcement', 'popup', 'newsletter-popup'];
        if (blocklist.some(blocked => name.includes(blocked))) return false;

        // 2. Strict type-based blocklist
        if (blocklist.some(blocked => type.includes(blocked))) return false;

        // 3. Skip snippets or layout shells that might have leaked in
        if (name.includes('theme.liquid') || type === 'layout' || type === 'snippet') return false;

        // 4. Explicit global flag check
        if (c.isGlobal === true) return false;

        return true;
    });

    const indexJson = {
        sections: {},
        order: []
    };

    for (const comp of pageSections) {
        const sectionId = normalizeFilename(comp.name, comp.type, false);
        indexJson.sections[sectionId] = {
            type: sectionId
        };
        indexJson.order.push(sectionId);
    }

    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: assemblerNode complete (${duration}ms)`);

    const indexJsonFile = {
        path: 'templates/index.json',
        content: JSON.stringify(indexJson, null, 2)
    };

    // Incremental R2 Update (Synchronous)
    const { themeId } = state;
    if (themeId) {
        try {
            const currentState = await getThemeState(themeId);
            const updatedState = [...currentState];
            const filePath = 'templates/index.json';
            const idx = updatedState.findIndex(s => (s.filePath || s.path) === filePath);
            const mod = { filePath, content: indexJsonFile.content, action: 'update', path: filePath };
            if (idx >= 0) updatedState[idx] = mod;
            else updatedState.push(mod);
            await uploadThemeState(themeId, updatedState);
            logger.info(`[R2] Incremental update saved for assemblerNode: ${filePath}`);
        } catch (e) { logger.warn(`[R2] Failed incremental update in assemblerNode: ${e.message}`); }
    }

    return {
        generatedFiles: [indexJsonFile],
        assemblyErrors: [],
        reasoning: { node: 'assembler', text: `Assembled ${pageSections.length} sections into index.json, excluding global elements.` }
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
    if (sendEvent) sendEvent({ type: 'progress', stage: 'assembly_qc', message: 'Auditing theme structure...' });
    const errors = [];


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
        if (sendEvent) sendEvent({ type: 'progress', stage: 'AI_CORRECTING', message: `Correcting assembly issues...`, component: 'Assembly Audit' });
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
    if (sendEvent) sendEvent({ type: 'progress', stage: 'design_qc', message: 'Reviewing visual aesthetics...', component: 'Visual QC' });

    if (state.tsErrors && state.tsErrors.length > 0) {
        return { designErrors: [] };
    }

    let attempt = 0;
    const maxAttempts = 10;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { fullStream, text } = await streamText({
                model: google31ProSticky,
                system: `You are a Visual QC Auditor for a High-End Editorial Shopify theme.

## 1. DESIGN SYSTEM SOURCE OF TRUTH (Aesthetic)
${designSystemContent}

## 2. COMPONENT SYSTEM SOURCE OF TRUTH (Structure)
${componentSpecContent}

PASS the theme if ALL of the following are true:
1. DESIGN SYSTEM COMPLIANCE: The code follows the rules in DESIGN.md (No rounded corners, no 1px dividers, tonal layering, correct typography).
2. COMPONENT SPEC COMPLIANCE: The structure follows COMPONENT.md (Nesting, spacing, responsive behavior for specific sections).
3. VISUAL QUALITY: The theme looks premium — authoritative, asymmetrical, professional.
4. VANILLA JS ONLY: All interactivity uses Vanilla JS and Web Components.
5. VALID SCHEMAS: All {% schema %} blocks contain valid JSON.

REJECT ONLY for: Non-compliance with DESIGN.md/COMPONENT.md, broken Liquid, missing schemas, or framework code.

OUTPUT FORMAT:
Return a JSON object inside a \`\`\`json code block.
Schema:
{
  "passed": boolean,
  "errors": ["string"],
  "thoughtProcess": "string"
}`,
                prompt: `Design Tokens: ${JSON.stringify(designTokens)}\n\nGenerated Code for Review:\n${JSON.stringify(generatedFiles)}`,
                maxTokens: 32768,
            });

            let hasStartedStream = false;
            let streamBuffer = "";
            let partCount = 0;

            let lastLogTime = Date.now();
            for await (const part of fullStream) {
                partCount++;
                const delta = part.textDelta || part.reasoning || part.thought || part.text || "";

                if (!hasStartedStream && delta) {
                    logger.info(`[AI] agenticQcNode stream started (Recvd ${partCount} parts)...`);
                    hasStartedStream = true;
                    lastLogTime = Date.now(); // Reset timer on start
                }

                const now = Date.now();
                if (now - lastLogTime >= 2000) {
                    logger.info(`[AI] agenticQcNode: Recvd ${partCount} parts (Alive)...`);
                    lastLogTime = now;
                }

                if (delta) {
                    streamBuffer += delta;
                    if (sendEvent && part.type === 'text-delta') sendEvent({ type: 'thinking', node: 'agenticQc', text: delta, component: 'Visual QC' });

                    if (streamBuffer.length > 50 || streamBuffer.includes('\n')) {
                        logger.info(`[AI] ${streamBuffer}`);
                        streamBuffer = "";
                    }
                }
            }
            if (streamBuffer) logger.info(`[AI] ${streamBuffer}`);

            const finalText = await text;
            finalObject = extractJsonFromText(finalText);

            if (!finalObject || typeof finalObject.passed !== 'boolean') {
                throw new Error("Failed to extract valid JSON from agentic QC stream");
            }
            break; // Success!
        } catch (error) {
            if (error.name === 'AI_NoObjectGeneratedError' || error.name === 'AI_JSONParseError' || error.message.includes('extract valid JSON')) {
                logger.warn(`[Graph] Agentic QC error, Retrying (${attempt}/${maxAttempts})...`);
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

// (Utilities moved to top)

/**
 * --- UTILITY: Extract Structural Skeleton ---
 * Minimizes an HTML string to just its structural tags, classes, and IDs for LLM context.
 */
// (Already moved to top)

module.exports = {
    classifierNode,
    designerNode,
    plannerNode,
    contentWriterNode,
    structuralNode,
    coderNode,
    tsQcNode,
    assemblerNode,
    assemblyQcNode,
    agenticQcNode
};
