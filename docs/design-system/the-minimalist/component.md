# COMPONENT.md: Structural Blueprints & Skeleton Specification

## 1. Global Layout Shell
- **Nesting:** `Body > Header (Sticky) > Main > Footer`
- **Spacing:** 
  - Desktop: `px-20` (120px) horizontal margins, `max-w-[1440px]`
  - Mobile: `px-5` (20px) horizontal margins
- **Breakpoints:** 
  - Mobile (< 768px): 1-column stack
  - Desktop (> 1024px): 12-column grid system

---

## 2. Navigation (TopNavBar)
- **Nesting:** `Header > Nav Container > [Logo (Left/Center) | Links (Center) | Icons (Right)]`
- **Spacing:** `py-6`, `gap-8` for desktop links, `gap-4` for mobile icons.
- **Responsive:**
  - Desktop: Horizontal flex with inline navigation links.
  - Mobile: Flex-between with hamburger menu trigger and icon-only actions.

---

## 3. Hero Section (index.json)
- **Nesting:** `Section > Relative Container > [Image (Full-bleed) | Overlay Content Box]`
- **Spacing:** `py-24` (desktop), `py-12` (mobile). Content box `p-12`.
- **Responsive:**
  - Desktop: 12-col grid overlay, often 1/2 or 1/3 width content placement.
  - Mobile: Stacked layout; image top, content below with `gap-6`.

---

## 4. Product Grid (collection.json)
- **Nesting:** `Section > Grid Container > Product Card (Article)`
- **Spacing:** `gap-12` (desktop), `gap-6` (mobile). Card internal: `mt-4` for info.
- **Responsive:**
  - Desktop: 3-column or 4-column asymmetric grid.
  - Mobile: 2-column grid.

---

## 5. Product Page (product.json)
- **Nesting:** `Section > 2-Column Grid > [Media Gallery (Left) | Sticky Buy-Box (Right)]`
- **Spacing:** `gap-20` between columns. `mb-8` for typography blocks.
- **Responsive:**
  - Desktop: Sticky right-side panel with scrollable left-side media.
  - Mobile: Single-column stack; media carousel top, buy-box below.

---

## 6. Cart Drawer & Summary (cart.json)
- **Nesting:** `Aside (Drawer) > Flex Header > Scrollable Item List > Fixed Footer CTA`
- **Spacing:** `p-10` (desktop drawer), `p-6` (mobile summary). Item `gap-6`.
- **Responsive:**
  - Desktop: Slide-out drawer (right) or full-page 2-col summary.
  - Mobile: Full-width slide-up or single-col stack.

---

## 7. Newsletter & Footer
- **Nesting:** `Footer > Grid > [Brand Info | Nav Links | Social | Newsletter Form]`
- **Spacing:** `py-20`, `gap-12` between grid columns.
- **Responsive:**
  - Desktop: 4-column horizontal grid.
  - Mobile: 1-column vertical stack with `mt-12` between blocks.