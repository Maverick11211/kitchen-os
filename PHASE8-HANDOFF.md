# Phase 8 handoff — Polish and deploy

Written 2026-08-22, at the end of the Phase 7 work.

Read `CLAUDE.md` first, then the DECISIONS.md sections named below. This
document does not repeat the architecture rules; it tells you where Phases 6
and 7 got to, what will bite you, and what is genuinely undecided.

---

## 1. Phases 6 and 7 are both complete

The recipe library, the cook flow, and everything between them are built and on
Jack's machine. Suite **6818** passing, lint and build clean, seventeen browser
steps green in `qa/smoke-phase7.cjs`, with `qa/smoke-phase6.cjs` and
`qa/smoke-phase5.cjs` still passing.

**Schema is now version 5.** Any further change to `src/types/schema.ts` needs
BOTH a `db.version(n).upgrade()` block in `src/db/db.ts` AND a step in
`upgradeBackup` in `src/engine/backup.ts` — plus a line in `upgradeNotes`, or
the restore warning will describe the wrong version. `src/db/migration.test.ts`
is the pattern; its frozen v1, v2, v3 and v4 store layouts are historical
records and must NOT be updated when `db.ts` changes.

Three things Phase 7 changed that Phase 8 inherits:

**Cook events exist now, and three places that used to refuse them no longer
do.** `deleteConsumption` moves the portion back onto the batch;
`restoreConsumption` does the reverse; `logCookPortion` maintains
`fractionConsumed`. The `leftover` arm of `ConsumptionSource` still refuses
everywhere, loudly, because nothing writes one and the only way to meet one is a
mistake. Keep that property.

**`planRecipeDeduction` now shares a reservation across the lines of one plan.**
It did not, and a recipe naming one ingredient twice spent the same grams twice
(six seed recipes). The lines are still separate — each its own handful, its own
row, its own shortfall — but they see what the earlier ones claimed. Do not
"simplify" that back out.

**`Shortfall` carries `optional`, and `complete` ignores optional shortfalls.**
A garnish you own none of is not a problem; treating it as one made the cook
sheet contradict the recipe card on 102 of the seed set's lines.

---

## 2. The thing to know before anything else

**The bundle split is not a build change. It changes when data arrives.**

The Phase 8 answer to Vite's 500 KB warning is a dynamic import, which needs
`recipes.json` split out of `src/data/bundled.ts` into its own module. That file
is imported SYNCHRONOUSLY today, and three things assume the recipes are simply
there the moment the app renders:

- `useRecipes()` in `src/ui/useKitchenData.ts` joins `BUNDLED_RECIPES` with the
  user's own inside a live query.
- `App.tsx` computes `kitQuestions(recipes)` and the rail's ready-count from it.
- `RecipeDetail` resolves a cook's recipe through the same list.

Make that import dynamic and all three go from "always there" to "undefined for
a moment". Two of them already handle `undefined` because the live query starts
that way; the kit pass is the one to watch, because `askAboutKit` is what
decides whether a modal covers the whole app on launch, and a list that arrives
late could make it flash.

**Measure before you split.** 825 KB raw is 205 KB gzipped, which is one
mid-sized photograph, over the local network, once, and then cached. Vite warns
at 500 KB raw for everyone regardless of context. If the iPad opens the app
quickly, the honest answer may be to raise `chunkSizeWarningLimit` and write
down why — that is a smaller change than restructuring the data layer, and
CLAUDE.md's ±15% rule is the same instinct applied to a different number.

**A service worker interacts with the one thing that must not break.** Browser
storage is the only copy of Jack's data and export is load-bearing
(CLAUDE.md). A service worker does not touch IndexedDB, but it does decide which
version of the code runs against it — and code from two different versions
opening the same database is exactly the situation Dexie migrations are least
forgiving about. Whatever the update strategy is, it should not be able to leave
an old tab running v5 code while a new one upgrades to v6.

---

## 3. What Phase 8 is

From ROADMAP.md: PWA install, offline verification, real iPad testing.

Concretely: a manifest and icons so it installs to the home screen, enough
offline capability that opening it without a network works, and the first real
session on the actual device it was built for.

Not in Phase 8: the shopping list, leftovers as a usable entity, macro goals,
trend statistics. Those are v2 or later.

Phase 9 is the two-week live trial. Phase 8's job is to get the app onto the
iPad in a state where that trial is about the app rather than about the
plumbing.

---

## 4. Decisions already locked that Phase 8 must respect

**No backend, ever.** A service worker is not a backend, but it must not fetch
anything external. Everything it caches is served from the same origin.

**Hash routing, so GitHub Pages needs no configuration.** `#/inventory` works on
reload with no redirect trick. A service worker's scope and the manifest's
`start_url` both have to agree with that, and with the repository subpath
GitHub Pages serves from.

**Browser storage is the only copy.** Installing as a PWA does not change that,
and it arguably makes it worse: an app on the home screen looks permanent in a
way a tab does not, and iOS will evict a PWA's storage. The backup reminder
already exists and DECISIONS.md calls it "not optional".

**iPad Safari, landscape-first.** 16px minimum on inputs or Safari auto-zooms,
`dvh` not `vh`, 44pt touch targets, no hover-dependent interactions. Phase 8 is
the first time any of this gets tested on the real thing rather than in a
1180×820 Chromium window.

---

