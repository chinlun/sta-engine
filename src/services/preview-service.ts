import { Request, Response } from 'express';

/**
 * Creates an Express handler that authenticates the user's browser with the Shopify store natively.
 * It does this by returning a small auto-submitting HTML form that POSTs the store password directly 
 * to Shopify, then uses the `return_to` parameter to forcefully drop the user onto the generated theme preview.
 */
export function createMagicPreviewHandler() {
  return (req: Request, res: Response) => {
    const themeId = req.params.themeId;
    const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const storePassword = process.env.SHOPIFY_STORE_PASSWORD;

    if (!storeDomain || !storePassword) {
      res.status(500).send("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_STORE_PASSWORD");
      return;
    }

    // Return a tiny HTML page that instantly POSTs the password form to Shopify 
    // and sets the redirect destination to the specific preview theme ID.
    const html = `
<!DOCTYPE html>
<html>
  <head>
    <title>Authenticating Preview...</title>
    <style>
      body { bg-color: #111; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .loader { text-align: center; }
      .spinner { border: 4px solid rgba(255,255,255,0.1); width: 36px; height: 36px; border-radius: 50%; border-left-color: #09f; animation: spin 1s linear infinite; margin: 0 auto 16px; }
      @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
  </head>
  <body style="background-color: #111827; color: white;">
    <div class="loader">
      <div class="spinner"></div>
      <p>Securely authenticating with Shopify...</p>
    </div>
    <form id="magic-form" action="https://${storeDomain}/password" method="POST" style="display: none;">
      <input type="hidden" name="form_type" value="storefront_password" />
      <input type="hidden" name="utf8" value="✓" />
      <input type="hidden" name="password" value="${storePassword}" />
      <input type="hidden" name="return_to" value="/" />
    </form>
    <script>
      // Immediately submit the password to Shopify's native auth endpoint
      document.getElementById('magic-form').submit();
    </script>
  </body>
</html>
        `;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  };
}
