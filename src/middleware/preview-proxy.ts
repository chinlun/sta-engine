import { createProxyMiddleware } from "http-proxy-middleware";
import { Request } from "express";
import http from 'http';

const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000 });

/**
 * Extracts machineId from multiple sources to ensure "Sticky Routing"
 */
function getMachineId(req: Request): string | null {
    // 1. Path (/proxy/machineId/...)
    const pathMatch = req.originalUrl?.match(/^\/proxy\/([^\/]+)/);
    if (pathMatch && pathMatch[1]) return pathMatch[1];

    // 2. Referer header
    const referer = req.headers.referer;
    if (referer) {
        // Look for the proxy segment in the referer URL
        const refMatch = referer.match(/\/proxy\/([^\/]+)/);
        if (refMatch && refMatch[1]) return refMatch[1];
    }

    // 3. Cookie (fly_machine_id)
    const cookies = req.headers.cookie;
    if (cookies) {
        const cookieMatch = cookies.match(/fly_machine_id=([^;]+)/);
        if (cookieMatch && cookieMatch[1]) return cookieMatch[1].trim();
    }

    return null;
}

export const previewProxy = createProxyMiddleware({
    // Only proxy if we can identify a machineId (via path, Referer, or Cookie)
    pathFilter: (pathname: string, req: Request) => {
        // Never proxy standard API, health, or tracking/telemetry routes
        const isIgnored =
            pathname.startsWith('/api/') ||
            pathname === '/health' ||
            pathname.includes('monorail') ||
            pathname.includes('collect');

        if (isIgnored) return false;
        return !!getMachineId(req);
    },
    target: "http://66.241.125.193",
    router: (req: Request) => {
        return "http://66.241.125.193"; // Always hit the Fly Edge
    },
    agent, // Use keep-alive agent to prevent ECONNRESET
    proxyTimeout: 60000,
    timeout: 60000,
    on: {
        proxyReq: (proxyReq: any, req: any, res: any) => {
            const appName = process.env.FLY_APP_NAME;
            proxyReq.setHeader('Host', `${appName}.fly.dev`);

            const machineId = getMachineId(req);
            if (machineId) {
                proxyReq.setHeader('fly-force-machine-id', machineId);
                proxyReq.setHeader('Connection', 'keep-alive');

                const prefixMatch = req.originalUrl?.match(/^\/proxy\/[^\/]+/);
                if (prefixMatch) {
                    const rewritten = req.url.replace(/^\/proxy\/[^\/]+/, '') || '/';
                    proxyReq.path = rewritten;
                    console.log(`[ProxyReq] Machine: ${machineId} | Path: ${rewritten}`);
                } else {
                    console.log(`[ProxyReq] Machine: ${machineId} | Asset/Nav: ${proxyReq.path}`);
                }
            }
        },
        proxyReqWs: (proxyReq: any, req: any, socket: any, options: any, head: any) => {
            const appName = process.env.FLY_APP_NAME;
            proxyReq.setHeader('Host', `${appName}.fly.dev`);

            const machineId = getMachineId(req);
            if (machineId) {
                proxyReq.setHeader('fly-force-machine-id', machineId);
                console.log(`[ProxyReqWs] Machine: ${machineId} (WS)`);
            }
        },
        proxyRes: (proxyRes: any, req: any, res: any) => {
            // Strip headers that block iframe embedding or cause CSP noise
            const headersToStrip = [
                'x-frame-options',
                'content-security-policy',
                'content-security-policy-report-only',
                'expect-ct'
            ];
            headersToStrip.forEach(h => delete proxyRes.headers[h]);

            // Ensure stickiness by refreshing the cookie on every proxy response
            const machineId = getMachineId(req);
            if (machineId) {
                // Use res.append to avoid overwriting existing cookies
                res.append('Set-Cookie', `fly_machine_id=${machineId}; Path=/; HttpOnly; Max-Age=3600; SameSite=Lax`);
            }
        },
        error: (err: any, req: any, res: any) => {
            const machineId = getMachineId(req);
            console.error(`[Proxy Error] ❌ Machine: ${machineId} | Path: ${req.url} | Error:`, err.message || err);

            if (res.headersSent) return;
            res.status(502).send(`Proxy error: ${err.message || 'Socket hung up'}. Please try refreshing.`);
        }
    },
    changeOrigin: true,
    ws: true // Enable WebSocket proxying for Shopify CLI hot-reload
});
