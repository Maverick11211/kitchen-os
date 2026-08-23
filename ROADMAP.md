# Kitchen OS — Roadmap

## Current status
Phase 0 complete. Phase 1 complete. Phase 2 complete. Phase 3 complete.
Phase 4 complete. Phase 5 complete. Phase 6 complete. Phase 7 complete.
Phase 8 next.
Last updated: 2026-08-22

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

## Phase 4 — Inventory UI — DONE
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

5. **Reconcile and the backup reminder.** Tapping an inventory row opens its
   packets: Full / three-quarters / half / quarter / Empty against the original
   size, plus a typed amount, applied immediately with an Undo. Emptied packets
   are one toggle away so a mis-tap is recoverable. The backup banner appears
   after 7 days without an export, and when there has never been one.
6. Documentation pass — this file, DECISIONS.md, and `PHASE5-HANDOFF.md`.

Suite 6432 passing, lint and build clean.

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

## Phase 5 — Nutrition UI — DONE
Daily totals (calories, carbs, fat, protein), browse past days,
direct ingredient logging.

Briefed in `PHASE5-HANDOFF.md` (written 2026-08-20): current state, the locked
decisions this phase must respect, the engine functions to use rather than
reimplement, and the open questions to settle with Jack first. All seven of
those questions are now settled and recorded in DECISIONS.md (2026-08-20
"Phase 5: nutrition UI"). No schema change was needed.

**Built (chunks 1-3):**
1. **Plumbing.** `src/lib/clock.ts` gained local-day helpers — a day is local
   midnight to local midnight, and `consumedAt` is a UTC instant, so the day
   query is a range and not a string match. `src/db/repo/consumption.ts` logs an
   entry and debits the packet in ONE transaction, deletes with a revert, and
   restores the whole original record for Undo. `deleteLot` throws a packet out.
