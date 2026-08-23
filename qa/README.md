# qa/

Dev-only validation tooling for the Phase 2 seed data (`src/data/ontology.json`
and `src/data/recipes.json`). Nothing in this folder is imported by the app —
it exists purely so `npm test` can catch data problems before they ship.

The dependency runs one way: this folder imports from `src/`, never the reverse.
Since Phase 3 the conversion check calls the real engine (`src/engine/units.ts`)
rather than keeping its own copy of the math.

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

     This calls `toGrams` from `src/engine/units.ts`, so it runs the same rules
     the app runs. It also works in the other direction: the 1562 seed
     ingredient lines are a regression test on the engine, and any change to
     `units.ts` that disagrees with the values the Phase 2 build scripts
     computed fails here. A line the engine cannot convert is now a FAILURE
     rather than a silent skip — before Phase 3 the private copy of this math
     couldn't handle cup/tbsp/tsp on a liquid (no liquid carries a
     `cupWeightG`) and quietly passed over 266 of the 1562 lines.
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

## The browser smoke tests

`smoke-phase5.cjs`, `smoke-phase6.cjs` and `smoke-phase7.cjs` are not part of
`npm test`. They drive a running dev server with Playwright, because across
four phases the browser runs have caught things a green suite did not — two
buttons both reading "Made it", a staple tagged in alarming red. Run them with
the dev server up:

```
npm run dev -- --port 5174
node qa/smoke-phase7.cjs
```

Since Phase 8 the dev server serves from `http://localhost:5174/kitchen-os/`,
because `base` is set for development as well as for builds. Each script's
`BASE` constant already includes the subpath; override it with the `BASE`
environment variable to point at somewhere else.

`smoke-phase8.cjs` is the odd one out and runs against the BUILD, not the dev
server:

```
npm run build
node qa/smoke-phase8.cjs
```

Everything it tests only exists in `dist/`: `sw.js` is generated at build time,
the manifest and icons are copied from `public/`, and a service worker will not
register over an unbundled dev server. It serves `dist/` itself rather than
using `npm run preview`, because it needs to pretend a SECOND version has been
deployed — its little static server can start returning a byte-different
`sw.js` on demand, which is what a deploy looks like from the browser's side and
the only honest way to watch the update banner appear, wait, and be tapped.

One trap worth knowing if you extend it: `page.waitForFunction` with an **async
predicate** does not do what it looks like. The callback returns a Promise, a
Promise is truthy, and the wait succeeds on its first poll regardless of the
state being waited for. Reading a service worker registration needs an async
callback, so `smoke-phase8.cjs` polls from Node with its own `untilStates`
helper instead.
