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
import type { Lot, LotId, ProductId, Timestamp } from '../../types/schema'
import { setLotRemaining } from '../../engine'
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

/**
 * Correct what is left in a lot to an observed amount. Backs Reconcile.
 *
 * Read and write are one transaction so two corrections in quick succession
 * cannot both act on the same stale copy and lose one of them.
 *
 * An unknown lot id throws rather than doing nothing, matching `inventory.ts`:
 * the id came from something the app rendered, so its absence is a bug, and a
 * silent no-op would look to the User exactly like a change that did not stick.
 */
export async function adjustLotRemaining(
  db: KitchenOsDb,
  lotId: LotId,
  grams: number,
  now: Timestamp,
): Promise<Lot> {
  return db.transaction('rw', db.lots, async () => {
    const lot = await db.lots.get(lotId)
    if (!lot) throw new Error(`adjustLotRemaining: unknown lot "${lotId}".`)
    const next = setLotRemaining(lot, grams, now)
    await db.lots.put(next)
    return next
  })
}

/**
 * Write a lot back exactly as given. Used by Undo.
 *
 * Undo restores the whole previous record rather than recomputing it, because
 * `depleted` and `depletedAt` are not derivable from the amount alone — a lot
 * emptied last week and one emptied by the tap you are undoing look identical
 * apart from that timestamp.
 */
export async function saveLot(db: KitchenOsDb, lot: Lot): Promise<void> {
  await db.lots.put(lot)
}

/**
 * Remove a lot outright. Backs "I threw it out".
 *
 * **This is a deliberate narrowing of "depleted lots are retained"**
 * (DECISIONS.md), decided by Jack on 2026-08-20. That rule protects consumption
 * HISTORY: a lot you ate your way through is the evidence for what you ate, and
 * deleting it would destroy something unrecoverable. A packet that went in the
 * bin past its date is the opposite case — nothing was eaten, there is no
 * history in it, and leaving it in the emptied-packets list forever means the
 * list stops being worth opening.
 *
 * Marking it empty was already possible and is NOT the same thing: empty means
 * "I finished it", which is a claim about food that went into a person.
 *
 * What survives deletion: any `ConsumptionEvent` that debited this lot keeps its
 * macro snapshot untouched, because those figures are stored on the event and
 * never recomputed (DECISIONS.md, "history is immutable"). Past days' totals do
 * not move. What is lost is the event's inventory link, so deleting such an
 * event afterwards puts nothing back — `deleteConsumption` handles a missing lot
 * silently for exactly this reason.
 *
 * Unknown ids are a no-op rather than an error, unlike `adjustLotRemaining`.
 * Deleting twice is a plausible thing for a person to do with a stale screen
 * open, and both taps mean the same thing: this packet should not exist.
 */
export async function deleteLot(db: KitchenOsDb, lotId: LotId): Promise<void> {
  await db.lots.delete(lotId)
}
