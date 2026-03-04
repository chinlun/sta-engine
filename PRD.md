# PRD: AI Shopify Theme Architect (Internal Dev Store Edition)

## 1. Executive Summary
**Objective:** Build a self-healing AI agent that allows users to customize Shopify "Dawn" themes via natural language.
**The "Why":** Traditional theme customization is slow. This tool automates the "Edit -> Zip -> Upload -> Preview" cycle into a single <15s loop.
**Key Change:** The system provides managed Shopify Development Stores for the user. No user-side API configuration is required for testing.

## 2. User Experience (UX)
- **Zero-Friction Onboarding:** Users design immediately without providing Shopify credentials.
- **The "Magic" Preview:** A side-by-side view with an auto-refreshing screenshot of changes.
- **Iterative Refinement:** Uses Firestore state to remember past design choices for contextual updates.

## 3. High-Level Requirements (Functional)
- **Managed Dev Store Pool:** Backend handles internal stores and the 20-theme limit cleanup.
- **Visible Impact Hierarchy:** The system MUST prioritize updating `templates/index.json` and `config/settings_data.json` to ensure modifications render on the storefront.
- **In-Memory Build Engine:** All ZIP manipulation occurs in Node.js buffers via `adm-zip`.
- **Visual QA:** A headless browser (Playwright) verifies the render before finalizing the response.
- **Cost Efficiency:** Cloudflare R2 for zero-egress theme hosting.
- **Visible-First Design:** The system prioritizes architectural visibility (JSON templates) over structural logic (Liquid) to ensure every user request results in a clear visual change.
- **Streaming Thinking UI:** The interface provides a "Gemini-like" experience by streaming internal logic to the user while the theme build is in progress.