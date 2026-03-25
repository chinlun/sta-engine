import { Router } from "express";
import { flyMachineService } from "../services/fly-machine-service";
import { validateAndRepair, normalizeMod } from "../services/builder";
import { logger } from "../lib/logger";
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
        const previewUrl = `https://${appName}.fly.dev/?machine_id=${machineId}`;

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
        const { machineId, files, globalSettings } = req.body;
        if (!machineId || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: "Missing machineId or files array" });
        }

        logger.info(`[PreviewRoutes] 📦 Received bulk sync request for ${files.length} files to machine ${machineId}`);

        // 1. Validate and Auto-Repair
        const themePlan = { modifications: files, globalSettings, thoughtProcess: "" };
        const validation = validateAndRepair(themePlan as any);

        if (!validation.valid) {
            logger.error(`[PreviewRoutes] ❌ Validation failed: ${validation.errors.join(", ")}`);
            return res.status(400).json({ error: "Validation failed", details: validation.errors });
        }

        if (validation.repairs.length > 0) {
            logger.info(`[PreviewRoutes] 🛠️ Applied ${validation.repairs.length} auto-repairs before sync.`);
        }

        // 2. Normalize and Sort (Liquid first, then JSON)
        const normalizedFiles = files.map(f => normalizeMod(f))
            .filter(f => f.filePath && f.content)
            .sort((a, b) => {
                const aIsJson = a.filePath!.endsWith('.json');
                const bIsJson = b.filePath!.endsWith('.json');
                if (aIsJson && !bIsJson) return 1;
                if (!aIsJson && bIsJson) return -1;
                return 0;
            });

        // 3. Sync with Monitoring
        await new Promise<void>(async (resolve, reject) => {
            let isResolved = false;

            // Start Monitor
            const stopMonitor = flyMachineService.monitorLogs(machineId, (error) => {
                if (isResolved) return;
                logger.error(`[PreviewRoutes] 🚨 Remote Error Detected: ${error.message}`);
            });

            // "Warm up" delay for fly logs connection - ensures we are listening before the move triggers sync
            logger.info(`[PreviewRoutes] ⏳ Waiting 3s for Log Monitor to establish stream...`);
            await new Promise(r => setTimeout(r, 3000));

            flyMachineService.syncBulk(machineId, normalizedFiles as any)
                .then(async () => {
                    // Grace period for logs - Shopify CLI can be slow to report rejections
                    logger.info(`[PreviewRoutes] ✅ Sync commands sent. Pipeline moving to IDLE while monitor remains active.`);

                    // We DO NOT stop the monitor here anymore. 
                    // It is persistent per machine and will catch late errors.
                    // We resolve immediately so the UI is and subsequent syncs can proceed.
                    isResolved = true;
                    resolve();
                })
                .catch(err => {
                    isResolved = true;
                    stopMonitor();
                    reject(err);
                });
        });

        res.json({ success: true, repairs: validation.repairs });
    } catch (error: any) {
        logger.error(`[PreviewRoutes] ❌ Bulk sync failed: ${error.message}`);
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
