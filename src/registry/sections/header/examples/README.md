# Header Section Example

This header registry entry is designed for Shopify Online Store 2.0 themes that need a highly configurable navigation system without generating bespoke Liquid each time.

## Supported requirement coverage
- Placement options: top, after status bar, or boxed with top margin
- Width modes: full width or boxed, including square / round corner styling and layered presentation
- Height control between 50px and 80px
- Background behaviors:
  - solid color
  - transparent first load with solid header sliding in on scroll
  - transparent first load with background fading in on scroll
- Desktop content controls:
  - direct link navigation
  - sub navigation with click or hover reveal
  - mega menu with top / left / right visual variants
  - focus cards for category or product highlights
  - cart trigger modes (icon, text, icon + text)
  - cart page or slide-in cart drawer
  - logo enable / disable and left / center / right placement
  - search enable / disable, icon/text trigger, slide-in directions, and dropdown or full search page results
  - account entry with popup, drawer, or page behavior
  - favorites link placement
- Mobile content controls:
  - burger left or right
  - logo left / center / right or hidden
  - account, favorites, and search visibility by side
  - slide-in mobile navigation drawer

## Recommended integration notes
1. Copy the section and snippets into the theme.
2. Upload `styles.css` and `script.js` into theme assets, or merge their contents into your build pipeline.
3. Connect a real main menu and optional auxiliary mega menu in the theme editor.
4. Add focus item blocks for featured products / collections in mega menus.
5. If the store uses a wishlist app, set `favorites_url` to the app route.
6. Cart voucher input is rendered as a UI placeholder because Shopify typically redeems discount codes at checkout.
