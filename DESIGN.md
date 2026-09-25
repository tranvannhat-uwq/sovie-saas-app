---
name: SoVie Sales Operations
colors:
  canvas: '#f3f7fb'
  surface: '#ffffff'
  surface-soft: '#f8fafc'
  surface-muted: '#e2e8f0'
  ink: '#0f172a'
  ink-muted: '#475569'
  outline: '#cbd8e3'
  primary: '#0057cd'
  primary-bright: '#006eff'
  secondary: '#006e08'
  secondary-highlight: '#3cfe3b'
  danger: '#bf0014'
typography:
  display:
    fontFamily: Space Grotesk
    fontWeight: '600'
  interface:
    fontFamily: Inter
    fontWeight: '400'
rounded:
  sm: 8px
  DEFAULT: 12px
  lg: 18px
  xl: 24px
---

# SoVie Design System

## Product and interface

SoVie is a Vietnamese sales and business operations platform. The interface
helps teams manage customers, products, price lists, sales orders, returns,
suppliers, purchases, cash flow and company workspaces. Use Vietnamese labels
and familiar accounting terms throughout the authenticated application.

The public landing page explains the product and leads to login or contact.
The authenticated workspace uses a horizontal top navigation bar, a compact
page header and a light content canvas. Keep the landing page under
`#landing-page` and the signed-in application under `#app-layout` so their
styles do not leak into each other.

## Color and surfaces

Use navy and blue for navigation, primary actions and focus. Use the SoVie
green token for secondary actions and positive states; reserve its vivid green
highlight for small accents. Use red for destructive actions and errors and
amber for pending or warning states. Keep the main canvas a cool, light gray
and place white cards on it. Use readable borders for tables, filters and form
controls where they improve scanning in dense business data.

Use the shared tokens from the base stylesheet instead of introducing a new
color value for each module. Landing-page accents may use a brighter blue and
emerald, scoped to `#landing-page`.

## Type and information hierarchy

Use Inter for forms, navigation, tables and long text. Use Space Grotesk for
page titles and prominent totals. Make currency, order codes, status and dates
easy to compare at a glance. Keep table headings concise and align amounts to
the right.

## Components and behavior

- Use one horizontal navigation layout at every viewport. At narrow widths,
  allow the menu to wrap or open through its existing mobile controls without
  changing panel destinations.
- Use blue primary buttons for the main action on a screen. Use neutral buttons
  for secondary actions and clear labels for destructive actions.
- Use white cards with modest corner radii and soft shadows to group related
  controls. Avoid stacking multiple card surfaces around the same content.
- Keep forms aligned and readable. Show required fields, validation messages,
  loading, empty and error states where users need them.
- Use Lucide icons consistently. Do not use Material Symbols pseudo-elements
  or substitute glyph fonts for SVG icons.
- Keep modal, menu, panel and loading visibility tied to explicit state classes
  or attributes. Do not leave hidden controls active in the interface logic.
- Preserve role-based access and print layouts while changing presentation.
  Invoice and return print templates must remain legible on A4 paper.

## Responsive behavior

Keep the main content usable at 390, 768, 1199, 1200 and 1440 pixels. At mobile
widths, prevent page-level horizontal overflow; place wide data tables inside
their own horizontal scrollers. Stack form controls and modal actions when
there is not enough room for side-by-side fields.
