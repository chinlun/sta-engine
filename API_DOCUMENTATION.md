# API Documentation: AI Shopify Theme Architect

## Base URLs
- **sta-studio (FE)**: `http://localhost:3000`
- **sta-engine (BE)**: `http://localhost:8080`

## Endpoints

### 1. POST /api/chat
Used by the Vercel AI SDK `useChat` hook.
- **Stream**: Returns a `ReadableStream` (SSE).
- **Payload**: Streams `partialObject.thoughtProcess` for the thinking UI.

### 2. POST /api/build
Internal tool endpoint for the `build_theme` function.
- **Input**: `prompt`, `history`, and `currentState` (JSON strings).
- **Flow**:
  1. Patch ZIP buffer.
  2. Upload to R2 and generate Signed URL.
  3. POST to Shopify Admin API.
  4. Capture Playwright screenshot.
- **Return**: `theme_id`, `preview_url`, `screenshot_url`.