# PRD: AI Shopify Theme Architect (Internal Dev Store Edition)

## 1. Executive Summary
**Objective:** Build a self-healing AI agent that allows users to customize Shopify "Dawn" themes via natural language.
**The "Why":** Traditional theme customization is slow. This tool automates the "Edit -> Zip -> Upload -> Preview" cycle into a single <15s loop.
**Key Change:** The system provides managed Shopify Development Stores for the user. No user-side API configuration is required for testing.

## 2. User Experience (UX)
- **Zero-Friction Onboarding:** Users land on the chat and start designing immediately. No Shopify login or API keys required to start.
- **The "Magic" Preview:** A side-by-side view where the left is the chat and the right is an auto-refreshing screenshot of the changes on a managed dev store.
- **Iterative Refinement:** User can say "Make it darker," and the AI understands the current "Darkness" level from the Firestore state and adjusts accordingly.

## 3. High-Level Requirements (Functional)
- **Managed Dev Store Pool:** Backend handles a pool of internal Shopify dev stores to host user previews.
- **In-Memory Build Engine:** No physical file writes; all ZIP manipulation happens in Node.js buffers.
- **Visual QA:** Every build must be "seen" by a headless browser to ensure the page actually rendered.
- **Cost Efficiency:** Use Cloudflare R2 for zero-egress theme hosting to avoid GCP bandwidth costs.
