# Phase 5 handoff — Nutrition UI

Written 2026-08-20, at the end of the Phase 4 work.

Read `CLAUDE.md` first. Then the sections of `DECISIONS.md` named below. This
document does not repeat the architecture rules; it tells you where Phase 4 got
to, what is genuinely undecided, and what will bite you.

---

## 1. Phase 4 is complete

Chunk 5 — quantity adjustment, the Reconcile screen and the backup reminder —
was outstanding when this document was first written and has since been built.
Nothing from Phase 4 is owed.

Reconcile matters to Phase 5 specifically. Three decisions accept a known
inaccuracy on the grounds that correcting it is cheap: quantity drift under
Known risks, the sealed/best-by shelf-life convention of 2026-08-14, and
`applyDeductions` clamping at zero. A nutrition tracker deducts from lots far
more often than an inventory screen does, so drift accumulates faster from here
on. When Phase 5 decides whether direct logging deducts stock, that is the
context to decide it in.

## 2. Where Phase 4 got to

Done, tested, and pushed:

- **`src/db/`** — Dexie tables and a repository layer that is the only thing
  allowed to write. `src/db/seed.ts` runs the startup ontology merge.
- **`src/engine/backup.ts` + `src/db/repo/backup.ts`** — export and import.
- **`src/App.tsx` + `src/ui/`** — hash-routed two-pane landscape shell, category
  list with live counts, inventory list with expiry bands, backup screen.
- **`src/ui/AddFlow.tsx`** — add product, add lot, and the inline
  "can't find it? add it" ingredient form.
- **`src/ui/ItemSheet.tsx`** — Reconcile: tap an inventory row to correct how
  full each packet is, one tap, with Undo.

Suite is **6432 passing**, lint and build clean.

### Schema version is now 2

`MacroSet.cholesterolMg` was added on 2026-08-20 and forced the first real
migration. **Any further change to `src/types/schema.ts` needs BOTH:**

1. a `db.version(n).upgrade()` block in `src/db/db.ts` for stored rows, and
2. a step in `upgradeBackup` in `src/engine/backup.ts` for backup files.

`src/db/migration.test.ts` is the pattern to copy. Note that the version 1 store
layout inside it is frozen on purpose — it is a record of what was on disk, and
updating it when `db.ts` changes would make the test agree with whatever the
code does today, which is the opposite of the point.

---

## 3. What Phase 5 is

From ROADMAP.md: *"Daily totals (calories, carbs, fat, protein), browse past
days, direct ingredient logging."*

Concretely:

1. **A daily view.** Today's four headline macros, and the ability to page back
   through previous days. `DECISIONS.md` is explicit: **no goals, no targets, no
   comparison statistics in v1.**
2. **Direct ingredient logging.** Log grams of any ingredient without a recipe.
   This is a v1 requirement, not a nicety — "a tracker that only counts cooked
   meals will not replace a calorie app, and retrofitting it later is
   expensive."
3. **A repository for consumption events.** `src/db/repo/` has no
   `consumption.ts` yet. The `consumptionEvents` table exists and is indexed on
   `id, consumedAt`.

Cooking is **not** Phase 5. `CookEvent` and the cook flow are Phase 7. Phase 5
only needs the `{ type: 'ingredient' }` arm of `ConsumptionSource` to work; the
`cook` and `leftover` arms can be displayed if present but nothing creates them
yet.

---

## 4. Decisions already locked that Phase 5 must respect

Read these in `DECISIONS.md` (the Nutrition and Data model sections near the
top) before designing anything.

- **History is immutable.** `ConsumptionEvent.macros` is a SNAPSHOT taken at log
  time. Never recompute a past day's totals from products. Correcting a
  product's nutrition next month must leave last month exactly as it was. This
  is the single most important rule in the phase, and the schema is built around
  it — the daily view sums stored `macros`, it does not look anything up.
- **Stored vs displayed.** Nine figures are stored; the daily view shows
  calories, carbs, fat, protein. The rest are captured because they are on every
  label and cost nothing.
- **Accuracy tolerance is ±15%.** Do not build precision machinery.
- **Cooking and eating are separate events.**
- **No serving counts.** Consumption of a cooked batch is logged as a fraction.
- **Untracked staples contribute nothing.** Salt and water never get a product,
  so they never produce a macro line. This falls out of the model rather than
  needing a special case.

---

## 5. Use the engine; do not reimplement it

Everything below is built, tested, and exported from `src/engine/index.ts`.

