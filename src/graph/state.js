const { Annotation } = require("@langchain/langgraph");

/**
 * The state representing the Shopify theme generation process.
 */
const ThemeGenerationState = Annotation.Root({
    userPrompt: Annotation(),
    catalogSize: Annotation(),
    designBrief: Annotation(),
    generatedFiles: Annotation({
        reducer: (x, y) => y,
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
});

module.exports = { ThemeGenerationState };
