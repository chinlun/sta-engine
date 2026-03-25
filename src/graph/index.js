const { StateGraph, START, END } = require("@langchain/langgraph");
const { ThemeGenerationState } = require("./state");
const {
    classifierNode,
    plannerNode,
    coderNode,
    tsQcNode,
    assemblerNode,
    assemblyQcNode
} = require("./nodes");
const { logger } = require("../lib/logger");

/**
 * Compiled LangGraph that enforces Component-Loop QC via state transitions.
 * Implemented in JS to bypass tsc architectural limitations.
 */
const workflow = new StateGraph(ThemeGenerationState)
    .addNode("classifier", classifierNode)
    .addNode("planner", plannerNode)
    .addNode("coder", coderNode)
    .addNode("tsQc", tsQcNode)
    .addNode("assembler", assemblerNode)
    .addNode("assemblyQc", assemblyQcNode)

    .addEdge(START, "classifier")
    .addEdge("classifier", "planner")
    .addEdge("planner", "coder")
    .addEdge("coder", "tsQc");

workflow.addConditionalEdges(
    "tsQc",
    (state) => {
        if (state.tsErrors && state.tsErrors.length > 0) {
            const compName = state.components?.[state.currentComponentIndex]?.name || 'unknown';
            logger.info(`[Graph] TS Validation failed for component ${compName}. Routing back to coder.`);
            return "coder";
        }

        // Validation passed! Are we done looping?
        const totalComponents = state.components?.length || 0;
        if (state.currentComponentIndex >= totalComponents) {
            logger.info(`[Graph] All components generated and validated (${totalComponents}). Moving to Assembly.`);
            return "assembler";
        } else {
            logger.info(`[Graph] Moving to next component (${state.currentComponentIndex + 1}/${totalComponents}).`);
            return "coder";
        }
    },
    {
        coder: "coder",
        assembler: "assembler"
    }
);

workflow.addEdge("assembler", "assemblyQc");

workflow.addConditionalEdges(
    "assemblyQc",
    (state) => {
        if (state.assemblyErrors && state.assemblyErrors.length > 0) {
            logger.info(`[Graph] Assembly Validation failed. Routing back to assembler for self-healing.`);
            return "assembler";
        }
        logger.info(`[Graph] Assembly Validation passed. Theme generation complete.`);
        return END;
    },
    {
        assembler: "assembler",
        [END]: END
    }
);

const themeWorkflow = workflow.compile();

module.exports = { themeWorkflow };

