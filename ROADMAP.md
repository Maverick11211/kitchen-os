# Kitchen OS — Roadmap

## Current status
Phase 0 complete. Phase 1 complete. Phase 2 not started.
Last updated: 2026-08-14

## Environment (done)
- Repo: github.com/Maverick11211/kitchen-os
- React + TypeScript + Vite, ESLint, Prettier, Vitest
- Claude Code installed, CLAUDE.md written
- Sanity test passing via `npm test`

## Phase 0 — Schema — DONE
Locked data model in src/types/schema.ts.
All decisions recorded in DECISIONS.md.

## Phase 1 — Ingredient ontology — DONE
Canonical ingredient table built: 193 entries across all 10 categories
(dairy, protein, produce, grain, legume, fat-oil, condiment, spice,
baking, beverage, other).
Output: src/data/ontology.json
Judgment calls and conventions from this phase are recorded in
DECISIONS.md (fallback unitWeightG on high-variance mass ingredients,
sealed/best-by shelf-life convention, spice tracked/perishable split,
canned-goods net-weight convention, produce format-variant deferral).

## Phase 2 — Recipe seed set
100-150 recipes from TheMealDB, normalized against the Phase 1 ontology.
Every ingredient line must resolve to a canonical ID with a numeric quantity.
Output: src/data/recipes.json
Recommended model: Sonnet.

## Phase 3 — Core engine (headless, tested)
Unit conversion, FEFO deduction, macro computation, ownership ranking.
Pure functions in src/engine/, no React imports, full test coverage.
Recommended model: Opus or opusplan.

## Phase 4 — Inventory UI
Two-pane landscape layout. Add product, add lot, category view,
expiry warnings, quantity adjustment, reconcile screen.
Export/import ships here — not later.
Needs scoping: an "add canonical ingredient" screen. The ontology built
in Phase 1 has no in-app way to grow after launch — see the open item
in DECISIONS.md (`AppMeta.seedVersion` exists for merging future
ontology.json updates, but nothing lets the User add a one-off ingredient
without a redeploy). Decide whether this ships in Phase 4 alongside
add-product/add-lot, or later.

## Phase 5 — Nutrition UI
Daily totals (calories, carbs, fat, protein), browse past days,
direct ingredient logging.

## Phase 6 — Recipe UI
Card grid with ownership rings, Missing One tier, filters and sorts,
recipe detail, manual add form.

## Phase 7 — Cook flow
Cooking mode -> "Made it" -> scale confirm -> deduction preview ->
commit -> "how much did you eat" -> consumption logged.

## Phase 8 — Polish and deploy
PWA install, offline verification, real iPad testing.

## Phase 9 — Two-week live trial
Use it. Fix what annoys you. That is v1.

## Deferred to v2
Barcode scanning, label OCR, leftovers as usable entity,
macro goals and targets, trend statistics, recipe import by URL.