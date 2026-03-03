import AdmZip from 'adm-zip';
import { ThemePlan } from '../schema';
import path from 'path';

export const buildTheme = async (plan: ThemePlan): Promise<Buffer> => {
    console.log("[Builder] Building theme based on plan:", plan.thoughtProcess);

    // Load the base theme
    const baseTheme = process.env.BASE_THEME_FILE || 'dawn-15.4.1.zip';
    const zipPath = path.join(process.cwd(), baseTheme);

    if (!require('fs').existsSync(zipPath)) {
        throw new Error(`Base theme file not found: ${zipPath}. Please ensure BASE_THEME_FILE is set correctly in .env.`);
    }

    const zip = new AdmZip(zipPath);

    // Apply global settings (stub)
    if (plan.globalSettings) {
        console.log("Applying global settings:", plan.globalSettings);
        // Example: modify settings_data.json
    }

    // Apply modifications
    for (const mod of plan.modifications) {
        if (mod.action === 'create' || mod.action === 'update') {
            console.log(`[Builder] ${mod.action.toUpperCase()} ${mod.filePath}`);
            // Ensure path formatting is correct relative to the zip root
            // If the zip contains a root folder (e.g., 'dawn-15.4.1/'), this logic might need adjustment depending on the zip structure.
            // Assuming the file paths provided by AI are relative to the 'dawn' root.
            zip.addFile(mod.filePath, Buffer.from(mod.content, "utf8"));
        }
    }

    return zip.toBuffer();
};
