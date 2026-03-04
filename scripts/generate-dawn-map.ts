import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';

/**
 * Generates docs/reference/dawn-file-map.md from the base Dawn theme ZIP.
 * 
 * This provides the AI with a complete understanding of:
 * - Every file available in the Dawn theme
 * - The {% schema %} JSON from each section (settings, blocks, presets)
 * - The JSON content of each template
 */

const BASE_THEME = process.env.BASE_THEME_FILE || 'dawn-15.4.1.zip';
const zipPath = path.join(process.cwd(), BASE_THEME);
const outputPath = path.join(process.cwd(), 'docs', 'reference', 'dawn-file-map.md');

if (!fs.existsSync(zipPath)) {
    console.error(`❌ Base theme not found: ${zipPath}`);
    process.exit(1);
}

const zip = new AdmZip(zipPath);
const entries = zip.getEntries();

// Detect root prefix
let rootPrefix = '';
if (entries.length > 0) {
    const firstEntry = entries[0].entryName;
    if (firstEntry.endsWith('/') && entries.every(e => e.entryName.startsWith(firstEntry))) {
        rootPrefix = firstEntry;
    }
}

// Categorize files
const categories: Record<string, string[]> = {
    'config': [],
    'layout': [],
    'templates': [],
    'sections': [],
    'snippets': [],
    'assets': [],
    'locales': [],
    'other': [],
};

for (const entry of entries) {
    if (entry.isDirectory) continue;

    const relativePath = entry.entryName.replace(rootPrefix, '');
    const folder = relativePath.split('/')[0];

    if (folder in categories) {
        categories[folder].push(relativePath);
    } else {
        categories['other'].push(relativePath);
    }
}

// Build the markdown output
const lines: string[] = [];
lines.push('# Dawn Theme File Map');
lines.push('');
lines.push(`> Auto-generated from \`${BASE_THEME}\`. Do not edit manually.`);
lines.push(`> Regenerate with: \`npx tsx scripts/generate-dawn-map.ts\``);
lines.push('');

// File tree summary
lines.push('## File Tree');
lines.push('');
for (const [category, files] of Object.entries(categories)) {
    if (files.length === 0) continue;
    lines.push(`### ${category}/ (${files.length} files)`);
    lines.push('');
    for (const file of files.sort()) {
        lines.push(`- \`${file}\``);
    }
    lines.push('');
}

// Extract section schemas
lines.push('---');
lines.push('');
lines.push('## Section Schemas');
lines.push('');
lines.push('Each section\'s `{% schema %}` block defines its available settings, blocks, and presets.');
lines.push('The AI MUST use these schemas when configuring sections in `templates/*.json`.');
lines.push('');

const sectionFiles = categories['sections'].filter(f => f.endsWith('.liquid')).sort();

for (const file of sectionFiles) {
    const fullPath = rootPrefix + file;
    const entry = zip.getEntry(fullPath);
    if (!entry) continue;

    const content = entry.getData().toString('utf-8');

    // Extract {% schema %} block
    const schemaMatch = content.match(/\{%[-\s]*schema\s*[-\s]*%\}([\s\S]*?)\{%[-\s]*endschema\s*[-\s]*%\}/);

    const sectionName = path.basename(file, '.liquid');
    lines.push(`### ${sectionName}`);
    lines.push('');

    if (schemaMatch) {
        try {
            const schemaJson = JSON.parse(schemaMatch[1]);
            // Extract key info: name, settings IDs, block types, presets
            const name = schemaJson.name || sectionName;
            const settingIds = (schemaJson.settings || [])
                .filter((s: any) => s.id)
                .map((s: any) => `\`${s.id}\` (${s.type})`);
            const blockTypes = (schemaJson.blocks || [])
                .map((b: any) => `\`${b.type}\` — ${b.name || 'unnamed'}`);
            const hasPresets = schemaJson.presets && schemaJson.presets.length > 0;

            lines.push(`- **Name**: ${name}`);
            if (settingIds.length > 0) {
                lines.push(`- **Settings**: ${settingIds.join(', ')}`);
            }
            if (blockTypes.length > 0) {
                lines.push(`- **Block types**: ${blockTypes.join(', ')}`);
            }
            lines.push(`- **Has presets**: ${hasPresets ? 'Yes' : 'No'}`);
        } catch {
            lines.push('- Schema: (contains translation keys, parse skipped)');
        }
    } else {
        lines.push('- No `{% schema %}` block found');
    }
    lines.push('');
}

// Extract template contents
lines.push('---');
lines.push('');
lines.push('## Template Contents');
lines.push('');
lines.push('These show the default section configurations for each page template.');
lines.push('');

const templateFiles = categories['templates'].filter(f => f.endsWith('.json')).sort();

for (const file of templateFiles) {
    const fullPath = rootPrefix + file;
    const entry = zip.getEntry(fullPath);
    if (!entry) continue;

    const content = entry.getData().toString('utf-8');
    const templateName = path.basename(file, '.json');

    lines.push(`### ${templateName}`);
    lines.push('');

    try {
        const json = JSON.parse(content);
        // Show section types and order
        if (json.sections) {
            const sectionSummary = Object.entries(json.sections).map(([key, val]: [string, any]) =>
                `\`${key}\` → type: \`${val.type}\``
            );
            lines.push(`- **Sections**: ${sectionSummary.join(', ')}`);
        }
        if (json.order) {
            lines.push(`- **Order**: ${json.order.map((o: string) => `\`${o}\``).join(' → ')}`);
        }
    } catch {
        lines.push('- (parse error)');
    }
    lines.push('');
}

// Write output
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');

console.log(`✅ Dawn file map generated: ${outputPath}`);
console.log(`   ${entries.filter(e => !e.isDirectory).length} files documented`);
console.log(`   ${sectionFiles.length} section schemas extracted`);
console.log(`   ${templateFiles.length} template contents extracted`);
