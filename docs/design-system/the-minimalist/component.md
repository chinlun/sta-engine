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
- **Nesting:** `Header > Nav Container > [Logo (Left/Center/Right) | Links (Center) | Icons (Right)]`
- **Dimensions & Spacing:**
  - Height: Between `50px` and `80px` (with `60px` as the common standard).
  - Spacing: `py-6`, `gap-8` for desktop links, `gap-4` for mobile icons.
- **Placement & Width:**
  - Placed at the top (topmost or after an announcement bar). Full-width or boxed (with square or rounded corners, optionally layered on top of the header).
- **Background & Scroll Behavior:**
  - Options: Solid color, transparent, or transparent transitioning to solid on scroll.
  - Scroll behavior: On scroll-up or on scroll-down, transition from absolute/transparent to a fixed background color (fading in or sliding in).
- **Desktop Content & Layout Options:**
  - **Menu Options:** Inline direct links or burger trigger to open a SubNav or MegaMenu.
  - **SubNav Behavior:** Reveals on hover or click. Contains category headlines and nested menu items.
  - **MegaMenu Behavior:** Slides in from the top, left, or right. Contains a main menu (Level 1 + Level 2 revealing on click or hover with sublists), focus cards (e.g., product or category image + design highlights), and auxiliary submenus.
  - **Cart Drawer/Slide:** Triggered by an icon or text link. Slides in from top, right, or left, or opens a cart page. Drawer contents: header/headline, item lists (product title, image, SKU, quantity, price, add/remove buttons), total cost, voucher field, and a direct checkout CTA.
  - **Search:** Optional left/right placement. Search loop icon or search text button. Click triggers slide-in (left, top, right) with search results either sliding down below the search bar or routing to a results page.
  - **Account Access:** Optional placement. On-click opens login popup, login slide-in (left/right/top), or dedicated login page.
  - **Favorites:** Optional placement. Links directly to a new page.
- **Mobile Content & Layout:**
  - Centered or aligned logo.
  - Burger menu button (left or right placement).
  - Quick-access icons (Account, Favorites, Search, Cart).
- **Responsive:**
  - Desktop: Horizontal flex with inline navigation links.
  - Mobile: Flex-between with hamburger menu trigger and icon-only actions.

---

## 3. Hero Section (index.json)
- **Nesting:** `Section > Relative Container > [Image (Full-bleed) | Overlay Content Box]`
- **Dimensions & Spacing:**
  - Width: Full-width or boxed (with round/square corners).
  - Height: Full screen height (100vh) or fixed height.
  - Spacing: `py-24` (desktop), `py-12` (mobile). Content box `p-12`.
- **Placement & Layout:**
  - Placed after header/navigation or top layer (with transparent header overlay and scroll background fade).
  - Presentation: Single hero image/video or multiple slides with slide/fade-in-out transitions.
- **Background:** Color, gradient, responsive desktop/mobile picture, or looping video.
- **Content Elements:**
  - Optional Pre-headline, authoritative primary Headline, content description text.
  - Button One (custom style, label, action link).
  - Button Two (custom style, label, action link).
  - Scroll-to-next-section helper anchor.
  - If color/gradient background: grid layout showing boxed pictures, category highlights, or feature callout buttons.
- **Content Positioning (9-Box Grid):**
  - Content can be aligned inside one of 9 virtual boxes on desktop and mobile respectively:
    - Horizontal: Left | Center | Right
    - Vertical: Top | Center | Bottom
- **Responsive:**
  - Desktop: 12-col grid overlay, utilizing asymmetric content placements (often 1/2 or 1/3 width content placement).
  - Mobile: Stacked layout or centered/aligned overlay.

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