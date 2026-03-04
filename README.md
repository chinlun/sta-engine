# AI Shopify Theme Architect (STA) Engine

The `sta-engine` repository is the backend service that powers the AI Shopify Theme Architect. It works in tandem with the frontend repository, `sta-studio`.

## How the Repositories Work Together

The architecture is split into two halves to separate the user interface from the heavy lifting of AI generation and file manipulation.

### 1. `sta-studio` (Frontend)
- **Tech Stack:** Next.js 15 (App Router), Tailwind CSS, Vercel AI SDK.
- **Role:** Provides the user interface. It contains a split-pane dashboard:
  - **Left Pane:** A chat interface where the user describes the desired theme changes.
  - **Right Pane:** An iframe preview of the generated Shopify theme.
- **Flow:** When the user sends a message, `sta-studio` proxies the chat history to the `sta-engine` backend via an API route (`/api/chat/route.ts`).

### 2. `sta-engine` (Backend)
- **Tech Stack:** Node.js, Express, TypeScript, `@ai-sdk/google` (Gemini), `adm-zip`, AWS S3 API (for Cloudflare R2).
- **Role:** Handles the AI prompt engineering, file manipulation, and third-party API integrations.
- **Flow:**
  1. **AI Processing:** Receives the chat history and prompts Google Gemini. It provides Gemini with a specific tool (`build_theme`) that uses a strict JSON schema (Zod) defining how to generate theme modifications.
  2. **Theme Generation (`builder.ts`):** When Gemini invokes the `build_theme` tool, the engine uses `adm-zip` to open a base Shopify theme (configured via `BASE_THEME_FILE` in `.env`, e.g., `dawn-15.4.1.zip`), injects the AI-generated code modifications, and repackages the zip file in memory.
  3. **Storage (`r2-service.ts`):** The modified zip buffer is uploaded to a Cloudflare R2 bucket. R2 provides a temporary, public URL for the zip file.
  4. **Shopify Integration (`shopify-service.ts`):** The engine makes a POST request to the Shopify Admin API, instructing the store to download the zip from the R2 URL and install it as an **unpublished** (draft) theme.
  5. **Response:** The engine streams the result (including the Shopify Preview URL) back to `sta-studio`, which updates the right-hand preview iframe.

---

## Future Business Models

Currently, the engine uses hardcoded API keys (`.env`) to connect to a single development store. As the project scales into a business, the architecture will adapt based on the commercial strategy.

### Strategy A: The SaaS Product (Public App)
If the goal is to allow *any* Shopify merchant to sign up and use the AI Theme Architect on their own live stores, the app must transition to a standard Shopify Public App using OAuth.

**The Workflow:**
1. A merchant visits your website and clicks "Install on Shopify."
2. They authorize the app, granting it `write_themes` and `read_themes` permissions.
3. Shopify returns a temporary authorization code, which `sta-engine` exchanges for a **Store-Specific Access Token**. This token is safely stored in a database alongside the user's account ID.
4. When the merchant generates a theme, `shopify-service.ts` looks up their specific token and pushes the theme directly to their store as an unpublished draft.
5. **Security:** Merchants never handle API keys or zip files.

### Strategy B: The Agency Model (Transferable Stores)
If the goal is to offer a "Done-For-You" service where you build custom stores using AI and sell the completed digital real estate, the architecture remains much simpler.

**The Workflow:**
1. In the Shopify Partner Dashboard, create a **Development Store** specifically for a client (a Transferable Store).
2. Inside that client's specific store admin, generate a temporary **Custom App API Token** (`shpat_...`).
3. Plug that token into your local `sta-engine` instance.
4. Use `sta-studio` to generate the custom theme with Gemini directly into the client's store.
5. Once the design is approved, **Transfer Ownership** of the store to the client via the Partner Dashboard.
6. **Security:** Upon transfer, Shopify automatically disables the Custom App, revoking your API access and securing the store for the new owner. You get paid for the completed build without managing complex OAuth infrastructure.

---

## AI Context Injection & Token Budget

The engine injects comprehensive Shopify reference documentation into the Gemini system prompt to improve theme-building accuracy. This follows the **CAT (Context, Action, Target)** strategy.

### Injected Context Layers
| Layer | File | Approximate Tokens |
|-------|------|--------------------|
| Role & Rules | Inline in `prompt-builder.ts` | ~800 |
| OS 2.0 Architecture | `docs/reference/shopify-os2-architecture.md` | ~1,500 |
| Dawn File Map | `docs/reference/dawn-file-map.md` | ~2,000 |
| Liquid Reference | `docs/liquid-cheat-sheet.md` | ~1,000 |
| Current Theme State | Extracted from base ZIP at runtime | ~500–2,000 |
| Few-Shot Examples | Inline in `prompt-builder.ts` | ~500 |

**Total: ~6,000–8,000 tokens per request.** With Gemini's 1M context window this is negligible (<1%), but it does mean slightly higher per-request cost vs. minimal context.

### Regenerating the Dawn File Map
If you update the base theme ZIP (e.g., upgrading from Dawn 15.4.1 to a newer version):

```bash
npx tsx scripts/generate-dawn-map.ts
```

### Future Optimization Ideas
- **Selective injection**: Only inject sections relevant to the user's request (requires intent classification)
- **Compressed references**: Use shorter key-value format instead of full markdown
- **Caching**: Pre-tokenize and cache the system prompt across requests

