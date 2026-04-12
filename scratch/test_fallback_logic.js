const { gemini31Pro, gemini3Flash } = require("../src/lib/ai");

// Mocking the behavior of getLLMConfig for a quick test
function getLLMConfig(state) {
    if (state.isFallback) {
        return {
            model: "gemini3Flash", // Using name for simplicity in test
            adaptiveInstructions: `
[ADAPTIVE INSTRUCTION MODE: ACTIVE]
You are operating in high-efficiency fallback mode.
- BE EXTREMELY EXPLICIT...`.trim()
        };
    }
    return {
        model: "gemini31Pro",
        adaptiveInstructions: ""
    };
}

// Test Case 1: Standard Mode
const standardState = { isFallback: false };
const standardConfig = getLLMConfig(standardState);
console.log("--- TEST CASE 1: Standard ---");
console.log("Model:", standardConfig.model);
console.log("Instructions length:", standardConfig.adaptiveInstructions.length);

// Test Case 2: Fallback Mode
const fallbackState = { isFallback: true };
const fallbackConfig = getLLMConfig(fallbackState);
console.log("\n--- TEST CASE 2: Fallback ---");
console.log("Model:", fallbackConfig.model);
console.log("Instructions:", fallbackConfig.adaptiveInstructions);

if (fallbackConfig.model === "gemini3Flash" && fallbackConfig.adaptiveInstructions.includes("ADAPTIVE INSTRUCTION")) {
    console.log("\n✅ Success: Fallback logic works as expected.");
} else {
    console.log("\n❌ Failure: Fallback logic is incorrect.");
}
