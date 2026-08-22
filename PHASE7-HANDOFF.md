> **Carried out on 2026-08-22.** Phase 7 is complete. Every open question in
> section 6 was settled with Jack before code was written, and the answers —
> with the reasoning — are in DECISIONS.md under
> "2026-08-22 — Phase 7: the cook flow. Schema version 5."
> This document is kept as the brief it was, not as a description of what
> exists: read DECISIONS.md and ROADMAP.md for that.

# Phase 7 handoff — Cook flow

Written 2026-08-21, at the end of the Phase 6 work.

Read `CLAUDE.md` first, then the DECISIONS.md sections named below. This
document does not repeat the architecture rules; it tells you where Phase 6 got
to, what will bite you, and what is genuinely undecided.

---

## 1. Phase 6 is complete

The recipe library, the recipe detail view, the kit list, and typing a recipe in
are all built and on Jack's machine. Suite **6705** passing, lint and build
clean, twenty-three browser steps green in `qa/smoke-phase6.cjs`, and
`qa/smoke-phase5.cjs` still passes.

Schema is now **version 4**. Any further change to `src/types/schema.ts` needs
BOTH a `db.version(n).upgrade()` block in `src/db/db.ts` AND a step in
`upgradeBackup` in `src/engine/backup.ts` — plus a line in `upgradeNotes`, or
the restore warning will describe the wrong version. `src/db/migration.test.ts`
is the pattern; its frozen v1, v2 and v3 store layouts are historical records
and must NOT be updated when `db.ts` changes.

Two things Phase 6 changed that Phase 7 inherits:

- **Ownership pools an ingredient across lines.** A recipe naming bell pepper
  twice needs the sum of both, and `IngredientOwnership` carries `requiredG`
  (that line) and `requiredTotalG` (the whole recipe). Six seed recipes are
  affected. `planRecipeDeduction` does NOT pool — it deducts per line, which is
  correct, because each line is a separate handful going into the pan.
- **Seed recipes are read from the bundle, not the database.** `db.recipes`
  holds only recipes Jack typed. A `CookEvent.recipeId` may therefore point at
  a bundled recipe that is not in any table. Resolve recipes through
  `useRecipes()` / `combineRecipes`, never `db.recipes` alone.

---

## 2. The thing to know before anything else

**Nothing has ever written a `CookEvent`, and three places already refuse to
deal with one.** Phase 7 is the phase that closes them. Find them before you
design anything, because two of the three will throw an error at Jack if you
write cook-sourced events without touching them:

1. **`deleteConsumption` throws** on any event whose `source.type` is not
   `'ingredient'` (`src/db/repo/consumption.ts`). The message says so out loud
   and points at Phase 7. The Food log's remove button calls this. Write a
   cook-sourced `ConsumptionEvent` without extending it, and removing an entry
   from Tuesday's log throws in his face.
2. **`restoreConsumption`** — Undo — has the same gap and is QUIETER about it,
   which makes it the more dangerous of the two. It only touches inventory for
   the `ingredient` arm; hand it a cook-sourced event and it puts the row back
   without adjusting anything else, no error. Whatever Phase 7 decides about
   un-eating a portion has to be added here deliberately, because nothing will
   complain if it is not.
3. **`CookEvent.fractionConsumed` is maintained by nobody.** It exists so the
   app knows how much of a batch is left. Every consumption event pointing at a
   cook has to move it, and un-eating has to move it back — and those are two
   writes that must both happen or neither, the same argument the startup seed
   merge and `logIngredient` are already built on.

Where these refuse rather than guess, keep the property: if Phase 7 cannot
answer something, it should be loud.

---

## 3. What Phase 7 is

From ROADMAP.md: *cooking mode → "Made it" → scale confirm → deduction preview →
commit → "how much did you eat" → consumption logged.*

Concretely: a way to say you cooked a recipe, at what size, see exactly which
packets are about to be debited before it happens, commit that in one
transaction, and log what you actually ate as a fraction of the batch.

**Not in Phase 7:** leftovers as a usable entity (v2 — the `Leftover` table
exists so it needs no migration later, and nothing should write to it now), the
shopping list (Jack wants it, later), macro goals, and trend statistics.

---

## 4. Decisions already locked that Phase 7 must respect

Read the Nutrition and Data model sections of DECISIONS.md before designing
anything.

