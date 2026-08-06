import AdmZip from 'adm-zip';
import { ThemePlan, BuildThemeToolParams } from '../schema';
import path from 'path';
import { logger } from '../lib/logger';

/**
 * Normalizes a single modification object from LLM output.
 * The LLM can generate any key name:
 *   filePath, file_path, file, path, fileName, file_name, etc.
 * This function finds the right value regardless of key naming.
 */
export function normalizeMod(raw: any): { filePath: string | null; action: string; content: string } {
    // Find file path — check all known variants
    const filePathKeys = ['filePath', 'file_path', 'file', 'path', 'fileName', 'file_name', 'filename'];
    let filePath: string | null = null;
    for (const key of filePathKeys) {
        if (raw[key] && typeof raw[key] === 'string') {
            filePath = raw[key];
            break;
        }
    }

    // Find action
    const actionKeys = ['action', 'type', 'operation'];
    let action = 'update';
    for (const key of actionKeys) {
        if (raw[key] && typeof raw[key] === 'string') {
            action = raw[key];
            break;
        }
    }

    // Find content
    const contentKeys = ['contentSource', 'content', 'code', 'body', 'source', 'file_content', 'fileContent'];
    let content = '';
    for (const key of contentKeys) {
        if (raw[key] !== undefined) {
            if (Array.isArray(raw[key])) {
                content = raw[key].join('\n');
            } else if (typeof raw[key] === 'string') {
                content = raw[key];
            }
            break;
        }
    }

    // Post-process: Enforce kebab-case for sections (except header/footer)
    if (filePath && filePath.startsWith('sections/') && filePath.endsWith('.liquid')) {
        const parts = filePath.split('/');
        const filename = parts.pop()!;
        const baseName = filename.replace('.liquid', '');
        
        // Reserved names stay as is
        if (!['header', 'footer'].includes(baseName)) {
            const kebabBase = baseName
                .replace(/([a-z])([A-Z])/g, '$1-$2') // CamelCase -> kebab-case
                .replace(/[\s_]+/g, '-')            // spaces/underscores -> hyphens
                .toLowerCase()
                .replace(/^-+|-+$/g, '');           // trim leading/trailing hyphens
            
            filePath = `sections/${kebabBase}.liquid`;
        }
    }

    return { filePath, action, content };
}

// ═══════════════════════════════════════════════════════
// Validate & Auto-Repair (Item 4: Zero Broken Themes)
// ═══════════════════════════════════════════════════════

interface ValidationResult {
    valid: boolean;
    errors: string[];    // Critical — block deploy
    warnings: string[];  // Non-critical — logged but don't block
    repairs: string[];   // Auto-repairs applied
}

/**
 * Updates both the normalized mod and the raw mod content to keep them in sync.
 */
function updateModContent(mod: any, newContent: string) {
    mod.content = newContent;
    const contentKeys = ['contentSource', 'content', 'code', 'body', 'source', 'file_content', 'fileContent'];
    if (mod.raw) {
        for (const key of contentKeys) {
            if (mod.raw[key] !== undefined) {
                mod.raw[key] = newContent;
                break;
            }
        }
    }
}

/**
 * Validates and auto-repairs a theme plan before building.
 * Returns a ValidationResult with errors (block deploy), warnings (info only), and repairs (auto-fixed).
 */
