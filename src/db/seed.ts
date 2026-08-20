/**
 * Kitchen OS — Startup seed merge
 *
 * Run once at launch. Folds the bundled `ontology.json` into whatever is already
 * stored, then records which bundle version was merged.
 *
 * This doubles as first-run seeding. An undefined `AppMeta.seedVersion` means
 * nothing has ever been merged, so the merge adds everything — there is
 * deliberately no separate "seed the database" path, because two code paths
 * doing nearly the same thing is how they drift apart.
 *
 * The merge rules themselves (User always wins a conflict, nothing is ever
 * deleted) live in `src/engine/seed-merge.ts` and are tested there. This file
 * only does what the engine cannot: read, write, and stamp the version.
 *
 * ## Why it is all one transaction
 *
 * Writing the ingredients and writing `seedVersion` must both happen or neither
 * must. If the version were stored and the ingredients were not, `needsSeedMerge`
 * would return false forever after and those ingredients would never appear —
 * silently, with no error and no way to notice short of counting rows. The
 * reverse order has the same problem in mirror image. A transaction is what makes
 * a crash halfway through recoverable: next launch simply tries again.
 */
import type { CanonicalIngredient } from '../types/schema'
import type { SeedMergeResult } from '../engine'
import { describeSeedMerge, mergeSeedOntology, needsSeedMerge } from '../engine'
import { BUNDLED_ONTOLOGY, BUNDLED_SEED_VERSION } from '../data/bundled'
import type { KitchenOsDb } from './db'
import { readMeta, writeMeta } from './repo/meta'

export interface SeedMergeOutcome {
  /** False when the stored seed version already matched and nothing was done. */
  readonly ran: boolean
  /** One line fit to show the User after an app update. */
  readonly summary: string
  /** Null when the merge did not run. */
  readonly result: SeedMergeResult | null
}

/**
 * Bring the stored ingredient list up to date with the bundled one.
 *
 * `bundled` and `bundledSeedVersion` are parameters with real defaults so tests
 * can drive this with a small fake ontology instead of all 310 entries.
 */
export async function runStartupSeedMerge(
  db: KitchenOsDb,
  bundled: readonly CanonicalIngredient[] = BUNDLED_ONTOLOGY,
  bundledSeedVersion: string = BUNDLED_SEED_VERSION,
): Promise<SeedMergeOutcome> {
  return db.transaction('rw', db.canonicalIngredients, db.meta, async () => {
    const meta = await readMeta(db)

    if (!needsSeedMerge(meta, bundledSeedVersion)) {
      return { ran: false, summary: 'Ingredient list already up to date.', result: null }
    }

    const local = await db.canonicalIngredients.toArray()
    const result = mergeSeedOntology(local, bundled)

    // The whole list is written, not just the changed rows. The merge returns
    // the original object wherever nothing changed, so this is cheap, and
    // rewriting everything means a database left half-written by an earlier
    // crash repairs itself rather than staying subtly wrong.
    await db.canonicalIngredients.bulkPut([...result.ingredients])

    // `schemaVersion` is deliberately NOT part of this patch. It records what
    // version the STORED data is at, so it belongs to whatever migration
    // actually converts that data — not to a routine ontology refresh.
    await writeMeta(db, { seedVersion: bundledSeedVersion })

    return { ran: true, summary: describeSeedMerge(result), result }
  })
}
