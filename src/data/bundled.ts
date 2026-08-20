/**
 * Kitchen OS — What ships inside the app bundle
 *
 * `ontology.json` is compiled into the JavaScript at build time, not fetched at
 * runtime (CLAUDE.md: no runtime fetch to an external service, ever). On first
 * run it is copied into IndexedDB, and from then on IndexedDB is the source of
 * truth — see `src/db/seed.ts`.
 */
import type { CanonicalIngredient } from '../types/schema'
import ontologyJson from './ontology.json'

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
