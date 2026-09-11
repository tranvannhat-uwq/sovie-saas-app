---
name: Luminous Engine
colors:
  surface: '#f5fbf6'
  surface-dim: '#d5dbd7'
  surface-bright: '#f5fbf6'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff5f0'
  surface-container: '#e9efea'
  surface-container-high: '#e4eae5'
  surface-container-highest: '#dee4df'
  on-surface: '#171d1a'
  on-surface-variant: '#424655'
  inverse-surface: '#2c322f'
  inverse-on-surface: '#ecf2ed'
  outline: '#727787'
  outline-variant: '#c2c6d8'
  surface-tint: '#0057cd'
  primary: '#0057cd'
  on-primary: '#ffffff'
  primary-container: '#006eff'
  on-primary-container: '#000416'
  inverse-primary: '#b1c5ff'
  secondary: '#006e08'
  on-secondary: '#ffffff'
  secondary-container: '#3cfe3b'
  on-secondary-container: '#007108'
  tertiary: '#bf0014'
  on-tertiary: '#ffffff'
  tertiary-container: '#e72226'
  on-tertiary-container: '#ffffff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d9e2ff'
  primary-fixed-dim: '#b1c5ff'
  on-primary-fixed: '#001946'
  on-primary-fixed-variant: '#00419d'
  secondary-fixed: '#76ff66'
  secondary-fixed-dim: '#05e61f'
  on-secondary-fixed: '#002201'
  on-secondary-fixed-variant: '#005304'
  tertiary-fixed: '#ffdad6'
  tertiary-fixed-dim: '#ffb4ab'
  on-tertiary-fixed: '#410002'
  on-tertiary-fixed-variant: '#93000d'
  background: '#f5fbf6'
  on-background: '#171d1a'
  surface-variant: '#dee4df'
typography:
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
---

# Design System Documentation: Digital Fluidity & Resource Intelligence

## 1. Overview & Creative North Star

### The Creative North Star: "The Luminous Engine"
This design system moves away from the static, boxy constraints of traditional utility apps. Instead, it treats data as a living, breathing pulse. We are building "The Luminous Engine"—a high-end editorial experience where smart home resource tracking feels less like a chore and more like a curated command center.

To achieve this, we break the "template" look by utilizing **intentional asymmetry** and **tonal depth**. Rather than rigid grids, we use white space as a structural element. Elements should feel like they are floating in a clean, pressurized environment, using overlapping layers and high-contrast typography to guide the eye through complex data sets.

---

## 2. Colors & Surface Architecture

The palette is rooted in a pristine, light-mode foundation (`surface`), punctuated by high-performance accents that represent the "flow" of life: Energy (`primary` - `#006eff`), Water (`secondary` - `#00e51e`), and Alert/Critical Flow (`tertiary` - `#f62f2f`), with a neutral anchor (`#edf3ee`).

### The "No-Line" Rule
**Explicit Instruction:** You are prohibited from using 1px solid borders to define sections or containers. Layout boundaries must be established solely through:
1.  **Background Color Shifts:** Placing a `surface-container-low` element against a `surface` background.
2.  **Tonal Transitions:** Using the hierarchy of `surface-container` tokens to imply separation.

### Surface Hierarchy & Nesting
Think of the UI as physical layers of fine, matte paper or frosted glass. 

### The "Glass & Gradient" Rule
To escape the "flat" look, use **Glassmorphism** for floating elements (e.g., navigation bars or quick-action overlays). 
*   **Implementation:** Use a semi-transparent `surface` color with a `backdrop-blur` (12px–20px). 
*   **Signature Textures:** For main CTAs or data visualizations, apply subtle linear gradients transitioning from `primary` (#006eff) to add a "glow" that feels premium and alive.

---

## 3. Typography: The Editorial Voice

We pair the technical precision of **Inter** with the futuristic, architectural character of **Space Grotesk**.

*   **Display & Headlines (Space Grotesk):** Use `display-lg` to `headline-sm` for high-impact data points (e.g., total energy usage). The sharp terminals of Space Grotesk convey a "futuristic" and "engineered" aesthetic.
*   **Body & Titles (Inter):** Use `title-lg` down to `body-sm` for all functional reading and navigation. Inter provides the "Clean, minimalist" legibility required for high-density information.
*   **Information Hierarchy:** Always lean into high-contrast scale. If a headline is `headline-lg`, the supporting label should be `label-md` to create a sophisticated, editorial "white space" around the content.

---

## 4. Elevation & Depth

We define hierarchy through **Tonal Layering** rather than structural scaffolding.

*   **The Layering Principle:** Depth is achieved by stacking. A `surface-container-lowest` (#ffffff) card placed on top of a `surface-container-low` background creates a natural, soft lift.
*   **Ambient Shadows:** For floating elements, use extra-diffused shadows. 
    *   **Spec:** Blur: 24px–40px | Opacity: 4%–8% | Color: Tinted with `on-surface`. Never use pure black shadows.
*   **The "Ghost Border" Fallback:** If a container absolutely requires a boundary for accessibility, use the `outline-variant` at **10-20% opacity**. This creates a "breath" of a line rather than a hard edge.

---

## 5. Components

### Buttons & Interaction
*   **Primary (Energy):** `primary` background with `on-primary` text. Use a 1rem (`DEFAULT`) corner radius for an approachable feel. Apply a subtle outer glow on hover.
*   **Secondary (Water):** `secondary` background with `on-secondary` text. Reserved specifically for water-related resource actions.
*   **Tertiary:** Transparent background with `primary` text. Use for low-emphasis actions.

### Data Chips & Status
*   **High-Contrast Status:** Status indicators (e.g., "Active," "Leaking," "Peak") must use the `primary_fixed` or `error_container` tokens for background, ensuring the `on-` variant provides maximum legibility.
*   **Resource Chips:** Rounded-full (`full`) chips with thin `outline-variant` (Ghost Border) to categorize resource streams.

### Inputs & Forms
*   **The Clean Input:** No bottom line or full box. Use a `surface-container-low` background with a subtle `outline-variant` ghost border. 
*   **Focus State:** Transition the background to `surface-container-lowest` and the border to a 2px `primary` stroke.

### Cards & Resource Lists
*   **Rule:** Forbid the use of divider lines. 
*   **Separation:** Use a `spacing-8` (2rem) vertical gap or a background shift to `surface-container-lowest` for individual items. 
*   **Asymmetry:** In resource dashboards, alternate card widths to break the "standard grid" and feel more like a custom-designed report.

---

## 6. Do’s and Don’ts

### Do:
*   **Do** use `spaceGrotesk` for all major numerical data to emphasize the "futuristic" tracking aspect.
*   **Do** leverage `surface_bright` to highlight active "Live" states in the UI.
*   **Do** use the Spacing Scale strictly. Gaps of `4` (1rem) and `8` (2rem) should be your primary layout drivers to maintain "breathing room."

### Don’t:
*   **Don’t** use 100% opaque grey borders. It breaks the "Luminous Engine" immersion.
*   **Don’t** mix `primary` and `secondary` within a single component unless it is a combined resource report. Keep the flows distinct.
*   **Don’t** use standard "Drop Shadows." If an element doesn't feel like it's floating through tonal shift, reconsider the layer hierarchy before adding a shadow.
*   **Don’t** crowd the interface. If a screen feels busy, increase the spacing to the next tier in the scale.