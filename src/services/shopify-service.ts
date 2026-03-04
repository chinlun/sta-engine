/**
 * Checks the current theme count on the managed dev store.
 * If the 20-theme limit is reached, deletes the oldest "unpublished" theme.
 * Per SPEC §4.4: "Theme Management"
 */
export const ensureThemeSlot = async (): Promise<void> => {
    const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
    const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
        throw new Error("Missing Shopify credentials in .env");
    }

    console.log(`[Shopify] Checking theme count on ${SHOPIFY_STORE_DOMAIN}...`);

    const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/themes.json`, {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
    });

    if (!response.ok) {
        throw new Error(`Failed to list themes: ${response.status}`);
    }

    const data = await response.json();
    const themes = data.themes as Array<{ id: number; name: string; role: string; created_at: string }>;

    console.log(`[Shopify] Current theme count: ${themes.length}/20`);

    if (themes.length >= 20) {
        // Find the oldest unpublished theme
        const unpublished = themes
            .filter(t => t.role === 'unpublished')
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

        if (unpublished.length === 0) {
            throw new Error("Theme limit reached (20) but no unpublished themes to delete. Manual cleanup required.");
        }

        const oldest = unpublished[0];
        console.log(`[Shopify] Deleting oldest unpublished theme: "${oldest.name}" (ID: ${oldest.id})`);

        const deleteResponse = await fetch(
            `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/themes/${oldest.id}.json`,
            {
                method: 'DELETE',
                headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
            }
        );

        if (!deleteResponse.ok) {
            const errText = await deleteResponse.text();
            throw new Error(`Failed to delete theme ${oldest.id}: ${deleteResponse.status} — ${errText}`);
        }

        console.log(`[Shopify] Deleted theme ${oldest.id}, slot freed.`);
    }
};

export const uploadThemeToShopify = async (themeName: string, zipUrl: string) => {
    const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
    const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
        throw new Error("Missing Shopify credentials in .env");
    }

    console.log(`[Shopify] Uploading theme "${themeName}" from ${zipUrl} to ${SHOPIFY_STORE_DOMAIN}`);

    const themePayload = {
        theme: {
            name: themeName,
            src: zipUrl,
            role: "unpublished" // Shopify ignores role during src-based creation anyway; we publish explicitly after processing
        }
    };

    try {
        const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/themes.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
            body: JSON.stringify(themePayload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Shopify API Error:", errorText);
            throw new Error(`Shopify API failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return {
            id: data.theme.id,
            name: data.theme.name,
            role: data.theme.role,
            preview_url: `https://${SHOPIFY_STORE_DOMAIN}/?preview_theme_id=${data.theme.id}`
        };
    } catch (error) {
        console.error("Error creating theme in Shopify:", error);
        throw error;
    }
};

/**
 * Polls the Shopify API until the theme is fully processed and previewable.
 * @param themeId - The Shopify theme ID to check
 * @param onProgress - Optional callback to emit progress updates
 * @param maxWaitMs - Maximum time to wait (default: 2 minutes)
 * @param intervalMs - Polling interval (default: 3 seconds)
 */
export const waitForThemeReady = async (
    themeId: number | string,
    onProgress?: (message: string) => void,
    maxWaitMs = 120000,
    intervalMs = 3000
): Promise<void> => {
    const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
    const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
        throw new Error("Missing Shopify credentials in .env");
    }

    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < maxWaitMs) {
        attempt++;
        try {
            const response = await fetch(
                `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/themes/${themeId}.json`,
                {
                    headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to check theme status: ${response.status}`);
            }

            const data = await response.json();
            const theme = data.theme;
            const processing = theme.processing;
            const previewable = theme.previewable;

            console.log(`[Shopify] Theme ${themeId} — processing: ${processing}, previewable: ${previewable} (attempt ${attempt})`);

            if (!processing && previewable) {
                onProgress?.('Theme is ready for preview!');
                return;
            }

            onProgress?.(`Waiting for Shopify to process theme... (${Math.round((Date.now() - startTime) / 1000)}s)`);
        } catch (error) {
            console.error(`[Shopify] Error checking theme status:`, error);
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Theme ${themeId} did not become ready within ${maxWaitMs / 1000}s`);
};

/**
 * Publishes a theme by setting its role to "main" (live).
 * Must be called AFTER waitForThemeReady() to ensure the theme is fully processed.
 */
export const publishTheme = async (themeId: number | string): Promise<void> => {
    const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
    const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
        throw new Error("Missing Shopify credentials in .env");
    }

    console.log(`[Shopify] Publishing theme ${themeId} as main/live...`);

    const response = await fetch(
        `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/themes/${themeId}.json`,
        {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
            body: JSON.stringify({
                theme: { id: themeId, role: 'main' }
            }),
        }
    );

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to publish theme ${themeId}: ${response.status} — ${errText}`);
    }

    console.log(`[Shopify] Theme ${themeId} is now the live theme.`);
};
