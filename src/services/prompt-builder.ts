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

    return entry.getData().toString('utf-8');
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
    parts.push(`You are a senior Shopify theme architect. When the user describes what they want for their store, you MUST:

1. FIRST, write out your design thinking and rationale as text. Explain what colors, fonts, layout choices you're making and why. Stream this naturally so the user can follow your thought process.

2. THEN, immediately call the build_theme tool with the actual modifications. Do NOT ask for confirmation.

## THE "THREE-POINT EDIT" RULE (CRITICAL)
Every theme modification MUST evaluate and update ALL THREE of these files when relevant:
  - **templates/index.json** — Register sections in the "sections" object AND the "order" array.
  - **config/settings_data.json** — Apply global brand settings (colors, fonts, spacing).
  - **sections/*.liquid** — The actual Liquid section files with valid schema blocks.

A section that is not registered in index.json will NOT render. A color change not in settings_data.json will NOT apply. ALWAYS include all three.

## RENDERING ORDER RULE
Any new section added to templates/index.json MUST be included in the "order" array to appear on the page.

## SECTION SCHEMA RULE
Every .liquid file in sections/ MUST include a valid {% schema %} JSON block at the bottom with a "presets" array (e.g., [{"name": "Default"}]) to be selectable in the Shopify Theme Editor.

## CSS STANDARDS
- Use Shopify's native CSS variables: var(--color-base-accent-1), var(--font-body-family), etc.
- Use BEM naming convention for CSS classes.
- Wrap custom CSS in <style> tags within the .liquid file to keep it scoped to that section.

## ACTION TYPES
- "create": Create a new file
- "update": Replace an existing file's content
- "delete": Remove a file from the theme

## FILE PATH FORMAT
- Always use relative paths starting with a folder name (e.g., "sections/hero.liquid", NOT "/sections/hero.liquid")
- Section filenames use hyphens (e.g., "image-banner.liquid", NOT "image_banner.liquid")`);

    // ═══════════════════════════════════════════
    // Layer 2: Shopify OS 2.0 Architecture Reference
    // ═══════════════════════════════════════════
    const archRef = refs.get('shopify-os2-architecture.md');
    if (archRef) {
        parts.push(`\n## SHOPIFY OS 2.0 ARCHITECTURE REFERENCE\n${archRef}`);
    }

    // ═══════════════════════════════════════════
    // Layer 3: Dawn File Map
    // ═══════════════════════════════════════════
    const dawnMap = refs.get('dawn-file-map.md');
    if (dawnMap) {
        // Inject the full map — tells the AI exactly what files exist
        parts.push(`\n## DAWN THEME FILE MAP\nThis is the complete file structure of the base Dawn theme you are modifying.\n${dawnMap}`);
    }

    // ═══════════════════════════════════════════
    // Layer 4: Liquid Reference
    // ═══════════════════════════════════════════
    const cheatSheet = refs.get('liquid-cheat-sheet.md');
    if (cheatSheet) {
        parts.push(`\n## SHOPIFY LIQUID & OS 2.0 REFERENCE\n${cheatSheet}`);
    }

    // ═══════════════════════════════════════════
    // Layer 5: Current State Injection
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
    // Layer 6: Few-Shot Examples
    // ═══════════════════════════════════════════
    parts.push(`\n## GOLD-STANDARD EXAMPLES

### Example 1: Adding a Hero Banner Section
When asked to "add a hero banner", the modifications array should look like:

\`\`\`json
{
  "globalSettings": {},
  "modifications": [
    {
      "filePath": "sections/hero-banner.liquid",
      "action": "create",
      "content": "<section class=\\"hero-banner color-{{ section.settings.color_scheme }}\\">\\n  <div class=\\"hero-banner__content page-width\\">\\n    {%- if section.settings.heading != blank -%}\\n      <h1 class=\\"hero-banner__heading {{ section.settings.heading_size }}\\">{{ section.settings.heading | escape }}</h1>\\n    {%- endif -%}\\n    {%- if section.settings.subheading != blank -%}\\n      <p class=\\"hero-banner__subheading\\">{{ section.settings.subheading | escape }}</p>\\n    {%- endif -%}\\n  </div>\\n</section>\\n\\n<style>\\n  .hero-banner {\\n    padding: {{ section.settings.padding_top }}px 0 {{ section.settings.padding_bottom }}px;\\n    text-align: center;\\n  }\\n  .hero-banner__heading {\\n    font-family: var(--font-heading-family);\\n    margin-bottom: 1rem;\\n  }\\n  .hero-banner__subheading {\\n    font-family: var(--font-body-family);\\n    opacity: 0.8;\\n  }\\n</style>\\n\\n{% schema %}\\n{\\n  \\"name\\": \\"Hero Banner\\",\\n  \\"class\\": \\"section\\",\\n  \\"settings\\": [\\n    { \\"type\\": \\"text\\", \\"id\\": \\"heading\\", \\"label\\": \\"Heading\\", \\"default\\": \\"Welcome to our store\\" },\\n    { \\"type\\": \\"select\\", \\"id\\": \\"heading_size\\", \\"label\\": \\"Heading size\\", \\"options\\": [{\\"value\\": \\"h1\\", \\"label\\": \\"H1\\"}, {\\"value\\": \\"h0\\", \\"label\\": \\"H0\\"}], \\"default\\": \\"h1\\" },\\n    { \\"type\\": \\"text\\", \\"id\\": \\"subheading\\", \\"label\\": \\"Subheading\\", \\"default\\": \\"Discover our collection\\" },\\n    { \\"type\\": \\"color_scheme\\", \\"id\\": \\"color_scheme\\", \\"label\\": \\"Color scheme\\", \\"default\\": \\"scheme-1\\" },\\n    { \\"type\\": \\"range\\", \\"id\\": \\"padding_top\\", \\"min\\": 0, \\"max\\": 100, \\"step\\": 4, \\"unit\\": \\"px\\", \\"label\\": \\"Top padding\\", \\"default\\": 36 },\\n    { \\"type\\": \\"range\\", \\"id\\": \\"padding_bottom\\", \\"min\\": 0, \\"max\\": 100, \\"step\\": 4, \\"unit\\": \\"px\\", \\"label\\": \\"Bottom padding\\", \\"default\\": 36 }\\n  ],\\n  \\"presets\\": [{ \\"name\\": \\"Hero Banner\\" }]\\n}\\n{% endschema %}"
    },
    {
      "filePath": "templates/index.json",
      "action": "update",
      "content": "... (full index.json with the new section added to both 'sections' object AND 'order' array)"
    }
  ]
}
\`\`\`

### Example 2: Changing Brand Colors to Dark Theme
When asked to "make it a dark luxury theme", ALWAYS include settings_data.json:

\`\`\`json
{
  "globalSettings": { "primaryColor": "#C9A96E", "fontFamily": "playfair_display_n4" },
  "modifications": [
    {
      "filePath": "config/settings_data.json",
      "action": "update",
      "content": "... (full settings_data.json with scheme-1 background changed to '#0A0A0A', text to '#F5F5F5', accent to '#C9A96E', etc.)"
    }
  ]
}
\`\`\``);

    return parts.join('\n');
}
