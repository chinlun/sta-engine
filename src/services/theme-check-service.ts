import { check, Offense, Severity } from '@shopify/theme-check-node';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CheckResult {
    passed: boolean;
    offenses: Offense[];
    errors: string[];
}

export class ThemeCheckService {
    static async runGateA(rootDir: string): Promise<CheckResult> {
        try {
            // Priority 1: src/config (Development/Local)
            // Priority 2: dist/config (Production)
            let configPath = path.resolve(process.cwd(), 'src/config/theme-check-gate-a.yml');
            if (!existsSync(configPath)) {
                configPath = path.join(__dirname, '../config/theme-check-gate-a.yml');
            }

            if (!existsSync(configPath)) {
                console.warn(`[ThemeCheckService] ⚠️ Config not found at ${configPath}. Running with default Shopify rules.`);
                configPath = undefined as any;
            }

            const offenses = configPath
                ? await check(rootDir, configPath)
                : await check(rootDir);
            const errors = offenses
                .filter(o => o.severity === Severity.ERROR)
                .map(o => {
                    const fileName = o.uri ? path.basename(o.uri) : 'unknown';
                    return `${o.check}: ${o.message} at ${fileName}:${o.start.line + 1}:${o.start.character + 1}`;
                });

            return {
                passed: errors.length === 0,
                offenses,
                errors
            };
        } catch (error: any) {
            console.error('[ThemeCheckService] Gate A failed:', error);
            return {
                passed: false,
                offenses: [],
                errors: [`Theme check failed to run: ${error.message}`]
            };
        }
    }

    /**
     * Gate B: Assembly Level Check
     * Runs a full 'shopify theme check' to catch cross-reference errors.
     * @param themeDir The directory containing the full theme.
     */
    static async runGateB(themeDir: string): Promise<CheckResult> {
        try {
            // Run 'shopify theme check' via CLI
            // This assumes shopify cli is installed in the environment
            const { stdout, stderr } = await execAsync('shopify theme check --output json', { cwd: themeDir });

            // Shopify CLI might return a non-zero exit code if issues are found, 
            // but we want to parse the JSON output anyway.
            const result = JSON.parse(stdout);

            const offenses: Offense[] = result.offenses || [];
            const errors = offenses
                .filter((o: any) => o.severity === 'error')
                .map((o: any) => `${o.check}: ${o.message} in ${o.path}`);

            return {
                passed: errors.length === 0,
                offenses: [], // We don't bother converting full tool output to Offense[] if we just need errors
                errors
            };
        } catch (error: any) {
            // If the command failed but returned JSON on stdout, parse it
            if (error.stdout) {
                try {
                    const result = JSON.parse(error.stdout);
                    const offenses = result.offenses || [];
                    const errors = offenses
                        .filter((o: any) => o.severity === 'error')
                        .map((o: any) => `${o.check}: ${o.message} in ${o.path}`);

                    return {
                        passed: errors.length === 0,
                        offenses: [],
                        errors
                    };
                } catch (e) {
                    // fall through
                }
            }

            console.error('[ThemeCheckService] Gate B failed:', error);
            return {
                passed: false,
                offenses: [],
                errors: [`Shopify CLI check failed: ${error.message}`]
            };
        }
    }
}
