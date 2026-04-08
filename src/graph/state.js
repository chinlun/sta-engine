const { Annotation } = require("@langchain/langgraph");

/**
 * The state representing the Shopify theme generation process.
 */
const ThemeGenerationState = Annotation.Root({
    userPrompt: Annotation(),
    themeId: Annotation(),
    catalogSize: Annotation(),
    designBrief: Annotation(), // Deprecated, replaced by designTokens
    designTokens: Annotation(),
    selectedBlueprintId: Annotation(),
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
        reducer: (x, y) => {
            const merged = [...(x || [])];
            for (const newFile of (y || [])) {
                const idx = merged.findIndex(f => f.path === newFile.path);
                if (idx >= 0) merged[idx] = newFile;
                else merged.push(newFile);
            }
            return merged;
        },
        default: () => [],
    }),
    tsErrors: Annotation({
        reducer: (x, y) => y,
        default: () => [],
    }),
    assemblyErrors: Annotation({
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
    layoutShell: Annotation(), // Step 5: Global layout shell content
    sectionContent: Annotation({ // Step 3: Sophisticated copy for sections
        reducer: (x, y) => ({ ...(x || {}), ...y }),
        default: () => ({}),
    }),
});

module.exports = { ThemeGenerationState };
