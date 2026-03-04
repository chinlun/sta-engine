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
    const contentKeys = ['content', 'code', 'body', 'source', 'file_content', 'fileContent'];
    let content = '';
    for (const key of contentKeys) {
        if (raw[key] && typeof raw[key] === 'string') {
            content = raw[key];
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
            const indexJson = JSON.parse(indexJsonMod.content);
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

    return result;
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

    // Apply global settings (stub)
    if (plan.globalSettings) {
        console.log("Applying global settings:", plan.globalSettings);
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
