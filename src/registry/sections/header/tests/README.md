# Header Section Tests

## Manual QA checklist
- [ ] Header placement works for top, after status bar, and boxed offset modes
- [ ] Full width and boxed width modes render correctly
- [ ] Round and square boxed corner variants render correctly
- [ ] Boxed layered mode visually floats above content without clipping
- [ ] Header height setting is respected between 50px and 80px
- [ ] Solid background mode renders immediately
- [ ] Transparent slide mode remains transparent on first load and slides in on scroll
- [ ] Transparent fade mode fades background in on scroll
- [ ] Desktop logo can be disabled, and left / center / right placement works
- [ ] Mobile logo can be disabled, and left / center / right placement works
- [ ] Desktop direct-link navigation renders correctly
- [ ] Sub navigation opens by hover when configured
- [ ] Sub navigation opens by click when configured
- [ ] Mega menu renders level 1 and level 2 links correctly
- [ ] Mega menu focus cards map to matching parent labels
- [ ] Mega auxiliary menu renders if configured
- [ ] Desktop burger mode opens navigation drawer
- [ ] Mobile burger works on both left and right positions
- [ ] Search trigger icon / text / both variants render correctly
- [ ] Search panel opens from left / top / right
- [ ] Dropdown predictive search results render after typing
- [ ] Search page mode submits to the search page
- [ ] Account behavior supports popup, left / top / right drawer, and page mode
- [ ] Favorites link respects desktop / mobile side visibility settings
- [ ] Cart trigger supports icon, text, and icon + text
- [ ] Cart behavior supports left / top / right drawer and cart page mode
- [ ] Cart drawer shows product image, title, SKU, quantity, price, totals, and checkout CTA
- [ ] Escape key and overlay click close all active panels
- [ ] No console errors on load or interaction

## Suggested automated checks
- Liquid schema parses without errors
- All snippets referenced in `manifest.json` exist
- `customElements.define('shopify-header', ...)` executes once
- Search endpoint handling does not throw when no predictive results exist
- Asset references resolve correctly in the target theme
