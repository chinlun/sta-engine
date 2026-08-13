const fs = require('fs');
const path = require('path');
let logger;
try {
    logger = require('../lib/logger').logger;
} catch (e) {
    logger = console;
}

const { normalizeHeaderCss } = require('./css-normalizer');

const REGISTRY_DIR = path.join(__dirname, 'sections/header');

/**
 * Loads registry files for the header section
 */
function loadHeaderRegistry() {
    try {
        const manifestPath = path.join(REGISTRY_DIR, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        const sectionLiquid = fs.readFileSync(path.join(REGISTRY_DIR, 'section.liquid'), 'utf8');
        const stylesCss = fs.readFileSync(path.join(REGISTRY_DIR, 'styles.css'), 'utf8');
        const scriptJs = fs.readFileSync(path.join(REGISTRY_DIR, 'script.js'), 'utf8');

        const snippetsDir = path.join(REGISTRY_DIR, 'snippets');
        const snippetFiles = fs.readdirSync(snippetsDir).filter(f => f.endsWith('.liquid'));
        
        const snippets = {};
        for (const file of snippetFiles) {
            snippets[`snippets/${file}`] = fs.readFileSync(path.join(snippetsDir, file), 'utf8');
        }

        const presetsDir = path.join(REGISTRY_DIR, 'presets');
        const presets = {};
        if (fs.existsSync(presetsDir)) {
            const presetFiles = fs.readdirSync(presetsDir).filter(f => f.endsWith('.json'));
            for (const file of presetFiles) {
                const presetName = file.replace('.json', '');
                try {
                    presets[presetName] = JSON.parse(fs.readFileSync(path.join(presetsDir, file), 'utf8'));
                } catch (err) {}
            }
        }
        const defaultPresetPath = path.join(presetsDir, 'default.json');
        const defaultPreset = fs.existsSync(defaultPresetPath) 
            ? JSON.parse(fs.readFileSync(defaultPresetPath, 'utf8'))
            : {};

        const variantsDir = path.join(REGISTRY_DIR, 'variants');
        const variants = {};
        if (fs.existsSync(variantsDir)) {
            const variantFiles = fs.readdirSync(variantsDir);
            for (const file of variantFiles) {
                const ext = path.extname(file);
                const name = path.basename(file, ext);
                if (!variants[name]) variants[name] = {};
                const fullPath = path.join(variantsDir, file);
                if (ext === '.liquid') variants[name].liquid = fs.readFileSync(fullPath, 'utf8');
                else if (ext === '.css') variants[name].css = fs.readFileSync(fullPath, 'utf8');
            }
        }

        return {
            manifest,
            sectionLiquid,
            stylesCss,
            scriptJs,
            snippets,
            presets,
            variants,
            defaultPreset
        };
    } catch (e) {
        logger.error(`[HeaderRegistry] Error loading header registry: ${e.message}`);
        throw e;
    }
}

/**
 * Assembles the final header section files (section.liquid + snippets + CSS/JS)
 * applying LLM configuration patch and design tokens.
 */
function assembleHeaderFiles(registry, configPatch, designTokens = {}, shopName = "") {
    const { variants } = registry;
    let { sectionLiquid, stylesCss, scriptJs, snippets, presets } = registry;
    const settingsPatch = configPatch?.settings_patch || {};
    let deltaCss = configPatch?.delta_css || "";
    const deltaJs = configPatch?.delta_js || "";
    const rationale = (configPatch?.rationale || "").toLowerCase();

    // 1. Load requested preset (or fallback to default)
    const presetId = configPatch?.preset_id || 'default';
    const selectedPreset = presets?.[presetId] || registry?.defaultPreset || {};
    const presetSettings = selectedPreset.settings || {};

    let targetVariantId = configPatch?.variant || configPatch?.variant_id || configPatch?.preset_id || selectedPreset.variant || presetId || "default";

    if (variants && Object.keys(variants).length > 0) {
        if (!variants[targetVariantId] || targetVariantId === 'default') {
            const variantKeys = Object.keys(variants);
            if ((rationale.includes('split') || rationale.includes('centered logo')) && variants['centered-split']) targetVariantId = 'centered-split';
            else if (rationale.includes('drawer') && variants['stacked-drawer']) targetVariantId = 'stacked-drawer';
            else if (rationale.includes('minimal') && variants['minimal-icon']) targetVariantId = 'minimal-icon';
            else if (rationale.includes('pill') && variants['floating-pill']) targetVariantId = 'floating-pill';
            else if (variantKeys.length > 0) {
                targetVariantId = variantKeys[Math.floor(Math.random() * variantKeys.length)];
            }
        }
        if (variants[targetVariantId]) {
            if (variants[targetVariantId].liquid) sectionLiquid = variants[targetVariantId].liquid;
            if (variants[targetVariantId].css) stylesCss = `${stylesCss}\n${variants[targetVariantId].css}`;
        }
    }

    logger.info(`[HeaderRegistry] Assembling header section using variant "${targetVariantId}" (requested preset: "${presetId}")`);

    const colors = designTokens.palette || {};
    const defaultBg = colors.background || '#FFFFFF';
    const defaultText = colors.text || '#111111';

    // Rationale Auto-Bridge for Header variations
    if (rationale.includes('centered logo') && !settingsPatch.desktop_logo_position) {
        settingsPatch.desktop_logo_position = 'center';
    }
    if (rationale.includes('drawer') && !settingsPatch.desktop_menu_content) {
        settingsPatch.desktop_menu_content = 'burger';
    }
    if (rationale.includes('sticky') && settingsPatch.enable_sticky_header === undefined) {
        settingsPatch.enable_sticky_header = true;
    }

    let customizedSectionLiquid = sectionLiquid;

    // Parse schema settings to validate patch values against schema constraints
    let validSettingsMap = {};
    try {
        const schemaMatch = sectionLiquid.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
        if (schemaMatch) {
            const schemaObj = JSON.parse(schemaMatch[1]);
            if (Array.isArray(schemaObj.settings)) {
                for (const s of schemaObj.settings) {
                    if (s.id) {
                        validSettingsMap[s.id] = s;
                    }
                }
            }
        }
    } catch (err) {
        logger.warn(`[HeaderRegistry] Failed to parse schema JSON for validation: ${err.message}`);
    }

    // Apply settings patch on top of requested preset and schema defaults
    const mergedSettings = {
        ...presetSettings,
        placement: "top",
        width_mode: "full",
        boxed_corner_style: "square",
        background_color: defaultBg,
        scroll_background_color: defaultBg,
        text_color: defaultText,
        scroll_text_color: defaultText,
        ...settingsPatch
    };

    // Filter and sanitize settings according to schema definitions
    const sanitizedSettings = {};
    for (let [key, val] of Object.entries(mergedSettings)) {
        const settingDef = validSettingsMap[key];
        if (!settingDef) continue; // Skip unknown setting IDs

        // BUGFIX: Sanitize null / "null" / "undefined" strings
        if (val === null || val === undefined || String(val).toLowerCase() === 'null' || String(val).toLowerCase() === 'undefined') {
            sanitizedSettings[key] = "";
            continue;
        }

        if (settingDef.type === 'select') {
            const validOptions = (settingDef.options || []).map(o => String(o.value));
            const strVal = String(val);
            if (validOptions.includes(strVal)) {
                sanitizedSettings[key] = strVal;
            } else if (val === true || strVal === 'true' || strVal === 'yes') {
                const fallback = validOptions.find(o => o !== 'none') || validOptions[0];
                sanitizedSettings[key] = fallback;
            } else if (val === false || strVal === 'false' || strVal === 'no') {
                const fallback = validOptions.includes('none') ? 'none' : validOptions[0];
                sanitizedSettings[key] = fallback;
            } else {
                logger.warn(`[HeaderRegistry] Invalid select value "${val}" for setting "${key}". Allowed values: [${validOptions.join(', ')}]. Skipping.`);
            }
        } else if (settingDef.type === 'checkbox') {
            sanitizedSettings[key] = Boolean(val);
        } else if (settingDef.type === 'color' || settingDef.type === 'text' || settingDef.type === 'textarea' || settingDef.type === 'liquid' || settingDef.type === 'url') {
            sanitizedSettings[key] = String(val);
        } else if (settingDef.type === 'range' || settingDef.type === 'number') {
            const numVal = Number(val);
            if (!isNaN(numVal)) {
                let bounded = numVal;
                if (settingDef.min !== undefined) bounded = Math.max(settingDef.min, bounded);
                if (settingDef.max !== undefined) bounded = Math.min(settingDef.max, bounded);
                sanitizedSettings[key] = bounded;
            }
        }
    }

    // Replace schema default values safely via JSON modification
    try {
        const schemaMatch = customizedSectionLiquid.match(/(\{%\s*schema\s*%\})([\s\S]*?)(\{%\s*endschema\s*%\})/);
        if (schemaMatch) {
            const schemaObj = JSON.parse(schemaMatch[2]);
            if (Array.isArray(schemaObj.settings)) {
                for (const s of schemaObj.settings) {
                    if (s.id && sanitizedSettings[s.id] !== undefined) {
                        const val = sanitizedSettings[s.id];
                        if (val === "" || val === null) {
                            delete s.default;
                        } else {
                            s.default = val;
                        }
                    }
                }
            }
            customizedSectionLiquid = customizedSectionLiquid.replace(
                schemaMatch[0],
                () => `${schemaMatch[1]}\n${JSON.stringify(schemaObj, null, 2)}\n${schemaMatch[3]}`
            );
        }
    } catch (err) {
        logger.warn(`[HeaderRegistry] Failed to update schema JSON: ${err.message}`);
    }

    // 2. Asset Isolation: Prepend asset tags into section.liquid (No inline <style> or <script> blocks)
    const assetTags = `{{ 'section-header.css' | asset_url | stylesheet_tag }}\n<script src="{{ 'section-header.js' | asset_url }}" defer="defer"></script>\n`;
    if (!customizedSectionLiquid.includes("section-header.css")) {
        customizedSectionLiquid = assetTags + '\n' + customizedSectionLiquid;
    }

    // 3. Populate header-group.json config without empty {} objects
    const headerGroupJson = {
        name: "Header Group",
        type: "header",
        sections: {
            header: {
                type: "header",
                settings: Object.keys(sanitizedSettings).length > 0 ? sanitizedSettings : { background_color: defaultBg, text_color: defaultText }
            }
        },
        order: ["header"]
    };

    // 4. Assemble all files with asset isolation
    const resultFiles = [
        {
            path: 'sections/header.liquid',
            content: customizedSectionLiquid
        },
        {
            path: 'assets/section-header.css',
            content: `${stylesCss}\n${normalizeHeaderCss(deltaCss)}`.trim()
        },
        {
            path: 'assets/section-header.js',
            content: `${scriptJs}\n${deltaJs}`.trim()
        },
        {
            path: 'sections/header-group.json',
            content: JSON.stringify(headerGroupJson, null, 2)
        }
    ];

    // Add snippet files
    for (const [snippetPath, content] of Object.entries(snippets)) {
        resultFiles.push({
            path: snippetPath,
            content
        });
    }

    // Add any delta files if provided by LLM
    if (configPatch?.delta_files && Array.isArray(configPatch.delta_files)) {
        for (const file of configPatch.delta_files) {
            if (file.path && file.content) {
                resultFiles.push(file);
            }
        }
    }

    return resultFiles;
}

module.exports = {
    loadHeaderRegistry,
    assembleHeaderFiles
};
