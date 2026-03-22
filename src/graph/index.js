const { StateGraph, START, END } = require("@langchain/langgraph");
const { ThemeGenerationState } = require("./state");
const {
    classifierNode,
    plannerNode,
    coderNode,
    tsQcNode,
    agenticQcNode
} = require("./nodes");

/**
 * Compiled LangGraph that enforces "Swiss Cheese" QC via state transitions.
 * Implemented in JS to bypass tsc architectural limitations.
 */
const workflow = new StateGraph(ThemeGenerationState)
    .addNode("classifier", classifierNode)
    .addNode("planner", plannerNode)
    .addNode("coder", coderNode)
    .addNode("tsQc", tsQcNode)
    .addNode("agenticQc", agenticQcNode)

    .addEdge(START, "classifier")
    .addEdge("classifier", "planner")
    .addEdge("planner", "coder")
    .addEdge("coder", "tsQc");

workflow.addConditionalEdges(
    "tsQc",
    (state) => {
        if (state.tsErrors && state.tsErrors.length > 0) {
            console.log(`[Graph] TS Validation failed. Routing back to coder.`);
            return "coder";
        }
        return "agenticQc";
    },
    {
        coder: "coder",
        agenticQc: "agenticQc"
    }
);

workflow.addConditionalEdges(
    "agenticQc",
    (state) => {
        if (state.designErrors && state.designErrors.length > 0) {
            console.log(`[Graph] Agentic QC failed. Routing back to coder.`);
            return "coder";
        }
        return END;
    },
    {
        coder: "coder",
        [END]: END
    }
);

const themeWorkflow = workflow.compile();

module.exports = { themeWorkflow };
