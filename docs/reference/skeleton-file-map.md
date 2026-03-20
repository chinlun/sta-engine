# Skeleton Theme File Map

> Auto-generated from `skeleton-theme.zip`. Do not edit manually.
> Regenerate with: `npx tsx scripts/generate-skeleton-map.ts`

## File Tree

### config/ (2 files)

- `config/settings_data.json`
- `config/settings_schema.json`

### layout/ (2 files)

- `layout/password.liquid`
- `layout/theme.liquid`

### templates/ (12 files)

- `templates/404.json`
- `templates/article.json`
- `templates/blog.json`
- `templates/cart.json`
- `templates/collection.json`
- `templates/gift_card.liquid`
- `templates/index.json`
- `templates/list-collections.json`
- `templates/page.json`
- `templates/password.json`
- `templates/product.json`
- `templates/search.json`

### sections/ (16 files)

- `sections/404.liquid`
- `sections/article.liquid`
- `sections/blog.liquid`
- `sections/cart.liquid`
- `sections/collection.liquid`
- `sections/collections.liquid`
- `sections/custom-section.liquid`
- `sections/footer-group.json`
- `sections/footer.liquid`
- `sections/header-group.json`
- `sections/header.liquid`
- `sections/hello-world.liquid`
- `sections/page.liquid`
- `sections/password.liquid`
- `sections/product.liquid`
- `sections/search.liquid`

### snippets/ (3 files)

- `snippets/css-variables.liquid`
- `snippets/image.liquid`
- `snippets/meta-tags.liquid`

### assets/ (4 files)

- `assets/critical.css`
- `assets/icon-account.svg`
- `assets/icon-cart.svg`
- `assets/shoppy-x-ray.svg`

### locales/ (2 files)

- `locales/en.default.json`
- `locales/en.default.schema.json`

### other/ (12 files)

- `.gitattributes`
- `.github/workflows/ci.yml`
- `.github/workflows/cla.yml`
- `.gitignore`
- `.shopifyignore`
- `.theme-check.yml`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `LICENSE.md`
- `README.md`
- `blocks/group.liquid`
- `blocks/text.liquid`

---

## Section Schemas

Each section's `{% schema %}` block defines its available settings, blocks, and presets.
The AI MUST use these schemas when configuring sections in `templates/*.json`.

### 404

- **Name**: t:general.404
- **Has presets**: No

### article

- **Name**: t:general.article
- **Has presets**: No

### blog

- **Name**: t:general.blog
- **Has presets**: No

### cart

- **Name**: t:general.cart
- **Has presets**: No

### collection

- **Name**: t:general.collection
- **Has presets**: No

### collections

- **Name**: t:general.collections_grid
- **Settings**: `grid_item_width` (select), `grid_gap` (range)
- **Has presets**: Yes

### custom-section

- **Name**: t:general.custom_section
- **Settings**: `background_image` (image_picker)
- **Block types**: `@theme` — unnamed
- **Has presets**: Yes

### footer

- **Name**: t:general.footer
- **Settings**: `menu` (link_list), `show_payment_icons` (checkbox)
- **Has presets**: No

### header

- **Name**: t:general.header
- **Settings**: `menu` (link_list), `customer_account_menu` (link_list)
- **Has presets**: No

### hello-world

- **Name**: Hello World
- **Has presets**: Yes

### page

- **Name**: t:general.page
- **Has presets**: No

### password

- **Name**: t:general.password
- **Has presets**: No

### product

- **Name**: t:general.product
- **Has presets**: No

### search

- **Name**: t:general.search
- **Has presets**: No

---

## Template Contents

These show the default section configurations for each page template.

### 404

- **Sections**: `main` → type: `404`
- **Order**: `main`

### article

- **Sections**: `main` → type: `article`
- **Order**: `main`

### blog

- **Sections**: `main` → type: `blog`
- **Order**: `main`

### cart

- **Sections**: `main` → type: `cart`
- **Order**: `main`

### collection

- **Sections**: `main` → type: `collection`
- **Order**: `main`

### index

- **Sections**: `main` → type: `hello-world`
- **Order**: `main`

### list-collections

- **Sections**: `main` → type: `collections`
- **Order**: `main`

### page

- **Sections**: `main` → type: `page`
- **Order**: `main`

### password

- **Sections**: `main` → type: `password`
- **Order**: `main`

### product

- **Sections**: `main` → type: `product`
- **Order**: `main`

### search

- **Sections**: `main` → type: `search`
- **Order**: `main`
