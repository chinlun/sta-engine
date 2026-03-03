const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "placeholder.myshopify.com";
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || "placeholder";

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
            role: "unpublished" // Important: Creates it safely as a draft
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
