import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

// Cache for reference files (loaded once at startup)
let referenceCache: Map<string, string> | null = null;

/**
 * Loads and caches all reference files from docs/ and docs/reference/.
 * Called once at startup, results are cached for subsequent requests.
 */
function loadReferenceFiles(): Map<string, string> {
    if (referenceCache) return referenceCache;

    referenceCache = new Map();
    const docsDir = path.join(process.cwd(), 'docs');

    // Load docs/*.md
    loadMdFilesFromDir(docsDir, referenceCache);

    // Load docs/reference/*.md
    const refDir = path.join(docsDir, 'reference');
    loadMdFilesFromDir(refDir, referenceCache);

    console.log(`[PromptBuilder] Loaded ${referenceCache.size} reference files:`);
    for (const [name, content] of referenceCache) {
        console.log(`  - ${name} (${content.length} chars)`);
    }

    return referenceCache;
}

function loadMdFilesFromDir(dir: string, cache: Map<string, string>): void {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isFile()) {
            cache.set(file, fs.readFileSync(filePath, 'utf-8'));
        }
    }
}

/**
 * Extracts a file from the base Dawn theme ZIP.
 * Returns the file content as a string, or null if not found.
 */
export function extractFileFromBaseTheme(filePath: string): string | null {
    const baseTheme = process.env.BASE_THEME_FILE || 'dawn-15.4.1.zip';
    const zipPath = path.join(process.cwd(), baseTheme);

    if (!fs.existsSync(zipPath)) {
        console.warn(`[PromptBuilder] Base theme not found: ${zipPath}`);
        return null;
    }

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    // Detect root prefix (e.g. "dawn-15.4.1/")
    let rootPrefix = '';
    if (entries.length > 0) {
        const firstEntry = entries[0].entryName;
        if (firstEntry.endsWith('/') && entries.every(e => e.entryName.startsWith(firstEntry))) {
            rootPrefix = firstEntry;
        }
    }

    const fullPath = rootPrefix + filePath.replace(/^\//, '');
    const entry = zip.getEntry(fullPath);
    if (!entry) {
        console.warn(`[PromptBuilder] File not found in base theme: ${fullPath}`);
        return null;
    }

    const content = entry.getData().toString('utf-8');
    if (filePath.endsWith('.json')) {
        // Strip comments for AI context to ensure it sees valid JSON
        return content.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1');
    }
    return content;
}

/**
 * Builds the complete system prompt using layered context injection (CAT Strategy).
 * 
 * Layers:
 * 1. Role & Rules — Core behavioral rules (Three-Point Edit, etc.)
 * 2. OS 2.0 Architecture — How Shopify themes work
 * 3. Dawn File Map — What files exist in Dawn
 * 4. Liquid Reference — Syntax & patterns
 * 5. Current State — What's already been built
 * 6. Few-Shot Examples — Gold-standard modification examples
 */
export function buildSystemPrompt(
    currentIndexJson?: string | null,
    currentSettingsData?: string | null,
): string {
    const refs = loadReferenceFiles();
    const parts: string[] = [];

    // ═══════════════════════════════════════════
    // Layer 1: Core Role & Rules
    // ═══════════════════════════════════════════
    parts.push(`You are an elite Shopify theme designer and architect. You design themes that look like they cost $5,000 from a professional agency. When the user describes what they want for their store, you MUST:

1. FIRST, write out your design thinking and rationale as text. Explain what colors, typography pairings, and layout choices you're making and why. Outline your "designStyle" intent. Stream this naturally so the user can follow your thought process.

2. THEN, provide the global settings using a JSON markdown block with the exact header:
### \`globalSettings\`
\`\`\`json
{
  "primaryColor": "#C9A96E",
  "secondaryColor": "#141414",
  "accentColor": "#C9A96E",
  "backgroundColor": "#0A0A0A",
  "fontFamily": "montserrat_n4",
  "headingFont": "playfair_display_n6",
  "designStyle": "Luxury Dark"
}
\`\`\`
*(The engine will automatically compile these into the theme's settings_data.json)*

3. FINALLY, provide ALL file modifications using Markdown code blocks. Precede EACH code block with an exact file path header.
Example:
### \`sections/hero-luxury-watch.liquid\`
\`\`\`liquid
<section class="hero">...</section>
\`\`\`

### \`templates/index.json\`
\`\`\`json
{
  "sections": { ... },
  "order": [ ... ]
}
\`\`\`

## DESIGN AESTHETICS (CRITICAL)
- Every section MUST have polished, production-ready CSS.
- NEVER use browser-default fonts, plain backgrounds with no contrast, or unstyled text.
- Implement gradients, glassmorphism, subtle shadows, smooth transitions, and proper hover effects where appropriate.
- Use proper spatial rhythm and responsive padding.
- Refer strictly to the Design System Reference for color palettes and typographic hierarchy.

## THE "TWO-POINT EDIT" RULE (CRITICAL)
Every theme modification MUST evaluate and update BOTH of these files when relevant:
  - **templates/index.json** — Register sections in the "sections" object AND the "order" array.
  - **sections/*.liquid** — The actual Liquid section files with valid schema blocks.

## THE "GLOBAL SETTINGS" RULE (CRITICAL)
DO NOT create or modify \`config/settings_data.json\`. Use the \`globalSettings\` markdown block instead.

A section that is not registered in index.json will NOT render. ALWAYS include it.

## RENDERING ORDER RULE
Any new section added to templates/index.json MUST be included in the "order" array to appear on the page.

## SECTION SCHEMA RULE
Every .liquid file in sections/ MUST include a valid {% schema %} JSON block at the bottom with a "presets" array (e.g., [{"name": "Default"}]) to be selectable in the Shopify Theme Editor.

## CSS STANDARDS
- Use Shopify's native CSS variables: var(--color-base-accent-1), var(--font-body-family), etc.
- Use BEM naming convention for CSS classes.
- Wrap custom CSS in <style> tags within the .liquid file to keep it scoped to that section.

## FILE PATH FORMAT
- Always use relative paths starting with a folder name (e.g., "sections/hero.liquid", NOT "/sections/hero.liquid")
- Section filenames use hyphens (e.g., "image-banner.liquid", NOT "image_banner.liquid")`);

    // ═══════════════════════════════════════════
    // Layer 2: Design System Reference
    // ═══════════════════════════════════════════
    const dsRef = refs.get('design-system.md');
    if (dsRef) {
        parts.push(`\n## DESIGN SYSTEM REFERENCE\n${dsRef}`);
    }

    // ═══════════════════════════════════════════
    // Layer 3: Shopify OS 2.0 Architecture Reference
    // ═══════════════════════════════════════════
    const archRef = refs.get('shopify-os2-architecture.md');
    if (archRef) {
        parts.push(`\n## SHOPIFY OS 2.0 ARCHITECTURE REFERENCE\n${archRef}`);
    }

    // ═══════════════════════════════════════════
    // Layer 4: Base Theme File Map
    // ═══════════════════════════════════════════
    const baseThemeFile = process.env.BASE_THEME_FILE || 'dawn-15.4.1.zip';
    const isSkeleton = baseThemeFile.includes('skeleton');
    const mapName = isSkeleton ? 'skeleton-file-map.md' : 'dawn-file-map.md';
    const themeName = isSkeleton ? 'Skeleton' : 'Dawn';
    const fileMap = refs.get(mapName);
    if (fileMap) {
        // Inject the full map — tells the AI exactly what files exist
        parts.push(`\n## ${themeName.toUpperCase()} THEME FILE MAP\nThis is the complete file structure of the base ${themeName} theme you are modifying.\n${fileMap}`);
    }

    // ═══════════════════════════════════════════
    // Layer 5: Liquid Reference
    // ═══════════════════════════════════════════
    const cheatSheet = refs.get('liquid-cheat-sheet.md');
    if (cheatSheet) {
        parts.push(`\n## SHOPIFY LIQUID & OS 2.0 REFERENCE\n${cheatSheet}`);
    }

    // ═══════════════════════════════════════════
    // Layer 6: Current State Injection
    // ═══════════════════════════════════════════
    if (currentIndexJson || currentSettingsData) {
        parts.push(`\n## CURRENT THEME STATE
Use this to understand what has already been built. Do NOT lose or overwrite existing sections — merge your changes with the current state.`);

        if (currentIndexJson) {
            parts.push(`\n### Current templates/index.json
\`\`\`json
${currentIndexJson}
\`\`\``);
        }

        if (currentSettingsData) {
            // Truncate settings_data if very large (it can be 10k+ lines)
            const truncated = currentSettingsData.length > 8000
                ? currentSettingsData.substring(0, 8000) + '\n... [truncated for token efficiency]'
                : currentSettingsData;
            parts.push(`\n### Current config/settings_data.json
\`\`\`json
${truncated}
\`\`\``);
        }
    }

    // ═══════════════════════════════════════════
    // Layer 7: Few-Shot Examples
    // ═══════════════════════════════════════════
    parts.push(`\n## GOLD-STANDARD EXAMPLES

### Example 1: Adding a High-End Hero Banner Section
When asked to "add a hero banner", the modifications array should look like:

\`\`\`json
{
  "globalSettings": {
    "designStyle": "modern elegant",
    "primaryColor": "#C9A96E"
  },
  "modifications": [
    {
      "filePath": "sections/hero-banner.liquid",
      "action": "create",
      "content": "<section class=\\"hero-banner color-{{ section.settings.color_scheme }}\\">\\n  <div class=\\"hero-banner__bg-overlay\\"></div>\\n  <div class=\\"hero-banner__content page-width\\">\\n    {%- if section.settings.heading != blank -%}\\n      <h1 class=\\"hero-banner__heading heading--editorial {{ section.settings.heading_size }}\\">{{ section.settings.heading | escape }}</h1>\\n    {%- endif -%}\\n    {%- if section.settings.subheading != blank -%}\\n      <p class=\\"hero-banner__subheading subheading--meta\\">{{ section.settings.subheading | escape }}</p>\\n    {%- endif -%}\\n    {%- if section.settings.button_label != blank -%}\\n      <a href=\\"{{ section.settings.button_link }}\\" class=\\"button button--primary\\">{{ section.settings.button_label | escape }}</a>\\n    {%- endif -%}\\n  </div>\\n</section>\\n\\n<style>\\n  .hero-banner {\\n    position: relative;\\n    padding: clamp(64px, 10vw, 120px) 0;\\n    text-align: center;\\n    display: flex;\\n    align-items: center;\\n    justify-content: center;\\n    min-height: 60vh;\\n  }\\n  .hero-banner__bg-overlay {\\n    position: absolute;\\n    inset: 0;\\n    background: radial-gradient(circle at center, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.6) 100%);\\n    z-index: 1;\\n  }\\n  .hero-banner__content {\\n    position: relative;\\n    z-index: 2;\\n    max-width: 800px;\\n  }\\n  .hero-banner__heading {\\n    font-family: var(--font-heading-family);\\n    font-weight: 300;\\n    letter-spacing: -0.02em;\\n    line-height: 1.1;\\n    margin-bottom: 24px;\\n    text-shadow: 0 4px 12px rgba(0,0,0,0.3);\\n  }\\n  .hero-banner__subheading {\\n    font-family: var(--font-body-family);\\n    font-weight: 400;\\n    opacity: 0.9;\\n    margin-bottom: 32px;\\n    font-size: 1.125rem;\\n    line-height: 1.6;\\n  }\\n  .button--primary {\\n    background-color: var(--color-base-accent-1);\\n    color: var(--color-base-solid-button-labels);\\n    padding: 16px 40px;\\n    border-radius: 4px;\\n    font-weight: 600;\\n    text-transform: uppercase;\\n    letter-spacing: 0.05em;\\n    transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);\\n    border: none;\\n    display: inline-block;\\n    text-decoration: none;\\n  }\\n  .button--primary:hover {\\n    transform: translateY(-2px);\\n    box-shadow: 0 10px 20px rgba(0, 0, 0, 0.15);\\n  }\\n</style>\\n\\n{% schema %}\\n{\\n  \\"name\\": \\"Elite Hero Banner\\",\\n  \\"class\\": \\"section\\",\\n  \\"settings\\": [\\n    { \\"type\\": \\"text\\", \\"id\\": \\"heading\\", \\"label\\": \\"Heading\\", \\"default\\": \\"Elevate Your Standard\\" },\\n    { \\"type\\": \\"select\\", \\"id\\": \\"heading_size\\", \\"label\\": \\"Heading size\\", \\"options\\": [{\\"value\\": \\"h1\\", \\"label\\": \\"H1\\"}, {\\"value\\": \\"h0\\", \\"label\\": \\"H0\\"}], \\"default\\": \\"h1\\" },\\n    { \\"type\\": \\"text\\", \\"id\\": \\"subheading\\", \\"label\\": \\"Subheading\\", \\"default\\": \\"Discover the new collection of premium goods.\\" },\\n    { \\"type\\": \\"text\\", \\"id\\": \\"button_label\\", \\"label\\": \\"Button Label\\", \\"default\\": \\"Shop Now\\" },\\n    { \\"type\\": \\"url\\", \\"id\\": \\"button_link\\", \\"label\\": \\"Button Link\\" },\\n    { \\"type\\": \\"color_scheme\\", \\"id\\": \\"color_scheme\\", \\"label\\": \\"Color scheme\\", \\"default\\": \\"scheme-1\\" }\\n  ],\\n  \\"presets\\": [{ \\"name\\": \\"Elite Hero Banner\\" }]\\n}\\n{% endschema %}"
    },
    {
      "filePath": "templates/index.json",
      "action": "update",
      "content": "... (full index.json with the new section added to both 'sections' object AND 'order' array)"
    }
  ]
}
\`\`\`

### Example 2: Changing Brand Colors to a Premium Dark Theme
When asked to "make it a dark luxury theme", define the \`globalSettings\` without modifying \`settings_data.json\`:

\`\`\`json
{
  "globalSettings": { 
    "designStyle": "Luxury Dark",
    "primaryColor": "#F5F5F0",
    "secondaryColor": "#141414",
    "accentColor": "#C9A96E",
    "backgroundColor": "#0A0A0A",
    "fontFamily": "playfair_display_n4",
    "headingFont": "playfair_display_n6"
  },
  "modifications": []
}
\`\`\``);

    return parts.join('\n');
}