## 5. Things that are genuinely undecided — ask, don't assume

**Does v1 get a service worker at all, or only a manifest?** "Offline
verification" could mean either. A manifest plus icons gets the app onto the
home screen and is nearly risk-free. A service worker is what makes it open with
no network — and is also the thing that can serve stale code. These are
different amounts of work and different amounts of risk.

**How does new code reach the iPad once a service worker is caching?** Silently
on next launch, or with a visible "there is a new version, reload"? Silent is
less friction and more surprising; visible is one more thing on screen. This
interacts with schema migrations, per §2.

**Should the backup reminder get louder once installed?** iOS can evict an
installed PWA's storage without warning. The reminder currently fires on a
schedule; an installed app might deserve a stronger first-run message about
exporting. Or that might be nagging.

**Is 205 KB gzipped actually a problem?** See §2. Decide with a measurement from
the iPad, not from Vite's warning.

**The kit pass still opens as a modal over the whole app** on a database that
has never been asked. The Phase 6 handoff flagged switching it to a banner
beside the backup reminder "if it grates". Nobody has decided, and Phase 8 is
when Jack first uses the app on the device, which is when it will either grate
or not.

**`todayIso()` is read once when the shell renders.** An app left open across
midnight goes on calling yesterday "Today" until something re-renders the shell.
It has never mattered, because a browser tab gets reloaded. An installed PWA
that is never closed is exactly the case where it starts to matter, and Phase 8
is the phase that creates that case.

---

## 6. Use what is there; do not reimplement it

Everything below is built, tested, and exported from `src/engine/index.ts`. The
cook flow leans on all of it and so should anything new.

| Need | Use |
|---|---|
| what cooking this would debit | `planRecipeDeduction(index, ontology, recipe, scale)` |
| apply a plan to lots | `applyDeductions(lots, deductions, now)` |
| reverse one | `revertDeductions(lots, deductions)` |
| macros of the batch cooked | `batchMacrosForDeductions(index, deductions)` |
| macros of a portion | `fractionOfMacros(batchMacros, fraction)` |
| what is left of a batch | `remainingFraction(cook)`, `isBatchOpen(cook)` |
| can this be cooked, and how big | `evaluateOwnership(...)` → `maxBatchScale` |

Two conventions that have held since Phase 3: nothing in the engine reads the
clock (`now`/`today` are parameters, `src/lib/clock.ts` is the only place
ambient time is read), and `units.ts` returns typed failures while
`inventory.ts` throws. Do not "fix" either.

Pure view logic goes in a plain `.ts` module beside the components
(`cook-view.ts`, `recipe-view.ts`, `nutrition-view.ts`, `inventory-view.ts`) and
is unit tested without a browser.

---

## 7. Working practices that have paid off

- **Validate from a copy of the working tree in a cloud sandbox, not through the
  device bridge** — the rolldown native binding is broken there.
  `npm test && npm run lint && npm run build`.
- **Smoke-test in a real browser before saying it works.** `npm run dev -- --port
  5174`, then `node qa/smoke-phase7.cjs`. Across Phases 4-7 the browser runs have
  caught things a green suite did not — most recently two buttons both reading
  "Made it", and a staple tagged in alarming red. Phase 8 adds a third venue:
  the actual iPad, which will catch things Chromium does not.
- **Go looking for bugs rather than waiting to meet them.** The 2026-08-22 hunt
  through the Phase 7 seams found three real defects in about an hour, one of
  them latent since Phase 3. Reading the code adversarially, with a throwaway
  probe test to confirm each suspicion before touching anything, worked better
  than any amount of extra test-writing would have.
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
- **When a locked decision does not survive contact with the code, flag it
  rather than working around it silently.** Two such flags in Phase 6 and two in
  Phase 7 were worth more than the code written around them.

---

## 8. Files to read first, in order

1. `CLAUDE.md` — architecture rules, conventions, target environment
2. `DECISIONS.md` — the Platform table at the top, then the two 2026-08-22
   entries at the bottom (Phase 7, and the bug hunt after it)
3. `vite.config.ts` and `index.html` — currently as bare as they come; the
   manifest and any base-path config go here
4. `src/data/bundled.ts` — the module the bundle split has to break apart, and
   §2's whole problem
5. `src/ui/useKitchenData.ts` — every live query, and the three places that
   assume the recipes are already there
6. `src/App.tsx` — the shell, the rail, `todayIso()`, and the kit-pass modal
7. `qa/smoke-phase7.cjs` — the browser-run pattern to extend

---

## 9. Still outstanding from earlier phases

Not Phase 8's job, but worth knowing they are open:

- **`interchangeableWith` is populated on none of the 310 ontology entries.**
  Deliberately deferred until Phase 9's live trial produces the list of
  substitutions Jack actually accepts. Every ownership question routes through
  `availableGramsForLine`, so it stays a change to one function.
- **The shopping list** — missing ingredients across recipes he wants to cook.
  Jack wants it; agreed it comes later.
- **The batch list in the log sheet is not searchable and is uncapped.** It only
  shows unprompted, so a long list is hidden the moment you type. Fine while
  there are a handful of open batches; revisit if the trial says otherwise.
- **Batches have no expiry.** A batch older than four days is marked
  ("12 days ago — still good?") but never removed, because the app cannot know
  what went in the freezer. Real leftovers with real dates are a v2 feature.
