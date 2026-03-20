import AdmZip from 'adm-zip';
import { ThemePlan } from '../schema';
import path from 'path';

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
 * Validates and auto-repairs a theme plan before building.
 * Returns a ValidationResult with errors (block deploy), warnings (info only), and repairs (auto-fixed).
 * 
 * Mutates the modifications array in-place to apply repairs.
 */
export function validateAndRepair(plan: ThemePlan): ValidationResult {
    const result: ValidationResult = { valid: true, errors: [], warnings: [], repairs: [] };
    const mods = plan.modifications || [];

    // Normalize all modifications first
    const normalizedMods: Array<{ filePath: string | null; action: string; content: string; raw: any }> = [];
    for (const rawMod of mods) {
        const normalized = normalizeMod(rawMod);
        normalizedMods.push({ ...normalized, raw: rawMod });
    }

    // Track which section types are being created/updated
    const sectionFiles = new Set<string>();
    let indexJsonMod: { filePath: string; action: string; content: string; raw: any } | null = null;

    for (const mod of normalizedMods) {
        if (!mod.filePath) continue;

        // Auto-repair: Strip leading '/'
        if (mod.filePath.startsWith('/')) {
            const fixedPath = mod.filePath.replace(/^\//, '');
            result.repairs.push(`Auto-stripped leading '/' from "${mod.filePath}" → "${fixedPath}"`);
            // Update the raw mod with the fixed path
            for (const key of ['filePath', 'file_path', 'file', 'path', 'fileName', 'file_name', 'filename']) {
                if (mod.raw[key] === mod.filePath) {
                    mod.raw[key] = fixedPath;
                    break;
                }
            }
            mod.filePath = fixedPath;
        }

        // Track sections
        if (mod.filePath.startsWith('sections/') && mod.filePath.endsWith('.liquid')) {
            const sectionType = path.basename(mod.filePath, '.liquid');
            sectionFiles.add(sectionType);

            // Check: JSON validity is not applicable for .liquid files
            // Check: Schema presence
            if (mod.action !== 'delete' && mod.content) {
                if (!mod.content.includes('{% schema %}') || !mod.content.includes('{% endschema %}')) {
                    // Auto-repair: inject a default schema block
                    const sectionName = sectionType
                        .split('-')
                        .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
                        .join(' ');

                    const defaultSchema = `\n\n{% schema %}\n{\n  "name": "${sectionName}",\n  "class": "section",\n  "settings": [\n    { "type": "color_scheme", "id": "color_scheme", "label": "Color scheme", "default": "scheme-1" },\n    { "type": "range", "id": "padding_top", "min": 0, "max": 100, "step": 4, "unit": "px", "label": "Top padding", "default": 36 },\n    { "type": "range", "id": "padding_bottom", "min": 0, "max": 100, "step": 4, "unit": "px", "label": "Bottom padding", "default": 36 }\n  ],\n  "presets": [{ "name": "${sectionName}" }]\n}\n{% endschema %}`;

                    // Update content in the raw mod
                    for (const key of ['content', 'code', 'body', 'source', 'file_content', 'fileContent']) {
                        if (mod.raw[key] && typeof mod.raw[key] === 'string') {
                            mod.raw[key] += defaultSchema;
                            break;
                        }
                    }
                    mod.content += defaultSchema;

                    result.repairs.push(`Auto-injected {% schema %} block into "${mod.filePath}"`);
                }

                // Auto-repair: Shopify Schema Sanity (Fix hallucinations)
                const schemaRepairCount = repairShopifySchema(mod);
                if (schemaRepairCount > 0) {
                    result.repairs.push(`Auto-repaired ${schemaRepairCount} schema violations in "${mod.filePath}" (e.g., product_picker → product)`);
                }

                // Check: Liquid tag balance
                const liquidTagErrors = checkLiquidTagBalance(mod.content);
                if (liquidTagErrors.length > 0) {
                    // Auto-repair: append missing closing tags
                    let repaired = mod.content;
                    for (const missingTag of liquidTagErrors) {
                        repaired += `\n{% ${missingTag} %}`;
                        result.repairs.push(`Auto-appended missing {% ${missingTag} %} to "${mod.filePath}"`);
                    }
                    // Update content in the raw mod
                    for (const key of ['content', 'code', 'body', 'source', 'file_content', 'fileContent']) {
                        if (mod.raw[key] && typeof mod.raw[key] === 'string') {
                            mod.raw[key] = repaired;
                            break;
                        }
                    }
                    mod.content = repaired;
                }
            }
        }

        // Track index.json
        if (mod.filePath === 'templates/index.json') {
            indexJsonMod = mod as any;
        }

        // Check: JSON validity for .json files
        if (mod.filePath.endsWith('.json') && mod.action !== 'delete' && mod.content) {
            try {
                JSON.parse(mod.content);
            } catch (e) {
                result.errors.push(`Invalid JSON in "${mod.filePath}": ${(e as Error).message}`);
                result.valid = false;
            }
        }
    }

    // Check: Sections created but not registered in index.json
    if (sectionFiles.size > 0 && indexJsonMod && indexJsonMod.content) {
        try {
            const cleanContent = indexJsonMod.content.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1');
            const indexJson = JSON.parse(cleanContent);
            const registeredTypes = new Set(
                Object.values(indexJson.sections || {}).map((s: any) => s.type)
            );
            const orderArray: string[] = indexJson.order || [];

            for (const sectionType of sectionFiles) {
                if (!registeredTypes.has(sectionType)) {
                    // Auto-repair: add section to index.json
                    const sectionKey = sectionType.replace(/-/g, '_');
                    indexJson.sections = indexJson.sections || {};
                    indexJson.sections[sectionKey] = {
                        type: sectionType,
                        settings: {}
                    };
                    if (!orderArray.includes(sectionKey)) {
                        orderArray.push(sectionKey);
                    }
                    indexJson.order = orderArray;

                    result.repairs.push(`Auto-registered section "${sectionType}" in templates/index.json`);
                }
            }

            // Also check: sections in 'sections' but not in 'order'
            for (const key of Object.keys(indexJson.sections || {})) {
                if (!orderArray.includes(key)) {
                    orderArray.push(key);
                    result.repairs.push(`Auto-added "${key}" to index.json order array`);
                }
            }
            indexJson.order = orderArray;

            // Write back updated index.json
            const updatedContent = JSON.stringify(indexJson, null, 2);
            for (const key of ['content', 'code', 'body', 'source', 'file_content', 'fileContent']) {
                if (indexJsonMod.raw[key] && typeof indexJsonMod.raw[key] === 'string') {
                    indexJsonMod.raw[key] = updatedContent;
                    break;
                }
            }
        } catch {
            // index.json already flagged as invalid JSON above
        }
    } else if (sectionFiles.size > 0 && !indexJsonMod) {
        result.warnings.push(
            `New sections created (${[...sectionFiles].join(', ')}) but no templates/index.json modification found. ` +
            `These sections will not render on the homepage.`
        );
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
function enforceShopifyLimits(normalizedMods: any[], result: ValidationResult, plan: ThemePlan) {
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

function updateModContent(mod: any, newContent: string) {
    mod.content = newContent;
    if (mod.raw) {
        // Find existing key containing the content and update it
        for (const key of ['contentSource', 'content', 'code', 'body', 'source', 'file_content', 'fileContent']) {
            if (mod.raw[key] !== undefined) {
                if (Array.isArray(mod.raw[key])) {
                    mod.raw[key] = newContent.split('\n');
                } else if (typeof mod.raw[key] === 'string') {
                    mod.raw[key] = newContent;
                }
                break;
            }
        }
    }
}

/**
 * Checks Liquid tag balance and returns a list of missing closing tags.
 */
function checkLiquidTagBalance(content: string): string[] {
    const missingTags: string[] = [];
    const tagPairs: Record<string, string> = {
        'if': 'endif',
        'unless': 'endunless',
        'for': 'endfor',
        'case': 'endcase',
        'form': 'endform',
        'capture': 'endcapture',
        'comment': 'endcomment',
        'raw': 'endraw',
        'tablerow': 'endtablerow',
    };

    // Don't count tags inside {% schema %} blocks
    const contentWithoutSchema = content.replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, '');

    for (const [openTag, closeTag] of Object.entries(tagPairs)) {
        const openRegex = new RegExp(`\\{%-?\\s*${openTag}\\b`, 'g');
        const closeRegex = new RegExp(`\\{%-?\\s*${closeTag}\\s*-?%\\}`, 'g');

        const openCount = (contentWithoutSchema.match(openRegex) || []).length;
        const closeCount = (contentWithoutSchema.match(closeRegex) || []).length;

        if (openCount > closeCount) {
            for (let i = 0; i < openCount - closeCount; i++) {
                missingTags.push(closeTag);
            }
        }
    }

    return missingTags;
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

    // Repair 2: Remove "default" entirely for "type": "url" if it contains an anchor link (#)
    // Case A: "type": "url" comes BEFORE "default"
    const urlDefaultRegexA = /("type":\s*"url"[\s\S]*?),\s*"default":\s*"#[^"]*?"/g;
    if (urlDefaultRegexA.test(schemaJson)) {
        schemaJson = schemaJson.replace(urlDefaultRegexA, '$1');
        repairCount++;
    }

    // Case B: "default" comes BEFORE "type": "url"
    const urlDefaultRegexB = /"default":\s*"#[^"]*?",\s*([\s\S]*?"type":\s*"url")/g;
    if (urlDefaultRegexB.test(schemaJson)) {
        schemaJson = schemaJson.replace(urlDefaultRegexB, '$1');
        repairCount++;
    }

    // Repair 3: SVG Placeholder hallucinations (e.g., "texture-1" -> "image")
    // Shopify CLI only supports specific names. Everything else crashes the page.
    const validPlaceholders = /^(image|product-[1-6]|collection-[1-6]|lifestyle-[1-2])$/;
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

    if (repairCount > 0) {
        const newContent = mod.content.replace(schemaRegex, `${prefix}${schemaJson}${suffix}`);
        updateModContent(mod, newContent);
    }

    return repairCount;
}

// ═══════════════════════════════════════════════════════
// Theme Builder
// ═══════════════════════════════════════════════════════

export const buildTheme = async (plan: ThemePlan): Promise<Buffer> => {
    const modCount = plan.modifications?.length || 0;
    console.log("[Builder] Building theme with", modCount, "modifications");

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
            console.log(`[Builder] Detected zip root folder: ${rootPrefix}`);
        }
    }

    // Apply global settings directly to the base settings_data.json
    if (plan.globalSettings) {
        console.log("[Builder] Applying global settings to config/settings_data.json:", plan.globalSettings);
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
                    console.warn(`[Builder] Intercepted AI-generated settings_data.json. Replacing it with cleanly patched version.`);
                    plan.modifications.splice(modIdx, 1); // remove from array
                }

                // Write patched JSON back to the zip
                zip.updateFile(settingsPath, Buffer.from(JSON.stringify(settingsJson, null, 2), 'utf8'));
            } else {
                console.warn(`[Builder] Could not find config/settings_data.json in base theme zip.`);
            }
        } catch (error) {
            console.error("[Builder] Failed to apply global settings:", error);
        }
    }

    // Apply modifications (normalize keys from LLM output)
    const mods = plan.modifications || [];
    for (const rawMod of mods) {
        const { filePath, action, content } = normalizeMod(rawMod);

        if (!filePath) {
            console.warn('[Builder] Skipping modification — could not resolve filePath from keys:', Object.keys(rawMod));
            continue;
        }

        const fullPath = rootPrefix + filePath.replace(/^\//, '');
        if (action === 'create' || action === 'update') {
            console.log(`[Builder] ${action.toUpperCase()} ${fullPath} (${content.length} chars)`);
            zip.addFile(fullPath, Buffer.from(content, "utf8"));
        } else if (action === 'delete') {
            console.log(`[Builder] DELETE ${fullPath}`);
            zip.deleteFile(fullPath);
        }
    }

    return zip.toBuffer();
};
