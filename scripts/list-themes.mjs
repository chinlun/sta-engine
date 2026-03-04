import * as fs from 'fs';
import * as path from 'path';

async function listThemes() {
    // Load env
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) process.env[match[1]] = match[2].replace(/^["'](.*)["']$/, '$1');
        });
    }

    const domain = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!domain || !token) {
        console.error("Missing credentials");
        return;
    }

    const res = await fetch(`https://${domain}/admin/api/2024-01/themes.json`, {
        headers: { 'X-Shopify-Access-Token': token }
    });

    const data = await res.json();
    console.log(`Found ${data.themes.length} themes.`);
    data.themes.forEach(t => {
        console.log(`- ID: ${t.id} | Name: "${t.name}" | Role: ${t.role}`);
    });
}
listThemes();
