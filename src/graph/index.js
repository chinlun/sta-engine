const { StateGraph, START, END } = require("@langchain/langgraph");
const { ThemeGenerationState } = require("./state");
const {
    classifierNode,
    plannerNode,
    coderNode,
    tsQcNode,
    assemblerNode,
    agenticQcNode
} = require("./nodes");

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
    .addNode("agenticQc", agenticQcNode)

    .addEdge(START, "classifier")
    .addEdge("classifier", "planner")
    .addEdge("planner", "coder")
    .addEdge("coder", "tsQc");

workflow.addConditionalEdges(
    "tsQc",
    (state) => {
        if (state.tsErrors && state.tsErrors.length > 0) {
            console.log(`[Graph] TS Validation failed for component ${state.components[state.currentComponentIndex].name}. Routing back to coder.`);
            return "coder";
        }

        // Validation passed! Are we done looping?
        if (state.currentComponentIndex >= state.components.length) {
            console.log(`[Graph] All components generated and validated. Moving to Assembly.`);
            return "assembler";
        } else {
            console.log(`[Graph] Moving to next component (${state.currentComponentIndex + 1}/${state.components.length}).`);
            return "coder";
        }
    },
    {
        coder: "coder",
        assembler: "assembler"
    }
);

workflow.addEdge("assembler", "agenticQc");

workflow.addConditionalEdges(
    "agenticQc",
    (state) => {
        if (state.designErrors && state.designErrors.length > 0) {
            console.log(`[Graph] Agentic QC failed. (Note: Feedback loop to assembly or coder can be refined here) Routing back to assembler.`);
            return "assembler";
        }
        return END;
    },
    {
        assembler: "assembler",
        [END]: END
    }
);

const themeWorkflow = workflow.compile();

module.exports = { themeWorkflow };

