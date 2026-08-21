/**
 * Kitchen OS — Consumption events
 *
 * Everything eaten. This is what the daily totals sum over, and in Phase 5 the
 * only thing that writes here is direct ingredient logging — the `cook` and
 * `leftover` arms of `ConsumptionSource` belong to Phase 7.
 *
 * Two rules from DECISIONS.md shape this whole file:
 *
 * **History is immutable.** `ConsumptionEvent.macros` is a SNAPSHOT taken when
 * the entry is written. Nothing here recomputes a stored event from a product,
 * so correcting a product's nutrition next month cannot rewrite last month. The
 * macros arrive already worked out and are stored as given.
 *
 * **Cooking and eating are separate.** Logging an ingredient does two things at
 * once — it adds to the day and it takes food out of a packet — and those must
 * not be able to half-happen. Every write here is one transaction, the same
 * reasoning as the startup seed merge: half of this is worse than none of it.
 */
import type {
  CanonicalId,
  ConsumptionEvent,
  ConsumptionEventId,
  LotId,
  MacroSet,
  MealSlot,
  ProductId,
  Timestamp,
} from '../../types/schema'
import { applyDeductions, revertDeductions } from '../../engine'
import type { KitchenOsDb } from '../db'
import { newId } from '../ids'

/**
 * What the log form collects.
 *
 * `macros` is the total for the amount eaten, not per 100g — the form scales it
 * with `scaleMacros` before it reaches here, so this layer stores a figure it
 * never has to interpret.
 *
 * `lotId` is what decides whether inventory moves. Omitting it is the "don't
 * take it out of my stock" switch (Jack, 2026-08-20): food eaten out of the
 * house, or an ingredient the app holds nothing of.
 *
 * `meal` is optional and never guessed (Jack, 2026-08-21). Absent means the
 * question was not answered, which the daily view shows under its own heading
 * rather than filing under a made-up one.
 */
export interface LogIngredientInput {
  readonly canonicalId: CanonicalId
  readonly grams: number
  readonly label: string
  readonly macros: MacroSet
  readonly productId?: ProductId
  readonly lotId?: LotId
  readonly meal?: MealSlot
}

export interface LoggedIngredient {
  readonly event: ConsumptionEvent
  /** Grams actually taken out of the packet. Zero when nothing was deducted. */
  readonly deductedG: number
  /** Grams the packet could not cover. Zero when it covered the lot. */
  readonly shortfallG: number
}

/**
 * Record something eaten, and debit the packet it came out of.
 *
 * **One packet, not several.** FEFO can span two packets, but the schema's
 * ingredient arm holds a single optional `lotId` and cannot describe a two-lot
 * deduction. Jack's call (2026-08-20): take what the first-expiring packet has,
 * log the full amount of macros anyway — you ate what you ate — and report the
 * gap in `shortfallG` so the screen can say so out loud. The leftover
 * difference is quantity drift, which DECISIONS.md already accepts and which
 * Reconcile fixes in one tap.
 *
 * The packet is re-read INSIDE the transaction rather than trusted from the
 * screen, so two logs in quick succession cannot both act on the same stale
 * copy and lose one of them.
 *
 * `lotId` is only recorded on the event when grams actually came out. An event
 * pointing at a packet it took nothing from would put food back on delete that
 * it never removed.
 */
export async function logIngredient(
  db: KitchenOsDb,
  input: LogIngredientInput,
  now: Timestamp,
): Promise<LoggedIngredient> {
  if (!Number.isFinite(input.grams) || input.grams <= 0) {
    throw new RangeError(`logIngredient: grams must be a positive number, got ${input.grams}.`)
  }

  return db.transaction('rw', db.consumptionEvents, db.lots, async () => {
    let deductedG = 0

    if (input.lotId !== undefined) {
      const lot = await db.lots.get(input.lotId)
      if (!lot) throw new Error(`logIngredient: unknown lot "${input.lotId}".`)

      deductedG = Math.min(lot.remainingG, input.grams)
      if (deductedG > 0) {
        const [next] = applyDeductions(
          [lot],
          [{ lotId: lot.id, canonicalId: input.canonicalId, grams: deductedG }],
          now,
        )
        await db.lots.put(next)
      }
    }

    const event: ConsumptionEvent = {
      id: newId('cons'),
      consumedAt: now,
      source: {
        type: 'ingredient',
        canonicalId: input.canonicalId,
        grams: input.grams,
        ...(input.productId === undefined ? {} : { productId: input.productId }),
        ...(deductedG > 0 && input.lotId !== undefined ? { lotId: input.lotId } : {}),
      },
      macros: input.macros,
      label: input.label,
      ...(input.meal === undefined ? {} : { meal: input.meal }),
    }
    await db.consumptionEvents.add(event)

    return { event, deductedG, shortfallG: input.grams - deductedG }
  })
}

