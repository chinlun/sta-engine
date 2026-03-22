# Shopify Liquid & Theme Development Reference
> **Authoritative source**: Scraped from official Shopify documentation.
> Last updated from: [Liquid Reference](https://shopify.dev/docs/api/liquid) · [Tags](https://shopify.dev/docs/api/liquid/tags) · [Best Practices](https://shopify.dev/docs/storefronts/themes/best-practices)

---

## 1. Critical Liquid Tag Rules

### `{% schema %}` Tag
- Each section can have **only ONE** `{% schema %}` tag.
- It **CANNOT** be nested inside another Liquid tag.
- Must contain **only valid JSON**.
- Violation = syntax error that prevents theme upload.

### `{% stylesheet %}` Tag
- Includes CSS styles in section, block, and snippet files.
- Each section/block/snippet can have **only ONE** `{% stylesheet %}` tag.
- ⚠️ **Liquid code is NOT rendered inside `{% stylesheet %}` tags.** Including Liquid causes syntax errors.
- Use CSS custom properties or `assets/` CSS files for dynamic styling instead.

### `{% javascript %}` Tag
- Includes JS code in section, block, and snippet files.
- Each section/block/snippet can have **only ONE** `{% javascript %}` tag.
- ⚠️ **Liquid code is NOT rendered inside `{% javascript %}` tags.** Including Liquid causes syntax errors.
- Use `assets/` JS files or data attributes for dynamic behavior instead.

### `{% render %}` Tag (replaces `{% include %}`)
- Renders a snippet or app block.
- Snippet name is specified **without** the `.liquid` extension: `{% render 'snippet-name' %}`
- Variables created outside the snippet are **NOT accessible** inside it (scoped).
- Pass variables explicitly: `{% render 'snippet-name', product: product, show_vendor: true %}`
- Use `for` to render for each item: `{% render 'product-card' for collection.products as product %}`
- Use `with` to pass a single object: `{% render 'product-card' with featured_product as product %}`
- ⚠️ **Cannot use `{% include %}` inside a snippet rendered with `{% render %}`.**
- Global objects (like `settings`, `shop`) ARE accessible inside rendered snippets.
- Template-specific objects (like `product` in a product template) ARE also accessible.

### `{% section %}` Tag
- Renders a section **statically**.
- Section name is specified **without** the `.liquid` extension: `{% section 'header' %}`
- Statically rendered sections should use `default` in schema, not `presets`.

### `{% form %}` Tag
Valid form types (15 total):
```
activate_customer_password  cart               contact
create_customer             currency           customer
customer_address            customer_login     guest_login
localization                new_comment        product
recover_customer_password   reset_customer_password  storefront_password
```
- `cart` form requires a `cart` object parameter: `{% form 'cart', cart %}`
- `product` form requires a `product` object parameter: `{% form 'product', product %}`
- `new_comment` form requires an `article` object parameter: `{% form 'new_comment', article %}`
- `customer_address` form requires a `customer.new_address` or address: `{% form 'customer_address', customer.new_address %}`

---

## 2. Liquid Basics Quick Reference

### Output
```liquid
{{ product.title }}                          {# Output object property #}
{{ product.title | upcase }}                 {# Apply filter #}
{{ product.title | upcase | remove: 'THE' }} {# Chain filters #}
```

### Tags (Logic)
```liquid
{% if product.available %}...{% endif %}
{% for product in collection.products %}...{% endfor %}
{% assign my_var = 'value' %}
{% capture my_html %}...{% endcapture %}
```

### Whitespace Control
Use `-` to strip whitespace:
```liquid
{%- if condition -%}...{%- endif -%}
{{- variable -}}
```

### Variables
```liquid
{% assign greeting = 'Hello' %}          {# String #}
{% assign count = 5 %}                   {# Number #}
{% assign list = 'a,b,c' | split: ',' %} {# Array #}
```

### Object Access Patterns
1. **Globally available**: `settings`, `shop`, `routes`, `request`, `cart`, `content_for_header`, `content_for_layout`
2. **Template-specific**: `product` (in product template), `collection`, `article`, `blog`, `page`, `search`
3. **Via parent objects**: `article` objects through `blog.articles`

---

## 3. Common Shopify Liquid Filters

### URL Filters
```liquid
{{ 'style.css' | asset_url }}              {# Link to theme asset #}
{{ 'image.png' | asset_img_url: '300x' }}  {# Image with size #}
{{ product.url | within: collection }}      {# Product URL in collection context #}
{{ 'collection-1' | placeholder_svg_tag }} {# SVG placeholder #}
```

### String Filters
```liquid
{{ title | upcase }}
{{ title | downcase }}
{{ title | capitalize }}
{{ title | truncate: 50 }}
{{ title | truncatewords: 10 }}
{{ handle | replace: '-', ' ' }}
{{ html_string | strip_html }}
{{ text | escape }}
{{ text | url_encode }}
{{ text | newline_to_br }}
```

### HTML Filters
```liquid
{{ product.featured_image | image_tag }}
{{ product.featured_image | image_url: width: 300 | image_tag }}
{{ 'style.css' | asset_url | stylesheet_tag }}
{{ 'script.js' | asset_url | script_tag }}
```

### Money Filters
```liquid
{{ product.price | money }}                {# $10.00 #}
{{ product.price | money_with_currency }}  {# $10.00 USD #}
{{ product.price | money_without_trailing_zeros }} {# $10 #}
```

### Math Filters
```liquid
{{ 4 | plus: 2 }}        {# 6 #}
{{ 4 | minus: 2 }}       {# 2 #}
{{ 4 | times: 2 }}       {# 8 #}
{{ 10 | divided_by: 3 }} {# 3 #}
{{ 10 | modulo: 3 }}     {# 1 #}
```

---

## 4. Theme Best Practices (From Official Docs)

### Sections Best Practices
- Template default content should be in a **main template section**.
- Sections should be **addable, removable, and reorderable**.
- Use sections to control settings scoped to the entire section's layout.

### Block Best Practices
- Ensure **theme settings are scoped to the block**, not the section.
- Choose appropriate block layouts:
  - Stack **vertically** for text with hierarchy.
  - Stack **horizontally** or use a grid for non-hierarchical content.
  - Ensure responsive behavior and reflow.
- **Don't rely on specific block type order** to determine layout.
- **Avoid overly granular blocks** — group related settings together (e.g., author + date + comments = one block).
- Support **app blocks** in sections with clear use cases (product pages, cart).

### Design Principles
- Create a great **customer experience** with fast, accessible, discoverable stores.
- Performance: Optimize and test theme performance.
- Accessibility: Create inclusive experiences.
- Design: Meet requirements of merchants and customers.
- Never use deceptive coding practices (obfuscating code, manipulating search engines).

---

## 5. Official Documentation Links
- [Liquid Reference](https://shopify.dev/docs/api/liquid)
- [Liquid Tags](https://shopify.dev/docs/api/liquid/tags)
- [Liquid Filters](https://shopify.dev/docs/api/liquid/filters)
- [Liquid Objects](https://shopify.dev/docs/api/liquid/objects)
- [Form Tag Reference](https://shopify.dev/docs/api/liquid/tags/form)
- [Render Tag](https://shopify.dev/docs/api/liquid/tags/render)
- [Section Tag](https://shopify.dev/docs/api/liquid/tags/section)
- [Stylesheet Tag](https://shopify.dev/docs/api/liquid/tags/stylesheet)
- [JavaScript Tag](https://shopify.dev/docs/api/liquid/tags/javascript)
- [Theme Best Practices](https://shopify.dev/docs/storefronts/themes/best-practices)
- [Building with Sections & Blocks](https://shopify.dev/docs/storefronts/themes/best-practices/templates-sections-blocks)
- [Shopify Liquid Cheat Sheet](https://www.shopify.com/partners/shopify-cheat-sheet)
