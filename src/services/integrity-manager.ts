import path from 'path';

export class ValidationError extends Error {
    constructor(public filePath: string, public reason: string) {
        super(`Validation Error in ${filePath}: ${reason}`);
        this.name = 'ValidationError';
    }
}

export interface Modification {
    filePath: string;
    action: string;
    content: string;
}

export class IntegrityManager {
    /**
     * Orchestrates all validations for a set of modifications.
     */
    static validate(modifications: Modification[]): void {
        const indexJsonMod = modifications.find(m => m.filePath === 'templates/index.json');

        for (const mod of modifications) {
            if (!mod.content || mod.action === 'delete') continue;

            // 1. Validate Liquid blocks (no nested liquid in css/js)
            this.validateLiquidBlocks(mod.filePath, mod.content);

            // 2. Validate Schema JSON
            if (mod.filePath.endsWith('.liquid')) {
                this.validateSchemaJSON(mod.filePath, mod.content);
            }
        }

        // 3. Verify Template Integrity
        if (indexJsonMod) {
            this.verifyTemplateIntegrity(modifications, indexJsonMod.content);
        }
    }

    /**
     * Ensures no Liquid tags exists inside {% stylesheet %} or {% javascript %} tags.
     */
    static validateLiquidBlocks(filePath: string, content: string): void {
        const blockRegex = /\{%\s*(stylesheet|javascript)\s*%\}([\s\S]*?)\{%\s*end\1\s*%\}/g;
        const liquidTagRegex = /\{\{|%\}|\{%|\}\}/;

        let match;
        while ((match = blockRegex.exec(content)) !== null) {
            const blockType = match[1];
            const blockContent = match[2];

            if (liquidTagRegex.test(blockContent)) {
                throw new ValidationError(
                    filePath,
                    `Liquid tags are not allowed inside {% ${blockType} %} blocks. Move them to a separate Liquid block or use CSS/JS variables.`
                );
            }
        }
    }

    /**
     * Extracts and verifies {% schema %} is valid JSON.
     */
    static validateSchemaJSON(filePath: string, content: string): void {
        const schemaRegex = /\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/;
        const match = content.match(schemaRegex);

        if (match) {
            const jsonContent = match[1].trim();
            try {
                const parsed = JSON.parse(jsonContent);
                if (parsed.blocks && Array.isArray(parsed.blocks)) {
                    const seenTypes = new Set<string>();
                    for (const block of parsed.blocks) {
                        if (typeof block.type === 'string') {
                            if (seenTypes.has(block.type)) {
                                throw new ValidationError(
                                    filePath,
                                    `Duplicate block type "${block.type}" in section schema. All block types within a section must be unique.`
                                );
                            }
                            seenTypes.add(block.type);
                        }
                    }
                }
            } catch (e: any) {
                if (e instanceof ValidationError) throw e;
                throw new ValidationError(
                    filePath,
                    `Invalid JSON in {% schema %} block: ${e.message}`
                );
            }
        }
    }

    /**
     * Verifies that all types in templates/*.json have corresponding .liquid files.
     */
    static verifyTemplateIntegrity(modifications: Modification[], indexJsonContent: string): void {
        try {
            const cleanContent = indexJsonContent.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1');
            const indexJson = JSON.parse(cleanContent);
            const sections = indexJson.sections || {};

            // Build a map of available sections and their defined block types
            const availableSections = new Map<string, Set<string> | null>();
            for (const mod of modifications) {
                if (mod.filePath.startsWith('sections/') && mod.filePath.endsWith('.liquid')) {
                    const sectionName = path.basename(mod.filePath, '.liquid');
                    availableSections.set(sectionName, this.extractSchemaBlockTypes(mod.content));
                }
            }

            for (const [key, section] of Object.entries<any>(sections)) {
                const sectionType = section.type;
                if (!sectionType) continue;

                // Skip validation if it's a known base section in Dawn or Skeleton
                if (DAWN_BASE_SECTIONS.has(sectionType) || SKELETON_BASE_SECTIONS.has(sectionType)) continue;

                if (!availableSections.has(sectionType)) {
                    throw new ValidationError(
                        'templates/index.json',
                        `Missing section file: sections/${sectionType}.liquid (referenced by section "${key}"). 
If you are using a custom section, you MUST provide the .liquid file content. 
If you intended to use a built-in Dawn or Skeleton section, ensure the type matches exactly.`
                    );
                }

                // New: Validate block types within the section
                const validBlockTypes = availableSections.get(sectionType);
                if (validBlockTypes && section.blocks) {
                    for (const [blockKey, block] of Object.entries<any>(section.blocks)) {
                        if (block.type && !validBlockTypes.has(block.type)) {
                            throw new ValidationError(
                                'templates/index.json',
                                `Invalid block type "${block.type}" in section "${key}" (block "${blockKey}"). 
Available block types in "sections/${sectionType}.liquid" are: ${Array.from(validBlockTypes).join(', ') || '(none)'}.
Please update the template to use a valid block type or update the section schema.`
                            );
                        }
                    }
                }
            }
        } catch (e: any) {
            if (e instanceof ValidationError) throw e;
            console.error(`[IntegrityManager] JSON Parse Error during template verification: ${e.message}`);
        }
    }

    /**
     * Helper to extract block types from a liquid section's schema.
     */
    private static extractSchemaBlockTypes(content: string): Set<string> | null {
        const schemaRegex = /\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/;
        const match = content.match(schemaRegex);
        if (!match) return null;

        try {
            const schema = JSON.parse(match[1].trim());
            if (schema.blocks && Array.isArray(schema.blocks)) {
                return new Set(schema.blocks.map((b: any) => b.type).filter((t: any) => typeof t === 'string'));
            }
        } catch (e) {
            // If schema is invalid, validateSchemaJSON will catch it elsewhere
        }
        return new Set();
    }
}

const SKELETON_BASE_SECTIONS = new Set([
    '404', 'article', 'blog', 'cart', 'collection', 'collections', 'custom-section',
    'footer', 'header', 'hello-world', 'page', 'password', 'product', 'search'
]);

const DAWN_BASE_SECTIONS = new Set([
    'announcement-bar', 'apps', 'bulk-quick-order-list', 'cart-drawer', 'cart-icon-bubble',
    'cart-live-region-text', 'cart-notification-button', 'cart-notification-product',
    'collage', 'collapsible-content', 'collection-list', 'contact-form', 'custom-liquid',
    'email-signup-banner', 'featured-blog', 'featured-collection', 'featured-product',
    'footer', 'header', 'image-banner', 'image-with-text', 'main-404', 'main-account',
    'main-activate-account', 'main-addresses', 'main-article', 'main-blog', 'main-cart-footer',
    'main-cart-items', 'main-collection-banner', 'main-collection-product-grid',
    'main-list-collections', 'main-login', 'main-order', 'main-page', 'main-password-footer',
    'main-password-header', 'main-product', 'main-register', 'main-reset-password',
    'main-search', 'multicolumn', 'multirow', 'newsletter', 'page', 'pickup-availability',
    'predictive-search', 'quick-order-list', 'related-products', 'rich-text', 'slideshow', 'video'
]);
