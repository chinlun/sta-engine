# PRD: AI Shopify Theme Architect (Internal Dev Store Edition)

## 1. Executive Summary
**Objective:** Build a self-healing AI agent that generates beautiful Shopify themes via natural language.
**The "Why":** Traditional theme customization is slow. This tool automates the "Generate → Validate → Upload → Preview" cycle into <15s.
**Key Change:** The system uses Flowbite/Tailwind CSS for instant visual quality and managed Shopify Development Stores for zero-friction previews.

## 2. User Experience (UX)
- **Zero-Friction Onboarding:** Users design immediately without providing Shopify credentials.
- **The "Magic" Preview:** A side-by-side view with an auto-refreshing screenshot of changes.
- **Iterative Refinement:** Uses Firestore state to remember past design choices for contextual updates.

## 3. High-Level Requirements (Functional)
- **Managed Dev Store Pool:** Backend handles internal stores and the 20-theme limit cleanup.
- **Flowbite-First Aesthetic:** The system generates themes using standard Flowbite/Tailwind CSS classes for immediate, out-of-the-box beauty. Standard color utilities (e.g., `bg-blue-600`, `text-gray-900`) are preferred over complex HSL variable mappings.
- **Visible Impact Hierarchy:** The system MUST prioritize updating `templates/index.json` and `config/settings_data.json` to ensure modifications render on the storefront.
- **In-Memory Build Engine:** All ZIP manipulation occurs in Node.js buffers via `adm-zip`.
- **Visual QA:** A headless browser (Playwright) verifies the render before finalizing the response.
- **Cost Efficiency:** Cloudflare R2 for zero-egress theme hosting.
- **Streaming Thinking UI:** The interface provides a "Gemini-like" experience by streaming internal logic to the user while the theme build is in progress.
- **Schema-Driven Customization:** Merchants control content (images, text, toggles) via `{% schema %}`. Per-pixel CSS settings are NOT required.
- **Vanilla JS & Web Components:** All interactive logic MUST be 100% Vanilla JS (Custom Elements, Light DOM) without external dependencies.
- **Deterministic Schema Repair:** The system auto-fixes `settings_schema.json` conflicts (e.g., `theme_info` support fields, name length limits) before syncing to Shopify.