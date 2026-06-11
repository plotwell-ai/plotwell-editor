# Design System Guide

## Brand

The brand name is `plotwell` in lowercase. Use lowercase in product copy and exports, for example "Generated using plotwell". At the start of a sentence, `Plotwell` is acceptable if required by grammar.

## Color System

Tailwind CSS v4 uses HSL-based CSS variables in `index.css`.

```css
--background: 0 0% 100%;
--foreground: 222.2 84% 4.9%;
--primary: 217 91% 60%;
--primary-foreground: 210 40% 98%;
--destructive: 0 72% 51%;
--border: 214 32% 91%;
--ring: 217 91% 60%;
```

Primary colors:

- Blue primary: `hsl(217 91% 60%)` / `#2563eb`.
- Amber accent: `#d97706` to `#f59e0b`.
- Slate/gray neutral palette for structure and text hierarchy.

## Typography

Fonts:

- Plus Jakarta Sans for UI text.
- JetBrains Mono for monospace.

Scale:

- Heading 1: `text-2xl md:text-3xl font-bold`.
- Heading 2: `text-xl font-semibold`.
- Body: `text-sm` or `text-base`.
- Caption: `text-xs`.

## Components

Base UI components live in `plotwell-app/src/components/ui/`.

Use shadcn/ui and Radix primitives where they already exist. Use `cn()` from `@/lib/utils` for conditional classes.

## SidePanel

Use `SidePanel` from `@/components/ui/SidePanel` for edit forms, settings, and detail views.

Dialogs are only for quick confirmations. `SidePanel` renders via portal above the app shell. Desktop width is typically `w-[480px]`; mobile behaves as a bottom sheet. See `plotwell-app/VIEWS_LAYOUT.md` for full layout guidance.

## Responsive Patterns

Use mobile-first layouts and `md:` at 768 px.

- `IconRail` and `SubNav` are hidden on mobile.
- `MobileNav` provides bottom navigation on mobile.
- `AIChatPanel` is full-screen on mobile and floating on desktop.
- View headers should wrap: prefer `flex flex-col sm:flex-row`.
- View padding: `py-4 md:py-8 px-3 md:px-6`.
- Editor padding: `p-6 md:p-16`.
- Toolbars should support horizontal overflow on mobile: `overflow-x-auto flex-nowrap md:flex-wrap`.
