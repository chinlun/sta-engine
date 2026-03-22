# Monolith Atelier Design System

## 1. Overview & Creative North Star
**Creative North Star: The Curated Void**

Monolith Atelier is a design system rooted in the philosophy of "Essentialism." It moves away from the cluttered density of traditional e-commerce and SaaS platforms, opting instead for a high-end editorial feel. The system prioritizes material honesty, generous whitespace (negative space as a functional element), and a strict monochromatic foundation. By utilizing intentional asymmetry and radical typographic hierarchy, Monolith Atelier transforms a digital interface into a gallery-like experience.

## 2. Colors
The palette is intentionally restrained, focusing on "True Black" (#000000) and "Ghost Whites" (#F9F9FB) to allow product photography and content to hold the weight of the experience.

- **The "No-Line" Rule:** Visual separation must never be achieved through 1px solid borders. Boundaries are defined by transitions between `surface` (#f9f9fb) and `surface_container_low` (#f3f3f5). Hairline dividers (1px) are permitted only in navigation or footers at 10% opacity to maintain a "skeletal" structure.
- **Surface Hierarchy:** Depth is created through a "stacking" methodology. The base layer is `surface`, while interactive or secondary sections use `surface_container_low`. Overlays and drawers utilize a `backdrop-blur` (24px+) combined with a semi-transparent surface color to simulate architectural glass.
- **Signature Textures:** Use subtle grayscale gradients (e.g., `surface` to transparent) to create a sense of infinite horizon in hero sections.

## 3. Typography
The typography system uses a pairing of **Manrope** for high-impact editorial moments and **Inter** for utilitarian clarity.

- **Display & Headline (Manrope):** Characterized by tight tracking (-0.05em) and heavy weights. The scale is aggressive, ranging from 3rem (72px) for hero titles to 1.875rem (30px) for section headers.
- **Body (Inter):** Set with generous leading (1.6) to ensure readability against the minimalist backdrop.
- **Micro-Labels:** Use 10px or 12px Inter with extreme tracking (0.3em to 0.5em) and uppercase transformation. This is the "Signature Mark" of the system, used for categories and metadata.
- **Ground Truth Sizes:**
  - Hero Display: 72px (4.5rem)
  - Section Header: 30px (1.875rem)
  - Sub-header/Large Body: 18px (1.125rem)
  - Standard Body: 16px (1rem)
  - Utility/Metadata: 10px - 12px

## 4. Elevation & Depth
Elevation in Monolith Atelier is achieved through **Tonal Layering** rather than heavy drop shadows.

- **The Layering Principle:** A side drawer or modal should not appear to "float" with a heavy shadow, but rather "slide over" as a distinct material plane.
- **Ambient Shadows:** When necessary for functional depth (like the cart drawer), use a `0px 0px 60px` shadow with a very low opacity (6%) of the `on_surface` color.
- **Glassmorphism:** Navigation bars and drawers must use `backdrop-blur-xl` with an 85% opacity surface color to maintain a sense of environmental continuity.

## 5. Components
- **Buttons:** Sharp or subtly rounded (2px-4px). Primary buttons are solid `primary` (#000000) with `on_primary` (#ffffff) text. Tracking should be wide (0.2em).
- **Cards:** No borders. Cards are defined by the media (images) they contain. Images should use an `aspect-[4/5]` ratio and subtle `scale-105` hover transitions.
- **Inputs:** Search and form fields are pill-shaped (`rounded-full`) but use the `surface_container_low` background to remain recessed rather than prominent.
- **Dividers:** 1px height, using `outline_variant` at 20% opacity.

## 6. Do's and Don'ts
### Do's
- Use whitespace as a primary layout tool; let elements breathe.
- Maintain a strict 4/5 or 16/9 aspect ratio for all primary imagery.
- Use uppercase, wide-tracked labels for all non-body metadata.
- Implement smooth, long-duration transitions (500ms-700ms) for image hover effects.

### Don'ts
- **No standard "Blue" links:** All interactions remain monochromatic unless they are system errors.
- **No heavy shadows:** Avoid Material Design-style floating action buttons or high-elevation cards.
- **No Rounded Corners:** Avoid "bubbly" UI. Keep radii between 0px and 8px (except for search bars).
- **No traditional Grids:** Break the grid occasionally with offset text or overlapping image/text elements to maintain the editorial feel.