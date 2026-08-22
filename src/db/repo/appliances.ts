/**
 * Kitchen OS — Appliances
 *
 * One row per appliance the User has been ASKED about. A missing row means the
 * question has not been put to them yet, which is different from a row saying
 * `owned: false` — and the recipe card treats it differently: unknown is
 * silent, not-owned is a warning (Jack, 2026-08-21).
 *
 * That distinction is why nothing seeds this table with defaults. Guessing that
 * he owns an oven would be guessing on his behalf, and the seed recipes only
 * reference four appliances between them.
 */
import type { Appliance, ApplianceId } from '../../types/schema'
import type { KitchenOsDb } from '../db'

/** Every appliance the User has answered about, keyed by id for the card. */
export async function listAppliances(db: KitchenOsDb): Promise<Map<ApplianceId, Appliance>> {
  const rows = await db.appliances.toArray()
  return new Map(rows.map((row) => [row.id, row]))
}

/**
 * Record an answer. Writing the row IS the answer being given.
 *
 * `name` is stored rather than looked up at read time so a warning can name the
 * item without the caller needing the catalogue. It costs a short string a row.
 *
 * `size` is left ALONE when undefined rather than cleared. Tapping "Yes" after
 * typing a size must not wipe the size, and tapping "No" must not either — if
 * he corrects himself back to Yes, the number he already typed is still true.
 */
export async function setApplianceOwned(
  db: KitchenOsDb,
  id: ApplianceId,
  name: string,
  owned: boolean,
  size?: number,
): Promise<Appliance> {
  const existing = await db.appliances.get(id)
  const keptSize = size ?? existing?.size
  const row: Appliance = keptSize === undefined ? { id, name, owned } : { id, name, owned, size: keptSize }
  await db.appliances.put(row)
  return row
}