**Cooking and eating are separate events.** `CookEvent` removes ingredients from
inventory. `ConsumptionEvent` adds to the day's totals. Cooking a batch and
eating a quarter of it are two actions, and a flow that collapses them is
changing a locked decision, not simplifying a screen.

**Consumption is a FRACTION of a batch, never a serving count.** Recipes have no
serving count by design — it is called the single largest source of macro
tracking error. "I ate about 40% of what I made" is what a person can actually
estimate.

**History is immutable.** `ConsumptionEvent.macros` and `CookEvent.batchMacros`
are snapshots taken at write time. Nothing recomputes them from products
afterwards. Correcting a product's label next month must not move last month's
totals. Fixing a mistake is withdraw-and-relog, never edit in place.

**Deduction is first-expiring-first-out, across lots.** `planRecipeDeduction`
already does this. Do not re-derive it.

**Optional ingredients ARE deducted; untracked staples are not.** A garnish you
used leaves your inventory. Salt and water never have a lot to debit, so
reporting "short 5 g of salt" would be noise.

**Deduction takes what is available and reports a shortfall.** It never refuses
and never goes negative. What the flow DOES about a shortfall is a Phase 7
question (see §6), but the engine's behaviour is settled.

**Warnings never block a save; errors do.** And nothing is ever guessed on
Jack's behalf — no meal inferred from the clock, no scale inferred from stock.

**Depleted lots are retained, never deleted.** `applyDeductions` marks and keeps.

---

## 5. Use the engine; do not reimplement it

All of this is built, tested, and exported from `src/engine/index.ts`.

| Need | Use |
| --- | --- |
| what cooking this would debit | `planRecipeDeduction(index, ontology, recipe, scale)` |
| one ingredient's worth of that | `planDeduction(index, canonicalId, grams)` |
| apply a plan to lots | `applyDeductions(lots, deductions, now)` |
| undo one | `revertDeductions(lots, deductions)` |
| macros of the batch actually cooked | `batchMacrosForDeductions(index, deductions)` |
| the per-lot macro lines behind it | `macroLinesForDeductions(index, deductions)` |
| macros of a portion | `fractionOfMacros(batchMacros, fraction)` |
| can this be cooked at all, and how big | `evaluateOwnership(...)` → `maxBatchScale` |

`RecipeDeductionPlan` already carries `lines`, `deductions`, `shortfalls` and
`complete`. The deduction preview needs no arithmetic of its own — CLAUDE.md
means that literally.

Two conventions that have held since Phase 3: nothing in the engine reads the
clock (`now`/`today` are parameters, `src/lib/clock.ts` is the only place
ambient time is read), and `units.ts` returns typed failures while
`inventory.ts` throws. Do not "fix" either.

Pure view logic goes in a plain `.ts` module beside the components
(`cook-view.ts`, following `recipe-view.ts`, `nutrition-view.ts` and
`inventory-view.ts`) and is unit tested without a browser.

---

## 6. Things that are genuinely undecided — ask, don't assume

**How do you eat a batch across four days?** This is the big one. A stew cooked
on Sunday is eaten on Monday and Tuesday. Leftovers are a v2 feature, so the
`Leftover` table is not the answer — but `CookEvent.fractionConsumed` exists
precisely so a past cook can still be eaten from. Something has to make
Sunday's cook findable on Tuesday, and that something is a screen nobody has
designed. Decide this before anything else in the phase; it shapes the whole
flow.

**Does "Made it" ask "how much did you eat?" straight away, or are they two
separate moments?** Cooking and eating being separate events does not settle
whether the two questions are asked back to back. Cooking and immediately eating
a third is the common case; cooking to fill the fridge is the other one.

**Can you cook a recipe you are short on?** Ownership says you cannot make it;
`planRecipeDeduction` will happily take what is there and report the rest as a
shortfall. Three plausible answers — block it, warn and let him proceed, or
offer to record what actually left inventory — and they are meaningfully
different. Note that DECISIONS.md's answer for the *log* flow was the third:
take what the packet has, record what was eaten, say the gap out loud.

**What does the scale control look like?** A free number, or the ½ / 1 / 2 / 3
steps that Reconcile uses? And does changing the scale re-check ownership at
that scale — `maxBatchScale` is already computed and would make "you can only
manage a half batch" answerable at the moment it matters.

**What does undoing a cook mean once part of it has been eaten?** `fractionConsumed`
> 0 means the batch is not just sitting there. Reverting the deductions puts raw
ingredients back that were partly turned into meals already on the day's totals.
An undo window like the log flow's (immediate, before anything is eaten) is much
easier to reason about than a general delete.

