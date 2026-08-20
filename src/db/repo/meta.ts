/**
 * Kitchen OS — App metadata
 *
 * One row. Holds the schema version, the seed version the ontology was last
 * merged at, and when the User last exported a backup (which drives the reminder
 * banner — DECISIONS.md treats export as a v1 requirement, not a nicety).
 */
import type { AppMeta, Timestamp } from '../../types/schema'
import { SCHEMA_VERSION } from '../../types/schema'
import { META_KEY, type KitchenOsDb } from '../db'

/** What a database that has never been written looks like. */
export function defaultMeta(): AppMeta {
  return { schemaVersion: SCHEMA_VERSION }
}

/**
 * Read the metadata row, or the defaults if it does not exist yet.
 *
 * Never returns undefined. A missing row means a fresh install, and every
 * caller would otherwise have to invent the same fallback.
 */
export async function readMeta(db: KitchenOsDb): Promise<AppMeta> {
  return (await db.meta.get(META_KEY)) ?? defaultMeta()
}

/**
 * Merge `patch` into the metadata row and return the result.
 *
 * Read-modify-write, so a caller updating `lastExportAt` cannot accidentally
 * blank out `seedVersion`. Safe to call inside a wider transaction — and the
 * seed merge does exactly that on purpose.
 */
export async function writeMeta(db: KitchenOsDb, patch: Partial<AppMeta>): Promise<AppMeta> {
  const current = await readMeta(db)
  const next: AppMeta = { ...current, ...patch }
  await db.meta.put(next, META_KEY)
  return next
}

/** Record that a backup was successfully written. Drives the reminder banner. */
export async function markExported(db: KitchenOsDb, now: Timestamp): Promise<AppMeta> {
  return writeMeta(db, { lastExportAt: now })
}
