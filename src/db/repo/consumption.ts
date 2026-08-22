/**
 * Kitchen OS — Consumption events
 *
 * Everything eaten. This is what the daily totals sum over. Two of the three
 * arms of `ConsumptionSource` are live: `ingredient` since Phase 5, `cook` since
 * Phase 7. The `leftover` arm is a v2 feature and is still refused everywhere it
 * appears — loudly, because nothing writes one and the only way to meet one is a
 * mistake.
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
  CookEventId,
  Deduction,
  LotId,
  MacroSet,
  MealSlot,
  ProductId,
  Timestamp,
} from '../../types/schema'
import {
  addPortion,
  applyDeductions,
  clampPortion,
  fractionOfMacros,
  remainingFraction,
  removePortion,
  revertDeductions,
} from '../../engine'
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
    let deductions: Deduction[] = []

    if (input.lotId !== undefined) {
      const lot = await db.lots.get(input.lotId)
      if (!lot) throw new Error(`logIngredient: unknown lot "${input.lotId}".`)

      deductedG = Math.min(lot.remainingG, input.grams)
      if (deductedG > 0) {
        deductions = [{ lotId: lot.id, canonicalId: input.canonicalId, grams: deductedG }]
        const [next] = applyDeductions([lot], deductions, now)
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
        // What actually came out, which is not always what was eaten. Recorded
        // since version 5 so that deleting a clamped entry hands back exactly
        // what it took (DECISIONS.md, 2026-08-20, closed 2026-08-22).
        ...(deductions.length > 0 ? { deductions } : {}),
      },
      macros: input.macros,
      label: input.label,
      ...(input.meal === undefined ? {} : { meal: input.meal }),
    }
    await db.consumptionEvents.add(event)

    return { event, deductedG, shortfallG: input.grams - deductedG }
  })
}

// ---------------------------------------------------------------------------
// Eating a batch you cooked
// ---------------------------------------------------------------------------

/**
 * What the portion question collects.
 *
 * `fraction` is a portion of the WHOLE batch, not of what is left — the schema
 * is explicit about it, and it is what makes two portions of the same cook add
 * up. A screen that would rather ask "how much of the rest?" converts before it
 * gets here.
 *
 * No macros: they are not a thing the User can be asked for here. A portion of a
 * batch is that fraction of `CookEvent.batchMacros`, which was snapshotted when
 * the cook was committed.
 */
export interface LogCookPortionInput {
  readonly cookEventId: CookEventId
  readonly fraction: number
  readonly meal?: MealSlot
}

export interface LoggedCookPortion {
  readonly event: ConsumptionEvent
  /** What was actually recorded, after clamping to what was left of the batch. */
  readonly fraction: number
  /** What was asked for. Differs from `fraction` only on a stale screen. */
  readonly requestedFraction: number
  /** How much of the batch is left AFTER this. */
  readonly remainingFraction: number
}

/**
 * Record eating some of a batch you cooked.
 *
 * The two writes the Phase 7 handoff singles out — the consumption event and the
 * move on `CookEvent.fractionConsumed` — happen in ONE transaction. Either both
 * land or neither does; a day's totals that count a meal the batch does not know
 * it gave up is a discrepancy nothing afterwards could detect.
 *
 * **No inventory moves here.** The ingredients left the packets when the recipe
 * was cooked. Debiting them again would take the same food out twice.
 *
 * The batch is re-read INSIDE the transaction and the portion clamped to what is
 * actually left, the same as `logIngredient` re-reads its packet. Asking for
 * more than remains is not an error — it is a second helping logged from a sheet
 * opened before the first one — so it is clamped, and the difference is returned
 * for the screen to say out loud. Asking for a portion of a batch with nothing
 * left IS an error: there is no honest number to write, and doing nothing
 * quietly is the failure mode this phase exists to remove.
 */