**Accuracy question worth naming.** `batchMacrosForDeductions` totals the
products actually debited, so anything the recipe called for that inventory
could not cover contributes ZERO calories to the batch. Cook a recipe while
short of the oil and the batch reads lighter than it was. Within the ±15%
tolerance most of the time, but it is a systematic under-count in exactly the
case that is already going wrong, so decide deliberately whether the batch
figure should be based on what was deducted or on what the recipe asked for.

**Fold in the clamped-deduction fix?** DECISIONS.md (2026-08-20) records that an
ingredient-sourced entry clamped by a nearly-empty packet stores the grams
EATEN, not the grams REMOVED, so deleting it can hand back slightly more than it
took. The recorded escape hatch is a `Deduction[]` on the ingredient arm — "which
Phase 7 wants anyway". If Phase 7 bumps the schema for any other reason, this
should ride along in the same bump.

**Where do cooks live in the UI?** A history screen of its own, a section on the
recipe detail ("you have cooked this 3 times"), or only reachable through the
food log. Nobody has decided, and it interacts with the first question above.

---

## 7. Working practices that have paid off

- **Validate from a clone in the cloud sandbox, not through the device bridge** —
  the rolldown native binding is broken there. `npm test && npm run lint && npm run build`.
- **Smoke-test in a real browser before saying it works.** `qa/smoke-phase6.cjs`
  is the pattern: `npm run dev -- --port 5174`, then `node qa/smoke-phase6.cjs`.
  Across Phases 4-6 the browser runs have caught things a green suite did not,
  including a modal that blocked the whole app on launch.
- **Never run git through the device bridge.** `git status` creates
  `.git/index.lock`, the bridge cannot delete it, and Jack's next `git add`
  fails. Read `.git/refs/heads/main` with `cat` instead.
- **Never overwrite Jack's `package-lock.json`.** Patch `package.json` and tell
  him to re-run `npm install`.
- **Jack pushes from Terminal himself.** Write files to his machine; never push.
- Tests type-check under `tsconfig.app.json`, which has no node types —
  `process.env` will not compile, use `vi.stubEnv`. ESLint has no underscore
  exemption for unused variables.
- **Describe the plan and wait for approval before large changes.** He is not an
  experienced developer, and he has now found several real bugs by using the
  app — take his reports literally.
- When a locked decision does not survive contact with the code, **flag it
  rather than working around it silently**. Two such flags in Phase 6 were worth
  more than the code written around them.

---

## 8. Files to read first, in order

1. `CLAUDE.md` — architecture rules, conventions, target environment
2. `DECISIONS.md` — the Nutrition section near the top, then the three
   2026-08-21 Phase 6 entries at the bottom, and the 2026-08-20 Phase 5 entry
   for how logging and Undo were settled
3. `src/engine/inventory.ts` — `planRecipeDeduction`, `applyDeductions`,
   `revertDeductions`, `batchMacrosForDeductions`. The whole phase leans on this
4. `src/db/repo/consumption.ts` — the transaction shape to copy, and the two
   functions that currently refuse cook-sourced events
5. `src/types/schema.ts` — `CookEvent`, `ConsumptionSource`, `Leftover`
6. `src/ui/LogFlow.tsx` and `src/ui/log-forms.ts` — the closest existing flow,
   including its Undo
7. `src/ui/RecipeDetail.tsx` — where a "Made it" button would most likely live
8. `qa/smoke-phase6.cjs` — the browser-run pattern to extend

---

## 9. Still outstanding from earlier phases

Not Phase 7's job, but worth knowing they are open:

- **`interchangeableWith`** is populated on none of the 310 ontology entries.
  Deliberately deferred until Phase 9's live trial produces the list of
  substitutions Jack actually accepts. Every ownership question routes through
  `availableGramsForLine`, so it stays a change to one function.
- **The shopping list** — missing ingredients across recipes he wants to cook.
  Jack wants it; agreed it comes later.
- **The kit pass opens over the app** until it is finished, so an existing
  database meets a modal on launch. Switch it to a banner beside the backup
  reminder if it grates.
- **Bundle is 808 KB raw, 201 KB gzipped** and Vite's 500 KB warning fires. The
  Phase 8 answer is a dynamic import, which needs `recipes.json` split out of
  `src/data/bundled.ts` into its own module.
