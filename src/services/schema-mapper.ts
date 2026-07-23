import { ExtractedSignals, Signal } from './signal-extractor';
import { logger } from '../lib/logger';

export interface MappedThemeSettings {
  color_schemes: {
    primary: string;
    secondary: string;
    background: string;
    surface: string;
    text: string;
  };
  typography: {
    heading_font: string;
    body_font: string;
    base_size: number;
  };
  layout: {
    container_width: number;
    corner_radius: number;
    spacing_unit: number;
  };
  placeholders: {
    brand_name: string;
    shipping_policy: string;
    return_policy: string;
    guarantee: string;
    founder_bio: string;
  };
  lowConfidenceFields: string[];
}

// Industry/Tone to Color/Typography Best-Fit Mapping Matrix (for confidence 0.4–0.8)
const BEST_FIT_MATRIX: Record<string, { primary: string; background: string; heading_font: string; body_font: string }> = {
  luxury: { primary: '#111111', background: '#FAFAFA', heading_font: 'Playfair Display', body_font: 'Cormorant Garamond' },
  apparel: { primary: '#0F172A', background: '#FFFFFF', heading_font: 'Montserrat', body_font: 'Inter' },
  beauty_skincare: { primary: '#4A3B32', background: '#FAF7F5', heading_font: 'Cinzel', body_font: 'Plus Jakarta Sans' },
  tech: { primary: '#0284C7', background: '#0F172A', heading_font: 'Space Grotesk', body_font: 'Inter' },
  home_decor: { primary: '#2D3748', background: '#F7FAFC', heading_font: 'Lora', body_font: 'Outfit' },
  editorial: { primary: '#000000', background: '#F8F8F8', heading_font: 'Bodoni Moda', body_font: 'Inter' },
  default: { primary: '#18181B', background: '#FFFFFF', heading_font: 'Inter', body_font: 'Inter' }
};

export function mapSignalsToSchema(signals: ExtractedSignals, shopName?: string): MappedThemeSettings {
  logger.info("[SchemaMapper] Stage B: Mapping signals to schema fields...");
  const lowConfidenceFields: string[] = [];

  // Helper for applying 3-tier policy
  const resolveSetting = <T>(
    signal: Signal,
    highConfidenceVal: T,
    mediumConfidenceVal: T,
    neutralPlaceholderVal: T,
    fieldName: string
  ): T => {
    if (signal.confidence > 0.8) {
      return highConfidenceVal;
    } else if (signal.confidence >= 0.4) {
      return mediumConfidenceVal;
    } else {
      lowConfidenceFields.push(fieldName);
      return neutralPlaceholderVal;
    }
  };

  const styleKey = (signals.brand_style.value || signals.industry_category.value || '').toLowerCase();
  const matrixMatch = BEST_FIT_MATRIX[styleKey] || BEST_FIT_MATRIX.default;

  // 1. Color Schemes
  const primaryColor = resolveSetting(
    signals.brand_style,
    matrixMatch.primary,
    matrixMatch.primary,
    '#18181B',
    'color_schemes.primary'
  );

  const backgroundColor = resolveSetting(
    signals.brand_style,
    matrixMatch.background,
    matrixMatch.background,
    '#FFFFFF',
    'color_schemes.background'
  );

  // 2. Typography
  const headingFont = resolveSetting(
    signals.brand_style,
    matrixMatch.heading_font,
    matrixMatch.heading_font,
    'Inter',
    'typography.heading_font'
  );

  const bodyFont = resolveSetting(
    signals.brand_style,
    matrixMatch.body_font,
    matrixMatch.body_font,
    'Inter',
    'typography.body_font'
  );

  // 3. Layout Density
  const isSpacious = (signals.visual_density.value || '').includes('spacious');
  const containerWidth = resolveSetting(
    signals.visual_density,
    isSpacious ? 1440 : 1200,
    1280,
    1200,
    'layout.container_width'
  );

  const cornerRadius = resolveSetting(
    signals.brand_style,
    styleKey.includes('luxury') || styleKey.includes('minimal') ? 0 : 8,
    4,
    4,
    'layout.corner_radius'
  );

  // 4. Fact Preservation — Substitute unverified business facts with strict placeholders
  const placeholders = {
    brand_name: shopName || '[REPLACE_WITH_BRAND_NAME]',
    shipping_policy: '[REPLACE_WITH_SHIPPING_POLICY]',
    return_policy: '[REPLACE_WITH_RETURN_POLICY]',
    guarantee: '[REPLACE_WITH_GUARANTEE]',
    founder_bio: '[REPLACE_WITH_FOUNDER_BIO]'
  };

  logger.info(`[SchemaMapper] Stage B Complete. Low-confidence fields tracked: ${lowConfidenceFields.length}`);

  return {
    color_schemes: {
      primary: primaryColor,
      secondary: '#64748B',
      background: backgroundColor,
      surface: '#F4F4F5',
      text: backgroundColor === '#0F172A' || backgroundColor === '#000000' ? '#F8FAFC' : '#0F172A'
    },
    typography: {
      heading_font: headingFont,
      body_font: bodyFont,
      base_size: 16
    },
    layout: {
      container_width: containerWidth,
      corner_radius: cornerRadius,
      spacing_unit: isSpacious ? 12 : 8
    },
    placeholders,
    lowConfidenceFields
  };
}

/** Sanitizes any text string replacing missing or hallucinatory business facts with standard placeholders */
export function sanitizeBusinessFacts(content: string, shopName?: string): string {
  let sanitized = content;

  // Replace default brand name if needed
  if (shopName) {
    sanitized = sanitized.replace(/ACME\s+Store|Example\s+Store|My\s+Store/gi, shopName);
  } else {
    sanitized = sanitized.replace(/ACME\s+Store|Example\s+Store|My\s+Store/gi, '[REPLACE_WITH_BRAND_NAME]');
  }

  // Common business fact patterns
  sanitized = sanitized.replace(/\b(free\s+shipping\s+on\s+all\s+orders\s+over\s+\$\d+|ships\s+in\s+\d+-\d+\s+business\s+days)\b/gi, '[REPLACE_WITH_SHIPPING_POLICY]');
  sanitized = sanitized.replace(/\b(\d+-day\s+money\s+back\s+guarantee|100%\s+satisfaction\s+guaranteed)\b/gi, '[REPLACE_WITH_GUARANTEE]');
  sanitized = sanitized.replace(/\b(easy\s+\d+-day\s+returns|free\s+returns\s+within\s+\d+\s+days)\b/gi, '[REPLACE_WITH_RETURN_POLICY]');

  return sanitized;
}
