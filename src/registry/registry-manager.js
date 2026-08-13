const fs = require('fs');
const path = require('path');
let logger;
try {
    logger = require('../lib/logger').logger;
} catch (e) {
    logger = console;
}

const cssNormalizer = require('./css-normalizer');

const SECTIONS_DIR = path.join(__dirname, 'sections');

// Cache loaded registries in memory
const registryCache = new Map();

/**
 * Loads a section registry directory by name (e.g. 'featured-product', 'header', etc.)
 */
function loadSectionRegistry(sectionType) {
    if (registryCache.has(sectionType)) {
        return registryCache.get(sectionType);
    }

    const sectionDir = path.join(SECTIONS_DIR, sectionType);
    if (!fs.existsSync(sectionDir)) {
        logger.warn(`[RegistryManager] Section registry directory does not exist: ${sectionDir}`);
        return null;
    }

    try {
        const manifestPath = path.join(sectionDir, 'manifest.json');
        const manifest = fs.existsSync(manifestPath)
            ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            : { name: sectionType, version: '1.0.0' };

        const sectionLiquidPath = path.join(sectionDir, 'section.liquid');
        const sectionLiquid = fs.existsSync(sectionLiquidPath)
            ? fs.readFileSync(sectionLiquidPath, 'utf8')
            : '';

        const stylesCssPath = path.join(sectionDir, 'styles.css');
        const stylesCss = fs.existsSync(stylesCssPath)
            ? fs.readFileSync(stylesCssPath, 'utf8')
            : '';

        const scriptJsPath = path.join(sectionDir, 'script.js');
        const scriptJs = fs.existsSync(scriptJsPath)
            ? fs.readFileSync(scriptJsPath, 'utf8')
            : '';

        // Load snippets
        const snippetsDir = path.join(sectionDir, 'snippets');
        const snippets = {};
        if (fs.existsSync(snippetsDir)) {
            const snippetFiles = fs.readdirSync(snippetsDir).filter(f => f.endsWith('.liquid'));
            for (const file of snippetFiles) {
                snippets[`snippets/${file}`] = fs.readFileSync(path.join(snippetsDir, file), 'utf8');
            }
        }

        // Load presets
        const presetsDir = path.join(sectionDir, 'presets');
        const presets = {};
        if (fs.existsSync(presetsDir)) {
            const presetFiles = fs.readdirSync(presetsDir).filter(f => f.endsWith('.json'));
            for (const file of presetFiles) {
                const presetName = file.replace('.json', '');
                try {
                    presets[presetName] = JSON.parse(fs.readFileSync(path.join(presetsDir, file), 'utf8'));
                } catch (err) {
                    logger.warn(`[RegistryManager] Failed to parse preset ${file} in ${sectionType}: ${err.message}`);
                }
            }
        }

        // Load variants
        const variantsDir = path.join(sectionDir, 'variants');
        const variants = {};
        if (fs.existsSync(variantsDir)) {
            const variantFiles = fs.readdirSync(variantsDir);
            for (const file of variantFiles) {
                const ext = path.extname(file);
                const name = path.basename(file, ext);
                if (!variants[name]) variants[name] = {};
                const fullPath = path.join(variantsDir, file);
                if (ext === '.liquid') {
                    variants[name].liquid = fs.readFileSync(fullPath, 'utf8');
                } else if (ext === '.css') {
                    variants[name].css = fs.readFileSync(fullPath, 'utf8');
                }
            }
        }

        const registryData = {
            sectionType,
            manifest,
            sectionLiquid,
            stylesCss,
            scriptJs,
            snippets,
            presets,
            variants,
            defaultPreset: presets['default'] || Object.values(presets)[0] || {}
        };

        registryCache.set(sectionType, registryData);
        return registryData;
    } catch (err) {
        logger.error(`[RegistryManager] Error loading registry for "${sectionType}": ${err.message}`);
        return null;
    }
}

