# Shopify Theme Input Settings (Schema Reference)

This document is the definitive guide for `{% schema %}` blocks and `settings_schema.json` in Shopify OS 2.0 themes.

## 1. Universal Setting Properties
Every setting object MUST have:
- `type`: (String) The ID of the input setting.
- `id`: (String) The ID used to access the setting in Liquid (e.g., `section.settings.id`).
- `label`: (String) The user-facing label.

## 2. Valid Input Setting Types (BANNED types: `product_picker`, `checkbox_group`)

### Basic Inputs
- `checkbox`: Boolean toggle.
- `number`: Numeric input.
- `radio`: Multiple choice (uses `options` array).
- `range`: Slider (requires `min`, `max`, `step`, `unit`).
- `select`: Dropdown (uses `options` array).
- `text`: Single-line text.
- `textarea`: Multi-line text.

### Visual & Media
- `color`: Color picker.
- `color_background`: Gradient/Background picker.
- `image_picker`: Image selector.
- `video`: Video selector.

### Specialized Selectors
- `product`: Select ONE product. (NEVER use `product_picker`).
- `product_list`: Select multiple products.
- `collection`: Select ONE collection.
- `collection_list`: Select multiple collections.
- `blog`: Select a blog.
- `article`: Select an article.
- `link_list`: Select a navigation menu.
- `url`: Select a link (page, product, etc.).

### Rich Text
- `richtext`: Full rich text editor.
- `inline_richtext`: Single-line rich text editor.
- `html`: Custom HTML.

## 3. Critical Constraints (CLI Compliance)

### URL Defaults (STRICT)
- **NO Anchor Links**: `default: "#id"` is forbidden.
- **NO Blank Strings**: `default: ""` is forbidden for `url` type.
- **RULE**: If the type is `url`, OMIT the `default` property entirely.

### Section Presets
- EVERY section intended for the home page MUST have a `presets` array:
  ```json
  "presets": [
    { "name": "Section Name" }
  ]
  ```

### Color Schemes
- In Skeleton/Dawn, always use:
  ```json
  {
    "type": "color_scheme",
    "id": "color_scheme",
    "label": "Color scheme",
    "default": "scheme-1"
  }
  ```

## 4. Valid SVG Placeholders
When using `{{ 'name' | placeholder_svg_tag }}`, you MUST use ONLY these supported names. BANNED: `texture-1`, `pattern-1`.

- `image`: General image placeholder.
- `product-1`, `product-2`, `product-3`, `product-4`, `product-5`, `product-6`: Product images.
- `collection-1`, `collection-2`, `collection-3`, `collection-4`, `collection-5`, `collection-6`: Collection images.
- `lifestyle-1`, `lifestyle-2`: Lifestyle images.

## 5. Official Documentation
Refer to these for expanded rules:
- [Shopify Input Settings](https://shopify.dev/docs/themes/architecture/settings/input-settings)
- [SVG Placeholder Reference](https://shopify.dev/docs/api/liquid/filters/placeholder_svg_tag)
- [Section Schema Reference](https://shopify.dev/docs/themes/architecture/sections/section-schema)
- [Liquid Objects Reference](https://shopify.dev/docs/api/liquid/objects)
