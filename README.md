# Kitchen OS

Personal kitchen inventory, recipe browser and macro tracker. One person, one
iPad. Not a product.

Everything lives in the browser. There is no backend, no account and no network
call to anywhere — the app is a static bundle and an IndexedDB database, and
that database is the only copy of the data.

**Live at** https://maverick11211.github.io/kitchen-os/

## Running it

```
npm install
npm run dev -- --port 5174   # http://localhost:5174/kitchen-os/
npm run build                # production build into dist/
npm run lint
npm test                     # always run before calling something done
```

The dev server serves from `/kitchen-os/`, not `/`. That is the subpath GitHub
Pages uses for a project page, and it is deliberately the same in development,
so a path or service-worker-scope mistake shows up locally rather than for the
first time on the iPad.

## Deploying

Push to `main`. `.github/workflows/deploy.yml` runs the tests, the linter and
the build, then publishes `dist/` to GitHub Pages.

One manual step, once per repository: Settings → Pages → Build and deployment →
Source → **GitHub Actions**.

## Installing it on the iPad

Open the live URL in Safari, then Share → Add to Home Screen. It runs full
screen, opens with no network, and tells you when a new version is ready rather
than swapping the code underneath you.

**Export regularly.** iPadOS can clear an installed web app's storage on its
own, and there is no other copy. Settings → Back up now.

## How it is laid out

| Where | What |
|---|---|
| `src/engine/` | All the real logic. Pure — no React, and no clock: `now` and `today` are always parameters. |
| `src/db/` | Dexie schema and the repository layer, the only thing that reads or writes storage. |
| `src/ui/` | Screens, each with a plain `.ts` module beside it holding its view logic so it can be tested without a browser. |
| `src/lib/clock.ts` | The one place ambient time is read. |
| `src/data/` | The bundled ontology (310 ingredients) and seed recipes (150), compiled into the bundle rather than fetched. |
| `qa/` | Seed-data validation that runs with `npm test`, and browser smoke tests that do not. See `qa/README.md`. |

## The documents that matter

- **`CLAUDE.md`** — architecture rules, code conventions, target environment.
  These are not suggestions; several exist because breaking one produced a
  wrong answer already.
- **`DECISIONS.md`** — every decision, dated, with its reasoning. Entries are
  superseded rather than edited.
- **`ROADMAP.md`** — what each phase built, and what is deliberately deferred.
