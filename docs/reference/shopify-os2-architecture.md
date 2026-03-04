# Shopify OS 2.0 Theme Architecture Reference

## 1. Theme File Hierarchy

```
theme/
├── config/
│   ├── settings_data.json    ← Global brand settings (colors, fonts, spacing)
│   └── settings_schema.json  ← Defines the Theme Editor's "Theme settings" UI
├── layout/
│   ├── theme.liquid           ← Main HTML shell (loads CSS, header/footer groups)
│   └── password.liquid        ← Password page shell
├── templates/
│   ├── index.json             ← Homepage: defines which sections appear and in what order
│   ├── product.json           ← Product page template
│   ├── collection.json        ← Collection page template
│   ├── page.json              ← Generic page template
│   ├── blog.json              ← Blog listing template
│   ├── article.json           ← Blog post template
│   ├── cart.json              ← Cart page template
│   └── search.json            ← Search results template
├── sections/
│   ├── header.liquid          ← Sections contain Liquid+HTML+CSS+{% schema %}
│   ├── footer.liquid
│   ├── image-banner.liquid
│   ├── featured-collection.liquid
│   └── ... (one file per section)
├── snippets/
│   ├── card-product.liquid    ← Reusable partials (no {% schema %})
│   └── ...
└── assets/
    ├── base.css               ← Core stylesheet with CSS custom properties
    ├── global.js              ← Core JavaScript
    └── ...
```

---

## 2. JSON Template Structure (Critical)

JSON templates are the **control plane** of which sections render on a page.

### templates/index.json — Full Anatomy

```json
{
  "sections": {
    "<unique_key>": {
      "type": "<section-filename-without-extension>",
      "blocks": {
        "<block_key>": {
          "type": "<block_type_from_schema>",
          "settings": { ... }
        }
      },
      "block_order": ["<block_key>", ...],
      "settings": {
        "color_scheme": "scheme-1",
        "padding_top": 36,
        "padding_bottom": 36,
        ...
      }
    }
  },
  "order": ["<unique_key>", ...]
}
```

### Rules

| Rule | Description |
|------|-------------|
| **Section key** | Any unique string, e.g. `"hero_banner"`, `"template--123__main"` |
| **Section type** | Must match a `.liquid` filename in `sections/` (without `.liquid`), e.g. `"image-banner"` matches `sections/image-banner.liquid` |
| **order array** | Controls render order. A section NOT in `order` will NOT render |
| **blocks** | Optional. Only valid if the section's `{% schema %}` defines block types |
| **block_order** | Required if blocks exist. Controls block render order |
| **settings** | Must match setting `id`s defined in the section's `{% schema %}` |

### Common Settings Available on Most Dawn Sections

```json
{
  "color_scheme": "scheme-1",      // or "scheme-2" through "scheme-5"
  "padding_top": 36,               // 0-100, pixels
  "padding_bottom": 36,            // 0-100, pixels
  "full_width": true               // boolean, some sections only
}
```

---

## 3. config/settings_data.json — Global Brand Settings

This file controls the global design. Structure:

```json
{
  "current": "Default",
  "presets": {
    "Default": {
      "color_schemes": {
        "scheme-1": { "settings": { "background": "#FFFFFF", "text": "#121212", "button": "#121212", "button_label": "#FFFFFF", "secondary_button_label": "#121212", "shadow": "#121212" } },
        "scheme-2": { "settings": { ... } },
        "scheme-3": { "settings": { ... } },
        "scheme-4": { "settings": { ... } },
        "scheme-5": { "settings": { ... } }
      },
      "type_header_font": "assistant_n4",
      "heading_scale": 100,
      "type_body_font": "assistant_n4",
      "body_scale": 100,
      "page_width": 1200,
      "spacing_sections": 0,
      "buttons_radius": 0,
      "buttons_border_thickness": 1,
      "card_style": "standard",
      "card_image_padding": 0,
      "card_corner_radius": 0,
      "cart_type": "notification",
      "predictive_search_enabled": true
    }
  }
}
```

### Color Scheme Settings (per scheme)

| Key | Type | Description |
|-----|------|-------------|
| `background` | hex | Page/section background |
| `background_gradient` | string | CSS gradient, or empty |
| `text` | hex | Body text color |
| `button` | hex | Primary button background |
| `button_label` | hex | Primary button text |
| `secondary_button_label` | hex | Outline button text |
| `shadow` | hex | Shadow color |

### Typography Settings

| Key | Example | Description |
|-----|---------|-------------|
| `type_header_font` | `"assistant_n4"` | Shopify font handle for headings |
| `heading_scale` | `100` | Heading size multiplier (%) |
| `type_body_font` | `"assistant_n4"` | Shopify font handle for body |
| `body_scale` | `100` | Body size multiplier (%) |

### Shopify Font Handles (Common)

Format: `<family>_<style>` where style is `n4` (normal 400), `n7` (normal 700), `i4` (italic 400), etc.

Common fonts: `assistant_n4`, `montserrat_n4`, `playfair_display_n4`, `roboto_n4`, `lato_n4`, `open_sans_n4`, `poppins_n4`, `raleway_n4`, `oswald_n4`, `merriweather_n4`, `source_sans_pro_n4`, `nunito_n4`, `inter_n4`

---

## 4. Section .liquid File Anatomy

Every section `.liquid` file has two parts: **render logic** and **schema definition**.

