/**
 * Kitchen OS — What ships inside the app bundle
 *
 * Both files are compiled into the JavaScript at build time, not fetched at
 * runtime (CLAUDE.md: no runtime fetch to an external service, ever).
 *
 * The two bundles are then treated DIFFERENTLY on purpose:
 *
 *   ontology.json  — copied into IndexedDB on first run, and from then on
 *                    IndexedDB is the source of truth. See `src/db/seed.ts`.
 *   recipes.json   — never copied anywhere. Read from here every time. See
 *                    `src/engine/recipe-source.ts`.
 *
 * The difference is that the User edits ingredients (adds their own, and a
 * Product points at one) but only ever ADDS recipes. Nothing has to be merged
 * into a recipe the User already owns, so nothing has to be stored.
 */
import type { CanonicalIngredient, Recipe } from '../types/schema'
import ontologyJson from './ontology.json'
import recipesJson from './recipes.json'

/**
 * Stamp identifying the bundled seed data.
 *
 * BUMP THIS BY HAND whenever `ontology.json` changes. `needsSeedMerge` compares
 * it against the value stored in `AppMeta.seedVersion`; if it does not change,
 * a redeployed ontology is never folded in and the new entries silently never
 * appear. Comparison is by inequality, not ordering, so any different string
 * works — the date and entry count are just there to be readable.
 */
export const BUNDLED_SEED_VERSION = '2026-08-19-ontology-310'

/**
 * The bundled canonical ingredient table.
 *
 * The cast is deliberate. A JSON import infers `category: string` rather than
 * the `IngredientCategory` union, so the compiler cannot check this on its own.
 * The shape is instead enforced by `qa/seed-data.validate.test.ts`, which
 * validates every field of every entry on every `npm test` — a stricter check
 * than the type system would give, and one that runs against the real file.
 */
export const BUNDLED_ONTOLOGY: readonly CanonicalIngredient[] =
  ontologyJson as unknown as readonly CanonicalIngredient[]

/**
 * The bundled seed recipe set — 150 recipes, ~460 KB of JSON.
 *
 * There is deliberately NO `BUNDLED_RECIPE_VERSION` to go with
 * `BUNDLED_SEED_VERSION` above. A version stamp exists so a merge knows whether
 * to run; nothing merges these, so there is nothing to stamp. Editing
 * `recipes.json` and redeploying is the whole update mechanism.
 *
 * Same cast, same reason as the ontology: a JSON import infers `unit: string`
 * rather than the `Unit` union, and `qa/seed-data.validate.test.ts` validates
 * the real file on every `npm test`.
 */
export const BUNDLED_RECIPES: readonly Recipe[] = recipesJson as unknown as readonly Recipe[]
