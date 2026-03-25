# SPEC: AI Shopify Theme Architect (Internal Dev Store Edition)

## 1. System Architecture
- **Host:** Firebase App Hosting (Frontend) + Google Cloud Run (Backend Engine).
- **Storage:** Cloudflare R2 (S3-compatible) for ZIP hosting.
- **DB:** Firestore (State management & Chat history).
- **Models:** Vertex AI (Gemini 2.5 Pro/Flash).

## 2. Managed Shopify Integration
- **Theme Multi-Tenancy:** Each session creates a unique theme; the "Cleanup Agent" deletes the oldest theme if the 20-theme limit is reached.

## 3. The "Visible-First" Schema (Zod)
```typescript
const ThemePlanSchema = z.object({
  thoughtProcess: z.string().describe("Real-time stream of the AI's logical reasoning."),
  modifications: z.array(
    z.object({
      filePath: z.string().describe("Target file. Priority: templates/index.json, config/settings_data.json, sections/*.liquid"),
      action: z.enum(["update", "create", "delete"]),
      content: z.string().describe("The full code content for the file.")
    })
  )
});
```
*Note: The internal LangGraph state uses `path`. Mapping MUST occur at node boundaries.*

## 4. Design Philosophy: Flowbite Spec

### 4.1. Styling (Flowbite/Tailwind-First)
* **Standard Classes:** Use standard Flowbite and Tailwind CSS utilities (e.g., `bg-blue-600`, `text-gray-900`, `shadow-xl`, `rounded-xl`).
* **No Variable Bridging Required:** Do NOT map every color/spacing to Liquid settings. Prioritize "out-of-the-box" beauty.
* **Generous Whitespace:** Use `p-8`, `gap-8`, `rounded-xl` or `rounded-2xl` for a premium SaaS look.
* **Tailwind CDN:** `layout/theme.liquid` MUST include `<script src="https://cdn.tailwindcss.com"></script>`.

### 4.2. Tech Stack
* **Liquid:** Shopify Liquid for structure and templating.
* **Vanilla JS:** Web Components (Light DOM) for all interactivity.
* **Forbidden:** No React, Vue, jQuery, Shadow DOM.

### 4.3. Schema Simplicity
* Sections use `{% schema %}` for **content** (images, headings, CTAs) and **basic toggles** (`show_badge`, `enable_animation`).
* Do NOT create per-pixel CSS settings. Merchants control content, not layout.

## 5. Implementation Guardrails

### 5.1. Liquid & Schema Integrity
* **Tag Closure:** Every `{% if %}`, `{% for %}`, `{% case %}` must be explicitly closed.
* **Schema Registration:** New `.liquid` files in `sections/` MUST include `{% schema %}` with a `presets` array.
* **Web Component Guard:** Custom elements MUST include `customElements.define` in a `<script>` tag.

### 5.2. The "R2 Handshake" Protocol
* **Deployment Flow:** Cloud Run generates ZIP → Uploads to R2 → Generates 60s Signed URL → Shopify Admin API ingest.

### 5.3. QC Pipeline
* **Gate A (tsQcNode):** Deterministic Liquid syntax validation per component.
* **Gate B (assemblyQcNode):** Assembly-level schema and template integrity checks.
* **Agentic QC (agenticQcNode):** Visual quality audit — checks for premium aesthetics, Vanilla JS compliance, and valid schemas. Does NOT police Tailwind colors or pixel values.

### 5.4. Deterministic Schema Repair
* **theme_info:** Auto-resolves `theme_support_email` vs `theme_support_url` conflicts.
* **theme_name:** Auto-truncates to Shopify's 25-character limit.

### 5.5. JSON Template Architecture
* **The "Three-Point Edit":** AI MUST update `templates/index.json` and `config/settings_data.json` for every visible change.

## 6. Context & Knowledge Management
- **Reference Files:** Liquid rules and API limits from `sta-engine/reference/*.md` are injected into system instructions.
- **State Injection:** Current `templates/index.json` and `config/settings_data.json` are primary context for every LLM call.
