# Kitchen OS — Roadmap

## Current status
Phase 0 complete. Phase 1 complete. Phase 2 complete. Phase 3 complete.
Phase 4 in progress — persistence, export/import, the app shell and the add
flows are done; quantity adjustment, the reconcile screen and the backup
reminder banner are not.
Last updated: 2026-08-20

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

## Phase 2 — Recipe seed set — DONE
150 recipes from TheMealDB (top of the 100-150 target range), normalized
against the Phase 1 ontology. Every ingredient line resolves to a
canonical ID with a numeric quantity; `qa/seed-data.validate.test.ts`
enforces this and passes clean (6017 assertions).
Output: src/data/recipes.json (150 recipes). Ontology grew 193 -> 310
entries to cover them (`src/data/ontology.json`).
30 cuisines represented; British capped at 8/150 (~5%), under the ~10%
ceiling set to avoid skewing the set toward familiar/easy sourcing.
Judgment calls and conventions from this phase are recorded in
DECISIONS.md (dated entries per batch) — notably: alcohol is included
(not excluded as originally assumed), fried dishes record absorbed oil
rather than full frying volume, and a substitution-over-new-entry rule
(reuse the closest existing canonical with a documented `preparation`
note rather than adding a one-off ontology entry for a single recipe).
A pre-Phase-3 review of this output is recorded in DECISIONS.md
(2026-08-18 entry) — read it before starting Phase 3.

## Phase 3 — Core engine (headless, tested) — DONE
Unit conversion, FEFO deduction, macro computation, ownership ranking.
Pure functions in src/engine/, no React imports, full test coverage.

Output: `src/engine/` — `units.ts` (grams <-> any Unit), `ontology.ts`
(canonical lookup), `inventory.ts` (FEFO deduction, availability, expiry),
`macros.ts` (MacroSet arithmetic), `ownership.ts` (ranking, Missing One,
max batch size), `ingredients.ts` (validating and creating a User-added
canonical ingredient), `seed-merge.ts` (folding a redeployed ontology.json
into existing data), plus an `index.ts` barrel that the UI imports from.
No React, no Dexie, no clock read internally — `now`/`today` are always
parameters. 251 engine unit tests + 10 integration tests against the real
seed data; full suite 6289 passing, lint and build clean.

Decisions taken this phase are in DECISIONS.md (2026-08-19 entry):
ownership matches exact `canonicalId` only in v1 (`interchangeableWith`
still deferred, but routed through one function so it can be added
later), FEFO consumes null-expiry lots last, and deduction takes what is
available and reports a shortfall rather than refusing or going negative.

Also done in this pass: TypeScript `strict` was never actually enabled in
any tsconfig despite CLAUDE.md requiring it — now on; the QA validator
dropped its duplicate copy of the conversion math and imports the engine,
which closed a blind spot where 266 of 1562 seed ingredient lines were
silently skipped rather than verified; and 10 ontology entries were
backfilled with the one conversion field each was missing.

The expiring-soon threshold is settled at 5 days
(`DEFAULT_EXPIRING_SOON_DAYS`), decided 2026-08-19 — see DECISIONS.md. It
stays a parameter, so Phase 6 can add a shorter "urgent" band on top.

## Phase 4 — Inventory UI — IN PROGRESS
Two-pane landscape layout. Add product, add lot, category view,
expiry warnings, quantity adjustment, reconcile screen.
Export/import ships here — not later.

Being built in six chunks, each ending with `npm test`, `npm run lint` and
`npm run build` green. Decisions are recorded in DECISIONS.md
(2026-08-19 "Phase 4: persistence, export/import, app shell").

**Done:**
1. **Persistence.** `src/db/` — Dexie tables plus a repository layer that is
   the only thing allowed to write. Startup seed merge wired up: the merge and
   the `seedVersion` stamp are one transaction, because either half alone is
   silent permanent data loss.
2. **Export / import.** `src/engine/backup.ts` builds and checks a
   `BackupFile` (pure); `src/db/repo/backup.ts` moves the rows. A restore
   replaces everything in one transaction; an older file is upgraded with a
   warning, and one from a newer app is refused outright.
3. **App shell.** Hash routing, two-pane landscape layout, category list with
   live counts, inventory list with the two expiry bands, and a working backup
   screen. iPad baseline in the CSS: `dvh`, 16px inputs, 44pt targets, no
   hover.

4. **Add flows.** Find it, describe it, say how much. The label can be read
   per package, per serving or per 100g. The inline "can't find it? add it"
   ingredient form is in and returns you to the product form for what you just
   created.

**Left:**
5. Quantity adjustment, the Reconcile screen, and the backup reminder banner
   after 7 days without an export.
6. Final documentation pass.

Schema note: `SCHEMA_VERSION` is now **2**. `Lot.frozen` went in under
version 1 while no database existed; `MacroSet.cholesterolMg` forced the first
real bump on 2026-08-20 and ships with both conversions — a Dexie `version(2)`
upgrade for stored rows and an upgrade path in `validateBackupFile` for backup
files. Any further change to `schema.ts` needs both of those again.

**Add-ingredient is scoped in** (decided 2026-08-19, see DECISIONS.md).
The engine side is already built and tested in Phase 3, so what is left
here is UI plus persistence:

- An **inline** "can't find it? add it" path in the add-product flow that
  returns the User to where they were — not a separate screen they have to
  navigate to and back from. This is the moment the wall is hit.
  The form calls `validateIngredientDraft` / `createUserIngredient` from
  `src/engine/ingredients.ts`; each issue it returns is already tagged with
  the field to highlight and carries a message written to be shown as-is.
  Warnings must be surfaced without blocking the save.
- **Add-only.** No editing of ingredients in v1, seed or User-added. This
  is what keeps the seed merge safe — do not add editing here without
  re-reading the merge decision first.
- **Wire up the seed merge on startup**: call `needsSeedMerge` against
  `AppMeta.seedVersion`, run `mergeSeedOntology`, write the result, then
  store the new `seedVersion`. Doubles as first-run seeding, since an
  undefined `seedVersion` merges everything. `describeSeedMerge` gives a
  one-line summary if a post-update notice is wanted.

Note this is what makes the app survivable offline: without it, an
ingredient the bundled ontology lacks blocks the whole chain — no
canonical means no Product means no Lot — until a redeploy.

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