# Remove gallery.tsx

## Problem
Gallery view is unwanted. Home route should be the only way to view sessions.

## Acceptance Criteria
- `app/routes/gallery.tsx` deleted
- Route removed from `app/routes.ts`
- All gallery references removed from `app/components/layout-switcher.tsx`
- Gallery-related imports/refs removed from `app/components/mobile-thumbnail.tsx`
- Gallery-specific WS logic removed from `server/ws-handler.ts` (if any)
- No dead imports or broken references remain
- App builds cleanly (`npm run build`)

## Relevant Files
- `app/routes/gallery.tsx` — delete
- `app/routes.ts` — remove gallery route entry
- `app/components/layout-switcher.tsx` — remove gallery navigation/toggle
- `app/components/mobile-thumbnail.tsx` — remove gallery-specific logic
- `server/ws-handler.ts` — check for gallery-specific code

## Constraints
- Home route (`home.tsx`) becomes the only session view — no replacement needed
- If layout-switcher only exists to toggle between home and gallery, consider removing it entirely
