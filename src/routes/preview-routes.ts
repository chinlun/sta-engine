import { Router } from "express";
import { flyMachineService } from "../services/fly-machine-service";
import path from "path";

const router = Router();

router.post("/start", async (req, res) => {
    try {
        const storeUrl = req.body.storeUrl || process.env.SHOPIFY_STORE_DOMAIN;
        const themeToken = req.body.themeToken || process.env.SHOPIFY_THEME_ACCESS_PASSWORD;

        if (!storeUrl || !themeToken) {
            return res.status(400).json({ error: "Missing storeUrl or themeToken in body or .env" });
        }

        const machineId = await flyMachineService.createMachine(storeUrl, themeToken);
        console.log(`[Preview API] Created new Machine: ${machineId}`);
        await flyMachineService.waitForMachine(machineId);
        console.log(`[Preview API] Machine ${machineId} is running.`);

        res.json({ machineId });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.post("/stop", async (req, res) => {
    try {
        const { machineId } = req.body;
        if (!machineId) return res.status(400).json({ error: "Missing machineId" });

        await flyMachineService.stopMachine(machineId);
        await flyMachineService.destroyMachine(machineId);
        console.log(`[Preview API] Stopped & destroyed Machine ${machineId}`);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.post("/sync", async (req, res) => {
    try {
        const { machineId, filePath, content } = req.body;
        if (!machineId || !filePath || !content) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        console.log(`[Preview API] Syncing 1 file to Machine ${machineId}: ${filePath}`);

        // Escape content to safely echo it inside bash
        const escapedContent = Buffer.from(content).toString('base64');
        const fullPath = path.join("/theme", filePath);
        const dir = path.dirname(fullPath);

        const command = [
            "bash", "-c",
            `mkdir -p ${dir} && echo "${escapedContent}" | base64 -d > ${fullPath}`
        ];

        await flyMachineService.execCommand(machineId, command);

        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.post("/sync-bulk", async (req, res) => {
    try {
        const { machineId, files } = req.body; // files: { filePath: string, content: string }[]
        if (!machineId || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: "Missing machineId or files array" });
        }

        console.log(`[PreviewRoutes] 📦 Bulk syncing ${files.length} files to machine ${machineId}`);

        // Construct a single bash command to write all files
        // We use a temporary script to avoid command line length limits if there are many files
        let script = "";
        for (const file of files) {
            const escapedContent = Buffer.from(file.content).toString('base64');
            const fullPath = path.join("/theme", file.filePath);
            const dir = path.dirname(fullPath);
            script += `mkdir -p ${dir} && echo "${escapedContent}" | base64 -d > ${fullPath}\n`;
        }

        const command = [
            "bash", "-c",
            `echo "${Buffer.from(script).toString('base64')}" | base64 -d | bash`
        ];

        await flyMachineService.execCommand(machineId, command);

        res.json({ success: true });
    } catch (error: any) {
        console.error(`[PreviewRoutes] ❌ Bulk sync failed:`, error);
        res.status(500).json({ error: error.message });
    }
});

router.get("/ping/:machineId", async (req, res) => {
    const { machineId } = req.params;
    try {
        const response = await fetch(`http://66.241.125.193`, {
            headers: {
                "Host": `${machineId}.fly.dev`,
            },
            // Don't follow redirects, just check if the server is responding instead of 502
            redirect: "manual",
            // Abort quickly to fail fast during polling
            signal: AbortSignal.timeout(3000)
        });

        // 502 = bad gateway (kernel running but node/Shopify CLI not yet listening)
        if (response.status === 502 || response.status === 503) {
            return res.json({ ready: false, status: response.status });
        }

        // If it's a 2xx or 3xx or 404 (which implies node is actively denying us), it means the webserver is UP
        res.json({ ready: true, status: response.status });
    } catch (error: any) {
        // Network errors mean it's not ready
        res.json({ ready: false, error: error.message });
    }
});

export default router;