/**
 * Everything eaten in a span of real time, oldest first.
 *
 * Takes timestamps rather than a date because a day is a LOCAL-calendar
 * question and `consumedAt` is a UTC instant — `localDayRange` in
 * `src/lib/clock.ts` does that conversion, and this layer stays free of the
 * device's timezone.
 *
 * `startAt` is inclusive and `endAt` exclusive, so consecutive days neither
 * drop an event stamped exactly at midnight nor count it twice.
 */
export async function listConsumptionBetween(
  db: KitchenOsDb,
  startAt: Timestamp,
  endAt: Timestamp,
): Promise<ConsumptionEvent[]> {
  return db.consumptionEvents.where('consumedAt').between(startAt, endAt, true, false).toArray()
}

/** The oldest entry on record. Tells the daily view how far back there is to go. */
export async function firstConsumptionAt(db: KitchenOsDb): Promise<Timestamp | undefined> {
  const earliest = await db.consumptionEvents.orderBy('consumedAt').first()
  return earliest?.consumedAt
}

/**
 * Put a deleted entry back exactly as it was, and take its grams out again.
 *
 * This is Undo, and it restores the WHOLE record — the original id, timestamp
 * and macro snapshot — rather than logging a fresh one. A re-log would land on
 * today at today's figures, which is wrong twice over when what was deleted was
 * a meal from last Tuesday.
 *
 * `put` rather than `add`, so a second Undo from a stale screen is harmless.
 * The packet is re-read and the deduction re-clamped, because the world may
 * have moved on between the delete and the change of mind.
 */
export async function restoreConsumption(db: KitchenOsDb, event: ConsumptionEvent): Promise<void> {
  await db.transaction('rw', db.consumptionEvents, db.lots, async () => {
    if (event.source.type === 'ingredient' && event.source.lotId !== undefined) {
      const { lotId, canonicalId, grams } = event.source
      const lot = await db.lots.get(lotId)
      if (lot) {
        const take = Math.min(lot.remainingG, grams)
        if (take > 0) {
          const [next] = applyDeductions([lot], [{ lotId, canonicalId, grams: take }], event.consumedAt)
          await db.lots.put(next)
        }
      }
    }
    await db.consumptionEvents.put(event)
  })
}

export interface DeletedConsumption {
  readonly event: ConsumptionEvent
  /** Grams put back into the packet. Zero when there was nothing to put back. */
  readonly restoredG: number
}

/**
 * Remove a logged entry, and put its grams back where they came from.
 *
 * This is the agreed alternative to editing (Jack, 2026-08-20): a mis-tap
 * thirty seconds ago should be fixable, but "history is immutable" means a
 * stored snapshot is never rewritten in place. Withdrawing an entry and logging
 * a new one keeps that literally true.
 *
 * Returns `undefined` for an id that is already gone, rather than throwing. The
 * only way to ask twice is a stale screen, and both taps mean the same thing.
 *
 * Two cases where nothing is restored, both deliberate:
 *
 *  - The packet was deleted (thrown out). There is nowhere to put the grams
 *    back into, and the User has already said that food is gone.
 *  - The entry came from a `cook` or `leftover` source. Those own their
 *    deductions on the `CookEvent`, and un-eating a portion is a Phase 7
 *    question about `fractionConsumed`, not an inventory one. This refuses
 *    rather than guessing — nothing creates those events yet, so the only way
 *    to reach it is a Phase 7 mistake, and it should be loud.
 *
 * A restore can hand back slightly more than was taken in one narrow case: an
 * entry whose deduction was clamped by a nearly-empty packet records the grams
 * eaten, not the grams removed, and there is no field to keep the difference in
 * without a schema version bump. `revertDeductions` caps the result at the
 * packet's original size, so the error is bounded and Reconcile corrects it.
 */
export async function deleteConsumption(
  db: KitchenOsDb,
  id: ConsumptionEventId,
): Promise<DeletedConsumption | undefined> {
  return db.transaction('rw', db.consumptionEvents, db.lots, async () => {
    const event = await db.consumptionEvents.get(id)
    if (!event) return undefined

    if (event.source.type !== 'ingredient') {
      throw new Error(
        `deleteConsumption: "${id}" came from a ${event.source.type} event. ` +
          'Removing one of those has to adjust the cook event it belongs to (Phase 7).',
      )
    }

    const { lotId, canonicalId, grams } = event.source
    let restoredG = 0

    if (lotId !== undefined) {
      const lot = await db.lots.get(lotId)
      if (lot) {
        const [next] = revertDeductions([lot], [{ lotId, canonicalId, grams }])
        await db.lots.put(next)
        restoredG = next.remainingG - lot.remainingG
      }
    }

    await db.consumptionEvents.delete(id)
    return { event, restoredG }
  })
}