```liquid
{%- comment -%} 1. Render Logic {%- endcomment -%}
<div class="section-{{ section.id }} {{ section.settings.color_scheme }}">
  <h2>{{ section.settings.heading }}</h2>

  {%- for block in section.blocks -%}
    <div {{ block.shopify_attributes }}>
      {{ block.settings.text }}
    </div>
  {%- endfor -%}
</div>

<style>
  .section-{{ section.id }} {
    padding-top: {{ section.settings.padding_top }}px;
    padding-bottom: {{ section.settings.padding_bottom }}px;
  }
</style>

{%- comment -%} 2. Schema (REQUIRED) {%- endcomment -%}
{% schema %}
{
  "name": "My Section",
  "class": "section",
  "settings": [
    {
      "type": "text",
      "id": "heading",
      "label": "Heading",
      "default": "Welcome"
    },
    {
      "type": "color_scheme",
      "id": "color_scheme",
      "label": "Color Scheme",
      "default": "scheme-1"
    },
    {
      "type": "range",
      "id": "padding_top",
      "min": 0, "max": 100, "step": 4,
      "unit": "px",
      "label": "Top padding",
      "default": 36
    },
    {
      "type": "range",
      "id": "padding_bottom",
      "min": 0, "max": 100, "step": 4,
      "unit": "px",
      "label": "Bottom padding",
      "default": 36
    }
  ],
  "blocks": [
    {
      "type": "text_block",
      "name": "Text",
      "settings": [
        { "type": "richtext", "id": "text", "label": "Text" }
      ]
    }
  ],
  "presets": [
    {
      "name": "My Section"
    }
  ]
}
{% endschema %}
```

### Schema Setting Types

| Type | Description | Example Default |
|------|-------------|----------------|
| `text` | Single-line text | `"Hello"` |
| `textarea` | Multi-line text | `"Line 1\nLine 2"` |
| `richtext` | HTML rich text | `"<p>Hello</p>"` |
| `html` | Raw HTML | `"<div>custom</div>"` |
| `image_picker` | Image upload | (none) |
| `url` | URL field | `""` |
| `video_url` | Video URL (YouTube/Vimeo) | `""` |
| `checkbox` | Boolean toggle | `true` / `false` |
| `number` | Numeric input | `0` |
| `range` | Slider with min/max/step | `36` |
| `select` | Dropdown | `"option_1"` |
| `color` | Color picker (hex) | `"#000000"` |
| `color_scheme` | Predefined scheme selector | `"scheme-1"` |
| `font_picker` | Font selector | `"assistant_n4"` |
| `collection` | Collection picker | `""` |
| `product` | Product picker | `""` |
| `blog` | Blog picker | `""` |
| `page` | Page picker | `""` |
| `link_list` | Menu picker | `""` |
| `header` | Section header (UI only) | N/A |
| `paragraph` | Info text (UI only) | N/A |

---

## 5. Dawn CSS Custom Properties (Design Tokens)

These are defined in `assets/base.css` and should be used instead of hardcoded values:

### Colors
```css
var(--color-base-text)
var(--color-base-background-1)
var(--color-base-background-2)
var(--color-base-solid-button-labels)
var(--color-base-outline-button-labels)
var(--color-base-accent-1)
var(--color-base-accent-2)
var(--color-shadow)
var(--color-badge-foreground)
var(--color-badge-background)
var(--color-badge-border)
```

### Typography
```css
var(--font-body-family)
var(--font-body-style)
var(--font-body-weight)
var(--font-heading-family)
var(--font-heading-style)
var(--font-heading-weight)
var(--font-body-scale)
var(--font-heading-scale)
```

### Layout & Spacing
```css
var(--page-width)                /* Default: 120rem (1200px) */
var(--grid-desktop-horizontal-spacing)
var(--grid-desktop-vertical-spacing)
var(--grid-mobile-horizontal-spacing)
var(--grid-mobile-vertical-spacing)
```

### Component Tokens
```css
var(--buttons-radius)
var(--buttons-border-width)
var(--buttons-shadow-opacity)
var(--inputs-radius)
var(--inputs-border-width)
var(--card-corner-radius)
var(--card-border-width)
var(--card-shadow-opacity)
var(--media-radius)
var(--media-border-width)
var(--popup-corner-radius)
var(--popup-border-width)
```

---

## 6. Common Mistakes to Avoid

| # | Mistake | Fix |
|---|---------|-----|
| 1 | Creating a section `.liquid` but not adding it to `templates/index.json` | Always update `index.json` sections + order |
| 2 | Adding to `sections` object but forgetting the `order` array | Section won't render without being in `order` |
| 3 | Missing `{% schema %}` block in section file | Section will error. Always include at bottom |
| 4 | Missing `presets` in schema | Section won't appear in Theme Editor's "Add section" |
| 5 | Using hardcoded colors (`#FF0000`) instead of CSS variables | Use `var(--color-base-accent-1)` or color scheme classes |
| 6 | Unclosed Liquid tags | Every `{% if %}` needs `{% endif %}`, `{% for %}` needs `{% endfor %}` |
| 7 | Using `section.type` as the key in `index.json` | Key must be unique; type is the `.liquid` filename |
| 8 | Putting blocks in a section that doesn't define block types in schema | Blocks will be ignored |
| 9 | Changing `settings_data.json` without the `presets.Default` wrapper | Must nest under `presets > Default` |
| 10 | Using Google Fonts names instead of Shopify font handles | Use `poppins_n4` not `Poppins` |
