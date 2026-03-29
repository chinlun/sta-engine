```markdown
# Design System: High-End Editorial Specification

## 1. Overview & Creative North Star
**Creative North Star: The Digital Curator**

This design system is built to transcend the standard e-commerce "grid of products." It is designed to feel like a high-end, physical lifestyle magazine—where white space is a luxury good and every element is placed with intentionality. We move away from "UI components" toward "Editorial Compositions." 

To break the "template" look, we employ **Intentional Asymmetry**. Do not feel forced to fill every cell of the 12-column grid. Large-scale imagery should bleed off-edge or be inset with significant padding (Spacing 20 or 24) to create a sense of breath. Layering is our primary tool for depth; elements should overlap slightly (e.g., a text block overlapping a hero image) to create a sophisticated, bespoke feel that feels assembled by hand, not by an algorithm.

---

## 2. Colors & Surface Logic

The palette is rooted in a monochromatic, high-contrast foundation, utilizing tonal shifts rather than structural lines to define space.

### The "No-Line" Rule
While the original brief mentions 1px borders, as a signature rule for this system, **prohibit 1px solid borders for sectioning.** Physical boundaries must be defined solely through background color shifts. A section intended to stand out should move from `surface` (#F9F9F9) to `surface-container-low` (#F2F4F4). 

### Surface Hierarchy & Nesting
Treat the UI as a series of stacked fine papers. Use the following hierarchy to create "nested" depth:
- **Base Layer:** `surface` (#F9F9F9) for the primary background.
- **Content Blocks:** `surface-container-low` (#F2F4F4) for secondary editorial sections.
- **Interactive Cards:** `surface-container-lowest` (#FFFFFF) to provide a soft, natural "lift" against the off-white background.

### Signature Textures & Gradients
To avoid a "flat" digital feel, main CTAs and hero background overlays may use a subtle linear gradient transitioning from `primary` (#5F5E5E) to `primary-dim` (#535252) at a 135-degree angle. This adds a "weighted" metallic or charcoal ink feel to the interactive elements.

---

## 3. Typography: The Editorial Voice

The interplay between the authoritative Noto Serif (Playfair Display equivalent) and the functional Inter creates a dialogue between tradition and modernity.

*   **Display & Headlines (Noto Serif):** Used for storytelling and brand statements. Use `display-lg` (3.5rem) with tight letter-spacing (-0.02em) to create a high-fashion masthead feel.
*   **Body & UI (Inter):** Used for clarity and commerce. `body-lg` (1rem) should have a generous line-height (1.6) to maintain the "spacious" requirement.
*   **Labels (Inter):** Use `label-md` or `label-sm` in all caps with increased letter-spacing (0.05em) for category tags or "New Arrival" badges to denote a curated boutique aesthetic.

---

## 4. Elevation & Depth

We eschew traditional shadows in favor of **Tonal Layering** and **Ambient Light**.

*   **The Layering Principle:** Depth is achieved by stacking. Place a `surface-container-lowest` (#FFFFFF) card on a `surface-container-low` (#F2F4F4) section. This creates a 0dp elevation look that feels premium and tactile.
*   **Ambient Shadows:** If a floating element (like a Quick-Buy modal) is required, use a shadow with a 40px blur at 4% opacity, using the `on-surface` color (#2D3435). It should look like a soft glow, not a drop shadow.
*   **The "Ghost Border" Fallback:** If a border is required for accessibility, use the `outline-variant` (#ADB3B4) at **15% opacity**. Never use 100% opaque borders.
*   **Glassmorphism:** For navigation bars or floating filters, use `surface` (#F9F9F9) at 80% opacity with a `backdrop-blur` of 12px. This allows high-quality lifestyle imagery to bleed through the UI, softening the experience.

---

## 5. Components

### Buttons
*   **Primary:** Solid `primary` (#5F5E5E) with `on-primary` (#FAF7F6) text. Shape is strictly rectangular (`rounded-none`).
*   **Secondary:** Ghost style. No background, `outline-variant` at 20% opacity. Text in `primary`.
*   **States:** On hover, Primary buttons should shift to `primary-dim`. Transitions must be slow (300ms ease-in-out).

### Input Fields
*   **Styling:** No bottom line or box. Use a `surface-container-high` background with `label-sm` floating above the field. 
*   **Error State:** Use `error` (#9F403D) only for the helper text; do not turn the entire box red, as it breaks the minimalist aesthetic.

### Cards & Lists
*   **Rule:** Forbid the use of divider lines. 
*   **Spacing:** Separate list items using `spacing-6` (2rem). Separate editorial sections using `spacing-20` (7rem).
*   **Product Cards:** Use `surface-container-lowest` for the card background. Imagery should be "contained" within the card with `spacing-4` internal padding to create a framed, gallery look.

### Editorial Signature Components
*   **The Lookbook Carousel:** A horizontal scroll where images vary in aspect ratio (2:3 and 4:5), breaking the repetitive square grid.
*   **Floating Navigation:** A minimalist nav-bar that only appears on scroll-up, utilizing the Glassmorphism rule to maintain a light, airy feel.

---

## 6. Do's and Don'ts

### Do
*   **Do** use asymmetrical layouts. Place text in columns 1-5 and the image in columns 7-12.
*   **Do** prioritize "white space" as a functional element. If a section feels crowded, double the padding using the Spacing Scale (e.g., move from `16` to `24`).
*   **Do** use high-quality, desaturated lifestyle photography to complement the charcoal and off-white palette.

### Don't
*   **Don't** use rounded corners. Everything is 0px (`rounded-none`) to maintain a sharp, architectural edge.
*   **Don't** use pure black (#000000). Always use `on-background` (#2D3435) for text to keep the "ink on paper" softness.
*   **Don't** use standard "Sale" red. Use the sophisticated `error_container` (#FE8983) or `tertiary` (#486272) for subtle callouts.
*   **Don't** use dividers or 1px lines to separate content. Let the space and tonal shifts do the work.```