export function validateAndRepair(plan: ThemePlan | BuildThemeToolParams): ValidationResult {
    const result: ValidationResult = { valid: true, errors: [], warnings: [], repairs: [] };
    const mods = plan.modifications || [];

    // Normalize all modifications first
    const normalizedMods: Array<{ filePath: string | null; action: string; content: string; raw: any }> = [];
    for (const rawMod of mods) {
        const normalized = normalizeMod(rawMod);
        normalizedMods.push({ ...normalized, raw: rawMod });
    }

    // Track state across mods
    const sectionFiles = new Set<string>();
    let indexJsonMod: { filePath: string; action: string; content: string; raw: any } | null = null;

    // --- MAIN VALIDATION & REPAIR LOOP ---
    for (const mod of normalizedMods) {
        if (!mod.filePath) continue;

        // Auto-repair: Strip leading '/'
        if (mod.filePath.startsWith('/')) {
            const fixedPath = mod.filePath.replace(/^\//, '');
            result.repairs.push(`Auto-stripped leading '/' from "${mod.filePath}" → "${fixedPath}"`);
            const filePathKeys = ['filePath', 'file_path', 'file', 'path', 'fileName', 'file_name', 'filename'];
            for (const key of filePathKeys) {
                if (mod.raw[key] === mod.filePath) {
                    mod.raw[key] = fixedPath;
                    break;
                }
            }
            mod.filePath = fixedPath;
        }

        // Auto-repair: Snippet files MUST have .liquid extension
        if (mod.filePath.startsWith('snippets/') && !mod.filePath.endsWith('.liquid')) {
            const ext = path.extname(mod.filePath);
            const fixedPath = mod.filePath.replace(ext, '.liquid');
            result.repairs.push(`Auto-renamed "${mod.filePath}" → "${fixedPath}" (snippets must use .liquid extension)`);
            const filePathKeys = ['filePath', 'file_path', 'file', 'path', 'fileName', 'file_name', 'filename'];
            for (const key of filePathKeys) {
                if (mod.raw[key] === mod.filePath) {
                    mod.raw[key] = fixedPath;
                    break;
                }
            }
            mod.filePath = fixedPath;
        }

        // Auto-repair: Enforce sluggified filenames for sections
        if (mod.filePath.startsWith('sections/') && mod.filePath.endsWith('.liquid')) {
            const baseName = path.basename(mod.filePath, '.liquid');
            // Sluggify: lowercase, replace non-alphanumeric with hyphens, trim hyphens
            const fixedBaseName = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            
            if (baseName !== fixedBaseName) {
                const fixedPath = path.join(path.dirname(mod.filePath), fixedBaseName + '.liquid').replace(/\\/g, '/');
                result.repairs.push(`Auto-sluggified section filename: "${mod.filePath}" → "${fixedPath}"`);
                const filePathKeys = ['filePath', 'file_path', 'file', 'path', 'fileName', 'file_name', 'filename'];
                for (const key of filePathKeys) {
                    if (mod.raw[key] === mod.filePath) {
                        mod.raw[key] = fixedPath;
                        break;
                    }
                }
                mod.filePath = fixedPath;
            }
        }

        // Track and Repair Section Schema & Syntax
        if (mod.filePath.startsWith('sections/') && mod.filePath.endsWith('.liquid')) {
            const sectionType = path.basename(mod.filePath, '.liquid');
            sectionFiles.add(sectionType);

            if (mod.action !== 'delete' && mod.content) {
                // Ensure schema existence
                if (!mod.content.includes('{% schema %}') || !mod.content.includes('{% endschema %}')) {
                    const sectionName = sectionType.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                    const defaultSchema = `\n\n{% schema %}\n{\n  "name": "${sectionName}",\n  "class": "section",\n  "settings": [\n    { "type": "color_scheme", "id": "color_scheme", "label": "Color scheme", "default": "scheme-1" }\n  ],\n  "presets": [{ "name": "${sectionName}" }]\n}\n{% endschema %}`;
                    updateModContent(mod, mod.content + defaultSchema);
                    result.repairs.push(`Auto-injected schema into "${mod.filePath}"`);
                    logger.info(`[Validator] 🛠️ Injected schema: ${mod.filePath}`);
                }

                // AI Hallucination: product_picker -> product
                if (mod.content.includes('product_picker')) {
                    updateModContent(mod, mod.content.replace(/"type":\s*"product_picker"/g, '"type": "product"'));
                    result.repairs.push(`Auto-fixed product_picker in "${mod.filePath}"`);
                }

                // AI Schema conflict: default vs presets + name length
                const schemaRegex = /\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/;
                const match = mod.content.match(schemaRegex);
                if (match) {
                    try {
                        const parsedSchema = JSON.parse(match[1]);
                        let schemaModified = false;

                        // Fix: default vs presets conflict
                        if (parsedSchema.presets && parsedSchema.default !== undefined) {
                            delete parsedSchema.default;
                            schemaModified = true;
                            result.repairs.push(`Auto-removed 'default' from ${mod.filePath} schema (presets present)`);
                        }

                        // Fix: schema name too long (Shopify max 25 chars)
                        if (parsedSchema.name && parsedSchema.name.length > 25) {
                            const oldName = parsedSchema.name;
                            parsedSchema.name = parsedSchema.name.substring(0, 25).trim();
                            schemaModified = true;
                            result.repairs.push(`Auto-truncated schema name in ${mod.filePath}: "${oldName}" → "${parsedSchema.name}"`);
                            logger.info(`[Validator] 🛠️ Truncated schema name: "${oldName}" → "${parsedSchema.name}"`);
                        }

                        // Also truncate preset names to match
                        if (parsedSchema.presets && Array.isArray(parsedSchema.presets)) {
                            for (const preset of parsedSchema.presets) {
                                if (preset.name && preset.name.length > 25) {
                                    preset.name = preset.name.substring(0, 25).trim();
                                    schemaModified = true;
                                }
                            }
                        }

                        if (schemaModified) {
                            updateModContent(mod, mod.content.replace(match[1], `\n${JSON.stringify(parsedSchema, null, 2)}\n`));
                        }
                    } catch (e) { }
                }

                // AI Schema repairs (url default stripping, product_picker fix, preset conflicts)
                const schemaRepairCount = repairShopifySchema(mod);
                if (schemaRepairCount > 0) {
                    result.repairs.push(`Auto-repaired ${schemaRepairCount} schema violations in "${mod.filePath}"`);
                }

                // AI Liquid syntax: modulo pipe in if-tag
                const syntaxRepairCount = repairLiquidSyntax(mod);
                if (syntaxRepairCount > 0) {
                    result.repairs.push(`Auto-repaired ${syntaxRepairCount} syntax violations in "${mod.filePath}"`);
                }
            }
        }

        // Conflict: index.json vs index.liquid
        if (mod.filePath === 'templates/index.json') {
            indexJsonMod = mod as any;
            const liquidConflict = normalizedMods.find(m => m.filePath === 'templates/index.liquid');
            if (liquidConflict) {
                liquidConflict.action = 'delete';
                result.repairs.push(`Auto-deleted "templates/index.liquid" to avoid index name collision`);
                logger.info(`[Validator] 🛠️ Resolved index conflict (deleting .liquid)`);
            }
        }

        // Conflict: sections/*.json vs sections/*.liquid (Shopify blocks both)
        if (mod.filePath.startsWith('sections/') && mod.filePath.endsWith('.json')) {
            const baseName = path.basename(mod.filePath, '.json');
            const liquidPath = `sections/${baseName}.liquid`.replace(/\\/g, '/');
            const liquidConflict = normalizedMods.find(m => m.filePath === liquidPath);

            if (liquidConflict) {
                mod.action = 'delete';
                result.repairs.push(`Auto-deleted "${mod.filePath}" to avoid collision with "${liquidPath}"`);
                logger.info(`[Validator] 🛠️ Resolved section collision: deleted .json in favor of .liquid`);
            } else {
                // Force rename to .liquid (modern sections MUST use .liquid to have schemas)
                const fixedPath = liquidPath;
                result.repairs.push(`Auto-renamed section "${mod.filePath}" → "${fixedPath}"`);
                const filePathKeys = ['filePath', 'file_path', 'file', 'path', 'fileName', 'file_name', 'filename'];
                for (const key of filePathKeys) {
                    if (mod.raw[key] === mod.filePath) {
                        mod.raw[key] = fixedPath;
                        break;
                    }
                }
                mod.filePath = fixedPath;

                // If it was raw JSON, the later schema injection will handle it if it's missing tags
            }
        }

        // settings_schema.json conflict (theme_info) — GUARDRAIL: always URL, never email
        if (mod.filePath === 'config/settings_schema.json' && mod.action !== 'delete' && mod.content) {
            try {
                const schema = JSON.parse(mod.content);
                if (Array.isArray(schema)) {
                    let modificationMade = false;
                    for (const section of schema) {
                        const isThemeInfo = section.name === 'theme_info' || section.id === 'theme_info' || section.name === 'Theme info';
                        if (!isThemeInfo) continue;

                        // --- Flat Object keys (official Shopify theme_info structure) ---
                        if (section.theme_support_email) {
                            delete section.theme_support_email;
                            modificationMade = true;
                        }
                        if (!section.theme_support_url) {
                            section.theme_support_url = 'https://help.shopify.com';
                            modificationMade = true;
                        }

                        // --- Settings Array (some themes use this) ---
                        if (section.settings && Array.isArray(section.settings)) {
                            const emailIdx = section.settings.findIndex((s: any) => s.id === 'theme_support_email');
                            if (emailIdx !== -1) {
                                section.settings.splice(emailIdx, 1);
                                modificationMade = true;
                            }
                            const hasUrl = section.settings.some((s: any) => s.id === 'theme_support_url');
                            if (!hasUrl) {
                                section.settings.push({
                                    type: 'text',
                                    id: 'theme_support_url',
                                    label: 'Theme Support URL',
                                    default: 'https://help.shopify.com'
                                });
                                modificationMade = true;
                            }
                        }

                        // --- theme_name: max 25 chars ---
                        if (section.theme_name && typeof section.theme_name === 'string' && section.theme_name.length > 25) {
                            section.theme_name = section.theme_name.substring(0, 25).trim();
                            modificationMade = true;
                            logger.info(`[Validator] 🛠️ Guardrail: truncated theme_name to 25 chars`);
                        }

                        // --- theme_documentation_url: required ---
                        if (!section.theme_documentation_url) {
                            section.theme_documentation_url = 'https://help.shopify.com';
                            modificationMade = true;
                            logger.info(`[Validator] 🛠️ Guardrail: injected missing theme_documentation_url`);
                        }

                        if (modificationMade) {
                            result.repairs.push(`Auto-fixed settings_schema.json theme_info guardrails`);
                        }
                    }
                    if (modificationMade) {
                        updateModContent(mod, JSON.stringify(schema, null, 2));
                    }
                }
            } catch (e) { }
        }
    } // END MAIN LOOP

    // Post-loop: Sections created but not registered in index.json
    if (sectionFiles.size > 0 && indexJsonMod && indexJsonMod.content) {
        try {
            const cleanContent = indexJsonMod.content.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1');
            const indexJson = JSON.parse(cleanContent);
            const registeredTypes = new Set(Object.values(indexJson.sections || {}).map((s: any) => s.type));
            const orderArray: string[] = indexJson.order || [];

            for (const sectionType of sectionFiles) {
                // EXCLUSION: Do not auto-register global sections (header, footer, etc.) in the page template
                const blocklist = ['header', 'footer', 'announcement', 'popup', 'newsletter-popup'];
                if (blocklist.some(blocked => sectionType.includes(blocked))) continue;

                if (!registeredTypes.has(sectionType)) {
                    const sectionKey = sectionType.replace(/-/g, '_');
                    indexJson.sections = indexJson.sections || {};
                    indexJson.sections[sectionKey] = { type: sectionType, settings: {} };
                    if (!orderArray.includes(sectionKey)) orderArray.push(sectionKey);
                    result.repairs.push(`Auto-registered section "${sectionType}" in index.json`);
                }
            }
            // Guardrail: Ensure any hero section key in indexJson.order is hoisted to position 0
            const heroKeys = orderArray.filter(key => {
                const sec = indexJson.sections[key];
                const secType = sec?.type || key;
                return secType.toLowerCase().includes('hero');
            });
            if (heroKeys.length > 0) {
                const nonHeroKeys = orderArray.filter(key => !heroKeys.includes(key));
                indexJson.order = [...heroKeys, ...nonHeroKeys];
            } else {
                indexJson.order = orderArray;
            }

            updateModContent(indexJsonMod, JSON.stringify(indexJson, null, 2));
        } catch { }
    } else if (sectionFiles.size > 0 && !indexJsonMod) {
        result.warnings.push(`New sections created but templates/index.json is missing from plan.`);
    }

    if (result.repairs.length > 0) {
        logger.info(`[Validator] ✅ Applied ${result.repairs.length} auto-repairs.`);
    }

    enforceShopifyLimits(normalizedMods, result, plan);
    return result;
}

const SHOPIFY_LIMITS = {
    JSON_TEMPLATE: 500 * 1024, // 500 KB (Shopify hard limit is 512KB)
    LIQUID_FILE: 250 * 1024,   // 250 KB (Shopify hard limit is 256KB)
    ASSET_FILE: 19 * 1024 * 1024 // 19 MB (Shopify hard limit is 20MB)
};

/**
 * Enforces Shopify file size limits by auto-splitting or minifying large files.
 */
function enforceShopifyLimits(normalizedMods: any[], result: ValidationResult, plan: ThemePlan | BuildThemeToolParams) {
    const newMods: any[] = [];

    for (const mod of normalizedMods) {
        if (!mod.filePath || mod.action === 'delete') continue;

        let contentBytes = Buffer.byteLength(mod.content, 'utf8');

        // 1. JSON Templates (> 500 KB)
        if (mod.filePath.endsWith('.json') && contentBytes > SHOPIFY_LIMITS.JSON_TEMPLATE) {
            try {
                // Step 1: Whitespace minification
                const parsed = JSON.parse(mod.content);
                let minified = JSON.stringify(parsed);
                let newBytes = Buffer.byteLength(minified, 'utf8');

                if (newBytes < contentBytes) {
                    result.repairs.push(`Minified JSON template "${mod.filePath}" (${(contentBytes / 1024).toFixed(1)}KB -> ${(newBytes / 1024).toFixed(1)}KB)`);
                    updateModContent(mod, minified);
                    contentBytes = newBytes;
                }

                // Step 2: If STILL too massive, attempt to extract settings (for index.json)
                if (contentBytes > SHOPIFY_LIMITS.JSON_TEMPLATE && mod.filePath === 'templates/index.json' && parsed.sections) {
                    let extractedCount = 0;
                    for (const [sectionId, sectionData] of Object.entries<any>(parsed.sections)) {
                        if (sectionData.settings && Object.keys(sectionData.settings).length > 0) {
                            // Convert settings string to check size
                            const settingsBytes = Buffer.byteLength(JSON.stringify(sectionData.settings), 'utf8');
                            if (settingsBytes > 1024) { // Only extract if section settings > 1KB
                                const sectionType = sectionData.type || sectionId;
                                const liquidPath = `sections/${sectionType}.liquid`;
                                const liquidMod = normalizedMods.find(m => m.filePath === liquidPath);

                                if (liquidMod && liquidMod.content) {
                                    // Inject into schema
                                    const schemaRegex = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/;
                                    const match = liquidMod.content.match(schemaRegex);
                                    if (match) {
                                        try {
                                            const schemaObj = JSON.parse(match[1]);
                                            schemaObj.default = schemaObj.default || {};
                                            schemaObj.default.settings = { ...schemaObj.default.settings, ...sectionData.settings };

                                            // Replace schema in liquid file
                                            const newSchemaStr = `{% schema %}\n${JSON.stringify(schemaObj, null, 2)}\n{% endschema %}`;
                                            const newLiquidContent = liquidMod.content.replace(schemaRegex, newSchemaStr);

                                            if (Buffer.byteLength(newLiquidContent, 'utf8') <= SHOPIFY_LIMITS.LIQUID_FILE) {
                                                updateModContent(liquidMod, newLiquidContent);

                                                // Remove from index
                                                delete sectionData.settings;
                                                extractedCount++;
                                            }
                                        } catch (e) { /* ignore parse errors in schema */ }
                                    }
                                }
                            }
                        }
                    }

                    if (extractedCount > 0) {
                        minified = JSON.stringify(parsed);
                        newBytes = Buffer.byteLength(minified, 'utf8');
                        result.repairs.push(`Extracted ${extractedCount} large section settings from "${mod.filePath}" into section schemas (${(contentBytes / 1024).toFixed(1)}KB -> ${(newBytes / 1024).toFixed(1)}KB)`);
                        updateModContent(mod, minified);
                        contentBytes = newBytes;
                    }
                }

                // Final safety check
                if (contentBytes > SHOPIFY_LIMITS.JSON_TEMPLATE) {
                    result.errors.push(`JSON template "${mod.filePath}" is ${(contentBytes / 1024).toFixed(1)}KB, exceeding Shopify's 512KB limit even after extraction.`);
                    result.valid = false;
                }
            } catch (e) {
                // Ignore parse errors, already handled previously
            }
        }

        // 2. Liquid Files (> 250 KB)
        else if (mod.filePath.endsWith('.liquid') && contentBytes > SHOPIFY_LIMITS.LIQUID_FILE) {
            let replacedContent = mod.content;
            let snippetCounter = 1;
            let extractedSnippets = 0;

            // Step 1: Extract massive SVG blocks
            const svgRegex = /<svg[\s\S]*?<\/svg>/gi;
            replacedContent = replacedContent.replace(svgRegex, (match: string) => {
                if (Buffer.byteLength(match, 'utf8') > 50 * 1024) { // > 50KB SVG
                    const snippetName = `auto-extracted-svg-${Date.now()}-${snippetCounter++}`;
                    const snippetPath = `snippets/${snippetName}.liquid`;

                    const newMod = { filePath: snippetPath, action: 'create', contentSource: [match] };
                    if (!plan.modifications) plan.modifications = [];
                    plan.modifications.push(newMod as any); // Add to main plan so builder sees it
                    extractedSnippets++;

                    return `{% render '${snippetName}' %}`;
                }
                return match;
            });

            if (extractedSnippets > 0) {
                result.repairs.push(`Auto-extracted ${extractedSnippets} massive SVG blocks from "${mod.filePath}" into snippets.`);
                updateModContent(mod, replacedContent);
                contentBytes = Buffer.byteLength(replacedContent, 'utf8');
            }

            // Final safety check
            if (contentBytes > SHOPIFY_LIMITS.LIQUID_FILE) {
                result.errors.push(`Liquid file "${mod.filePath}" is ${(contentBytes / 1024).toFixed(1)}KB, exceeding Shopify's 256KB limit even after extraction.`);
                result.valid = false;
            }
        }
    }
}

/**
 * Repairs common Shopify schema hallucinations from LLMs.
 * Returns the number of repairs made.
 */
function repairShopifySchema(mod: any): number {
    let repairCount = 0;
    const schemaRegex = /({%\s*schema\s*%})([\s\S]*?)({%\s*endschema\s*%})/;
    const match = mod.content.match(schemaRegex);
    if (!match) return 0;

    const prefix = match[1];
    let schemaJson = match[2];
    const suffix = match[3];

    // Repair 1: product_picker -> product (Global replacement in schema JSON)
    schemaJson = schemaJson.replace(/"type":\s*"product_picker"/g, '"type": "product"');
    repairCount++;

    // Repair 2: Remove "default" property from all settings of type "url" (Shopify rejects default values on url picker settings)
    try {
        const parsed = JSON.parse(schemaJson);
        let urlRepaired = false;

        const cleanUrlSettings = (settingsArr: any[]) => {
            if (Array.isArray(settingsArr)) {
                for (const s of settingsArr) {
                    if (s && s.type === 'url' && s.default !== undefined) {
                        delete s.default;
                        urlRepaired = true;
                    }
                }
            }
        };

        if (parsed.settings) cleanUrlSettings(parsed.settings);
        if (parsed.blocks && Array.isArray(parsed.blocks)) {
            for (const b of parsed.blocks) {
                if (b && b.settings) cleanUrlSettings(b.settings);
            }
        }

        if (urlRepaired) {
            schemaJson = JSON.stringify(parsed, null, 2);
            repairCount++;
            logger.info(`[Validator] 🛠️ Auto-removed 'default' from 'url' type setting in ${mod.filePath}`);
        }
    } catch (e) { }

    // Repair 3: SVG Placeholder hallucinations (e.g., "texture-1" -> "image")
    // Official list from https://shopify.dev/docs/api/liquid/filters/placeholder_svg_tag
    const validPlaceholders = /^(image|product-[1-6]|collection-[1-6]|lifestyle-[1-2]|product-apparel-[1-4]|collection-apparel-[1-4]|hero-apparel-[1-3]|blog-apparel-[1-3]|detailed-apparel-1)$/;
    const svgRegex = /\{\{\s*['"]([^'"]+?)['"]\s*\|\s*placeholder_svg_tag\s*\}\}/g;

    let svgRepairCount = 0;
    const newContentWithSvgFix = mod.content.replace(svgRegex, (match: string, name: string) => {
        if (!validPlaceholders.test(name)) {
            svgRepairCount++;
            return `{{ 'image' | placeholder_svg_tag }}`;
        }
        return match;
    });

    if (svgRepairCount > 0) {
        updateModContent(mod, newContentWithSvgFix);
        repairCount += svgRepairCount;
    }

    // Repair 4: Duplicate block types in a section schema (causes Shopify to ignore the file)
    try {
        const parsed = JSON.parse(schemaJson);
        if (parsed.blocks && Array.isArray(parsed.blocks)) {
            const seenTypes = new Set<string>();
            const uniqueBlocks = [];
            let deduplicated = false;
            for (const block of parsed.blocks) {
                if (typeof block.type === 'string') {
                    if (seenTypes.has(block.type)) {
                        deduplicated = true;
                        continue; // Skip duplicate block type definitions
                    }
                    seenTypes.add(block.type);
                }
                uniqueBlocks.push(block);
            }
            if (deduplicated) {
                schemaJson = JSON.stringify(parsed, null, 2);
                repairCount++;
            }
        }
    } catch (e) {
        // Skip repair if JSON is currently invalid (will be caught by IntegrityManager)
    }

    // Repair 5: Missing "presets" or "name" in a section schema (makes it unusable in JSON templates)
    try {
        const parsed = JSON.parse(schemaJson);
        let modified = false;

        // Ensure "name" exists
        if (!parsed.name) {
            const sectionType = path.basename(mod.filePath, '.liquid');
            parsed.name = sectionType.split('-').map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
            modified = true;
        }

        // Ensure at least one preset exists for dynamic sections
        if (!parsed.presets || !Array.isArray(parsed.presets) || parsed.presets.length === 0) {
            parsed.presets = [{ name: parsed.name }];
            modified = true;
        }

        if (modified) {
            schemaJson = JSON.stringify(parsed, null, 2);
            repairCount++;
        }
    } catch (e) { }

    // Repair 6: "default" vs "presets" conflict (cannot define both on top level)
    try {
        const parsed = JSON.parse(schemaJson);
        if (parsed.presets && parsed.presets.length > 0 && parsed.default !== undefined) {
            delete parsed.default;
            schemaJson = JSON.stringify(parsed, null, 2);
            repairCount++;
            logger.info(`[Validator] 🛠️ Fixed schema conflict (default vs presets) in ${mod.filePath}`);
        }
    } catch (e) { }

    if (repairCount > 0) {
        const newContent = mod.content.replace(schemaRegex, `${prefix}${schemaJson}${suffix}`);
        updateModContent(mod, newContent);
    }

    return repairCount;
}

/**
 * Repairs common Liquid syntax hallucinations from LLMs.
 */
function repairLiquidSyntax(mod: any): number {
    let repairCount = 0;
    let content = mod.content;

    // Repair 1: modulo filter used directly in if/unless tags (Shopify does not support pipes in if-tags)
    // Pattern: {% if forloop.index | modulo: 2 == 0 %}
    // Fix: {% assign mod_val = forloop.index | modulo: 2 %}{% if mod_val == 0 %}
    const moduloIfRegex = /\{%-?\s*(if|unless)\s+([\s\S]+?)\s*\|\s*modulo:\s*(\d+)\s*(==|!=|>|<|>=|<=)\s*(\d+)\s*-?%\}/g;

    if (moduloIfRegex.test(content)) {
        content = content.replace(moduloIfRegex, (match: string, tag: string, variable: string, divisor: string, operator: string, value: string) => {
            repairCount++;
            const tempVar = `mod_${Math.floor(Math.random() * 1000)}`;
            return `{% assign ${tempVar} = ${variable} | modulo: ${divisor} %}{% ${tag} ${tempVar} ${operator} ${value} %}`;
        });
    }

    // Repair 2: Malformed or unclosed quote in split / filter arguments
    // Pattern e.g.: | split: '" or | split: '
    const malformedSplitRegex = /(\|\s*split:\s*)(['"])([^'"]*?)(?=\s*-?%\}|\s*\}\})/g;
    if (malformedSplitRegex.test(content)) {
        content = content.replace(malformedSplitRegex, (match: string, prefix: string, quote: string, val: string) => {
            if (!val.endsWith(quote)) {
                repairCount++;
                // If quote is unmatched (e.g. split: '" ), replace with valid split: ',' or close the quote
                return `${prefix}${quote}${val}${quote}`;
            }
            return match;
        });
    }

    // Repair 3: General unclosed quotes in Liquid tags before tag end (%} or }})
    const unclosedTagQuoteRegex = /(\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\})/g;
    content = content.replace(unclosedTagQuoteRegex, (tagMatch: string) => {
        // If single quote count inside tag is odd
        const singleQuotes = (tagMatch.match(/'/g) || []).length;
        const doubleQuotes = (tagMatch.match(/"/g) || []).length;
        if (singleQuotes % 2 !== 0 && tagMatch.includes("|")) {
            // Fix unclosed single quote right before %} or }}
            const fixedTag = tagMatch.replace(/(['"])([^'"]*?)(\s*-?%\}|\s*\}\})$/, "$1$2$1$3");
            if (fixedTag !== tagMatch) {
                repairCount++;
                return fixedTag;
            }
        }
        return tagMatch;
    });

    if (repairCount > 0) {
        updateModContent(mod, content);
    }
    return repairCount;
}

// ═══════════════════════════════════════════════════════
// Theme Builder
// ═══════════════════════════════════════════════════════

export const buildTheme = async (plan: ThemePlan): Promise<Buffer> => {
    const modCount = plan.modifications?.length || 0;
    logger.info(`[Builder] Building theme with ${modCount} modifications`);

    // Load the base theme
    const baseTheme = process.env.BASE_THEME_FILE || 'dawn-15.4.1.zip';
    const zipPath = path.join(process.cwd(), baseTheme);

    if (!require('fs').existsSync(zipPath)) {
        throw new Error(`Base theme file not found: ${zipPath}. Please ensure BASE_THEME_FILE is set correctly in .env.`);
    }

    const zip = new AdmZip(zipPath);

    // Detect root folder prefix in the zip (e.g., "dawn-15.4.1/")
    const entries = zip.getEntries();
    let rootPrefix = '';
    if (entries.length > 0) {
        const firstEntry = entries[0].entryName;
        if (firstEntry.endsWith('/') && entries.every(e => e.entryName.startsWith(firstEntry))) {
            rootPrefix = firstEntry;
            logger.info(`[Builder] Detected zip root folder: ${rootPrefix}`);
        }
    }

    // Apply global settings directly to the base settings_data.json
    if (plan.globalSettings) {
        logger.info(`[Builder] Applying global settings to config/settings_data.json: ${JSON.stringify(plan.globalSettings)}`);
        try {
            const settingsPath = rootPrefix + 'config/settings_data.json';
            const settingsEntry = zip.getEntry(settingsPath);
            if (settingsEntry) {
                const rawContent = settingsEntry.getData().toString('utf8');
                const cleanContent = rawContent.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1');
                const settingsJson = JSON.parse(cleanContent);

                const preset = settingsJson.presets?.Default || settingsJson.current;
                if (preset) {
                    // Update typography
                    if (plan.globalSettings.fontFamily) {
                        preset.type_body_font = plan.globalSettings.fontFamily;
                    }
                    if (plan.globalSettings.headingFont) {
                        preset.type_header_font = plan.globalSettings.headingFont;
                    }

                    // Update scheme-1
                    const scheme1 = preset.color_schemes?.['scheme-1']?.settings;
                    if (scheme1) {
                        if (plan.globalSettings.backgroundColor) scheme1.background = plan.globalSettings.backgroundColor;
                        if (plan.globalSettings.primaryColor) scheme1.text = plan.globalSettings.primaryColor;
                        if (plan.globalSettings.accentColor) {
                            scheme1.button = plan.globalSettings.accentColor;
                            scheme1.button_label = plan.globalSettings.backgroundColor || "#FFFFFF";
                        }
                        if (plan.globalSettings.secondaryColor) scheme1.secondary_button_label = plan.globalSettings.secondaryColor;
                    }

                    // Update scheme-2
                    const scheme2 = preset.color_schemes?.['scheme-2']?.settings;
                    if (scheme2) {
                        if (plan.globalSettings.secondaryColor) scheme2.background = plan.globalSettings.secondaryColor;
                        if (plan.globalSettings.primaryColor) scheme2.text = plan.globalSettings.primaryColor;
                        if (plan.globalSettings.accentColor) {
                            scheme2.button = plan.globalSettings.accentColor;
                            scheme2.button_label = plan.globalSettings.secondaryColor || "#FFFFFF";
                        }
                    }
                }

                // Remove AI-generated settings_data.json if present to prevent it from overwriting our patched version
                const modIdx = plan.modifications?.findIndex(m => m.filePath === 'config/settings_data.json' || m.filePath === 'settings_data.json');
                if (modIdx !== undefined && modIdx >= 0 && plan.modifications) {
                    logger.warn(`[Builder] Intercepted AI-generated settings_data.json. Replacing it with cleanly patched version.`);
                    plan.modifications.splice(modIdx, 1); // remove from array
                }

                // Write patched JSON back to the zip
                zip.updateFile(settingsPath, Buffer.from(JSON.stringify(settingsJson, null, 2), 'utf8'));
            } else {
                logger.warn(`[Builder] Could not find config/settings_data.json in base theme zip.`);
            }
        } catch (error) {
            logger.error(`[Builder] Failed to apply global settings: ${error}`);
        }
    }

    // Apply modifications (normalize keys from LLM output)
    const mods = plan.modifications || [];
    for (const rawMod of mods) {
        const { filePath, action, content } = normalizeMod(rawMod);

        if (!filePath) {
            logger.warn(`[Builder] Skipping modification — could not resolve filePath from keys: ${Object.keys(rawMod).join(', ')}`);
            continue;
        }

        const fullPath = rootPrefix + filePath.replace(/^\//, '');
        if (action === 'create' || action === 'update') {
            logger.info(`[Builder] ${action.toUpperCase()} ${fullPath} (${content.length} chars)`);
            zip.addFile(fullPath, Buffer.from(content, "utf8"));
        } else if (action === 'delete') {
            logger.info(`[Builder] DELETE ${fullPath}`);
            zip.deleteFile(fullPath);
        }
    }

    return zip.toBuffer();
};
