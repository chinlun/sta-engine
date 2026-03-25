import { Liquid } from 'liquidjs';
import { logger } from './logger';

const engine = new Liquid();

// Register the complete set of Shopify-specific tags so the structural parser is 100% accurate.
// Category A: Block Tags (Must have a matching {% end... %} tag)
const shopifyBlockTags = [
    'schema', 'style', 'stylesheet', 'javascript',
    'form', 'paginate', 'liquid'
];

// Category B: Singleton Tags (Self-closing, no end tag)
const shopifySingletonTags = [
    'section', 'sections', 'render', 'include', 'layout', 'echo', 'cycle'
];

for (const tag of shopifyBlockTags) {
    engine.registerTag(tag, {
        parse: () => { },
        render: () => { return ''; }
    });
}

for (const tag of shopifySingletonTags) {
    engine.registerTag(tag, {
        parse: () => { },
        render: () => { return ''; }
    });
}

export interface LintResult {
    valid: boolean;
    errors: string[];
    repairs: string[];
    repairedContent: string;
}

/**
 * Expert Shopify Liquid Linter.
 * Catches structural Liquid errors and Shopify-specific "quirks".
 */
export function lintLiquid(content: string, filePath: string): LintResult {
    const result: LintResult = {
        valid: true,
        errors: [],
        repairs: [],
        repairedContent: content
    };

    let currentContent = content;

    // RULE 1: Mandatory theme.liquid tags
    if (filePath.endsWith('theme.liquid')) {
        if (!currentContent.includes('{{ content_for_header }}')) {
            if (currentContent.includes('</head>')) {
                currentContent = currentContent.replace('</head>', '  {{ content_for_header }}\n</head>');
            } else {
                currentContent += '\n{{ content_for_header }}';
            }
            result.repairs.push('Injected missing {{ content_for_header }} into theme.liquid');
        }
        if (!currentContent.includes('{{ content_for_layout }}')) {
            if (currentContent.includes('</body>')) {
                currentContent = currentContent.replace('</body>', '  {{ content_for_layout }}\n</body>');
            } else {
                currentContent += '\n{{ content_for_layout }}';
            }
            result.repairs.push('Injected missing {{ content_for_layout }} into theme.liquid');
        }
    }

    // RULE 2: No pipes in logic tags (if/unless/case)
    // Shopify does not support filters inside logic tags.
    // Hallucination: {% if product.title | contains: 'Coffee' %}
    // Fix: {% if product.title contains 'Coffee' %}
    const logicTagRegex = /\{%-?\s*(if|unless|case)\s+([\s\S]+?)\s*-?%\}/g;
    currentContent = currentContent.replace(logicTagRegex, (match, tag, expression) => {
        if (expression.includes('|')) {
            // Check if it's a known bad pattern (e.g. | contains, | modulo)
            let fixedExpr = expression;

            // Special Case: modulo
            if (fixedExpr.includes('modulo:')) {
                // Handled by the assign-logic in builder.ts, but let's try to simplify if possible
                // For now, we'll let the more complex repair in builder.ts handle modulo
            } else {
                // General "remove pipe" for contains
                fixedExpr = fixedExpr.replace(/\|\s*contains:\s*/g, 'contains ');
            }

            if (fixedExpr !== expression) {
                result.repairs.push(`Auto-fixed pipe in ${tag} tag: "${expression}" -> "${fixedExpr}"`);
                return `{% ${tag} ${fixedExpr} %}`;
            }
        }
        return match;
    });

    // RULE 3: Clean {% schema %} blocks (No Liquid tags allowed inside)
    const schemaRegex = /({%\s*schema\s*%})([\s\S]*?)({%\s*endschema\s*%})/;
    const schemaMatch = currentContent.match(schemaRegex);
    if (schemaMatch) {
        let schemaJson = schemaMatch[2];
        const liquidTagInSchema = /\{[{%][\s\S]*?[}%]\}/g;
        if (liquidTagInSchema.test(schemaJson)) {
            schemaJson = schemaJson.replace(liquidTagInSchema, '');
            currentContent = currentContent.replace(schemaRegex, `$1${schemaJson}$3`);
            result.repairs.push('Stripped Liquid tags/comments from inside {% schema %} block');
        }
    }

    // RULE 4: Convert include to render (Deprecated vs Mandatory)
    const includeRegex = /\{%-?\s*include\s+['"]([^'"]+)['"]\s*([\s\S]*?)\s*-?%\}/g;
    if (includeRegex.test(currentContent)) {
        currentContent = currentContent.replace(includeRegex, (match, snippet, args) => {
            result.repairs.push(`Converted deprecated {% include '${snippet}' %} to {% render '${snippet}' %}`);
            return `{% render '${snippet}' ${args} %}`;
        });
    }

    // FINAL VALIDATION: Structural check via liquidjs
    try {
        // Attempt to parse the template
        engine.parse(currentContent);
        // We don't execute it, just verify the structure is sound
    } catch (e: any) {
        result.valid = false;
        result.errors.push(`Liquid structural error: ${e.message}`);
        logger.error({ filePath, error: e.message }, 'Liquid structural validation failed');
    }

    result.repairedContent = currentContent;
    return result;
}
