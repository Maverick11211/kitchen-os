/**
 * Kitchen OS — Lots
 *
 * Tier 3: one physical package, with its own expiry and its own remaining
 * quantity. Quantities are stored in GRAMS and nothing else (CLAUDE.md) — the
 * add-lot form converts whatever unit was typed through `toGrams` in the engine
 * before it ever reaches this file.
 *
 * Depleted lots are kept, never deleted (DECISIONS.md): they are what makes
 * consumption history and usage rates recoverable later.
 */
import type { Lot, LotId, ProductId } from '../../types/schema'
import type { KitchenOsDb } from '../db'
import { newId } from '../ids'

/**
 * What the add-lot form collects.
 *
 * `remainingG` and `depleted` are derived, not entered: a lot starts full.
 */
export type NewLot = Omit<Lot, 'id' | 'remainingG' | 'depleted' | 'depletedAt'>

export async function listLots(db: KitchenOsDb): Promise<Lot[]> {
  return db.lots.toArray()
}

export async function getLot(db: KitchenOsDb, id: LotId): Promise<Lot | undefined> {
  return db.lots.get(id)
}

export async function lotsForProduct(db: KitchenOsDb, productId: ProductId): Promise<Lot[]> {
  return db.lots.where('productId').equals(productId).toArray()
}

/**
 * Store a new lot.
 *
 * Throws on a nonsensical quantity rather than storing it. This follows
 * `inventory.ts`: by the time a value reaches here the form has already
 * converted and checked it, so a negative gram count is a bug in the app, and
 * silently writing a broken row would hide it until it corrupted a deduction.
 */
export async function addLot(db: KitchenOsDb, input: NewLot): Promise<Lot> {
  if (!Number.isFinite(input.initialG) || input.initialG <= 0) {
    throw new RangeError(`addLot: initialG must be a positive number, got ${input.initialG}.`)
  }

  const lot: Lot = {
    ...input,
    id: newId('lot'),
    remainingG: input.initialG,
    depleted: false,
  }
  await db.lots.add(lot)
  return lot
}
