# Shopify Theme Design System Reference

This document provides a gold-standard reference for creating professional, agency-quality Shopify themes. Use these curated palettes, typography pairings, and layout principles to ensure generated themes look like they were designed by an elite studio.

## 1. Professional Color Palettes

Never use raw black (#000000) or generic primary colors (#FF0000, #0000FF). Always use curated palettes with harmonious contrast. When applying these to `config/settings_data.json`, update the specific `color_schemes` accordingly.

> **Note on Custom Requests:** The palettes below are a baseline. If the user explicitly requests a design outside these curated options (e.g., "Cyberpunk Neon" or "Pastel Bubblegum"), you MUST act as an elite designer. Identify the base background, establish high-contrast text, pick a vibrant/soft accent color, and ensure the entire palette feels mathematically and visually cohesive. Do not fall back to generic defaults.

### 🖤 Luxury Dark (High-End Fashion, Tech, Watches)
- **Background:** `#0A0A0A` (Deepest Charcoal, softer than pure black)
- **Secondary Background (Cards):** `#141414` (Slightly lighter for depth)
- **Primary Text:** `#F5F5F0` (Off-white, reduces eye strain)
- **Secondary Text:** `#A3A3A3` (Muted gray for subtitles/meta)
- **Accent/Button Background:** `#C9A96E` (Warm Metallic Gold)
- **Button Text:** `#0A0A0A` (Dark text on gold button)
- **Outline/Borders:** `#262626` (Subtle separation)

### 🌿 Clean Minimal (Skincare, Home Goods, Ceramics)
- **Background:** `#FAF9F6` (Warm Off-White/Alabaster)
- **Secondary Background (Cards):** `#F0EFEA` (Very subtle definition)
- **Primary Text:** `#2D2C2A` (Soft Black/Charcoal)
- **Secondary Text:** `#73716E` (Warm gray)
- **Accent/Button Background:** `#4A5D4E` (Muted Sage Green) or `#2D2C2A` (Solid Black)
- **Button Text:** `#FAF9F6`
- **Outline/Borders:** `#E6E5E1` (Very soft borders)

### 🔥 Bold Streetwear (Apparel, Energy Drinks, Youth Culture)
- **Background:** `#ECECEC` (Cool Light Gray) or `#0F0F0F` (Dark Mode)
- **Primary Text:** `#111111` (Near Black)
- **Secondary Text:** `#666666` (Medium Gray)
- **Accent/Button Background:** `#FF3E00` (Vibrant Electric Orange) or `#CCFF00` (Acid Yellow/Green)
- **Button Text:** `#111111`
- **Outline/Borders:** `#111111` (High-contrast harsh borders, 2px solid)

### 🌊 Ocean Breeze (Swimwear, Supplements, Outdoor)
- **Background:** `#F4F7F6` (Very cool tinted white)
- **Primary Text:** `#1C2A38` (Deep Navy)
- **Secondary Text:** `#5A6B7C` (Slate Gray)
- **Accent/Button Background:** `#3A86FF` (Vibrant Royal Blue)
- **Button Text:** `#FFFFFF`
- **Outline/Borders:** `#DCE4E8`

---

## 2. Typography Pairings

Always specify Google Fonts natively supported by Shopify. Use precise weights to establish hierarchy.

| Vibe | Heading Font | Body Font | Heirarchy Rules |
|------|--------------|-----------|-----------------|
| **Modern Elegance** | `playfair_display_n6` (Semibold) | `montserrat_n4` (Regular) | Great for luxury and beauty. Headings look best in Title Case. |
| **Clean Tech/SaaS** | `inter_n7` (Bold) | `inter_n4` (Regular) | Tight tracking (letter-spacing: -0.02em) on headings for a modern look. |
| **Editorial/Chic** | `cormorant_garamond_i4` (Italic) | `lato_n4` (Regular) | Italic serif headings give a high-end magazine feel. Large heading sizing (h0, h1). |
| **Punchy Retail** | `oswald_n5` (Medium) | `roboto_n4` (Regular) | ALL CAPS headings (`text-transform: uppercase; letter-spacing: 0.1em;`). |
| **Friendly/Organic** | `outfit_n6` (Semibold) | `nunito_n4` (Regular) | Soft, rounded feel. Perfect for baby products or organic food. |

---

## 3. Spatial Rhythm & Spacing

Professional design relies on consistent whitespace. Do not use arbitrary padding values.

**Vertical Rhythm Scale:**
- Micro: `8px` / `16px` (Between heading and subheading, or icon and text)
- Component: `24px` / `32px` (Padding inside buttons or cards)
- Section Content: `48px` / `64px` (Between blocks within a section)
- Section Padding: `80px` / `100px` (Space between major page sections)

**Standard Implementation:**
```css
/* Use Shopify's native clamping for responsive spacing */
.section-padding {
  padding-top: clamp(48px, 8vw, 100px);
  padding-bottom: clamp(48px, 8vw, 100px);
}
```

---

## 4. Modern CSS Patterns & Aesthetics

Inject these techniques into your `.liquid` section `<style>` tags to elevate the design from "basic" to "premium".

### A. Polished Buttons (Hover States & Transitions)
Never generate a basic button without a hover state.
```css
.button--primary {
  background-color: var(--color-base-accent-1);
  color: var(--color-base-solid-button-labels);
  padding: 16px 32px;
  border-radius: 4px; /* 0px for streetwear, 100px for pill-shape */
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  border: 1px solid transparent;
}

.button--primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.1);
  /* For dark themes: box-shadow: 0 10px 20px rgba(255, 255, 255, 0.05); */
}
```

### B. High-End Card Layouts (Glassmorphism & Depth)
For product cards, feature highlights, or testimonials.
```css
.premium-card {
  background: rgba(255, 255, 255, 0.03); /* Subtle backdrop */
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.05); /* Very subtle border */
  border-radius: 12px;
  padding: 32px;
  transition: transform 0.4s ease, border-color 0.4s ease;
}

.premium-card:hover {
  transform: translateY(-4px);
  border-color: rgba(255, 255, 255, 0.2);
}
```

### C. Elegant Hero Overlays
Never put raw text directly on an image. It ruins legibility.
```css
.hero-banner__media::after {
  content: '';
  position: absolute;
  inset: 0;
  /* Premium gradient: dark at bottom/sides, lighter in center */
  background: radial-gradient(circle at center, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.6) 100%);
  z-index: 1;
}

.hero-banner__content {
  position: relative;
  z-index: 2;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3); /* Legibility shadow */
}
```

### D. Refined Typography Treatments
```css
.heading--editorial {
  font-family: var(--font-heading-family);
  font-weight: 300; /* Thin, elegant weight */
  letter-spacing: -0.02em; /* Tighter tracking for large text */
  line-height: 1.1;
  /* Subtle text gradient for luxury feel */
  background: linear-gradient(135deg, #FFF 0%, #A3A3A3 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.subheading--meta {
  font-family: var(--font-body-family);
  text-transform: uppercase;
  letter-spacing: 0.15em;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-base-accent-1);
}
```

## 5. UI/UX Rules of Thumb
- **Max Width:** Contain text content to a readable width. Paragraphs should rarely exceed `max-width: 60ch;` or `max-width: 800px;`. Wide screens make long text completely unreadable.
- **Contrast Check:** Ensure text on background has high contrast. Gray-on-gray is an amateur mistake.
- **Animation Constraint:** Only animate elements on `:hover`, or trigger mild fade-ins on load. Do not make elements constantly blink, spin, or bounce natively.
