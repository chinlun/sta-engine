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

        const appName = process.env.FLY_APP_NAME;
        const previewUrl = `https://${appName}.fly.dev`;

        res.json({ machineId, previewUrl });
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

        await flyMachineService.syncFile(machineId, filePath, content);

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

        await flyMachineService.syncBulk(machineId, files);

        res.json({ success: true });
    } catch (error: any) {
        console.error(`[PreviewRoutes] ❌ Bulk sync failed:`, error);
        res.status(500).json({ error: error.message });
    }
});

router.get("/ping/:machineId", async (req, res) => {
    const { machineId } = req.params;
    const appName = process.env.FLY_APP_NAME;
    try {
        const response = await fetch(`https://${appName}.fly.dev`, {
            headers: {
                "fly-force-instance-id": machineId,
            },
            redirect: "manual",
            signal: AbortSignal.timeout(3000)
        });

        // 502/503 = Fly proxy is up but app (Caddy/CLI) is not yet responding
        if (response.status === 502 || response.status === 503) {
            return res.json({ ready: false, status: response.status });
        }

        // Any other status (2xx, 3xx, 4xx, 500) means Caddy is responding!
        res.json({ ready: true, status: response.status });
    } catch (error: any) {
        res.json({ ready: false, error: error.message });
    }
});

export default router;
