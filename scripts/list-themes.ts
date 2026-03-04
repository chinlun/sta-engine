import * as dotenv from 'dotenv';
dotenv.config();

async function listThemes() {
    const domain = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    const res = await fetch(`https://${domain}/admin/api/2024-01/themes.json`, {
        headers: { 'X-Shopify-Access-Token': token! }
    });

    const data: any = await res.json();
    console.log(`Found ${data.themes.length} themes.`);
    data.themes.forEach((t: any) => {
        console.log(`- ID: ${t.id} | Name: "${t.name}" | Role: ${t.role}`);
    });
}
listThemes();
