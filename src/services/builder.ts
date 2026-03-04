import AdmZip from 'adm-zip';
import { ThemePlan } from '../schema';
import path from 'path';

export const buildTheme = async (plan: ThemePlan): Promise<Buffer> => {
    console.log("[Builder] Building theme with", plan.modifications.length, "modifications");

    // Load the base theme
    const baseTheme = process.env.BASE_THEME_FILE || 'dawn-15.4.1.zip';
    const zipPath = path.join(process.cwd(), baseTheme);

    if (!require('fs').existsSync(zipPath)) {
        throw new Error(`Base theme file not found: ${zipPath}. Please ensure BASE_THEME_FILE is set correctly in .env.`);
    }

    const zip = new AdmZip(zipPath);

    // Detect root folder prefix in the zip (e.g., "dawn-15.4.1/")
    const entries = zip.getEntries();
    let rootPrefix = '';
    if (entries.length > 0) {
        const firstEntry = entries[0].entryName;
        // Check if the first entry is a directory that contains all other files
        if (firstEntry.endsWith('/') && entries.every(e => e.entryName.startsWith(firstEntry))) {
            rootPrefix = firstEntry;
            console.log(`[Builder] Detected zip root folder: ${rootPrefix}`);
        }
    }

    // Apply global settings (stub)
    if (plan.globalSettings) {
        console.log("Applying global settings:", plan.globalSettings);
    }

    // Apply modifications
    for (const mod of plan.modifications) {
        if (mod.action === 'create' || mod.action === 'update') {
            // Prepend the root folder prefix so files go into the correct location
            const fullPath = rootPrefix + mod.filePath.replace(/^\//, '');
            console.log(`[Builder] ${mod.action.toUpperCase()} ${fullPath}`);
            zip.addFile(fullPath, Buffer.from(mod.content, "utf8"));
        }
    }

    return zip.toBuffer();
};
