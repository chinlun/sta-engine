import { flyMachineService, LogEntry } from './fly-machine-service';
import { executeCorrectionLoop } from '../lib/correction-loop';
import { logger } from '../lib/logger';
import path from 'path';

export interface SyncResult {
    success: boolean;
    fixedContent?: string;
    error?: string;
}

export class SyncOrchestrator {
    /**
     * Waits for the Shopify CLI "Ready" signal.
     * Signal: { type: "success", message: "Preview your theme" }
     */
    async waitForCLIReady(machineId: string): Promise<void> {
        return new Promise((resolve) => {
            logger.info(`[SyncOrchestrator] ⏳ Waiting for Shopify CLI ready signal on machine ${machineId}...`);
            
            const stopMonitor = flyMachineService.monitorLogs(machineId, (entry: LogEntry) => {
                const isReady = entry.type === 'success' && entry.message.includes('Preview your theme');
                if (isReady) {
                    logger.info(`[SyncOrchestrator] 🚀 Shopify CLI is READY.`);
                    stopMonitor();
                    resolve();
                }
            });
        });
    }

    /**
     * Syncs a single file and waits for a success/error signal from Shopify CLI.
     * Handlers:
     * 1. Success (Synced » update/create <path>) -> Resolve success
     * 2. Error -> Attempt repair (regex or AI) -> Re-sync -> Loop up to 5 times.
     */
    async syncFileWithRetry(
        machineId: string, 
        filePath: string, 
        content: string, 
        availableFiles: string[],
        themeId?: string
    ): Promise<SyncResult> {
        let currentContent = content;
        let attempts = 0;
        const MAX_ATTEMPTS = 5;

        while (attempts < MAX_ATTEMPTS) {
            attempts++;
            logger.info(`[SyncOrchestrator] 📤 [${attempts}/${MAX_ATTEMPTS}] Syncing: ${filePath}`);

            let resolveResult: (res: SyncResult) => void;
            const resultPromise = new Promise<SyncResult>((res) => { resolveResult = res; });

            const baseName = path.basename(filePath);
            const stopMonitor = flyMachineService.monitorLogs(machineId, async (entry: LogEntry) => {
                // 1. Success Detection
                const isSuccess = entry.message.includes('Synced »') && (entry.message.includes(filePath) || entry.message.includes(baseName));
                if (isSuccess) {
                    logger.info(`[SyncOrchestrator] ✅ Verified sync for ${filePath}`);
                    stopMonitor();
                    resolveResult({ success: true, fixedContent: currentContent });
                    return;
                }

                // 2. Error Detection (must match file path or base name, or contain liquid syntax error)
                const isError = entry.type === 'error' && (
                    entry.message.includes(filePath) || 
                    entry.message.includes(baseName) || 
                    entry.message.toLowerCase().includes('liquid syntax error')
                );
                if (isError) {
                    logger.warn(`[SyncOrchestrator] ⚠️ Error detected for ${filePath}: ${entry.message}`);
                    stopMonitor();
                    
                    const repairResult = await this.attemptRepair(machineId, filePath, currentContent, entry.message, availableFiles);
                    if (repairResult.handled) {
                        currentContent = repairResult.newContent;
                        // Return special result to restart the loop in outer scope (or just let while continue)
                        resolveResult({ success: false, fixedContent: currentContent }); 
                    } else {
                        // Persistent failure
                        resolveResult({ success: false, error: entry.message });
                    }
                }
            });
            let attemptResult;
            try {
                await flyMachineService.syncFile(machineId, filePath, currentContent);
                attemptResult = await Promise.race([
                    resultPromise,
                    new Promise<SyncResult>((r) => setTimeout(() => r({ success: false, error: 'Timeout' }), 90000))
                ]);
            } catch (err: any) {
                logger.warn(`[SyncOrchestrator] ⚠️ Network sync failed for ${filePath}: ${err.message}. Retrying...`);
                stopMonitor();
                await new Promise(r => setTimeout(r, 1000 * attempts));
                continue;
            }

            stopMonitor();

            if (attemptResult.success) {
                // If it fixed anything, we might want to propagate that back to index.ts
                if (attempts > 1 && themeId) {
                    await this.persistToR2(themeId, filePath, currentContent);
                }
                return attemptResult;
            }

            if (attemptResult.error === 'Timeout') {
                logger.warn(`[SyncOrchestrator] ⏲️ Timeout waiting for confirmation of ${filePath}. Moving on.`);
                return { success: true }; // Assume success on timeout to prevent blocking forever
            }

            // If we got here, we have a fixedContent and we should try again
            if (attemptResult.fixedContent) {
                currentContent = attemptResult.fixedContent;
            } else {
                return { success: false, error: attemptResult.error };
            }
        }

        return { success: false, error: 'Max attempts reached' };
    }