| Need | Use |
|---|---|
| macros for N grams of something | `scaleMacros(per100g, grams)` |
| a day's total | `totalMacros(events)` — takes `{ macros }[]` directly |
| adding sets together | `addMacros`, `sumMacros` |
| totals across several ingredients | `macrosForLines([{ grams, macrosPer100g }])` |
| rounding **for display only** | `roundMacros` |
| a portion of a batch | `fractionOfMacros(batch, fraction)` |
| what is on hand | `availableGramsFor`, `availableLotsFor` |
| taking stock out | `planDeduction` then `applyDeductions` |
| putting it back | `revertDeductions` |
| grams ⟷ any unit | `toGrams`, `fromGrams`, `convertibleUnits` |

Two conventions that have held since Phase 3 and should keep holding:

- **Nothing in the engine reads the clock.** `now` / `today` are always
  parameters. `src/lib/clock.ts` is the only place the clock is read; pass the
  value down.
- **Two deliberate error styles.** `units.ts` never throws — it returns
  `{ ok: false, reason, message }` because unconvertible input is a normal thing
  to report to a person. `inventory.ts` throws `RangeError` on a negative gram
  request or an unknown lot id, because those are values the app computed and a
  silent no-op would hide a bug. Do not "fix" either.

There is also a UI-side convention worth continuing: pure view logic lives in
plain `.ts` modules next to the components (`src/ui/inventory-view.ts`,
`src/ui/entry-forms.ts`) and is unit tested without a browser. The components
themselves do no arithmetic at all.

---

## 6. Things that are genuinely undecided

Ask rather than assume. Each of these changes what gets built.

**Does logging an ingredient deduct it from inventory?** The schema allows
either — `ConsumptionSource` has an optional `lotId`, documented as "omit to
skip inventory deduction". So the question is what the UI does by default. Eating
100g of cheese should plausibly reduce the cheese, but not everything logged is
something the app is tracking. If it does deduct, FEFO says which lot, and
`planDeduction` already gives you the answer.

**Which product's macros, when the ingredient has several?** `canonicalId` is
what recipes speak, but macros live on `Product`. If two cheddars are on hand,
something has to choose — the FEFO lot's product is the obvious candidate, but it
is a decision, not an obvious default.

**What counts as "today"?** `todayIso()` is local-time on purpose. A meal logged
at 00:30 belongs to which day? Note the `consumedAt` index is an ISO UTC string,
so a local-day range query is not a plain string prefix match — this needs
thinking about once, properly, rather than being discovered later.

**Can a logged item be edited or deleted?** "History is immutable" is about not
silently rewriting past totals when a product changes. Fixing a typo you made
thirty seconds ago is a different thing. It probably should be allowed, but say
so out loud rather than inferring it from a rule written for another purpose.

**Where the daily view sits.** The shell has a left rail of inventory
categories. Nutrition is a second top-level area, not another category, and the
navigation currently has no concept of that.

---

## 7. Working practices that have paid off

- **Validate from a clone in the cloud sandbox**, not through the device bridge —
  the rolldown native binding is broken there. `npm test && npm run lint &&
  npm run build`.
- **Smoke-test the UI in a real browser before saying it works.** Doing this
  caught two things TypeScript could not: Enter-key navigation dead-ending in a
  `<select>`, and a filter that disagreed with the badges beside it.
- **Never run `git` through the device bridge.** `git status` creates
  `.git/index.lock`, the bridge cannot delete it, and Jack's next `git add`
  fails. Read `.git/refs/heads/main` with `cat` instead.
- **Never overwrite Jack's `package-lock.json`.** He runs `npm install` himself
  on macOS. Patch `package.json` in place and tell him to re-run it.
- **Jack pushes from Terminal himself.** Write files to his machine; never push.
- Describe the plan and wait for approval before large changes. Explain in plain
  language — he is not an experienced developer, and he has twice found real
  bugs by using the app, so his reports are worth taking literally.

---

## 8. Files to read first, in order

1. `CLAUDE.md` — architecture rules, conventions, target environment
2. `src/types/schema.ts` — `ConsumptionEvent`, `ConsumptionSource`, `MacroSet`,
   and the `SCHEMA_VERSION` note
3. `DECISIONS.md` — Data model and Nutrition sections at the top, then the two
   Phase 4 entries at the bottom (2026-08-19 and 2026-08-20)
4. `src/engine/macros.ts` — the whole phase leans on this module
5. `src/db/repo/` — the pattern any new repository should follow
6. `src/ui/inventory-view.ts` and `src/ui/entry-forms.ts` — how view logic is
   kept pure and testable
