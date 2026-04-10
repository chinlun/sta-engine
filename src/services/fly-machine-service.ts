import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../lib/logger';

// Dynamic import for strip-ansi (ESM)
let stripAnsi: (string: string) => string;
import('strip-ansi').then(m => {
    stripAnsi = m.default;
});

export interface LogError {
    message: string;
    timestamp: string;
    instance: string;
}

// Active log monitors by machineId
const activeMonitors = new Map<string, {
    process: any,
    listeners: Set<(error: LogError) => void>,
    isStopped: boolean
}>();

export const flyMachineService = {
    async listMachines() {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;
        if (!apiToken || !appName) throw new Error("Missing FLY_API_TOKEN or FLY_APP_NAME");

        const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines`, {
            headers: { "Authorization": `Bearer ${apiToken}` }
        });

        if (!response.ok) {
            logger.error(`[Fly API] ❌ List machines failed ${response.status}`);
            return [];
        }

        return await response.json();
    },

    async createMachine(storeUrl: string, themeToken: string) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;
        if (!apiToken || !appName) throw new Error("Missing FLY_API_TOKEN or FLY_APP_NAME");

        logger.info(`[Fly API] ⏳ Creating machine for ${storeUrl}...`);
        const payload = {
            config: {
                image: `registry.fly.io/${appName}:latest`,
                auto_destroy: true,
                guest: {
                    cpu_kind: 'shared',
                    cpus: 1,
                    memory_mb: 1024
                },
                env: {
                    SHOPIFY_FLAG_STORE: storeUrl,
                    SHOPIFY_CLI_THEME_TOKEN: themeToken,
                    SHOPIFY_STORE_PASSWORD: process.env.SHOPIFY_STORE_PASSWORD || "",
                    BASE_THEME: process.env.BASE_THEME_FILE && process.env.BASE_THEME_FILE.includes("skeleton") ? "skeleton" : "dawn",
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

        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
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
                    logger.warn(`[Fly API] ⚠️ Create machine attempt ${attempt} failed with ${response.status}: ${rawText}`);
                    if (response.status >= 500 || response.status === 429) {
                        lastError = new Error(`Fly API ${response.status}: ${rawText}`);
                        const delay = Math.pow(2, attempt) * 1000;
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                    throw new Error(`Failed to create machine: ${response.status} ${rawText}`);
                }

                const data = JSON.parse(rawText);
                logger.info(`[Fly API] ✅ Created machine: ${data.id}.`);
                return data.id;
            } catch (err: any) {
                lastError = err;
                if (err.message && err.message.includes("Fly API")) {
                    // Already handled by the retry loop condition above
                    continue;
                }
                throw err;
            }
        }

        throw lastError || new Error("Failed to create machine after retries");
    },

    async startMachine(machineId: string) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;

        logger.info(`[Fly API] ⏳ Sending start signal to machine ${machineId}...`);
        const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines/${machineId}/start`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiToken}` }
        });

        if (!response.ok) {
            logger.warn(`[Fly API] ⚠️ Start machine returned ${response.status}`);
        } else {
            logger.info(`[Fly API] ✅ Start signal sent to ${machineId}`);
        }
    },

    async waitForMachine(machineId: string) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;

        logger.info(`[Fly API] ⏳ Waiting for machine ${machineId} to start...`);
        let lastState = '';
        for (let i = 0; i < 30; i++) {
            const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines/${machineId}`, {
                headers: { "Authorization": `Bearer ${apiToken}` }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.state !== lastState) {
                    logger.info(`[Fly API] ℹ️ Machine ${machineId} state: ${data.state}`);
                    lastState = data.state;
                }
                if (data.state === "started") {
                    logger.info(`[Fly API] ✅ Machine ${machineId} is fully started`);
                    return true;
                }
            } else {
                logger.warn(`[Fly API] ⚠️ Failed to fetch machine status: ${response.status}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        logger.error(`[Fly API] ❌ Machine ${machineId} failed to start within timeout.`);
        throw new Error("Machine failed to start within timeout.");
    },

    async stopMachine(machineId: string) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;

        logger.info(`[Fly API] ⏳ Stopping machine ${machineId}...`);
        const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines/${machineId}/stop`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiToken}` }
        });

        if (!response.ok) {
            logger.warn(`[Fly API] ⚠️ Stop machine returned ${response.status}`);
        } else {
            logger.info(`[Fly API] ✅ Stopped machine ${machineId}`);
            // Clean up log monitor if active
            const monitor = activeMonitors.get(machineId);
            if (monitor) {
                monitor.isStopped = true;
                if (monitor.process) monitor.process.kill();
                activeMonitors.delete(machineId);
                logger.info(`[LogChecker] 🛑 Cleaned up log monitor for stopped machine ${machineId}`);
            }
        }
    },

    async destroyMachine(machineId: string) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;

        logger.info(`[Fly API] ⏳ Destroying machine ${machineId}...`);
        const response = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines/${machineId}?kill=true`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${apiToken}` }
        });

        if (!response.ok) {
            logger.warn(`[Fly API] ⚠️ Destroy machine returned ${response.status}`);
        } else {
            logger.info(`[Fly API] ✅ Destroyed machine ${machineId}`);
            // Clean up log monitor if active
            const monitor = activeMonitors.get(machineId);
            if (monitor) {
                monitor.isStopped = true;
                if (monitor.process) monitor.process.kill();
                activeMonitors.delete(machineId);
                logger.info(`[LogChecker] 🛑 Cleaned up log monitor for destroyed machine ${machineId}`);
            }
        }
    },

    async execCommand(machineId: string, command: string[]) {
        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;
        if (!apiToken || !appName) throw new Error("Missing FLY_API_TOKEN or FLY_APP_NAME");

        let lastError = null;
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                if (attempt > 1) {
                    const delay = Math.pow(2, attempt) * 500;
                    logger.info(`[Fly API] 🔄 Retrying execCommand (attempt ${attempt}/5) in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                }

                logger.info(`[Fly API] 🚀 Executing command on machine ${machineId}: ${JSON.stringify(command)}`);
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
                    if (response.status === 429 || response.status >= 500) {
                        logger.warn(`[Fly API] ⚠️ Exec command failed with ${response.status} (attempt ${attempt}): ${errorText}`);
                        lastError = new Error(`Failed to exec command: ${response.status} ${errorText}`);
                        continue;
                    }
                    throw new Error(`Failed to exec command: ${response.status} ${errorText}`);
                }

                const rawText = await response.text();
                try {
                    const data = JSON.parse(rawText);
                    logger.info(`[Fly API] ✅ Exec command completed (Exit Code ${data.exit_code}).`);
                    if (data.stdout) logger.info(`[Fly API] STDOUT:\n${data.stdout}`);
                    if (data.stderr) logger.error(`[Fly API] STDERR:\n${data.stderr}`);
                } catch (e) {
                    logger.info(`[Fly API] ✅ Exec command completed. Raw response:\n${rawText}`);
                }
                return; // Success!
            } catch (err: any) {
                lastError = err;
                if (err.message && (err.message.includes("429") || err.message.includes("500") || err.message.includes("fetch"))) {
                    continue;
                }
                throw err;
            }
        }
        throw lastError || new Error("Failed to exec command after retries");
    },

    async syncFile(machineId: string, filePath: string, content: string) {
        const appName = process.env.FLY_APP_NAME;
        const themeToken = process.env.SHOPIFY_THEME_ACCESS_PASSWORD;
        if (!appName || !themeToken) throw new Error("Missing FLY_APP_NAME or SHOPIFY_THEME_ACCESS_PASSWORD");

        // The remote sync server automatically prefixes with 'theme/' internally.
        // But execCommand runs in '/' and needs the full prefix.
        const fullRoot = 'theme';
        const dirName = path.dirname(filePath);
        const fileName = path.basename(filePath);

        // Path for the sync server (relative to its own internal theme root)
        const serverStagingPath = `sta_staging/${dirName}/${fileName}`;

        // Paths for shell commands (absolute/relative to /)
        const shellStagingPath = `${fullRoot}/sta_staging/${dirName}/${fileName}`;
        const shellFinalPath = `${fullRoot}/${filePath}`;

        const targetUrl = `https://${appName}.fly.dev/sync`;

        const syncFileData = async (path: string, data: string) => {
            const payload = JSON.stringify({ filePath: path, content: data });
            const hmac = crypto.createHmac('sha256', themeToken);
            hmac.update(payload);
            const signature = hmac.digest('hex');

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
                throw new Error(`Failed to HTTP sync ${path}: ${response.status} ${errorText}`);
            }
        };

        logger.info(`[Fly API] 🚀 Atomic Syncing file ${filePath} to machine ${machineId}...`);

        // Ensure staging directory structure exists on remote
        await this.execCommand(machineId, ['mkdir', '-p', `${fullRoot}/sta_staging/${dirName}`]);

        // Write to staging via sync server (server adds 'theme/')
        await syncFileData(serverStagingPath, content);

        // Atomically move to target via shell (we must specify full path from /)
        await this.execCommand(machineId, ['mv', shellStagingPath, shellFinalPath]);
    },

    async syncBulk(machineId: string, files: { filePath: string, content: string }[]) {
        const appName = process.env.FLY_APP_NAME;
        const themeToken = process.env.SHOPIFY_THEME_ACCESS_PASSWORD;
        if (!appName || !themeToken) throw new Error("Missing FLY_APP_NAME or SHOPIFY_THEME_ACCESS_PASSWORD");

        const targetUrl = `https://${appName}.fly.dev/sync-bulk`;
        const fullRoot = 'theme';

        // Create directory structure in staging folder (shell command, needs full prefix)
        const uniqueDirs = [...new Set(files.map(f => path.dirname(f.filePath)))];
        if (uniqueDirs.length > 0) {
            const mkdirCommand = `mkdir -p ${fullRoot}/sta_staging/${uniqueDirs.join(` ${fullRoot}/sta_staging/`)}`;
            await this.execCommand(machineId, ['bash', '-c', mkdirCommand]);
        }

        // Prepare bulk with staged paths (Sync server handles 'theme/' internally, so we don't prefix here)
        const tmpFiles = files.map(f => ({ ...f, filePath: `sta_staging/${f.filePath}` }));
        const payload = JSON.stringify({ files: tmpFiles });

        const hmac = crypto.createHmac('sha256', themeToken);
        hmac.update(payload);
        const signature = hmac.digest('hex');

        logger.info(`[Fly API] 🚀 Bulk Atomic Syncing ${files.length} files to machine ${machineId}...`);
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
            logger.error(`[Fly API] ❌ HTTP Bulk Sync failed ${response.status}: ${errorText}`);
            throw new Error(`Failed to HTTP bulk sync: ${response.status} ${errorText}`);
        }

        // Atomically move all files from staging to their final locations (shell command, needs full prefix)
        const moveCommands = files.map(f => `mv "${fullRoot}/sta_staging/${f.filePath}" "${fullRoot}/${f.filePath}"`).join(' && ');
        await this.execCommand(machineId, ['bash', '-c', moveCommands]);
    },

    /**
     * Monitors logs for a specific machine and detects Shopify CLI errors.
     * Implements auto-reconnect and ANSI scrubbing.
     */
    monitorLogs(machineId: string, onValidationError: (error: LogError) => void): () => void {
        const existing = activeMonitors.get(machineId);
        if (existing) {
            logger.info(`[LogChecker] 🔗 Reusing existing log monitor for ${machineId}`);
            existing.listeners.add(onValidationError);
            return () => {
                existing.listeners.delete(onValidationError);
            };
        }

        const apiToken = process.env.FLY_API_TOKEN;
        const appName = process.env.FLY_APP_NAME;

        if (!apiToken || !appName) {
            logger.error("[LogChecker] ❌ CRITICAL: Missing FLY_API_TOKEN or FLY_APP_NAME. Monitor cannot start.");
            throw new Error("Missing FLY_API_TOKEN or FLY_APP_NAME");
        }

        logger.info(`[LogChecker] 🔍 Initializing NEW persistent log monitor for machine ${machineId}...`);

        const monitorState = {
            process: null as any,
            listeners: new Set<(error: LogError) => void>(),
            isStopped: false
        };
        monitorState.listeners.add(onValidationError);
        activeMonitors.set(machineId, monitorState);

        let logBuffer = "";
        let braceCount = 0;
        let inQuote = false;
        let inErrorBox = false;
        let currentErrorGroup: string[] = [];

        const startListener = () => {
            if (monitorState.isStopped) return;

            logger.info(`[LogChecker] 🛰️ Spawning fly logs for ${machineId}...`);
            const flyLogs = spawn('fly', ['logs', '--app', appName, '--instance', machineId], {
                env: { ...process.env, FLY_API_TOKEN: apiToken }
            });
            monitorState.process = flyLogs;

            flyLogs.on('error', (err: any) => {
                logger.error(`[LogChecker] ❌ Failed to spawn fly logs: ${err.message}`);
                if (!monitorState.isStopped) setTimeout(startListener, 5000);
            });

            flyLogs.stderr.on('data', (data: any) => {
                const msg = data.toString();
                if (!msg.includes("Waiting for logs") && !msg.includes("found instance")) {
                    logger.warn(`[LogChecker] ⚠️ fly logs stderr: ${msg.trim()}`);
                }
            });

            flyLogs.stdout.on('data', (data: any) => {
                logBuffer += data.toString();
                const lines = logBuffer.split('\n');
                logBuffer = lines.pop() || ""; // Keep the last incomplete part

                for (const rawLine of lines) {
                    if (!rawLine.trim()) continue;

                    try {
                        let line = rawLine.trim();
                        if (stripAnsi) line = stripAnsi(line);

                        // Fly log format: TIMESTAMP ID REGION [LEVEL] MESSAGE
                        // Extract everything after the [LEVEL] block
                        const flyMatch = line.match(/^.*\[\w+\]\s*(.*)$/);
                        let message = flyMatch ? flyMatch[1].trim() : line;

                        if (!message) continue;
                        logger.debug(`[LogMonitor] ${message}`);

                        // 1. Detect flattened JSON format from flatten-errors.js
                        if (message.startsWith('{') && message.includes('"process":"shopify_cli"')) {
                            try {
                                const inner = JSON.parse(message);
                                if (inner.process === 'shopify_cli') {
                                    const isError = ['error', 'failure', 'fail', 'rejected'].includes(String(inner.type).toLowerCase());
                                    if (isError) {
                                        logger.error(`[LogChecker] 🚨 FLATTENED ERROR DETECTED ON ${machineId}: ${inner.message}`);
                                        monitorState.listeners.forEach(listener => listener({
                                            message: inner.message,
                                            timestamp: inner.timestamp || new Date().toISOString(),
                                            instance: machineId
                                        }));
                                    } else {
                                        logger.info(`[LogMonitor] [ShopifyCLI] ${inner.message}`);
                                    }
                                    continue;
                                }
                            } catch (e) { /* Fall through to patterns */ }
                        }

                        // 2. Detect start of Shopify CLI error box (╭─ error)
                        if (message.includes("╭─ error") || message.includes("┌─ error") || message.includes("─ error")) {
                            inErrorBox = true;
                            currentErrorGroup = [];
                            continue;
                        }

                        if (inErrorBox) {
                            // Detect end of error box (╰─, └─)
                            if (message.includes("╰─") || message.includes("└─")) {
                                inErrorBox = false;
                                if (currentErrorGroup.length > 0) {
                                    const fullMessage = currentErrorGroup.join("\n").trim();
                                    logger.error(`[LogChecker] 🚨 REMOTE ERROR DETECTED ON ${machineId}:\n${fullMessage}`);
                                    monitorState.listeners.forEach(listener => listener({
                                        message: fullMessage,
                                        timestamp: new Date().toISOString(),
                                        instance: machineId
                                    }));
                                }
                            } else {
                                const cleanLine = message.replace(/[│┃╽╿]/g, "").trim();
                                if (cleanLine) currentErrorGroup.push(cleanLine);
                            }
                        } else {
                            // 3. Single-line failure detection (Signatures in plain text)
                            const errorSignatures = ["Rejected", "Invalid schema", "Liquid syntax error", "Liquid error", "Failed to upload", "Failed to delete"];
                            if (errorSignatures.some(sig => message.includes(sig)) && !message.includes("error reporting")) {
                                logger.error(`[LogChecker] 🚨 SINGLE-LINE ERROR DETECTED ON ${machineId}: ${message}`);
                                monitorState.listeners.forEach(listener => listener({
                                    message: message,
                                    timestamp: new Date().toISOString(),
                                    instance: machineId
                                }));
                            }
                        }
                    } catch (e: any) {
                        logger.warn(`[LogMonitor] Line Parse Error: ${e.message} | Raw: ${rawLine.substring(0, 50)}...`);
                    }
                }
            });

            flyLogs.on('close', (code: number) => {
                if (!monitorState?.isStopped) {
                    logger.info(`[LogChecker] 🔄 fly logs closed (code ${code}). Reconnecting...`);
                    setTimeout(startListener, 3000);
                }
            });
        };

        startListener();

        return () => {
            // Unsubscribe listener
            if (monitorState) {
                monitorState.listeners.delete(onValidationError);
                logger.info(`[LogChecker] Unsubscribed listener for ${machineId}. Active listeners: ${monitorState.listeners.size}`);
            }
        };
    }
};
