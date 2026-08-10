# Kitchen OS

Personal kitchen inventory, recipe browser, and macro tracker.
Single user, one iPad. Not a product — a tool for one person.

## Commands
- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm test` — run tests. ALWAYS run before saying work is complete.

## Architecture rules (do not violate)
- NO backend, ever. All data lives in the browser via IndexedDB (Dexie).
  Never add a server, API route, or runtime fetch to an external service.
- All quantities normalize to GRAMS internally. Never store or compare mixed units.
- Volume-to-mass for solids uses each ingredient's `cupWeightG` field.
  NEVER use density x volume for solids — it gives wrong answers for
  shredded, cubed, or chopped foods.
- Ingredient deduction is first-expiring-first-out across lots.
- Three-tier ingredient model: CanonicalIngredient -> Product -> Lot.
  Canonical is what recipes reference. Product carries macros. Lot carries
  expiration date and remaining quantity.

## Code conventions
- TypeScript strict mode. No `any`.
- Pure logic lives in `src/engine/` with zero React imports.
- UI components never do unit conversion or macro math — they call `src/engine/`.

## Target environment
- iPad Safari, landscape-first.
- Inputs must be at least 16px font or Safari auto-zooms on focus.
- Use `dvh` not `vh` — `vh` is unreliable on iOS.
- No hover-dependent interactions.
- Minimum touch target 44pt.

## Gotchas
- Macro accuracy tolerance is +/-15%. Do not build precision machinery
  beyond this — it's wasted effort for this use case.
- Staple ingredients (salt, oil, pepper) are excluded from ownership
  percentage and estimated for macros.
- Browser storage is the only copy of the user's data. Export/backup is
  load-bearing, not a nice-to-have.

## Working style
- Explain changes in plain language. I am not an experienced developer.
- Before large changes, describe the plan and wait for approval.