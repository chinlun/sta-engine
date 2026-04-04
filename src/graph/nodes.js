const { z } = require("zod");
const { generateObject, streamObject } = require("ai");
const { gemini31Pro, gemini3Flash } = require("../lib/ai");
const { validateAndRepair } = require("../services/builder");
const { IntegrityManager } = require("../services/integrity-manager");
const { logger } = require("../lib/logger");
const fs = require('fs');
const path = require('path');

// --- DESIGN SYSTEM SOURCE OF TRUTH ---
let designSystemContent = "";
let componentSpecContent = "";
try {
    const designPath = path.join(__dirname, "../../docs/design-system/the-minimalist/DESIGN.md");
    designSystemContent = fs.readFileSync(designPath, "utf8");

    const componentPath = path.join(__dirname, "../../docs/design-system/the-minimalist/component.md");
    componentSpecContent = fs.readFileSync(componentPath, "utf8");
} catch (e) {
    logger.warn(`Design specification not found: ${e.message}`);
}

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
 * --- NODE 1.5: Designer Agent ---
 * Selects a palette and design tokens based on user input. (Step 1)
 */
async function designerNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: designerNode");
    const { userPrompt, referenceImageBase64 } = state;
    const sendEvent = config.configurable?.sendEvent;

    const messageContent = [
        { type: 'text', text: `User Prompt: ${userPrompt}` }
    ];

    if (referenceImageBase64) {
        messageContent.push({ type: 'image', image: referenceImageBase64 });
    }

    const { fullStream, object } = await streamObject({
        model: gemini31Pro,
        system: `You are the Lead Designer Agent. Your goal is to select a curated, high-end color palette and design tokens.
        
AESTHETIC RULES:
1. "Sophisticated" & Premium: Avoid basic colors. Use HSL-tailored, harmonious palettes.
2. Editorial Design: Prioritize typography and white space. No rounded corners (0px).
3. Authority: The design should feel authoritative and state-of-the-art.`,
        messages: [{ role: 'user', content: messageContent }],
        schema: z.object({
            design_tokens: z.object({
                colors: z.object({
                    primary: z.string().describe("Main brand color (e.g. deep charcoal #1a1a1a)"),
                    secondary: z.string().describe("Accent color (e.g. muted gold #c5a059)"),
                    background: z.string().describe("Main page background (e.g. off-white #f8f8f8)"),
                    surface: z.string().describe("Surface color for cards/sections"),
                    text: z.string().describe("Main body text color")
                }),
                typography: z.object({
                    heading_font: z.string().describe("Google Font name for headings (e.g. Noto Serif)"),
                    body_font: z.string().describe("Google Font name for body text (e.g. Inter)"),
                    scale: z.enum(["minimal", "standard", "bold"])
                }),
                spacing: z.string().describe("Base spacing unit (e.g. 4px, 8px)"),
                elevation: z.string().describe("Shadow style (e.g. subtle, glassmorphism)")
            }),
            reasoning: z.string()
        }),
        maxTokens: 4096,
    });

    for await (const part of fullStream) {
        if (sendEvent && part.type === 'object') sendEvent({ type: 'partial', node: 'designer', object: part.object });
    }

    const finalObject = await object;
    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: designerNode complete (${duration}ms)`);
    return {
        designTokens: finalObject.design_tokens,
        reasoning: { node: 'designer', text: finalObject.reasoning }
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

    const { fullStream, object } = await streamObject({
        model: gemini31Pro,
        system: `You are the Lead Shopify Architect. Based on the selected design tokens, break down the home page into a list of components.
        
BLUEPRINT RULES:
1. Editorial Hierarchy: Start with a strong visual hook (Hero), followed by product discovery, then brand story.
2. Global Layout Elements: Always include exactly one "header.liquid" and one "footer.liquid". EXPLICITLY set their type to "header" and "footer" and mark them as isGlobal: true.
3. Page Template Sections: All other components should be tagged as type "section" and will be part of the Home Page Template (index.json).
4. No HTML/CSS: Describe layouts in English (e.g. "A split layout with image on left and text on right").`,
        prompt: `User Prompt: ${userPrompt}\nCatalog Size: ${catalogSize}\nDesign Tokens: ${JSON.stringify(designTokens)}`,
        schema: z.object({
            components: z.array(z.object({
                name: z.string().describe("file_name, e.g. hero-banner.liquid, header.liquid, footer.liquid"),
                type: z.enum(["header", "footer", "section", "main-template", "snippet"]),
                isGlobal: z.boolean().optional().describe("MUST be true for elements like header/footer that live in the layout shell."),
                layout_directive: z.string().describe("Direction for the coder agent.")
            })).describe("List of all components for the theme. Global elements must be tagged correctly."),
            reasoning: z.string()
        }),
        maxTokens: 8192,
    });

    for await (const part of fullStream) {
        if (sendEvent && part.type === 'object') sendEvent({ type: 'partial', node: 'planner', object: part.object });
    }

    const finalObject = await object;
    const duration = Date.now() - startTime;
    logger.info(`[Graph] ✅ Node: plannerNode complete (${duration}ms)`);
    return {
        components: finalObject.components,
        reasoning: { node: 'planner', text: finalObject.reasoning }
    };
}

/**
 * --- NODE 2.5: Content Writer ---
 * Generates sophisticated copy for planned components. (Step 3)
 */
async function contentWriterNode(state, config) {
    const startTime = Date.now();
    logger.info("[Graph] Node: contentWriterNode");
    const { userPrompt, components, designTokens } = state;
    const sendEvent = config.configurable?.sendEvent;

    let attempt = 0;
    const maxAttempts = 3;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { fullStream, object } = await streamObject({
                model: gemini31Pro,
                system: `You are a High-End Editorial Copywriter.
                
