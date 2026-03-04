# SPEC: AI Shopify Theme Architect (Internal Dev Store Edition)

## 1. System Architecture
- **Host:** Firebase App Hosting (Frontend) + Google Cloud Run (Backend Engine).
- **Storage:** Cloudflare R2 (S3-compatible) for ZIP hosting.
- **DB:** Firestore (State management & Chat history).
- **Models:** Vertex AI (Gemini 1.5 Pro/Flash).

## 2. Managed Shopify Integration
- **Theme Multi-Tenancy:** Each session creates a unique theme; the "Cleanup Agent" deletes the oldest theme if the 20-theme limit is reached.

## 3. The "Visible-First" Schema (Zod)
```typescript
const ThemePlanSchema = z.object({
  thoughtProcess: z.string().describe("Real-time stream of the AI's logical reasoning and progress."), // New: For the Gemini-style thinking stream
  globalSettings: z.object({
    primaryColor: z.string().optional(),
    fontFamily: z.string().optional(),
  }).describe("Tracking global brand state to prevent amnesia."),
  modifications: z.array(
    z.object({
      filePath: z.string().describe("Target file. Priority: templates/index.json, config/settings_data.json, sections/*.liquid"),
      action: z.enum(["update", "create", "delete"]),
      content: z.string().describe("The full code content for the file.")
    })
  )
});
```

## 4. Implementation Guardrails (Senior Developer Standards)

### 4.1. Liquid & Schema Integrity
* **Tag Closure:** The AI must strictly follow Liquid syntax. Every `{% if %}`, `{% for %}`, and `{% case %}` block must be explicitly closed with its corresponding end tag.
* **Schema Registration:** Any new `.liquid` file created in the `sections/` folder MUST include a valid `{% schema %}` JSON block at the bottom. This block must contain a `presets` array (e.g., `[{"name": "Default"}]`) to ensure the section is selectable in the Shopify Theme Editor.

### 4.2. CSS & Design Standards
* **Design Tokens:** Prioritize using Shopify's native CSS variables (e.g., `var(--color-base-accent-1)`, `var(--font-body-family)`) instead of hardcoding static values like hex codes or pixel sizes.
* **BEM Naming:** Use a BEM-like naming convention for CSS classes to prevent style leakage between sections.

### 4.3. The "R2 Handshake" Protocol
* **Deployment Flow:** Cloud Run service generates the theme ZIP -> Uploads to Cloudflare R2 -> Generates a temporary Signed URL (expires in 60 seconds).
* **Ingestion:** The Shopify Admin API is called with the `src` parameter pointing to this signed R2 URL. This ensures Shopify can fetch the file while keeping your bucket private.

### 4.4. Visual QA & Self-Healing Loop
* **Stateful Testing:** Playwright must wait for the `networkidle` event before capturing a screenshot.
* **Error Detection:** If the headless browser detects "Liquid error" text or a 404 status code on the preview page, the system must automatically feed the error log back to the "Fixer" agent for an immediate re-build.
* **Theme Management:** The backend must monitor the theme count on the managed dev store. If it hits the 20-theme limit, the oldest "Unpublished" theme must be deleted before proceeding.

### 4.5. JSON Template Architecture (The Visibility Rule)
* **The "Three-Point Edit":** To ensure changes are visible, the AI MUST update `templates/index.json` to register sections and `config/settings_data.json` for global styles.
* **Rendering Order:** Any new section added to `templates/index.json` must be included in the `order` array to actually appear on the page.

## 5. Context & Knowledge Management (Non-RAG)

### 5.1. Reference Files
- All Liquid syntax rules and Shopify API limits are stored in `sta-engine/reference/*.md`.
- These are read at runtime and injected into the Gemini System Instruction.

### 5.2. State Injection
- Before every LLM call, the engine fetches the 'Current State' from Firestore.
- **Critical:** The current `templates/index.json` and `config/settings_data.json` are injected as primary context to Gemini to ensure it knows what it has already built.

### 5.3. Token Optimization
- While Gemini has a large window, we use a 'Sliding Window' for chat history (last 10 messages) to keep response times fast and reduce token waste.

