import { Router } from "express";
import { flyMachineService } from "../services/fly-machine-service";
import { validateAndRepair, normalizeMod } from "../services/builder";
import { executeCorrectionLoop } from "../lib/correction-loop";
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

        // 1. Validate and Auto-Repair (Gate A)
        const themePlan = { modifications: files, globalSettings, thoughtProcess: "" };
        const validation = validateAndRepair(themePlan as any);

        if (!validation.valid) {
            logger.error(`[PreviewRoutes] ❌ Validation failed: ${validation.errors.join(", ")}`);
            return res.status(400).json({ error: "Validation failed", details: validation.errors });
        }

        if (validation.repairs.length > 0) {
            logger.info(`[PreviewRoutes] 🛠️ Applied ${validation.repairs.length} Gate A auto-repairs before sync.`);
        }

        // 2. Normalize from the REPAIRED plan (not the original files array)
        const normalizedFiles = (themePlan.modifications as any[]).map(f => normalizeMod(f))
            .filter(f => f.filePath && f.content && f.action !== 'delete')
            .sort((a, b) => {
                const aIsJson = a.filePath!.endsWith('.json');
                const bIsJson = b.filePath!.endsWith('.json');
                if (aIsJson && !bIsJson) return 1;
                if (!aIsJson && bIsJson) return -1;
                return 0;
            });

        // Store synced content for Gate B corrections
        const syncedFiles = new Map<string, string>();
        for (const f of normalizedFiles) {
            syncedFiles.set(f.filePath!, f.content);
        }

        // Delete files marked for deletion (e.g., index.liquid collision)
        const deletions = (themePlan.modifications as any[]).map(f => normalizeMod(f))
            .filter(f => f.filePath && f.action === 'delete');
        for (const del of deletions) {
            logger.info(`[PreviewRoutes] 🗑️ Deleting conflicting file on remote: ${del.filePath}`);
            try {
                await flyMachineService.execCommand(machineId, ['rm', '-f', `theme/${del.filePath}`]);
            } catch (e: any) {
                logger.warn(`[PreviewRoutes] ⚠️ Failed to delete ${del.filePath}: ${e.message}`);
            }
        }

        // 3. Gate B: Correction Loop State
        const MAX_ATTEMPTS_PER_FILE = 5;
        const fileAttempts = new Map<string, number>();
        let pendingErrors: string[] = [];
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const applyCorrections = async (errors: string[]) => {
            const filesToResync: { filePath: string; content: string }[] = [];
            const round = Math.max(...Array.from(fileAttempts.values()), 0) + 1;

            logger.info(`[PreviewRoutes] 🔧 Correction Round ${round}: Processing ${errors.length} errors...`);

            for (const errorMsg of errors) {
                // Parse error: extract file path and reason
                const fileMatch = errorMsg.match(/Failed to (?:upload|delete) file "([^"]+)"/);
                if (!fileMatch) continue;
                const failedFile = fileMatch[1];
                const reason = errorMsg.replace(fileMatch[0], "").trim();

                // Check per-file attempt limit
                const attempts = fileAttempts.get(failedFile) || 0;
                if (attempts >= MAX_ATTEMPTS_PER_FILE) {
                    logger.warn(`[PreviewRoutes] ⚠️ Max attempts (${MAX_ATTEMPTS_PER_FILE}) reached for "${failedFile}". Skipping.`);
                    continue;
                }
                fileAttempts.set(failedFile, attempts + 1);

                logger.info(`[PreviewRoutes] 🔍 Error on "${failedFile}" (attempt ${attempts + 1}/${MAX_ATTEMPTS_PER_FILE}): ${reason}`);

                let handled = false;

                // --- Regex Handler: Schema name too long ---
                if (reason.includes("name is too long")) {
                    const content = syncedFiles.get(failedFile);
                    if (content) {
                        const schemaRegex = /\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/;
                        const schemaMatch = content.match(schemaRegex);
                        if (schemaMatch) {
                            try {
                                const schema = JSON.parse(schemaMatch[1]);
                                if (schema.name && schema.name.length > 25) {
                                    schema.name = schema.name.substring(0, 25).trim();
                                }
                                if (schema.presets) {
                                    for (const p of schema.presets) {
                                        if (p.name && p.name.length > 25) p.name = p.name.substring(0, 25).trim();
                                    }
                                }
                                const fixedContent = content.replace(schemaMatch[1], `\n${JSON.stringify(schema, null, 2)}\n`);
                                syncedFiles.set(failedFile, fixedContent);
                                filesToResync.push({ filePath: failedFile, content: fixedContent });
                                logger.info(`[PreviewRoutes] ✅ [Regex] Fixed schema name length in "${failedFile}"`);
                                handled = true;
                            } catch (e) { }
                        }
                    }
                }

                // --- Regex Handler: Index collision ---
                if (!handled && (reason.includes("already exists with json extension") || reason.includes("already exists with liquid extension"))) {
                    const conflictingExt = reason.includes("json extension") ? "json" : "liquid";
                    const fileBase = failedFile.split('.')[0];
                    const fileToRemove = `${fileBase}.${conflictingExt}`;

                    logger.info(`[PreviewRoutes] 🗑️ [Regex] Removing conflicting extension: ${fileToRemove} (blocking ${failedFile})`);
                    try {
                        await flyMachineService.execCommand(machineId, ['rm', '-f', `theme/${fileToRemove}`]);
                    } catch (e) { }
                    handled = true;
                }

                // --- Guardrail: theme_info — always URL, never email, name ≤25, doc URL required ---
                if (!handled && (reason.includes("theme_support_email") || reason.includes("theme_support_url") || reason.includes("theme_documentation_url") || reason.includes("theme_name"))) {
                    let content = syncedFiles.get(failedFile);
                    if (content) {
                        try {
                            const schema = JSON.parse(content);
                            let fixed = false;

                            if (Array.isArray(schema)) {
                                for (const section of schema) {
                                    if (section.name === 'theme_info' || section.id === 'theme_info' || section.name === 'Theme info') {
                                        // Flat keys: always remove email, always ensure URL
                                        if (section.theme_support_email) {
                                            delete section.theme_support_email;
                                            fixed = true;
                                        }
                                        if (!section.theme_support_url) {
                                            section.theme_support_url = 'https://help.shopify.com';
                                            fixed = true;
                                        }
                                        // theme_documentation_url: required
                                        if (!section.theme_documentation_url) {
                                            section.theme_documentation_url = 'https://help.shopify.com';
                                            fixed = true;
                                        }
                                        // theme_name: max 25 chars
                                        if (section.theme_name && typeof section.theme_name === 'string' && section.theme_name.length > 25) {
                                            section.theme_name = section.theme_name.substring(0, 25).trim();
                                            fixed = true;
                                        }
                                        // Settings array: same logic
                                        if (Array.isArray(section.settings)) {
                                            const emailIdx = section.settings.findIndex((s: any) => s.id === 'theme_support_email');
                                            if (emailIdx !== -1) {
                                                section.settings.splice(emailIdx, 1);
                                                fixed = true;
                                            }
                                            const hasUrl = section.settings.some((s: any) => s.id === 'theme_support_url');
                                            if (!hasUrl) {
                                                section.settings.push({ type: 'text', id: 'theme_support_url', label: 'Theme Support URL', default: 'https://help.shopify.com' });
                                                fixed = true;
                                            }
                                        }
                                    }
                                }
                            }

                            if (fixed) {
                                content = JSON.stringify(schema, null, 2);
                                syncedFiles.set(failedFile, content);
                                filesToResync.push({ filePath: failedFile, content });
                                logger.info(`[PreviewRoutes] ✅ [Guardrail] Fixed theme_info in "${failedFile}"`);
                                handled = true;
                            }
                        } catch (e) { /* JSON parse failed, fall through */ }
                    }
                }

                // --- Guardrail: Section extension collision (.json vs .liquid) ---
                if (!handled && reason.includes("already exists with liquid extension")) {
                    const match = reason.match(/Filename\s+(\w+)\s+already exists with liquid extension/i);
                    const baseName = match ? match[1] : null;
                    if (baseName) {
                        const jsonFile = `sections/${baseName}.json`;
                        // Action: Remove from local sync map and delete on machine
                        syncedFiles.delete(jsonFile);
                        try {
                            await flyMachineService.execCommand(machineId, ['rm', '-f', `theme/${jsonFile}`]);
                        } catch (e) { }

                        logger.info(`[PreviewRoutes] ✅ [Guardrail] Resolved section collision: deleted "${jsonFile}" in favor of existing .liquid`);
                        handled = true;
                    }
                }

                // --- Regex Handler: Section type does not refer to existing section file ---
                if (!handled && reason.includes("does not refer to an existing section")) {
                    const content = syncedFiles.get(failedFile);
                    if (content) {
                        filesToResync.push({ filePath: failedFile, content });
                        logger.info(`[PreviewRoutes] 🔄 [Regex] Re-syncing template "${failedFile}" (section dependency should be fixed)`);
                        handled = true;
                    }
                }

                // --- LLM Fallback: Unrecognized error ---
                if (!handled) {
                    const content = syncedFiles.get(failedFile);
                    if (content) {
                        logger.info(`[PreviewRoutes] 🤖 [LLM] No regex handler for "${failedFile}". Calling AI correction...`);
                        const result = await executeCorrectionLoop(
                            { message: errorMsg, filePath: failedFile },
                            content
                        );
                        if (result.success) {
                            syncedFiles.set(failedFile, result.fixedContent);
                            filesToResync.push({ filePath: failedFile, content: result.fixedContent });
                            logger.info(`[PreviewRoutes] ✅ [LLM] AI corrected "${failedFile}"`);
                        } else {
                            logger.warn(`[PreviewRoutes] ⚠️ [LLM] AI could not fix "${failedFile}"`);
                        }
                    }
                }
            }

            // Re-sync corrected files
            if (filesToResync.length > 0) {
                logger.info(`[PreviewRoutes] 📤 Sequential re-sync of ${filesToResync.length} corrected files...`);
                try {
                    for (const file of filesToResync) {
                        await flyMachineService.syncFile(machineId, file.filePath, file.content);
                    }
                    // Wait 5 seconds to catch CLI feedback
                    await new Promise(r => setTimeout(r, 5000));
                    logger.info(`[PreviewRoutes] ✅ Correction round complete.`);
                } catch (e: any) {
                    logger.error(`[PreviewRoutes] ❌ Correction sequential sync failed: ${e.message}`);
                }
            } else {
                logger.info(`[PreviewRoutes] ℹ️ No correctable files found in this round.`);
            }
        };

        // Execution Controller
        let isCorrecting = false;
        let initialWaitPassed = false;
        let resolveSyncFinished: (val: any) => void;

        const processQueue = async () => {
            isCorrecting = true;
            while (pendingErrors.length > 0) {
                const errorsToProcess = [...pendingErrors];
                pendingErrors = [];
                await applyCorrections(errorsToProcess);
            }
            isCorrecting = false;

            if (initialWaitPassed && pendingErrors.length === 0 && resolveSyncFinished) {
                logger.info(`[PreviewRoutes] 🎉 All corrections finished and remote theme is stable.`);
                resolveSyncFinished({ success: true, repairs: validation.repairs });
            }
        };

        // 4. Start Monitor with Correction Callback
        const stopMonitor = flyMachineService.monitorLogs(machineId, (error) => {
            logger.error(`[PreviewRoutes] 🚨 Remote Error Detected: ${error.message.split('\n')[0]}`);

            pendingErrors.push(error.message);
            if (!isCorrecting) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    processQueue();
                }, 3000); // Wait 3s after last error before applying fixes
            }
        });

        // 5. Sync files sequentially to ensure structural integrity
        logger.info(`[PreviewRoutes] 📤 Sequential sync of ${normalizedFiles.length} files...`);
        for (const f of normalizedFiles) {
            await flyMachineService.syncFile(machineId, f.filePath!, f.content);
        }
        logger.info(`[PreviewRoutes] ✅ Initial sequential sync complete. Waiting for remote confirmation...`);

        const syncFinishedPromise = new Promise((resolve) => {
            resolveSyncFinished = resolve;
        });

        setTimeout(() => {
            initialWaitPassed = true;
            if (!isCorrecting && pendingErrors.length === 0 && resolveSyncFinished) {
                logger.info(`[PreviewRoutes] 🎉 Initial sync stable (no errors detected).`);
                resolveSyncFinished({ success: true, repairs: validation.repairs });
            }
        }, 6000); // Wait 6s after initial sync to see if CLI throws any errors

        const finalResult = await syncFinishedPromise;
        res.json(finalResult);
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
