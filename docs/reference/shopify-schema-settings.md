# Shopify Theme Input Settings & Section Schema Reference
> **Authoritative source**: Scraped from official Shopify documentation.
> Last updated from: [Input Settings](https://shopify.dev/docs/storefronts/themes/architecture/settings/input-settings) · [Section Schema](https://shopify.dev/docs/storefronts/themes/architecture/sections/section-schema) · [SVG Placeholders](https://shopify.dev/docs/api/liquid/filters/placeholder_svg_tag) · [JSON Templates](https://shopify.dev/docs/storefronts/themes/architecture/templates/json-templates)

---

## 1. Standard Setting Attributes
Every setting object supports these standard attributes:
- `type` (required): The setting type (see lists below).
- `id` (required): Unique ID within the section/block. Used in Liquid as `section.settings.<id>`.
- `label` (required): The user-facing label in the theme editor.
- `default` (optional): The default value. **Constraints vary by type — see below.**
- `info` (optional): Descriptive text displayed below the setting. Supports [markdown links](https://www.markdownguide.org/basic-syntax/#links).

---

## 2. Valid Input Setting Types (Complete & Official)

### Basic Input Settings
| Type | Output | Default Notes |
|---|---|---|
| `checkbox` | Boolean (`true`/`false`) | Defaults to `false` if omitted |
| `number` | Number or `nil` | Optional, but **must be a number, NOT a string**. Also supports `placeholder`. |
| `radio` | String (selected option value) | Requires `options` array. First option selected if `default` omitted. |
| `range` | Number | ✅ **`default` is REQUIRED.** Also requires `min`, `max`, `step` (all must be numeric, NOT strings), and `unit` (string like `"px"`). |
| `select` | String (selected option value) | Requires `options` array with `value`, `label`, and optional `group`. First option selected if `default` omitted. |
| `text` | String or empty | Optional. Also supports `placeholder`. Not updated when switching presets. |
| `textarea` | String or empty | Optional. Also supports `placeholder`. |

### Specialized Input Settings
| Type | Output | Default / Constraints |
|---|---|---|
| `article` | Article object or `blank` | ❌ Does NOT support `default`. Not updated on preset switch. |
| `article_list` | Array of article objects | ❌ Does NOT support `default`. Has `limit`. |
| `blog` | Blog object or `blank` | ❌ Does NOT support `default` |
| `collection` | Collection object or `blank` | ❌ Does NOT support `default` |
| `collection_list` | Array of collection objects | ❌ Does NOT support `default`. Has `limit`. |
| `color` | Color object or `blank` | Optional hex string (e.g., `"#000000"`) |
| `color_background` | CSS background string | Optional. Does NOT support image-related CSS properties. |
| `color_scheme` | Color scheme object | String (e.g., `"scheme-1"`). Returns first scheme from group if invalid. |
| `color_scheme_group` | Defines color schemes | Used in `settings_schema.json` only. Has `role` attribute. |
| `font_picker` | Font object | ✅ **`default` is REQUIRED.** Must be a valid [Shopify font](https://shopify.dev/docs/storefronts/themes/architecture/settings/fonts#available-fonts). |
| `html` | String or empty | Optional. Also supports `placeholder`. Unclosed tags auto-closed on save. `<html>`, `<head>`, `<body>` stripped. |
| `image_picker` | Image object or `nil` | ❌ Does NOT support `default`. Supports focal points. |
| `inline_richtext` | HTML string (no `<p>` wrap) | Optional. Supports bold, italic, link only. NO line breaks. |
| `link_list` | Linklist object or `blank` | ⚠️ **ONLY** `"main-menu"` or `"footer"` are valid defaults. |
| `liquid` | String (rendered Liquid) | Optional. Has limitations on which Liquid features are available. |
| `metaobject` | Metaobject or `nil` | Requires `resource_type`. |
| `metaobject_list` | Array of metaobjects | Requires `resource_type`. Has `limit`. |
| `page` | Page object or `blank` | ❌ Does NOT support `default`. Not updated on preset switch. |
| `product` | Product object or `blank` | ❌ Does NOT support `default`. Not updated on preset switch. |
| `product_list` | Array of product objects | ❌ Does NOT support `default`. Has `limit`. |
| `richtext` | HTML string (`<p>` wrapped) | Optional. Default must be wrapped in `<p>` tags: `"<p>text</p>"`. Supports bold, italic, underline, link, paragraph, unordered list. |
| `text_alignment` | String (`left`, `center`, `right`) | Defaults to `left` if omitted |
| `url` | String (URL) or `nil` | ⚠️ **ONLY** `/collections` or `/collections/all` are valid defaults. OMIT `default` for ANY other URL. |
| `video` | Video object or `nil` | ❌ Does NOT support `default`. Accepts `file_reference` metafields. |
| `video_url` | String (URL) | ❌ Does NOT support `default`. Requires `accept` array (e.g., `["youtube", "vimeo"]`). Also supports `placeholder`. |

### ❌ BANNED / Non-Existent Types
These types DO NOT EXIST in Shopify. Using them causes schema validation errors:
- `product_picker` → Use `product`
- `collection_picker` → Use `collection`
- `image` → Use `image_picker`
- `checkbox_group` → Does not exist
- `file` → Does not exist for themes
- `date` → Does not exist for themes

---

## 3. Section Schema Attributes

### Required
- `name`: Section title shown in theme editor.

### Optional
| Attribute | Description |
|---|---|
| `tag` | Wrapper HTML element. Accepted: `article`, `aside`, `div`, `footer`, `header`, `section`. Default: `div`. |
| `class` | Additional CSS class added to the `shopify-section` wrapper. |
| `limit` | Max times section can be added (`1` or `2`). |
| `settings` | Array of input settings. **All IDs must be unique within the section.** |
| `blocks` | Array of block type objects. Each has `type`, `name`, `settings`. **All block types AND names must be unique within a section. All setting IDs must be unique within each block.** |
| `max_blocks` | Max blocks per section (default: 50). Static blocks don't count. |
| `presets` | Array of preset configurations. **Required for dynamically-addable sections.** |
| `default` | Default configuration for statically rendered sections. Has same attributes as presets. |
| `locales` | Inline translation strings. |
| `enabled_on` / `disabled_on` | Control which templates the section appears on. |

### Schema Tag Rules
- Each section can have **only ONE** `{% schema %}` tag.
- The tag can be placed anywhere in the section file but **CANNOT be nested inside another Liquid tag**.
- The tag must contain **only valid JSON**.
- Having more than one `{% schema %}` tag causes a syntax error.

### Presets (CRITICAL for Dynamic Sections)
Sections added via the theme editor **MUST** have at least one preset:
```json
"presets": [{ "name": "Section Name", "category": "Custom" }]
```
- Sections with presets should **NOT** be statically rendered.
- For static sections, use `default` instead.

---

## 4. Valid SVG Placeholders (Complete Official List — 29 Names)
> Source: [shopify.dev/docs/api/liquid/filters/placeholder_svg_tag](https://shopify.dev/docs/api/liquid/filters/placeholder_svg_tag)

Usage: `{{ 'name' | placeholder_svg_tag }}`

| Category | Valid Names |
|---|---|
| General | `image` |
| Product | `product-1` through `product-6` |
| Collection | `collection-1` through `collection-6` |
| Lifestyle | `lifestyle-1`, `lifestyle-2` |
| Product Apparel | `product-apparel-1` through `product-apparel-4` |
| Collection Apparel | `collection-apparel-1` through `collection-apparel-4` |
| Hero Apparel | `hero-apparel-1` through `hero-apparel-3` |
| Blog Apparel | `blog-apparel-1` through `blog-apparel-3` |
| Detailed Apparel | `detailed-apparel-1` |

### ❌ BANNED Placeholders (Will Cause Liquid Errors)
`texture-1`, `pattern-1`, `background-1`, `hero-1`, `banner-1`, `icon-1` — these DO NOT EXIST.

---

## 5. JSON Template Format (OS 2.0)
> Source: [shopify.dev/docs/storefronts/themes/architecture/templates/json-templates](https://shopify.dev/docs/storefronts/themes/architecture/templates/json-templates)

### Schema
```json
{
  "layout": "theme",
  "sections": {
    "<unique-section-id>": {
      "type": "<section-filename-without-extension>",
      "disabled": false,
      "settings": { ... },
      "blocks": {
        "<unique-block-id>": {
          "type": "<block-type>",
          "settings": { ... }
        }
      },
      "block_order": ["<block-id-1>", "<block-id-2>"]
    }
  },
  "order": ["<section-id-1>", "<section-id-2>"]
}
```

### Critical Rules
- **`type` MUST match an existing `.liquid` file** in `sections/`. If `type: "hero-banner"`, then `sections/hero-banner.liquid` MUST exist. Otherwise: **upload error**.
- Max **25 sections** per template, **50 blocks** per section.
- Max **1,000 JSON templates** per theme.
- Section IDs must be unique **within the template**.
- `layout` defaults to `theme.liquid`. Set to `false` to render without a layout.
- `gift_card` and `robots.txt` templates **CANNOT** be JSON — they must be `.liquid`.

### Template Types (14 total)
`404`, `article`, `blog`, `cart`, `collection`, `gift_card.liquid`, `index`, `list-collections`, `page`, `password`, `product`, `robots.txt.liquid`, `search`, `metaobject`

---

## 6. Theme Architecture (Directory Structure)
> Source: [shopify.dev/docs/storefronts/themes/architecture](https://shopify.dev/docs/storefronts/themes/architecture)

Only these directories are supported (**no subdirectories**):
| Directory | Contents |
|---|---|
| `assets/` | CSS, JS, images. Reference via `{{ 'file.css' \| asset_url }}`. `.liquid` extension gives access to `settings` object and filters. |
| `config/` | `settings_schema.json` (defines settings UI), `settings_data.json` (stores values) |
| `layout/` | `theme.liquid` (**required**), `password.liquid` |
| `locales/` | Translation JSON files (e.g., `en.default.json`) |
| `sections/` | Section `.liquid` files and section group `.json` files |
| `snippets/` | Reusable `.liquid` snippet files |
| `templates/` | Page template `.json` or `.liquid` files. Also `templates/customers/` for legacy customer accounts. |

Only a `layout/` directory containing `theme.liquid` is required for upload.

---

## 7. Official Documentation Links
- [Input Settings Reference](https://shopify.dev/docs/storefronts/themes/architecture/settings/input-settings)
- [Section Schema Reference](https://shopify.dev/docs/storefronts/themes/architecture/sections/section-schema)
- [Theme Architecture](https://shopify.dev/docs/storefronts/themes/architecture)
- [JSON Templates](https://shopify.dev/docs/storefronts/themes/architecture/templates/json-templates)
- [Liquid Reference](https://shopify.dev/docs/api/liquid)
- [SVG Placeholder Filter](https://shopify.dev/docs/api/liquid/filters/placeholder_svg_tag)
- [Theme Best Practices](https://shopify.dev/docs/storefronts/themes/best-practices)
- [Building with Sections & Blocks](https://shopify.dev/docs/storefronts/themes/best-practices/templates-sections-blocks)
