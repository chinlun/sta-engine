# Shopify Liquid & OS 2.0 Master Reference

## 1. JSON Template Architecture (CRITICAL)
Shopify Online Store 2.0 uses JSON templates to control page layout. 
**Rule:** Modifying a `.liquid` file is useless if it is not referenced in the JSON template.

### templates/index.json
To add a section to the homepage, you must modify this file:
1. **Add to `sections` object:** Create a unique key (e.g., `"template--123__main"`) and define the type (matching the `.liquid` filename).
2. **Add to `order` array:** Append the unique key to the `order` array to make it render.

Example:
```json
{
  "sections": {
    "custom_hero": { "type": "hero-banner", "settings": { "title": "Hello" } }
  },
  "order": ["custom_hero"]
}
```

## 2. Global Brand Settings (config/settings_data.json)

**Rule:** Brand-wide design changes (colors, fonts, spacing) must be applied here.
- **Color Schemes:** Look for the `color_schemes` object. Update the specific scheme (e.g., "background", "text", "outline") to reflect brand changes.
- **Typography:** Change the `body_font_family` or `header_font_family`.
- **Visibility:** In Liquid files, these are accessed via `{{ settings.color_name }}`. If you change the JSON, the Liquid automatically reflects it.

---

## 3. Liquid Syntax & Section Guardrails

**Rule:** All structural logic must be valid and "Customizer-ready."
- **Tag Closure:** Every `{% if %}`, `{% for %}`, and `{% form %}` must have a corresponding `{% end... %}` tag.
- **Section Schema:** Every section MUST have a `{% schema %}` block at the bottom.
- **Presets:** To make a section appear in the "Add Section" menu in the Shopify editor, it MUST have a `presets` array in its schema.
  
Example of a valid schema:
```liquid
{% schema %}
{
  "name": "Custom Banner",
  "settings": [
    { "type": "text", "id": "heading", "label": "Heading" }
  ],
  "presets": [
    { "name": "Custom Banner" }
  ]
}
{% endschema %}
```

## 4. CSS & Styling Standards

**Rule:** Use Shopify's native design tokens to ensure the theme remains cohesive.
- **CSS Variables:** Prioritize Dawn's built-in variables:
  - `var(--color-base-text)`
  - `var(--color-base-background-1)`
  - `var(--font-body-family)`
- **BEM Naming:** Use Block-Element-Modifier (e.g., `.hero__title--large`) to prevent styles from leaking into other sections.
- **Scoped Styles:** If adding custom CSS, wrap it in `<style>` tags within the `.liquid` file to keep it scoped to that section.

---

## 5. Deployment & Asset Handling

**Rule:** Respect store limits and asset paths.
- **Asset URL:** Reference images or JS in the assets folder using: `{{ 'filename.jpg' | asset_url | img_tag }}`.
- **20-Theme Limit:** The engine will handle theme deletion, but the AI should prioritize editing the *current* active theme index to save space.
- **File Extensions:** Always check if a file is `.liquid`, `.json`, or `.css` before suggesting an `action: "update"`.

---

## 6. Liquid Objects Reference

### Global Objects
| Object | Description | Example |
|--------|-------------|---------|
| `settings` | Theme settings from settings_data.json | `{{ settings.type_body_font }}` |
| `section` | Current section instance | `{{ section.id }}`, `{{ section.settings.heading }}` |
| `block` | Current block in a `{% for block in section.blocks %}` | `{{ block.settings.text }}` |
| `shop` | Store info | `{{ shop.name }}`, `{{ shop.url }}` |
| `page_title` | Current page title | `{{ page_title }}` |
| `content_for_header` | Required in layout `<head>` | `{{ content_for_header }}` |
| `content_for_layout` | Required in layout `<body>` | `{{ content_for_layout }}` |
| `request` | Current request info | `{{ request.locale }}` |
| `routes` | Store URL paths | `{{ routes.cart_url }}` |

### Product Objects (on product pages)
| Object | Description | Example |
|--------|-------------|---------|
| `product` | Current product | `{{ product.title }}` |
| `product.price` | Price in cents | `{{ product.price | money }}` |
| `product.images` | Product images array | `{% for img in product.images %}` |
| `product.variants` | Variant array | `{% for variant in product.variants %}` |
| `product.description` | HTML description | `{{ product.description }}` |

