# Desktop Layout Switcher

## Problem
The 3 desktop views (Home, Grid, Lanes) are separate routes with no easy way to switch between them inline. Users need a visible, always-present toggle.

## Solution
Add a DaisyUI radio tab (`join` group) to the desktop layout that lets users switch between Home, Grid, and Lanes without a full page navigation feel.

```jsx
<div className="join">
  <input className="join-item btn" type="radio" name="layout" aria-label="Home" />
  <input className="join-item btn" type="radio" name="layout" aria-label="Grid" />
  <input className="join-item btn" type="radio" name="layout" aria-label="Lanes" />
</div>
```

## Acceptance Criteria
- Radio tab group visible on desktop views (home, grid, lanes)
- Active tab reflects current route
- Clicking a tab navigates to the corresponding route (or swaps content inline)
- Mobile layout unaffected (tabs are desktop-only)

## Relevant Files
- `app/routes/home.tsx`
- `app/routes/grid.tsx`
- `app/routes/lanes.tsx`
- Possibly a shared layout component

## Constraints
- Use DaisyUI `join` + radio pattern (not custom tabs)
- Keep it minimal — no extra wrapper routes or layout refactors unless necessary
