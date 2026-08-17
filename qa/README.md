# qa/

Dev-only validation tooling for the Phase 2 seed data (`src/data/ontology.json`
and `src/data/recipes.json`). Nothing in this folder is imported by the app —
it exists purely so `npm test` can catch data problems before they ship.

## Why this lives outside `src/`

`src/` is what actually ships in the app. This folder holds a reference table
and a test file that only make sense as build-time checks, so they're kept
separate on purpose:

- `calorie-reference.json` — rough calories-per-100g for every ingredient
  referenced by a seed recipe so far. **This is not real nutrition data and is
  not part of the app's data model.** The app's actual macro data will live on
  `Product.macrosPer100g` (Phase 3+), tied to a specific purchasable product —
  `CanonicalIngredient` deliberately carries no macros (see `DECISIONS.md`).
  These numbers are rough, general-knowledge estimates, good enough to catch a
  recipe that's off by 5-10x (a units mistake, a missing ingredient), not
  precise enough for anything else. Consistent with the project's own ±15%
  macro tolerance — this check is looser than even that, on purpose.
- `seed-data.validate.test.ts` — a Vitest test file (runs automatically with
  `npm test`, same as any other test) that checks:
  1. **Ontology structure** — no duplicate ids, required fields present,
     categories/units are valid, no ingredient uses `densityGPerMl` unless
     it's a true liquid (the "never use density × volume for solids" rule
     from `CLAUDE.md`), no two ingredients share an alias (which would make
     matching a recipe ingredient to a canonical id ambiguous).
  2. **Recipe structure** — every `canonicalId` a recipe references actually
     exists in the ontology, units are valid, quantities are positive.
  3. **Conversion math** — recomputes `quantityG` from scratch (quantity +
     unit + the ingredient's `cupWeightG`/`unitWeightG`/`densityGPerMl`) and
     compares it to what's stored, catching copy-paste or arithmetic mistakes
     made while building a recipe by hand. Same check for `estimatedYieldG`
     against the sum of its ingredients.
  4. **Calorie plausibility** — using the rough reference table above, flags
     any recipe whose overall calories-per-100g falls way outside a normal
     range for a real dish (a sign something is wrong, not proof something is
     right).

## Coverage

The calorie reference table only covers ingredients used by a seed recipe as
of the day it was built. New ingredients added by future recipes won't have
an entry yet — the test skips (doesn't fail) the calorie check for any recipe
with a missing ingredient and prints which one, so gaps are visible without
blocking `npm test`. Add the missing ingredient's rough kcal/100g to keep
coverage current.
