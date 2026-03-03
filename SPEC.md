# SPEC: AI Shopify Theme Architect (Internal Dev Store Edition)

## 1. System Architecture
- **Host:** Firebase App Hosting (Frontend) + Google Cloud Run (Backend Engine).
- **Storage:** Cloudflare R2 (S3-compatible) for ZIP hosting.
- **DB:** Firestore (State management & Chat history).
- **Models:** Vertex AI (Gemini 1.5 Pro/Flash).

## 2. Managed Shopify Integration
- **Internal Store API:** The backend uses a pre-configured `SHOPIFY_ADMIN_ACCESS_TOKEN` and `SHOPIFY_STORE_URL` for an internal development store.
- **Theme Multi-Tenancy:** Each user session creates a unique theme (up to the 20-theme limit per store) rather than using a unique store per user.

## 3. The "Amnesia-Proof" Schema (Zod)
```typescript
const ThemePlanSchema = z.object({
  thoughtProcess: z.string().describe("Logical reasoning for these specific changes."),
  globalSettings: z.object({
    primaryColor: z.string().optional(),
    fontFamily: z.string().optional(),
  }).describe("Tracking global brand state to prevent amnesia."),
  modifications: z.array(
    z.object({
      filePath: z.string().describe("e.g., 'sections/announcement-bar.liquid'"),
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

---

### Key Technical Strategy: Managing the "20 Theme Limit"
Since we are providing the stores, remember that Shopify limits each store to **20 themes**. 
* **The "Cleanup" Agent:** You'll need a simple background function (or a step in your tool) that checks the theme count. If it hits 20, it should delete the oldest "Unpublished" theme to make room for the new build.