2. **View logic, no React.** `src/ui/nutrition-view.ts` (the four headline
   figures, the day's rows, paging bounded by the first entry and today) and
   `src/ui/log-forms.ts` (which packets you could be eating from, unit
   conversion through the engine, the typed-figures path).
3. **Screens.** `src/ui/NutritionScreen.tsx` and `src/ui/LogFlow.tsx`, "Today"
   in the rail, and Throw out on a packet in `ItemSheet.tsx`.

Suite 6506 passing, lint and build clean, and the flow was driven end to end in
a real browser (`qa/smoke-phase5.cjs`).

**Jack's follow-up list of 2026-08-20 is done** (2026-08-21), and
`PHASE5-FOLLOWUPS.md` is deleted with it — the decisions are in DECISIONS.md:

4. **Counts are product-aware.** `gramsPerCount` in the engine; logging one
   tortilla uses the bag in the kitchen, not the ontology's average. Counted
   ingredients read as counts on the shelf — "6 flour tortillas", not "413 g".
5. **Meal slots.** Breakfast / lunch / dinner / snack, optional, grouped with
   subtotals, never guessed from the clock. Unlabelled entries sit under
   "Other" and still count towards the day.
6. **Editing a product** from the ingredient sheet, which the add-only rule
   never covered — that rule is about canonical ingredients and seed-merge
   safety.
7. Rail renamed to **Food log** and reordered, with the add button beside the
   kitchen list.

Suite 6555 passing, lint and build clean, sixteen browser steps green.

Schema note: `SCHEMA_VERSION` is now **3** — `ConsumptionEvent.meal` and
`Product.unitsPerPackage`, both optional, in ONE bump with one migration and one
backup upgrade step. Nothing is backfilled; absent is the truth about both on
older rows.

## Phase 6 — Recipe UI — DONE
Card grid with ownership rings, Missing One tier, filters and sorts,
recipe detail, manual add form.

Decisions are in DECISIONS.md — "Phase 6: the recipe library" and the entry
after it, both 2026-08-21. The ones that shape everything else: seed recipes
are read from the bundle and never copied into IndexedDB; nothing seeds the kit
table, he is asked once and an absent row means unknown rather than unowned;
the ring shows ownership and nothing else; equipment sizes are checked only
when the recipe states one; the add form is designed after the browse side has
been used.

**Done (chunks 1-4):**
1. **Recipes reach the app.** `BUNDLED_RECIPES`, `combineRecipes` in the engine
   (a User recipe shadows a seed of the same id), `listUserRecipes`,
   `useRecipes`.
2. **The grid.** `src/ui/recipe-view.ts` plus `RecipeScreen.tsx` — rings, the
   Missing One tier lifted above the list, cuisine and expiring-soon filters,
   ownership/A-Z sort, and a rail badge counting what needs nothing bought.
3. **Recipe detail** at `#/recipes/:recipeId`. Every line shown, staples and
   garnishes included. No cooking: that is Phase 7.
4. **The kit question** on Settings (renamed from Backup), grown on 2026-08-21
   into a full kit list: appliances, cookware and tools, derived from what the
   library actually names, with the biggest size he owns on the kinds where
   size decides whether a recipe fits. `src/engine/equipment.ts` reads the
   free-text tools; a recipe is warned about, never hidden.

Suite 6705 passing, lint and build clean, twenty-three browser steps green in
`qa/smoke-phase6.cjs`. Schema is now **version 4** (`Appliance.size`,
`AppMeta.kitSetUpAt`).

Decisions for the entry form are in DECISIONS.md (2026-08-21, "Chunk 5").
Still deferred: `interchangeableWith`, which Phase 9's live trial is what will
actually produce the list for.

5. **Typing a recipe in.** `src/engine/recipe-entry.ts` plus `RecipeForm.tsx`.
   The sheet opens on a paste box: `parseIngredientLines` reads amounts, units,
   fractions, ranges and preparation notes out of a pasted list and matches each
   line to the ontology, leaving what it cannot match for him to fix rather than
   guessing. His recipes are editable and deletable; editing keeps the id. The
   "can't find it? add it" path is `IngredientStep` from `AddFlow.tsx` itself.
   A "Only what I can make now" filter joined the grid at the same time.

**Fixed since:** `evaluateOwnership` used to judge each recipe line
independently, so a recipe listing the same ingredient twice (six of the 150
seed recipes do) read as owned with half of it there. Requirements are now
pooled per ingredient, and the counts are per distinct ingredient rather than
per line.

## Phase 7 — Cook flow — DONE
"Made it" on the recipe detail -> batch size -> deduction preview ->
commit -> "how much did you eat" -> consumption logged. Built as briefed in
`PHASE7-HANDOFF.md`; the eight open questions it listed were settled with Jack
on 2026-08-22 and are recorded in DECISIONS.md.

**How a batch cooked on Sunday is eaten on Tuesday:** batches with anything left
sit at the top of the log sheet, above the kitchen. Tap one, say what fraction
of it you ate. The `Leftover` table is still untouched — leftovers stay a v2
feature and `CookEvent.fractionConsumed` does this job.

Schema is now version 5: `CookEvent.label` and `deductions` on the ingredient
arm of `ConsumptionSource`. The three places that refused a cook-sourced event
are closed; the `leftover` arm still refuses, loudly, because nothing writes one.

Output: `src/engine/cooking.ts`, `src/db/repo/cooks.ts`, `src/ui/cook-view.ts`,
`src/ui/CookFlow.tsx`, `src/ui/BatchPortion.tsx`, plus `qa/smoke-phase7.cjs`.
Suite 6818 passing, lint and build clean, seventeen browser steps green.
A bug hunt through the new seams the same day found three real defects — see
DECISIONS.md, "2026-08-22, later" — all fixed and pinned by tests.

## Phase 8 — Polish and deploy — DONE
Installs to the home screen, opens with no network, and has a way to reach the
iPad at all. Decisions are in DECISIONS.md, 2026-08-23.

**The thing that had to be fixed first:** there was no `base` in
`vite.config.ts`, so the build emitted absolute `/assets/…` paths that would
have 404'd on a GitHub Pages project page. Nothing had caught it because nothing
had ever been deployed. `base` is now `/kitchen-os/`, set for the dev server too
so a path or scope mistake shows up locally rather than on the iPad.

**Installing:** `public/manifest.webmanifest` with every path relative, so the
repository subpath is written down in exactly one place. Icons rendered from
`public/icon.svg` and committed — the build needs no image toolchain. iOS gets
its own full-bleed `apple-touch-icon.png`, because Safari renders transparency
as black.

**Offline:** a hand-written service worker generated by `vite.config.ts` with
the hashed precache list baked in. No new dependency, and no Workbox. It never
fetches off-origin.

**Updates wait for a tap.** The worker never calls `skipWaiting()` itself;
`useAppUpdate` shows a banner and only a tap activates it. Browser storage is
the only copy of the kitchen, and two versions of the code open against one
Dexie database across a schema upgrade is what migrations handle worst.

**Not split:** 826 KB raw is 205 KB gzipped, measured. `chunkSizeWarningLimit`
raised to 900 with the reasoning written down. The split would have changed
*when* the recipes arrive, and three things assume they are already there.

**Also fixed:** `todayIso()` was read once when the shell rendered, so an
installed app left open across midnight would call yesterday "Today" forever.
`useToday` re-reads at local midnight and whenever the app returns to the
foreground — the second trigger is the one that matters on iPadOS, where a
backgrounded app is suspended and its timers do not fire.

Output: `.github/workflows/deploy.yml`, `public/manifest.webmanifest` and icons,
the service-worker plugin in `vite.config.ts`, `src/ui/useAppUpdate.ts`,
`src/ui/useToday.ts`, `src/ui/standalone.ts`, `msUntilNextLocalDay` in
`src/lib/clock.ts`, plus `qa/smoke-phase8.cjs`. Suite 6828 passing, lint and
build clean, all four browser suites green.

**Still needs Jack, on the actual iPad:** installing it to the home screen for
the first time, and deciding whether the kit pass should stay a modal or become
a banner. That one needs the device in hand.

## Phase 9 — Two-week live trial
Use it. Fix what annoys you. That is v1.

## Deferred to v2
Barcode scanning, label OCR, leftovers as usable entity,
macro goals and targets, trend statistics, recipe import by URL.