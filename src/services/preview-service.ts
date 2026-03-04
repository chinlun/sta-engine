import { Request, Response } from 'express';

let sessionCookie: string | null = null;

/**
 * Authenticates with the Shopify store password page and retrieves session cookies.
 */
async function authenticate(): Promise<string> {
    const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const storePassword = process.env.SHOPIFY_STORE_PASSWORD;

    if (!storeDomain || !storePassword) {
        throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_STORE_PASSWORD in .env");
    }

    console.log("[Proxy] Authenticating with store password...");

    // Submit the password form to get session cookies
    const response = await fetch(`https://${storeDomain}/password`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `form_type=storefront_password&utf8=%E2%9C%93&password=${encodeURIComponent(storePassword)}`,
        redirect: 'manual', // Don't follow redirects, we need the Set-Cookie header
    });

    // Extract cookies from the response
    const cookies = response.headers.getSetCookie?.() || [];
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

    if (!cookieStr) {
        throw new Error("Failed to authenticate — no cookies received");
    }

    console.log("[Proxy] Authenticated successfully");
    sessionCookie = cookieStr;
    return cookieStr;
}

/**
 * Express middleware that proxies requests to the Shopify store preview,
 * authenticated with the store password. Strips X-Frame-Options so it works in an iframe.
 */
export function createProxyHandler() {
    return async (req: Request, res: Response) => {
        const themeId = req.params.themeId;
        const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;

        if (!storeDomain) {
            res.status(500).send("Missing SHOPIFY_STORE_DOMAIN");
            return;
        }

        // Authenticate if we don't have a session yet
        if (!sessionCookie) {
            try {
                await authenticate();
            } catch (error) {
                console.error("[Proxy] Auth failed:", error);
                res.status(500).send("Failed to authenticate with store");
                return;
            }
        }

        // Build the target URL
        const subPath = req.params[0] || '';
        const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        const separator = queryString ? '&' : '?';
        const targetUrl = subPath
            ? `https://${storeDomain}/${subPath}${queryString}`
            : `https://${storeDomain}/${queryString}${separator}preview_theme_id=${themeId}`;

        try {
            const proxyResponse = await fetch(targetUrl, {
                headers: {
                    'Cookie': sessionCookie!,
                    'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
                    'Accept': req.headers['accept'] || '*/*',
                    'Accept-Encoding': 'identity', // Don't request compressed content
                },
            });

            // If we get a redirect to /password, re-authenticate and retry once
            if (proxyResponse.status === 302 && proxyResponse.headers.get('location')?.includes('/password')) {
                console.log("[Proxy] Session expired, re-authenticating...");
                await authenticate();

                const retryResponse = await fetch(targetUrl, {
                    headers: {
                        'Cookie': sessionCookie!,
                        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
                        'Accept': req.headers['accept'] || '*/*',
                        'Accept-Encoding': 'identity',
                    },
                });

                return sendProxyResponse(retryResponse, res, storeDomain);
            }

            return sendProxyResponse(proxyResponse, res, storeDomain);
        } catch (error) {
            console.error("[Proxy] Request failed:", error);
            res.status(502).send("Proxy error");
        }
    };
}

async function sendProxyResponse(proxyResponse: globalThis.Response, res: Response, storeDomain: string) {
    // Copy content type
    const contentType = proxyResponse.headers.get('content-type') || 'text/html';
    res.setHeader('Content-Type', contentType);

    // Copy status
    res.status(proxyResponse.status);

    // Do NOT copy X-Frame-Options — that's the whole point of the proxy
    // Do NOT copy CSP frame-ancestors either

    if (contentType.includes('text/html') || contentType.includes('text/css') || contentType.includes('javascript')) {
        // For text content, rewrite URLs to go through our proxy
        let body = await proxyResponse.text();

        // Rewrite absolute URLs to the store to go through our proxy
        // This ensures CSS, JS, and other assets also load through the proxy
        // Note: CDN assets (cdn.shopify.com) don't need password authentication
        body = body.replace(
            new RegExp(`https://${storeDomain.replace('.', '\\.')}`, 'g'),
            '' // Make them relative — they'll go through the proxy
        );

        res.send(body);
    } else {
        // For binary content (images, fonts), pipe through
        const buffer = await proxyResponse.arrayBuffer();
        res.send(Buffer.from(buffer));
    }
}
