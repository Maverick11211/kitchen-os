/**
 * Kitchen OS — Reading and writing backups
 *
 * The database half of export/import. Deciding what a valid backup looks like is
 * `src/engine/backup.ts`; turning a file into a download or a file picker is the
 * UI. This file only moves rows.
 *
 * ## Restore replaces everything
 *
 * Import is not a merge. Merging two inventories that have both moved on is a
 * genuinely hard problem — the same lot half-used on both sides has no correct
 * answer — and this is a restore path, not a sync path. So a restore wipes and
 * rewrites, which is easy to reason about and easy to explain. The UI is
 * responsible for saying so plainly and for offering to export first.
 *
 * ## Both halves are one transaction
 *
 * The clear and the rewrite happen together. A failure part-way through leaves
 * the database exactly as it was, because the alternative — an emptied database
 * and a failed rewrite — destroys the User's only copy of their data.
 */
import type { BackupFile, Timestamp } from '../../types/schema'
import type { BackupContents } from '../../engine'
import { buildBackupFile } from '../../engine'
import type { KitchenOsDb } from '../db'
import { META_KEY } from '../db'
import { readMeta } from './meta'

/**
 * Read every table into a backup file.
 *
 * One read transaction, so the result is a consistent snapshot rather than a
 * set of tables read at slightly different moments.
 */
export async function readBackup(db: KitchenOsDb, exportedAt: Timestamp): Promise<BackupFile> {
  return db.transaction(
    'r',
    [
      db.canonicalIngredients,
      db.products,
      db.lots,
      db.recipes,
      db.appliances,
      db.cookEvents,
      db.consumptionEvents,
      db.leftovers,
      db.meta,
    ],
    async () => {
      const contents: BackupContents = {
        canonicalIngredients: await db.canonicalIngredients.toArray(),
        products: await db.products.toArray(),
        lots: await db.lots.toArray(),
        recipes: await db.recipes.toArray(),
        appliances: await db.appliances.toArray(),
        cookEvents: await db.cookEvents.toArray(),
        consumptionEvents: await db.consumptionEvents.toArray(),
        leftovers: await db.leftovers.toArray(),
        meta: await readMeta(db),
      }
      return buildBackupFile(contents, exportedAt)
    },
  )
}

/** A backup file as JSON text, ready to be handed to the browser as a download. */
export async function readBackupJson(db: KitchenOsDb, exportedAt: Timestamp): Promise<string> {
  return JSON.stringify(await readBackup(db, exportedAt), null, 2)
}

/** Suggested filename for an export. Sorts chronologically in the Files app. */
export function backupFilename(exportedAt: Timestamp): string {
  const stamp = exportedAt.replace(/[:.]/g, '-')
  return `kitchen-os-backup-${stamp}.json`
}

/**
 * Replace the entire database with the contents of a backup.
 *
 * `backup` must already have been through `validateBackupFile` — this function
 * assumes it is well-formed and will happily restore nonsense otherwise.
 */
export async function restoreBackup(db: KitchenOsDb, backup: BackupFile): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.canonicalIngredients,
      db.products,
      db.lots,
      db.recipes,
      db.appliances,
      db.cookEvents,
      db.consumptionEvents,
      db.leftovers,
      db.meta,
    ],
    async () => {
      await Promise.all([
        db.canonicalIngredients.clear(),
        db.products.clear(),
        db.lots.clear(),
        db.recipes.clear(),
        db.appliances.clear(),
        db.cookEvents.clear(),
        db.consumptionEvents.clear(),
        db.leftovers.clear(),
        db.meta.clear(),
      ])

      await Promise.all([
        db.canonicalIngredients.bulkAdd(backup.canonicalIngredients),
        db.products.bulkAdd(backup.products),
        db.lots.bulkAdd(backup.lots),
        db.recipes.bulkAdd(backup.recipes),
        db.appliances.bulkAdd(backup.appliances),
        db.cookEvents.bulkAdd(backup.cookEvents),
        db.consumptionEvents.bulkAdd(backup.consumptionEvents),
        db.leftovers.bulkAdd(backup.leftovers),
        // The seed version comes back with the file. If the running app bundles
        // a newer ontology, the next launch folds the difference in — which is
        // exactly right, and is why this is restored rather than left alone.
        db.meta.put(backup.meta, META_KEY),
      ])
    },
  )
}
