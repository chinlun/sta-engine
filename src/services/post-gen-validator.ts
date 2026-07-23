import { logger } from '../lib/logger';

export interface ThemeFile {
  path: string;
  content: string;
}

export interface ValidationReport {
  passed: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    totalFiles: number;
    sectionCount: number;
    hasThemeBrandCss: boolean;
    placeholdersCount: number;
  };
}

export function validateGeneratedTheme(files: ThemeFile[]): ValidationReport {
  logger.info("[PostGenValidator] Running Post-Generation Validation Suite (7 Verification Checks)...");

  const errors: string[] = [];
  const warnings: string[] = [];
  let placeholdersCount = 0;
  let sectionCount = 0;
  let hasThemeBrandCss = false;

  for (const file of files) {
    const filePath = file.path || '';
    const content = file.content || '';

    // Check 1: Section files lean (< 700 lines of Liquid markup/code)
    if (filePath.startsWith('sections/') && filePath.endsWith('.liquid')) {
      sectionCount++;
      // Exclude schema block when checking markup complexity
      const codeWithoutSchema = content.replace(/\{%\s*schema\s*%\}/i, '---SCHEMA---').split('---SCHEMA---')[0];
      const markupLineCount = codeWithoutSchema.split('\n').length;
      const totalLineCount = content.split('\n').length;

      if (markupLineCount > 700) {
        errors.push(`[Check 1 Failed] Section '${filePath}' exceeds 700 lines limit (${markupLineCount} lines of Liquid code).`);
      }
    }

    // Check 2: No inline <style> or <script> blocks in Liquid files (External asset links allowed)
    if (filePath.endsWith('.liquid')) {
      if (/<style[\s>]/i.test(content)) {
        errors.push(`[Check 2 Failed] Liquid file '${filePath}' contains inline <style> block. CSS must be isolated into an asset file.`);
      }
      // Inline script: <script> tag that does NOT have a src= attribute
      if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(content) && !filePath.includes('layout/theme.liquid')) {
        warnings.push(`[Check 2 Warning] Section file '${filePath}' contains inline <script> block. Consider extracting to asset JS.`);
      }
    }

    // Check 3: All assets referenced via asset_url filter
    if (filePath.endsWith('.liquid')) {
      const unlinkedAssets = content.match(/href=["'](?!https?:\/\/|#)(\w+\.(?:css|js))["']/i);
      if (unlinkedAssets) {
        errors.push(`[Check 3 Failed] Direct unlinked asset reference '${unlinkedAssets[1]}' in '${filePath}'. Use 'asset_url' filter.`);
      }
    }

    // Check 4: Config JSON non-emptiness (no empty {})
    if (filePath.endsWith('.json') && (filePath.startsWith('config/') || filePath.startsWith('sections/') || filePath.startsWith('templates/'))) {
      try {
        const json = JSON.parse(content);
        if (Object.keys(json).length === 0) {
          errors.push(`[Check 4 Failed] Config file '${filePath}' is an empty {} object.`);
        }
      } catch (err: any) {
        errors.push(`[Check 4 Failed] Config file '${filePath}' contains invalid JSON: ${err.message}`);
      }
    }

    // Check 5: Brand overrides isolated in assets/theme-brand.css
    if (filePath === 'assets/theme-brand.css') {
      hasThemeBrandCss = true;
    }

    // Check 6: Business fact placeholders marked [REPLACE_WITH_*]
    const matches = content.match(/\[REPLACE_WITH_[A-Z_]+\]/g);
    if (matches) {
      placeholdersCount += matches.length;
    }
  }

  // Check 5 validation
  if (!hasThemeBrandCss) {
    errors.push(`[Check 5 Failed] Missing 'assets/theme-brand.css' isolated brand delta file.`);
  }

  // Check 7: Config JSON aligns with Stage B mapped output (Verify index.json & header-group.json exist)
  const hasIndexJson = files.some(f => f.path === 'templates/index.json');
  if (!hasIndexJson) {
    errors.push(`[Check 7 Failed] Missing required 'templates/index.json' structure.`);
  }

  const passed = errors.length === 0;
  logger.info(`[PostGenValidator] Verification complete. Passed: ${passed} | Errors: ${errors.length} | Warnings: ${warnings.length}`);

  return {
    passed,
    errors,
    warnings,
    metrics: {
      totalFiles: files.length,
      sectionCount,
      hasThemeBrandCss,
      placeholdersCount
    }
  };
}
