const { Annotation } = require("@langchain/langgraph");

/**
 * The state representing the Shopify theme generation process.
 */
const ThemeGenerationState = Annotation.Root({
    userPrompt: Annotation(),
    catalogSize: Annotation(),
    designBrief: Annotation(), // Deprecated, replaced by designTokens
    designTokens: Annotation(),
    components: Annotation({
        reducer: (x, y) => [...(x || []), ...y],
        default: () => [],
    }),
    currentComponentIndex: Annotation({
        reducer: (x, y) => y,
        default: () => 0,
    }),
    currentComponentFiles: Annotation({
        reducer: (x, y) => y,
        default: () => [],
    }),
    generatedFiles: Annotation({
        reducer: (x, y) => [...(x || []), ...y],
        default: () => [],
    }),
    tsErrors: Annotation({
        reducer: (x, y) => y,
        default: () => [],
    }),
    designErrors: Annotation({
        reducer: (x, y) => y,
        default: () => [],
    }),
    reasoning: Annotation({
        reducer: (x, y) => [...(x || []), y],
        default: () => [],
    }),
    referenceImageBase64: Annotation(),
    referenceHtml: Annotation(),
});

module.exports = { ThemeGenerationState };