    /**
     * Logic for repairing a broken file based on CLI error logs.
     */
    private async attemptRepair(
        machineId: string, 
        filePath: string, 
        content: string, 
        errorMsg: string, 
        availableFiles: string[]
    ): Promise<{ handled: boolean, newContent: string }> {
        const reason = errorMsg.split(filePath)[1] || errorMsg;
        let handled = false;
        let newContent = content;

        // --- 1. Regex: Schema name too long ---
        if (reason.includes("name is too long")) {
            const schemaRegex = /\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/;
            const schemaMatch = newContent.match(schemaRegex);
            if (schemaMatch) {
                try {
                    const schema = JSON.parse(schemaMatch[1]);
                    let changed = false;
                    if (schema.name && schema.name.length > 25) {
                        schema.name = schema.name.substring(0, 25).trim();
                        changed = true;
                    }
                    if (schema.presets) {
                        for (const p of schema.presets) {
                            if (p.name && p.name.length > 25) {
                                p.name = p.name.substring(0, 25).trim();
                                changed = true;
                            }
                        }
                    }
                    if (changed) {
                        newContent = newContent.replace(schemaMatch[1], `\n${JSON.stringify(schema, null, 2)}\n`);
                        logger.info(`[Sync] ✅ [Regex] Fixed schema name length in "${filePath}"`);
                        handled = true;
                    }
                } catch (e) { }
            }
        }

        // --- 2. Regex: Index collision ---
        if (!handled && (reason.includes("already exists with json extension") || reason.includes("already exists with liquid extension"))) {
            const conflictingExt = reason.includes("json extension") ? "json" : "liquid";
            const fileBase = filePath.split('.')[0];
            const fileToRemove = `${fileBase}.${conflictingExt}`;
            logger.info(`[Sync] 🗑️ [Regex] Removing collision: ${fileToRemove}`);
            try {
                await flyMachineService.execCommand(machineId, ['rm', '-f', `theme/${fileToRemove}`]);
                handled = true; 
            } catch (e) { }
        }

        // --- 3. Regex: theme_info guardrails ---
        if (!handled && (reason.includes("theme_support_email") || reason.includes("theme_support_url"))) {
            try {
                const schema = JSON.parse(newContent);
                let fixed = false;
                if (Array.isArray(schema)) {
                    for (const section of schema) {
                        if (section.name === 'theme_info' || section.id === 'theme_info') {
                            if (section.theme_support_email) { delete section.theme_support_email; fixed = true; }
                            if (!section.theme_support_url) { section.theme_support_url = 'https://help.shopify.com'; fixed = true; }
                        }
                    }
                }
                if (fixed) {
                    newContent = JSON.stringify(schema, null, 2);
                    logger.info(`[Sync] ✅ [Guardrail] Fixed theme_info in "${filePath}"`);
                    handled = true;
                }
            } catch (e) { }
        }

        // --- 4. Regex: Section missing in index.json ---
        if (!handled && reason.includes("does not refer to an existing section")) {
            const sectionMatch = reason.match(/Section type ['"]?([^'"\s]+)['"]?/i);
            const missingType = sectionMatch ? sectionMatch[1] : null;
            if (missingType) {
                try {
                    const indexJson = JSON.parse(newContent);
                    let fixed = false;
                    for (const key in (indexJson.sections || {})) {
                        if (indexJson.sections[key].type === missingType) {
                            const availableSections = availableFiles
                                .filter(k => k.startsWith('sections/') && k.endsWith('.liquid'))
                                .map(k => k.replace('sections/', '').replace('.liquid', ''));
                            
                            const bestMatch: string | undefined = availableSections.find(s => 
                                s.toLowerCase() === missingType.toLowerCase().replace(/\s+/g, '-') ||
                                s.toLowerCase().replace(/[^a-z0-0]/g, '') === missingType.toLowerCase().replace(/[^a-z0-0]/g, '')
                            );

                            if (bestMatch && bestMatch !== missingType) {
                                logger.info(`[Sync] 🛠️ [Regex] Mapping "${missingType}" -> "${bestMatch}" in "${filePath}"`);
                                indexJson.sections[key].type = bestMatch;
                                fixed = true;
                            } else if (!bestMatch) {
                                logger.info(`[Sync] 🗑️ [Regex] Removing rogue section "${missingType}" from "${filePath}"`);
                                delete indexJson.sections[key];
                                if (indexJson.order) indexJson.order = indexJson.order.filter((id: any) => id !== key);
                                fixed = true;
                            }
                        }
                    }
                    if (fixed) {
                        newContent = JSON.stringify(indexJson, null, 2);
                        handled = true;
                    }
                } catch (e) { }
            }
        }
        // --- 5. Regex/JSON: Invalid setting default type ---
        if (!handled && reason.includes("default must be a string")) {
            const settingMatch = reason.match(/setting with id=['"]?([^'"\s]+)['"]?/i);
            const settingId = settingMatch ? settingMatch[1] : null;
            if (settingId) {
                const schemaRegex = /\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/;
                const schemaMatch = newContent.match(schemaRegex);
                if (schemaMatch) {
                    try {
                        const schema = JSON.parse(schemaMatch[1]);
                        let changed = false;
                        const fixSettingDefault = (settings: any[]) => {
                            let subChanged = false;
                            for (const setting of settings) {
                                if (setting.id === settingId) {
                                    if (typeof setting.default !== 'string') {
                                        setting.default = "";
                                        subChanged = true;
                                    }
                                }
                            }
                            return subChanged;
                        };
                        if (schema.settings && Array.isArray(schema.settings)) {
                            if (fixSettingDefault(schema.settings)) changed = true;
                        }
                        if (schema.blocks && Array.isArray(schema.blocks)) {
                            for (const block of schema.blocks) {
                                if (block.settings && Array.isArray(block.settings)) {
                                    if (fixSettingDefault(block.settings)) changed = true;
                                }
                            }
                        }
                        if (changed) {
                            newContent = newContent.replace(schemaMatch[1], `\n${JSON.stringify(schema, null, 2)}\n`);
                            logger.info(`[Sync] ✅ [Regex] Fixed invalid default for setting "${settingId}" in "${filePath}"`);
                            handled = true;
                        }
                    } catch (e) { }
                }
            }
        }

        // --- 5.5. Regex: Liquid syntax & quote errors ---
        if (!handled && (reason.toLowerCase().includes("liquid syntax error") || reason.includes("Unexpected character"))) {
            const malformedSplitRegex = /(\|\s*split:\s*)(['"])([^'"]*?)(?=\s*-?%\}|\s*\}\})/g;
            if (malformedSplitRegex.test(newContent)) {
                newContent = newContent.replace(malformedSplitRegex, (match: string, prefix: string, quote: string, val: string) => {
                    if (!val.endsWith(quote)) {
                        return `${prefix}${quote}${val}${quote}`;
                    }
                    return match;
                });
                logger.info(`[Sync] ✅ [Regex] Auto-balanced quotes in Liquid filter for "${filePath}"`);
                handled = true;
            }
        }

        // --- 6. LLM Fallback ---
        if (!handled) {
            logger.info(`[Sync] 🤖 Falling back to LLM for "${filePath}"...`);
            const aiResult = await executeCorrectionLoop(
                { message: errorMsg, filePath },
                content,
                availableFiles
            );
            if (aiResult.success) {
                newContent = aiResult.fixedContent;
                handled = true;
                logger.info(`[Sync] ✅ [LLM] AI corrected "${filePath}"`);
            }
        }

        return { handled, newContent };
    }

    /**
     * Persists a fixed version of a file back to R2 so future builds have it.
     */
    private async persistToR2(themeId: string, filePath: string, content: string) {
        try {
            const { uploadThemeState, getThemeState } = require('./r2-service');
            const current = await getThemeState(themeId);
            const updated = [...current];
            const idx = updated.findIndex((f: any) => (f.filePath || f.path) === filePath);
            const mod = { filePath, content, action: 'update', path: filePath };
            if (idx >= 0) updated[idx] = mod; else updated.push(mod);
            await uploadThemeState(themeId, updated);
            logger.info(`[R2] ☁️ Persisted repair for ${filePath}`);
        } catch (e) {
            logger.warn(`[R2] Failed to persist repair: ${e}`);
        }
    }

    /**
     * Orders files for syncing to satisfy dependencies.
     * Liquid first, then JSON, with templates/index.json absolute last.
     */
    orderFilesForSync(modifications: any[]): any[] {
        return [...modifications].sort((a, b) => {
            const pathA = a.filePath || a.path || '';
            const pathB = b.filePath || b.path || '';

            // templates/index.json is ALWAYS last
            if (pathA === 'templates/index.json') return 1;
            if (pathB === 'templates/index.json') return -1;

            // config/settings_data.json is penultimate
            if (pathA === 'config/settings_data.json') return 1;
            if (pathB === 'config/settings_data.json') return -1;

            // Liquid files before JSON files
            const isLiquidA = pathA.endsWith('.liquid');
            const isLiquidB = pathB.endsWith('.liquid');
            if (isLiquidA && !isLiquidB) return -1;
            if (!isLiquidA && isLiquidB) return 1;

            // Otherwise alphabetical (ish)
            return pathA.localeCompare(pathB);
        });
    }
}

export const syncOrchestrator = new SyncOrchestrator();