/**
 * Discovers all registered section types in src/registry/sections/
 */
function getAvailableRegistries() {
    if (!fs.existsSync(SECTIONS_DIR)) return [];
    return fs.readdirSync(SECTIONS_DIR).filter(item => {
        const fullPath = path.join(SECTIONS_DIR, item);
        return fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'section.liquid'));
    });
}

/**
 * Unified assembly engine for any section registry type
 */
function assembleRegistryFiles(sectionType, configPatch = {}, designTokens = {}, shopName = "", sectionTargetName = "", presetId = "default") {
    // Check for legacy specific assemblers first
    if (sectionType === 'header') {
        const { loadHeaderRegistry, assembleHeaderFiles } = require('./header-assembler');
        return assembleHeaderFiles(loadHeaderRegistry(), configPatch, designTokens, shopName);
    }
    if (sectionType === 'hero') {
        const { loadHeroRegistry, assembleHeroFiles } = require('./hero-assembler');
        return assembleHeroFiles(loadHeroRegistry(), configPatch, designTokens, shopName, sectionTargetName || 'hero');
    }
    if (sectionType === 'product-grid' || sectionType === 'featured-collection') {
        const { loadProductGridRegistry, assembleProductGridFiles } = require('./product-grid-assembler');
        return assembleProductGridFiles(loadProductGridRegistry(), configPatch, designTokens, shopName, sectionTargetName || 'featured-collection');
    }
    if (sectionType === 'footer') {
        const { loadFooterRegistry, assembleFooterFiles } = require('./footer-assembler');
        return assembleFooterFiles(loadFooterRegistry(), configPatch, designTokens, shopName);
    }

    // Generic Registry Assembly for all new section registries
    const registry = loadSectionRegistry(sectionType);
    if (!registry) {
        throw new Error(`Registry for section type "${sectionType}" not found.`);
    }

    const { variants } = registry;
    let { sectionLiquid, stylesCss, scriptJs, snippets, presets } = registry;
    const settingsPatch = configPatch?.settings_patch || {};
    const deltaCss = configPatch?.delta_css || "";
    const deltaJs = configPatch?.delta_js || "";

    const targetPresetId = configPatch?.preset_id || presetId || "default";
    const selectedPreset = presets[targetPresetId] || registry.defaultPreset || {};
    const presetSettings = selectedPreset.settings || {};

    let targetVariantId = configPatch?.variant || configPatch?.variant_id || configPatch?.preset_id || presetId || "default";

    if (variants && Object.keys(variants).length > 0) {
        if (!variants[targetVariantId] || targetVariantId === 'default') {
            const rationale = (configPatch?.rationale || '').toLowerCase();
            const variantKeys = Object.keys(variants);
            const matchedKey = variantKeys.find(k => rationale.includes(k.replace(/-/g, ' ')) || rationale.includes(k) || targetPresetId.includes(k));
            if (matchedKey) {
                targetVariantId = matchedKey;
            } else if (variantKeys.length > 0) {
                targetVariantId = variantKeys[Math.floor(Math.random() * variantKeys.length)];
            }
        }
        if (variants[targetVariantId]) {
            if (variants[targetVariantId].liquid) sectionLiquid = variants[targetVariantId].liquid;
            if (variants[targetVariantId].css) stylesCss = `${stylesCss}\n${variants[targetVariantId].css}`;
        }
    }

    logger.info(`[RegistryManager] Assembling section "${sectionType}" using variant "${targetVariantId}" (requested preset: "${targetPresetId}")`);

    const colors = designTokens.colors || designTokens.palette || {};
    const defaultBg = colors.background || '#FFFFFF';
    const defaultText = colors.text || '#111111';
    const defaultPrimary = colors.primary || '#000000';

    let customizedSectionLiquid = sectionLiquid;

    // Validate settings against Liquid schema
    let validSettingsMap = {};
    try {
        const schemaMatch = sectionLiquid.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
        if (schemaMatch) {
            const schemaObj = JSON.parse(schemaMatch[1]);
            if (Array.isArray(schemaObj.settings)) {
                for (const s of schemaObj.settings) {
                    if (s.id) validSettingsMap[s.id] = s;
                }
            }
        }
    } catch (err) {
        logger.warn(`[RegistryManager] Schema parse error in ${sectionType}: ${err.message}`);
    }

    const mergedSettings = {
        ...presetSettings,
        background_color: defaultBg,
        text_color: defaultText,
        primary_color: defaultPrimary,
        ...settingsPatch
    };

    const sanitizedSettings = {};
    for (const [key, val] of Object.entries(mergedSettings)) {
        const settingDef = validSettingsMap[key];
        if (!settingDef) continue;

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
            } else if (val === true || strVal === 'true') {
                sanitizedSettings[key] = validOptions[0];
            }
        } else if (settingDef.type === 'checkbox') {
            sanitizedSettings[key] = Boolean(val);
        } else if (['color', 'text', 'textarea', 'liquid', 'url'].includes(settingDef.type)) {
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

    // Update section liquid schema default values
    try {
        const schemaMatch = customizedSectionLiquid.match(/(\{%\s*schema\s*%\})([\s\S]*?)(\{%\s*endschema\s*%\})/);
        if (schemaMatch) {
            const schemaObj = JSON.parse(schemaMatch[2]);
            if (Array.isArray(schemaObj.settings)) {
                for (const s of schemaObj.settings) {
                    if (s.id && sanitizedSettings[s.id] !== undefined) {
                        s.default = sanitizedSettings[s.id];
                    }
                }
            }
            customizedSectionLiquid = customizedSectionLiquid.replace(
                schemaMatch[0],
                () => `${schemaMatch[1]}\n${JSON.stringify(schemaObj, null, 2)}\n${schemaMatch[3]}`
            );
        }
    } catch (err) {
        logger.warn(`[RegistryManager] Failed updating schema defaults: ${err.message}`);
    }

    // Asset Isolation (Option A: Individual Asset Files per Section)
    const assetCssName = `section-${sectionType}.css`;
    const assetJsName = `section-${sectionType}.js`;
    const assetTags = `{{ '${assetCssName}' | asset_url | stylesheet_tag }}\n<script src="{{ '${assetJsName}' | asset_url }}" defer="defer"></script>\n`;

    if (!customizedSectionLiquid.includes(assetCssName)) {
        customizedSectionLiquid = assetTags + '\n' + customizedSectionLiquid;
    }

    let sectionFileName = sectionTargetName || sectionType;
    if (!sectionFileName.endsWith('.liquid')) sectionFileName += '.liquid';
    if (!sectionFileName.startsWith('sections/')) sectionFileName = 'sections/' + sectionFileName;

    // Normalizer CSS function if exists
    const normalizerName = `normalize${sectionType.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')}Css`;
    const normalizerFn = cssNormalizer[normalizerName] || (c => c);

    const resultFiles = [
        {
            path: sectionFileName,
            content: customizedSectionLiquid
        },
        {
            path: `assets/${assetCssName}`,
            content: `${stylesCss}\n${normalizerFn(deltaCss)}`.trim()
        },
        {
            path: `assets/${assetJsName}`,
            content: `${scriptJs}\n${deltaJs}`.trim()
        }
    ];

    // Include snippets
    for (const [snippetPath, content] of Object.entries(snippets)) {
        resultFiles.push({ path: snippetPath, content });
    }

    // Delta files if provided
    if (configPatch?.delta_files && Array.isArray(configPatch.delta_files)) {
        for (const file of configPatch.delta_files) {
            if (file.path && file.content) resultFiles.push(file);
        }
    }

    return resultFiles;
}

module.exports = {
    loadSectionRegistry,
    getAvailableRegistries,
    assembleRegistryFiles
};