export async function logCookPortion(
  db: KitchenOsDb,
  input: LogCookPortionInput,
  now: Timestamp,
): Promise<LoggedCookPortion> {
  if (!Number.isFinite(input.fraction) || input.fraction <= 0) {
    throw new RangeError(
      `logCookPortion: fraction must be a positive number, got ${input.fraction}.`,
    )
  }

  return db.transaction('rw', db.consumptionEvents, db.cookEvents, async () => {
    const cook = await db.cookEvents.get(input.cookEventId)
    if (!cook) throw new Error(`logCookPortion: unknown cook event "${input.cookEventId}".`)

    const left = remainingFraction(cook)
    const fraction = clampPortion(input.fraction, left)
    if (fraction <= 0) {
      throw new Error(
        `logCookPortion: there is none of "${cook.label}" left — all of it has been eaten.`,
      )
    }

    const event: ConsumptionEvent = {
      id: newId('cons'),
      consumedAt: now,
      source: { type: 'cook', cookEventId: cook.id, fraction },
      // A portion of the batch's snapshot, which is itself a snapshot. Nothing
      // recomputes either from products afterwards.
      macros: fractionOfMacros(cook.batchMacros, fraction),
      label: cook.label,
      ...(input.meal === undefined ? {} : { meal: input.meal }),
    }

    await db.consumptionEvents.add(event)
    await db.cookEvents.put({
      ...cook,
      fractionConsumed: addPortion(cook.fractionConsumed, fraction),
    })

    return {
      event,
      fraction,
      requestedFraction: input.fraction,
      remainingFraction: Math.max(0, left - fraction),
    }
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
  if (event.source.type === 'leftover') {
    throw new Error(
      `restoreConsumption: "${event.id}" came from a leftover, which is a v2 feature ` +
        'that nothing writes yet. Putting it back would need the Leftover table to be live.',
    )
  }

  await db.transaction('rw', db.consumptionEvents, db.lots, db.cookEvents, async () => {
    if (event.source.type === 'ingredient' && event.source.lotId !== undefined) {
      const { lotId, canonicalId, grams } = event.source
      const lot = await db.lots.get(lotId)
      if (lot) {
        // Take out exactly what the original entry took, when that is on record
        // (version 5 and later). Falling back to `grams` is the old behaviour
        // and is right for every entry the packet could cover.
        const owed = deductedGramsOf(event.source, grams)
        const take = Math.min(lot.remainingG, owed)
        if (take > 0) {
          const [next] = applyDeductions([lot], [{ lotId, canonicalId, grams: take }], event.consumedAt)
          await db.lots.put(next)
        }
      }
    }

    /*
     * The cook arm. The handoff singles this one out as the more dangerous of
     * the two gaps precisely because it was SILENT: without this block an
     * un-deleted portion goes back on the day's totals while the batch it came
     * out of still believes nobody ate it, and nothing anywhere complains.
     *
     * No inventory moves — the ingredients left when the recipe was cooked.
     * `addPortion` caps at a whole batch, so a double Undo from a stale screen
     * cannot push a batch past fully eaten.
     */
    if (event.source.type === 'cook') {
      const { cookEventId, fraction } = event.source
      const cook = await db.cookEvents.get(cookEventId)
      if (!cook) {
        /*
         * The batch has been removed since this entry was deleted, and putting
         * the entry back would count the same food twice.
         *
         * The sequence is real, not theoretical (found 2026-08-22): remove the
         * portion from the food log, then remove the now-untouched batch from
         * the log sheet — which puts the raw ingredients back on the shelf —
         * then tap the Undo still sitting on the food log. Without this the
         * meal returns to the day's totals while its ingredients are also back
         * in the kitchen, and nothing afterwards could tell they are the same
         * food. That is precisely what `deleteCookEvent`'s refusal exists to
         * prevent; this closes the back door into it.
         *
         * Note the deliberate asymmetry with `deleteConsumption`, which happily
         * removes an entry whose batch has gone. Removing an orphan is always
         * safe. RE-CREATING one is not.
         */
        throw new Error(
          `restoreConsumption: the batch "${event.label}" came out of has since been removed, ` +
            'and its ingredients are back in the kitchen. Putting this entry back would count ' +
            'the same food twice. Log it again if you did eat it.',
        )
      }
      await db.cookEvents.put({
        ...cook,
        fractionConsumed: addPortion(cook.fractionConsumed, fraction),
      })
    }

    await db.consumptionEvents.put(event)
  })
}

/**
 * How many grams an ingredient entry actually took out of its packet.
 *
 * `deductions` is the exact record and is present from schema version 5 on.
 * Absent means the entry predates the field, and `grams` — what was eaten — is
 * the best available answer, which is also the exact answer whenever the packet
 * covered the amount. See the accepted inaccuracy in DECISIONS.md (2026-08-20).
 */
function deductedGramsOf(
  source: Extract<ConsumptionEvent['source'], { type: 'ingredient' }>,
  fallbackG: number,
): number {
  if (source.deductions === undefined || source.deductions.length === 0) return fallbackG
  return source.deductions.reduce((total, deduction) => total + deduction.grams, 0)
}

export interface DeletedConsumption {
  readonly event: ConsumptionEvent
  /** Grams put back into the packet. Zero when there was nothing to put back. */
  readonly restoredG: number
  /**
   * Portion handed back to the batch this came out of. Zero for anything logged
   * directly — an ingredient entry belongs to no batch.
   */
  readonly restoredFraction: number
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
 * Three cases where no grams are restored, all deliberate:
 *
 *  - The packet was deleted (thrown out). There is nowhere to put the grams
 *    back into, and the User has already said that food is gone.
 *  - The entry came from a `cook`. Its ingredients left inventory when the
 *    recipe was cooked, not when the portion was eaten, so what is undone is
 *    the eating: the portion goes back onto `CookEvent.fractionConsumed` and
 *    the batch can be eaten from again. Undoing the COOK is a separate act,
 *    with its own rules, in `cooks.ts`.
 *  - The entry came from a `leftover`. That is a v2 feature nothing writes, so
 *    this still refuses rather than guessing — the only way to reach it is a
 *    mistake, and it should be loud.
 *
 * Since schema version 5 the amount handed back is exactly what was taken:
 * `source.deductions` records it. Entries written before that record the grams
 * EATEN, so one clamped by a nearly-empty packet can still hand back slightly
 * more than it took; `revertDeductions` caps the result at the packet's original
 * size, so the error is bounded and Reconcile corrects it.
 */
export async function deleteConsumption(
  db: KitchenOsDb,
  id: ConsumptionEventId,
): Promise<DeletedConsumption | undefined> {
  return db.transaction('rw', db.consumptionEvents, db.lots, db.cookEvents, async () => {
    const event = await db.consumptionEvents.get(id)
    if (!event) return undefined

    if (event.source.type === 'leftover') {
      throw new Error(
        `deleteConsumption: "${id}" came from a leftover, which is a v2 feature that ` +
          'nothing writes yet. Removing one would have to adjust the Leftover table.',
      )
    }

    /*
     * A portion of a batch. Nothing goes back into a packet — the ingredients
     * left the kitchen when the recipe was cooked, and putting them back here
     * would restore food the cook still accounts for. What is undone is the
     * EATING: the batch gets the portion back and can be eaten again.
     */
    if (event.source.type === 'cook') {
      const { cookEventId, fraction } = event.source
      let restoredFraction = 0

      const cook = await db.cookEvents.get(cookEventId)
      if (cook) {
        const next = removePortion(cook.fractionConsumed, fraction)
        await db.cookEvents.put({ ...cook, fractionConsumed: next })
        restoredFraction = cook.fractionConsumed - next
      }
      // A missing cook event is a broken reference, not a reason to refuse. The
      // entry is still the User's to remove, and leaving it on the day because
      // its batch has gone would be punishing them for the app's mistake.

      await db.consumptionEvents.delete(id)
      return { event, restoredG: 0, restoredFraction }
    }

    const { lotId, canonicalId, grams } = event.source
    let restoredG = 0

    if (lotId !== undefined) {
      const lot = await db.lots.get(lotId)
      if (lot) {
        // Exactly what came out, when the entry recorded it. See the note on
        // `deductedGramsOf` — this is the version 5 fix for handing back more
        // than was taken from a nearly-empty packet.
        const owed = deductedGramsOf(event.source, grams)
        const [next] = revertDeductions([lot], [{ lotId, canonicalId, grams: owed }])
        await db.lots.put(next)
        restoredG = next.remainingG - lot.remainingG
      }
    }

    await db.consumptionEvents.delete(id)
    return { event, restoredG, restoredFraction: 0 }
  })
}
