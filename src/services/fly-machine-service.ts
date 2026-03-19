import crypto from 'crypto';

export const flyMachineService = {
    async createMachine(storeUrl: string, themeToken: string) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;
        if (!apiToken || !appName) throw new Error("Missing FLY_API_TOKEN or FLY_APP_NAME");

        console.log(`[Fly API] ⏳ Creating machine for ${storeUrl}...`);
        const payload = {
            config: {
                image: `registry.fly.io/${appName}:latest`,
                auto_destroy: true, // Automatically delete the machine when it stops
                guest: {
                    cpu_kind: 'shared',
                    cpus: 1,
                    memory_mb: 1024
                },
                env: {
                    SHOPIFY_FLAG_STORE: storeUrl,
                    SHOPIFY_CLI_THEME_TOKEN: themeToken,
                    SHOPIFY_STORE_PASSWORD: process.env.SHOPIFY_STORE_PASSWORD || "",
                },
                services: [
                    {
                        protocol: "tcp",
                        internal_port: 9292,
                        autostop: "off",
                        autostart: true,
                        ports: [
                            { port: 80, handlers: ["http"] },
                            { port: 443, handlers: ["tls", "http"] }
                        ]
                    }
                ]
            }
        };

        console.log(`[Fly API] 📦 Create Machine Payload:`, JSON.stringify(payload, null, 2));

        const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiToken}`,
            },
            body: JSON.stringify(payload)
        });

        const rawText = await response.text();

        if (!response.ok) {
            console.error(`[Fly API] ❌ Create machine failed ${response.status}:`, rawText);
            throw new Error(`Failed to create machine: ${response.status} ${rawText}`);
        }

        const data = JSON.parse(rawText);
        console.log(`[Fly API] ✅ Created machine: ${data.id}. Raw Response:`, rawText);
        return data.id;
    },

    async waitForMachine(machineId: string) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;

        console.log(`[Fly API] ⏳ Waiting for machine ${machineId} to start...`);
        let lastState = '';
        for (let i = 0; i < 30; i++) {
            const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines/${machineId}`, {
                headers: { "Authorization": `Bearer ${apiToken}` }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.state !== lastState) {
                    console.log(`[Fly API] ℹ️ Machine ${machineId} state: ${data.state}`);
                    lastState = data.state;
                }
                if (data.state === "started") {
                    console.log(`[Fly API] ✅ Machine ${machineId} is fully started`);
                    return true;
                }
            } else {
                console.warn(`[Fly API] ⚠️ Failed to fetch machine status: ${response.status}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        console.error(`[Fly API] ❌ Machine ${machineId} failed to start within timeout.`);
        throw new Error("Machine failed to start within timeout.");
    },

    async stopMachine(machineId: string) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;

        console.log(`[Fly API] ⏳ Stopping machine ${machineId}...`);
        const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines/${machineId}/stop`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiToken}` }
        });

        if (!response.ok) {
            console.warn(`[Fly API] ⚠️ Stop machine returned ${response.status}`);
        } else {
            console.log(`[Fly API] ✅ Stopped machine ${machineId}`);
        }
    },

    async destroyMachine(machineId: string) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;

        console.log(`[Fly API] ⏳ Destroying machine ${machineId}...`);
        const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines/${machineId}?kill=true`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${apiToken}` }
        });

        if (!response.ok) {
            console.warn(`[Fly API] ⚠️ Destroy machine returned ${response.status}`);
        } else {
            console.log(`[Fly API] ✅ Destroyed machine ${machineId}`);
        }
    },

    async execCommand(machineId: string, command: string[]) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;

        console.log(`[Fly API] 🚀 Executing command on machine ${machineId}:`, JSON.stringify(command));
        const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines/${machineId}/exec`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiToken}`,
            },
            body: JSON.stringify({ command })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Fly API] ❌ Exec command failed ${response.status}:`, errorText);
            throw new Error(`Failed to exec command: ${response.status} ${errorText}`);
        }

        const rawText = await response.text();
        try {
            const data = JSON.parse(rawText);
            console.log(`[Fly API] ✅ Exec command completed (Exit Code ${data.exit_code}).`);
            if (data.stdout) console.log(`[Fly API] STDOUT:\n${data.stdout}`);
            if (data.stderr) console.error(`[Fly API] STDERR:\n${data.stderr}`);
        } catch (e) {
            console.log(`[Fly API] ✅ Exec command completed. Raw response:\n${rawText}`);
        }
    },

    async syncFile(machineId: string, filePath: string, content: string) {
        const appName = process.env.FLY_APP_NAME;
        const themeToken = process.env.SHOPIFY_THEME_ACCESS_PASSWORD;
        if (!appName || !themeToken) throw new Error("Missing FLY_APP_NAME or SHOPIFY_THEME_ACCESS_PASSWORD");

        const targetUrl = `https://${appName}.fly.dev/sync`;
        const payload = JSON.stringify({ filePath, content });

        // Generate HMAC signature
        const hmac = crypto.createHmac('sha256', themeToken);
        hmac.update(payload);
        const signature = hmac.digest('hex');

        console.log(`[Fly API] 🚀 Syncing file ${filePath} to machine ${machineId} via HTTP POST...`);
        const response = await fetch(targetUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "fly-force-instance-id": machineId,
                "x-sync-signature": signature
            },
            body: payload
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Fly API] ❌ HTTP Sync failed ${response.status}:`, errorText);
            throw new Error(`Failed to HTTP sync: ${response.status} ${errorText}`);
        }
    },

    async syncBulk(machineId: string, files: { filePath: string, content: string }[]) {
        const appName = process.env.FLY_APP_NAME;
        const themeToken = process.env.SHOPIFY_THEME_ACCESS_PASSWORD;
        if (!appName || !themeToken) throw new Error("Missing FLY_APP_NAME or SHOPIFY_THEME_ACCESS_PASSWORD");

        const targetUrl = `https://${appName}.fly.dev/sync-bulk`;
        const payload = JSON.stringify({ files });

        // Generate HMAC signature
        const hmac = crypto.createHmac('sha256', themeToken);
        hmac.update(payload);
        const signature = hmac.digest('hex');

        console.log(`[Fly API] 🚀 Bulk Syncing ${files.length} files to machine ${machineId} via HTTP POST...`);
        const response = await fetch(targetUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "fly-force-instance-id": machineId,
                "x-sync-signature": signature
            },
            body: payload
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Fly API] ❌ HTTP Bulk Sync failed ${response.status}:`, errorText);
            throw new Error(`Failed to HTTP bulk sync: ${response.status} ${errorText}`);
        }
    }
};