### Collection Objects (on collection pages)
| Object | Description | Example |
|--------|-------------|---------|
| `collection` | Current collection | `{{ collection.title }}` |
| `collection.products` | Products in collection | `{% for product in collection.products %}` |
| `collection.description` | HTML description | `{{ collection.description }}` |

---

## 7. Liquid Filters Reference

### String Filters
| Filter | Description | Example |
|--------|-------------|---------|
| `upcase` | Uppercase | `{{ "hello" | upcase }}` → `HELLO` |
| `downcase` | Lowercase | `{{ "HELLO" | downcase }}` → `hello` |
| `strip_html` | Remove HTML | `{{ product.description | strip_html }}` |
| `truncate` | Truncate text | `{{ title | truncate: 50 }}` |
| `replace` | Replace text | `{{ "hello" | replace: "hello", "hi" }}` |
| `append` | Append string | `{{ "hello" | append: " world" }}` |
| `prepend` | Prepend string | `{{ "world" | prepend: "hello " }}` |

### URL & Asset Filters
| Filter | Description | Example |
|--------|-------------|---------|
| `asset_url` | URL for theme asset | `{{ 'style.css' | asset_url }}` |
| `img_tag` | Creates `<img>` tag | `{{ 'logo.png' | asset_url | img_tag }}` |
| `image_url` | Shopify CDN image URL | `{{ product.featured_image | image_url: width: 500 }}` |
| `stylesheet_tag` | Creates `<link>` tag | `{{ 'custom.css' | asset_url | stylesheet_tag }}` |
| `script_tag` | Creates `<script>` tag | `{{ 'custom.js' | asset_url | script_tag }}` |

### Money Filters
| Filter | Description | Example |
|--------|-------------|---------|
| `money` | Format as money | `{{ product.price | money }}` |
| `money_with_currency` | With currency code | `{{ product.price | money_with_currency }}` |

### Array Filters
| Filter | Description | Example |
|--------|-------------|---------|
| `size` | Array length | `{{ cart.items | size }}` |
| `first` | First element | `{{ product.images | first }}` |
| `last` | Last element | `{{ product.images | last }}` |
| `join` | Join array | `{{ tags | join: ", " }}` |
| `where` | Filter array | `{{ products | where: "available" }}` |
| `map` | Map property | `{{ products | map: "title" }}` |
| `sort` | Sort array | `{{ products | sort: "price" }}` |

---

## 8. Common Liquid Patterns

### Responsive Image (with srcset)
```liquid
{%- if section.settings.image != blank -%}
  <img
    srcset="{{ section.settings.image | image_url: width: 375 }} 375w,
            {{ section.settings.image | image_url: width: 750 }} 750w,
            {{ section.settings.image | image_url: width: 1100 }} 1100w,
            {{ section.settings.image | image_url: width: 1500 }} 1500w"
    src="{{ section.settings.image | image_url: width: 1500 }}"
    alt="{{ section.settings.image.alt | escape }}"
    loading="lazy"
    width="{{ section.settings.image.width }}"
    height="{{ section.settings.image.height }}"
  >
{%- endif -%}
```

### Color Scheme Application
```liquid
<div class="color-{{ section.settings.color_scheme }} section-{{ section.id }}-padding">
  <!-- section content -->
</div>
```

### Block Loop with shopify_attributes
```liquid
{%- for block in section.blocks -%}
  <div {{ block.shopify_attributes }}>
    {%- case block.type -%}
      {%- when 'heading' -%}
        <h2>{{ block.settings.heading }}</h2>
      {%- when 'text' -%}
        <div>{{ block.settings.text }}</div>
      {%- when 'button' -%}
        <a href="{{ block.settings.link }}" class="button">
          {{ block.settings.label }}
        </a>
    {%- endcase -%}
  </div>
{%- endfor -%}
```

### Section Padding Pattern
```liquid
<style>
  .section-{{ section.id }}-padding {
    padding-top: {{ section.settings.padding_top | times: 0.75 | round: 0 }}px;
    padding-bottom: {{ section.settings.padding_bottom | times: 0.75 | round: 0 }}px;
  }
  @media screen and (min-width: 750px) {
    .section-{{ section.id }}-padding {
      padding-top: {{ section.settings.padding_top }}px;
      padding-bottom: {{ section.settings.padding_bottom }}px;
    }
  }
</style>
```

### Conditional Render
```liquid
{%- if section.settings.heading != blank -%}
  <h2 class="{{ section.settings.heading_size }}">
    {{ section.settings.heading | escape }}
  </h2>
{%- endif -%}
```
