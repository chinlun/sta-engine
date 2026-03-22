# Screen Design Documentation: Digital Atelier

This document contains Markdown descriptions of the three primary screens for the Digital Atelier e-commerce platform: Desktop, Tablet, and Mobile.

---

## 1. Desktop Collection ({{DATA:SCREEN:SCREEN_5}})
**Title:** Digital Atelier - Curated Collection
**Device:** Desktop (1440px+)
**Design System:** {{DATA:DESIGN_SYSTEM:DESIGN_SYSTEM_1}} (Aura Mono + Electric)

### Layout & Structure
- **Hero Section:** High-impact minimalist hero with the headline "The Art of Essentialism" and a subtle background image. Includes a "Explore Works" CTA.
- **Product Grid:** A staggered 2-column layout showcasing large, high-quality product photography.
- **Interactive Cart Drawer:** A sleek, right-aligned side drawer for managing selections without leaving the page.
- **Philosophy Section:** "Designed for Permanence" - a text-heavy section explaining the brand's commitment to quality.
- **Footer:** Minimalist site map with social links and copyright info.

### Components
- **TopNavBar:** Sticky navigation with links for "Collections," "Philosophy," and "Archive." Includes a bag icon and profile access.

---

## 2. Tablet Collection ({{DATA:SCREEN:SCREEN_7}})
**Title:** Digital Atelier - Tablet Collection
**Device:** Tablet (768px - 1024px)
**Design System:** {{DATA:DESIGN_SYSTEM:DESIGN_SYSTEM_1}}

### Layout & Structure
- **Hybrid Grid:** Transitions the desktop staggered grid into a more compact 2-column grid suitable for touch interaction.
- **Responsive Hero:** Re-proportioned hero image and text for better legibility on smaller landscapes.
- **Simplified Drawer:** The cart drawer is optimized for touch targets, providing a focused selection management experience.

### Components
- **TopNavBar:** Retains the core desktop links but with increased spacing for touch.

---

## 3. Mobile Collection ({{DATA:SCREEN:SCREEN_3}})
**Title:** Digital Atelier - Mobile Collection
**Device:** Mobile (375px - 430px)
**Design System:** {{DATA:DESIGN_SYSTEM:DESIGN_SYSTEM_1}}

### Layout & Structure
- **Single Column Flow:** Vertical stack optimized for one-handed scrolling.
- **Full-Width Imagery:** Products are presented in a high-contrast, single-column grid to maximize visual impact.
- **Mobile Bottom Nav:** A dedicated bottom navigation bar for quick access to "Home," "Search," "Wishlist," and "Cart."
- **Overlay Cart:** The side drawer becomes a full-screen or large-scale overlay for mobile.

### Components
- **TopAppBar:** Center-aligned branding with a menu icon (left) and shopping bag (right).
- **BottomNavBar:** Persistent icons for core navigation.