TONE OF VOICE: "Sophisticated"
- Authoritative yet graceful.
- Concise, poetic, and evocative.
- Avoid marketing clichés (no "best in class", "one stop shop").
- Focus on craftsmanship, heritage, and the sensory experience.`,
                prompt: `User Prompt: ${userPrompt}\nPlanned Components: ${JSON.stringify(components)}\nDesign Vibe: ${designTokens.typography.heading_font}`,
                schema: z.object({
                    sectionContent: z.array(z.object({
                        componentName: z.string().describe("Exact file name from the components list, e.g. hero-banner.liquid"),
                        heading: z.string(),
                        subheading: z.string().optional(),
                        body: z.string().optional(),
                        cta_label: z.string().optional(),
                        marketing_hooks: z.array(z.string()).optional()
                    })).describe("List of content for each planned component."),
                    reasoning: z.string()
                }),
                maxTokens: 16384,
            });

            for await (const part of fullStream) {
                if (sendEvent && part.type === 'object') sendEvent({ type: 'partial', node: 'contentWriter', object: part.object });
            }

            finalObject = await object;
            break; // Success!
        } catch (error) {
            if (error.name === 'AI_NoObjectGeneratedError' || error.name === 'AI_JSONParseError') {
                logger.warn(`[Graph] Content Writer silent truncation or JSON error, Retrying (${attempt}/${maxAttempts})...`);
                if (attempt >= maxAttempts) throw error;
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

    // 1. Generate base.css with design tokens
    const baseCss = `
:root {
  --color-primary: ${designTokens.primary_color || '#000000'};
  --color-secondary: ${designTokens.secondary_color || '#999999'};
  --color-background: ${designTokens.background_color || '#ffffff'};
  --color-surface: ${designTokens.surface_color || '#f4f4f4'};
  --color-text: ${designTokens.text_color || '#111111'};
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
        tsErrors
    } = state;
    const sendEvent = config.configurable?.sendEvent;

    // Helper to truncate large strings but keep head/tail for context
    const truncate = (str, maxChars = 2000) => {
        if (!str || str.length <= maxChars) return str;
        return `${str.substring(0, maxChars / 2)}\n... [TRUNCATED] ...\n${str.substring(str.length - maxChars / 2)}`;
    };

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
        text: `You are building a single component for a Shopify theme.\nDesign Tokens: ${JSON.stringify(designTokens)}\nGlobal Layout Shell Context (Truncated): ${layoutShell ? truncate(layoutShell, 3000) : "Not Provided"}\n\nComponent to Build:\nName: ${targetComponent.name}\nType: ${targetComponent.type}\nLayout Directive: ${targetComponent.layout_directive}\nSophisticated Content: ${JSON.stringify(sectionContent[targetComponent.name] || {})} `
    });

    let attempt = 0;
    const maxAttempts = 3;
    let finalObject;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const { fullStream, object } = await streamObject({
                model: gemini31Pro,
                system: `# MISSION: GENERATE HIGH-END SHOPIFY SECTION (VANILLA CSS SPEC)
Goal: Prioritize architectural, editorial beauty using STANDARD CSS (No Tailwind).

## 1. DESIGN SYSTEM SOURCE OF TRUTH (Aesthetic)
${designSystemContent}

## 2. COMPONENT SYSTEM SOURCE OF TRUTH (Structure)
${componentSpecContent}

## 3. THE ARCHITECTURAL RULES
You are a Senior Frontend Engineer. Build a stunning, bespoke editorial eCommerce section.
- STYLING: EXCLUSIVELY use Vanilla CSS inside a <style> tag within the section. Use the CSS variables provided in :root (--color-primary, --font-heading, etc.).
- NO TAILWIND: Do NOT use Tailwind utility classes (py-10, flex, etc.) in the HTML. Use standard CSS classes.
- CONTENT: Use the provided "Sophisticated" content exactly. Do NOT hallucinate generic copy.
- TECH STACK: Shopify Liquid + Vanilla JS Web Components (Light DOM) for interactivity.
- LAYOUT: Use the "Intentional Asymmetry" and "No-Line" rules from the design system.

## 4. OUTPUT PROTOCOL
1. Liquid Code: Provide the full .liquid section file with internal <style> and <script> tags.
2. Schema: Provide a standard Shopify {% schema %} at the BOTTOM of the file.`
                ,
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
    const { components } = state;

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
        const sectionId = comp.name.replace('.liquid', '');
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

REJECT ONLY for: Non-compliance with DESIGN.md/COMPONENT.md, broken Liquid, missing schemas, or framework code.`,
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
