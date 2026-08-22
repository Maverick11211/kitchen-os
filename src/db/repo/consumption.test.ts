/**
 * Kitchen OS — Logging something eaten, against a real (in-memory) IndexedDB.
 *
 * The two things worth testing here are the ones a person would notice: that a
 * log both records the meal and moves the food, without either half happening
 * alone; and that undoing it puts the food back where it came from.
 *
 * The local-day tests pin `TZ` on purpose. A day is local midnight to local
 * midnight while `consumedAt` is a UTC instant, and the case that breaks a naive
 * implementation — an evening meal stored under tomorrow's UTC date — only shows
 * up in a timezone behind UTC, which is where this iPad lives.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsumptionEvent, CookEvent, Lot, MacroSet, Product } from '../../types/schema'
import { localDayRange } from '../../lib/clock'
import { createDb, type KitchenOsDb } from '../db'
import { addProduct } from './products'
import { addLot, deleteLot, getLot } from './lots'
import {
  deleteConsumption,
  firstConsumptionAt,
  listConsumptionBetween,
  logCookPortion,
  logIngredient,
  restoreConsumption,
} from './consumption'

beforeEach(() => {
  vi.stubEnv('TZ', 'America/New_York')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

let dbCounter = 0
function freshDb(): KitchenOsDb {
  return createDb(`kitchen-os-consumption-test-${Date.now()}-${++dbCounter}`)
}

const NOW = '2026-08-20T18:00:00.000Z'

/** Cheddar, per 100g. */
const CHEDDAR_PER_100G: MacroSet = {
  calories: 402,
  proteinG: 25,
  carbsG: 1.3,
  fatG: 33,
  fiberG: 0,
  sugarG: 0.5,
  sodiumMg: 621,
  saturatedFatG: 19,
  cholesterolMg: 105,
}

/** What 50g of it comes to. The form scales; this layer stores what it is given. */
const FIFTY_GRAMS: MacroSet = {
  calories: 201,
  proteinG: 12.5,
  carbsG: 0.65,
  fatG: 16.5,
  fiberG: 0,
  sugarG: 0.25,
  sodiumMg: 310.5,
  saturatedFatG: 9.5,
  cholesterolMg: 52.5,
}

/**
 * A cooked batch. `deductions` is empty because these tests are about the
 * eating half — what leaves inventory when a recipe is cooked is `cooks.test.ts`.
 */
function aBatch(overrides: Partial<CookEvent> = {}): CookEvent {
  return {
    id: 'cook_1',
    recipeId: 'chicken-tikka-masala',
    label: 'Chicken Tikka Masala',
    scaleFactor: 1,
    cookedAt: NOW,
    deductions: [],
    batchMacros: CHEDDAR_PER_100G,
    fractionConsumed: 0,
    ...overrides,
  }
}

async function aPacketOfCheddar(
  db: KitchenOsDb,
  grams = 200,
): Promise<{ product: Product; lot: Lot }> {
  const product = await addProduct(
    db,
    {
      canonicalId: 'cheddar-shredded',
      name: 'Kroger Shredded Sharp Cheddar',
      macrosPer100g: CHEDDAR_PER_100G,
      packageSizeG: grams,
    },
    NOW,
  )
  const lot = await addLot(db, {
    productId: product.id,
    initialG: grams,
    expiresOn: '2026-09-01',
    acquiredOn: '2026-08-18',
  })
  return { product, lot }
}

describe('logIngredient', () => {
  it('records the entry and takes the grams out of the packet', async () => {
    const db = freshDb()
    const { product, lot } = await aPacketOfCheddar(db)

    const result = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        productId: product.id,
        lotId: lot.id,
      },
      NOW,
    )

    expect(result.deductedG).toBe(50)
    expect(result.shortfallG).toBe(0)
    expect((await getLot(db, lot.id))?.remainingG).toBe(150)

    const stored = await db.consumptionEvents.get(result.event.id)
    expect(stored?.source).toEqual({
      type: 'ingredient',
      canonicalId: 'cheddar-shredded',
      grams: 50,
      productId: product.id,
      lotId: lot.id,
      // Since schema version 5: exactly what came out of the packet, which here
      // is the whole 50 g because the packet could cover it.
      deductions: [{ lotId: lot.id, canonicalId: 'cheddar-shredded', grams: 50 }],
    })
  })

  it('stores the macros exactly as handed to it', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db)

    const { event } = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )

    // The snapshot rule: what is stored is what was computed at log time, with
    // nothing looked up again on the way in.
    expect((await db.consumptionEvents.get(event.id))?.macros).toEqual(FIFTY_GRAMS)
  })

  it('leaves inventory alone when no packet is named', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db)

    const result = await logIngredient(
      db,
      { canonicalId: 'cheddar-shredded', grams: 50, label: 'Cheddar', macros: FIFTY_GRAMS },
      NOW,
    )

    expect(result.deductedG).toBe(0)
    expect((await getLot(db, lot.id))?.remainingG).toBe(200)
    expect(result.event.source).not.toHaveProperty('lotId')
  })

  it('takes what the packet has and reports the gap when it cannot cover it', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db, 30)

    const result = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )

    expect(result.deductedG).toBe(30)
    expect(result.shortfallG).toBe(20)
    // You ate 50g, so 50g of macros are logged. The packet is simply empty.
    expect(result.event.macros).toEqual(FIFTY_GRAMS)
    expect((await getLot(db, lot.id))?.remainingG).toBe(0)
  })

  it('marks a packet depleted when the log empties it', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db, 50)

    await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )

    const emptied = await getLot(db, lot.id)
    expect(emptied?.depleted).toBe(true)
    expect(emptied?.depletedAt).toBe(NOW)
  })

  it('does not point the entry at a packet it took nothing from', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db, 50)
    await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )

    // The packet is empty now. A second log of the same thing gets nothing.
    const second = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )

    expect(second.deductedG).toBe(0)
    // No lotId, so deleting this entry later cannot put back food it never took.
    expect(second.event.source).not.toHaveProperty('lotId')
  })

  it('refuses a nonsensical amount rather than storing it', async () => {
    const db = freshDb()
    await expect(
      logIngredient(
        db,
        { canonicalId: 'cheddar-shredded', grams: 0, label: 'Cheddar', macros: FIFTY_GRAMS },
        NOW,
      ),
    ).rejects.toThrow(RangeError)
  })

  it('refuses a packet that does not exist, and writes nothing', async () => {
    const db = freshDb()
    await expect(
      logIngredient(
        db,
        {
          canonicalId: 'cheddar-shredded',
          grams: 50,
          label: 'Cheddar',
          macros: FIFTY_GRAMS,
          lotId: 'lot_nope',
        },
        NOW,
      ),
    ).rejects.toThrow(/unknown lot/)

    expect(await db.consumptionEvents.count()).toBe(0)
  })
})

describe('deleteConsumption', () => {
  it('puts the grams back in the packet', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db)
    const { event } = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )

    const undone = await deleteConsumption(db, event.id)

    expect(undone?.restoredG).toBe(50)
    expect((await getLot(db, lot.id))?.remainingG).toBe(200)
    expect(await db.consumptionEvents.get(event.id)).toBeUndefined()
  })

  it('un-empties a packet the entry had emptied', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db, 50)
    const { event } = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )

    await deleteConsumption(db, event.id)

    const restored = await getLot(db, lot.id)
    expect(restored?.depleted).toBe(false)
    expect(restored?.depletedAt).toBeUndefined()
  })

  it('still removes the entry when the packet has been thrown out', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db)
    const { event } = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )

    await deleteLot(db, lot.id)
    const undone = await deleteConsumption(db, event.id)

    expect(undone?.restoredG).toBe(0)
    expect(await db.consumptionEvents.get(event.id)).toBeUndefined()
  })

  it('says nothing happened for an entry that is already gone', async () => {
    const db = freshDb()
    expect(await deleteConsumption(db, 'cons_nope')).toBeUndefined()
  })

  /*
   * The inaccuracy DECISIONS.md accepted on 2026-08-20 and schema version 5
   * closed. Eating 50 g out of a packet holding 30 g removes 30 g and logs 50 g
   * of macros — you ate what you ate. Before `source.deductions` existed the
   * delete had only the 50 g to go on and handed back 20 g that never left.
   */
  it('hands back exactly what came out of a nearly-empty packet', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db, 30)
    const { event, deductedG, shortfallG } = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )
    expect(deductedG).toBe(30)
    expect(shortfallG).toBe(20)

    const undone = await deleteConsumption(db, event.id)

    expect(undone?.restoredG).toBe(30)
    expect((await getLot(db, lot.id))?.remainingG).toBe(30)
  })

  it('falls back to the grams eaten for an entry written before version 5', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db)
    // Exactly what schema version 4 would have written: a lotId and no
    // `deductions`. Absent must go on meaning "fall back to grams", which is
    // the right answer whenever the packet covered the amount.
    const legacy: ConsumptionEvent = {
      id: 'cons_v4',
      consumedAt: NOW,
      source: { type: 'ingredient', canonicalId: 'cheddar-shredded', grams: 50, lotId: lot.id },
      macros: FIFTY_GRAMS,
      label: 'Cheddar',
    }
    await db.consumptionEvents.add(legacy)
    await db.lots.put({ ...lot, remainingG: 150 })

    const undone = await deleteConsumption(db, legacy.id)

    expect(undone?.restoredG).toBe(50)
    expect((await getLot(db, lot.id))?.remainingG).toBe(200)
  })

  /*
   * Phase 5 asserted that this THREW. Phase 7 is the phase that closes it, and
   * the behaviour it is closed with is the point: the portion goes back to the
   * batch, and no grams go back into any packet. The ingredients left the
   * kitchen when the recipe was cooked — putting them back here would restore
   * food the cook event still accounts for, and the same food would exist
   * twice.
   */
  it('hands a portion back to its batch, and nothing back to a packet', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db)
    await db.cookEvents.add(aBatch({ fractionConsumed: 0.25 }))

    const fromCooking: ConsumptionEvent = {
      id: 'cons_cooked',
      consumedAt: NOW,
      source: { type: 'cook', cookEventId: 'cook_1', fraction: 0.25 },
      macros: FIFTY_GRAMS,
      label: 'Chicken Tikka Masala',
    }
    await db.consumptionEvents.add(fromCooking)

    const undone = await deleteConsumption(db, fromCooking.id)

    expect(undone?.restoredFraction).toBeCloseTo(0.25)
    expect(undone?.restoredG).toBe(0)
    expect((await db.cookEvents.get('cook_1'))?.fractionConsumed).toBe(0)
    expect(await db.consumptionEvents.get(fromCooking.id)).toBeUndefined()
    // The packet is untouched. This is the assertion that would catch a
    // well-meaning "put the ingredients back too".
    expect((await getLot(db, lot.id))?.remainingG).toBe(200)
  })

  it('removes the entry even when its batch has gone missing', async () => {
    const db = freshDb()
    const orphan: ConsumptionEvent = {
      id: 'cons_orphan',
      consumedAt: NOW,
      source: { type: 'cook', cookEventId: 'cook_gone', fraction: 0.5 },
      macros: FIFTY_GRAMS,
      label: 'Something',
    }
    await db.consumptionEvents.add(orphan)

    // A broken reference is the app's mistake, not a reason to trap the entry
    // on the User's day forever.
    const undone = await deleteConsumption(db, orphan.id)
    expect(undone?.restoredFraction).toBe(0)
    expect(await db.consumptionEvents.get(orphan.id)).toBeUndefined()
  })

  it('still refuses a leftover, which is a v2 feature nothing writes', async () => {
    const db = freshDb()
    const fromLeftover: ConsumptionEvent = {
      id: 'cons_leftover',
      consumedAt: NOW,
      source: { type: 'leftover', leftoverId: 'left_1', fraction: 0.5 },
      macros: FIFTY_GRAMS,
      label: 'Yesterday’s stew',
    }
    await db.consumptionEvents.add(fromLeftover)

    // Same reasoning the cook arm had until today: nothing writes one, so the
    // only way to get here is a mistake, and it should be loud.
    await expect(deleteConsumption(db, fromLeftover.id)).rejects.toThrow(/leftover/)
    expect(await db.consumptionEvents.get(fromLeftover.id)).toBeDefined()
  })
})

describe('restoreConsumption', () => {
  it('puts the entry back as it was and takes the grams out again', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db)
    const { event } = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )
    await deleteConsumption(db, event.id)

    await restoreConsumption(db, event)

    // Same id, same timestamp, same snapshot — not a fresh entry stamped today.
    expect(await db.consumptionEvents.get(event.id)).toEqual(event)
    expect((await getLot(db, lot.id))?.remainingG).toBe(150)
  })

  it('restores the entry even when the packet has gone', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db)
    const { event } = await logIngredient(
      db,
      {
        canonicalId: 'cheddar-shredded',
        grams: 50,
        label: 'Cheddar',
        macros: FIFTY_GRAMS,
        lotId: lot.id,
      },
      NOW,
    )
    await deleteConsumption(db, event.id)
    await deleteLot(db, lot.id)

    await restoreConsumption(db, event)

    expect(await db.consumptionEvents.get(event.id)).toBeDefined()
  })

  it('is harmless if asked twice', async () => {
    const db = freshDb()
    const { event } = await logIngredient(
      db,
      { canonicalId: 'cheddar-shredded', grams: 50, label: 'Cheddar', macros: FIFTY_GRAMS },
      NOW,
    )

    await restoreConsumption(db, event)
    await restoreConsumption(db, event)

    expect(await db.consumptionEvents.count()).toBe(1)
  })

  /*
   * The quieter of the two gaps the handoff named, and the more dangerous for
   * exactly that reason: before Phase 7 this put the row back and adjusted
   * nothing, with no error. The batch would go on believing nobody had eaten
   * that portion while the day's totals counted it.
   */
  it('gives the portion back to the batch when a cook entry is un-deleted', async () => {
    const db = freshDb()
    await db.cookEvents.add(aBatch({ fractionConsumed: 0.5 }))
    const portion: ConsumptionEvent = {
      id: 'cons_cooked',
      consumedAt: NOW,
      source: { type: 'cook', cookEventId: 'cook_1', fraction: 0.5 },
      macros: FIFTY_GRAMS,
      label: 'Chicken Tikka Masala',
    }
    await db.consumptionEvents.add(portion)
    await deleteConsumption(db, portion.id)
    expect((await db.cookEvents.get('cook_1'))?.fractionConsumed).toBe(0)

    await restoreConsumption(db, portion)

    expect((await db.cookEvents.get('cook_1'))?.fractionConsumed).toBeCloseTo(0.5)
    expect(await db.consumptionEvents.get(portion.id)).toEqual(portion)
  })

  it('never pushes a batch past fully eaten, however many times Undo is tapped', async () => {
    const db = freshDb()
    await db.cookEvents.add(aBatch({ fractionConsumed: 0.8 }))
    const portion: ConsumptionEvent = {
      id: 'cons_cooked',
      consumedAt: NOW,
      source: { type: 'cook', cookEventId: 'cook_1', fraction: 0.5 },
      macros: FIFTY_GRAMS,
      label: 'Chicken Tikka Masala',
    }
    await db.consumptionEvents.add(portion)

    await restoreConsumption(db, portion)
    await restoreConsumption(db, portion)

    expect((await db.cookEvents.get('cook_1'))?.fractionConsumed).toBe(1)
  })

  it('still refuses a leftover', async () => {
    const db = freshDb()
    const fromLeftover: ConsumptionEvent = {
      id: 'cons_leftover',
      consumedAt: NOW,
      source: { type: 'leftover', leftoverId: 'left_1', fraction: 0.5 },
      macros: FIFTY_GRAMS,
      label: 'Yesterday’s stew',
    }

    await expect(restoreConsumption(db, fromLeftover)).rejects.toThrow(/leftover/)
  })

  /*
   * The back door into the double-count that `deleteCookEvent`'s refusal exists
   * to prevent (found 2026-08-22). Remove the portion from the food log, then
   * remove the now-untouched batch — which puts the raw ingredients back on the
   * shelf — then tap the Undo still sitting on the food log. Restoring would
   * put the meal back on the day while its ingredients are also back in the
   * kitchen, and nothing afterwards could tell they are the same food.
   */
  it('refuses to put a portion back when its batch has been removed', async () => {
    const db = freshDb()
    const portion: ConsumptionEvent = {
      id: 'cons_cooked',
      consumedAt: NOW,
      source: { type: 'cook', cookEventId: 'cook_1', fraction: 0.25 },
      macros: FIFTY_GRAMS,
      label: 'Chicken Tikka Masala',
    }

    await expect(restoreConsumption(db, portion)).rejects.toThrow(/count the same food twice/)
    expect(await db.consumptionEvents.count()).toBe(0)
  })

  /*
   * The deliberate asymmetry. Removing an orphan is always safe — the entry is
   * the User's to withdraw and a broken reference is the app's mistake, not
   * theirs. Re-creating one is not.
   */
  it('but deleting an orphan is still allowed', async () => {
    const db = freshDb()
    const orphan: ConsumptionEvent = {
      id: 'cons_orphan2',
      consumedAt: NOW,
      source: { type: 'cook', cookEventId: 'cook_gone', fraction: 0.5 },
      macros: FIFTY_GRAMS,
      label: 'Something',
    }
    await db.consumptionEvents.add(orphan)

    await expect(deleteConsumption(db, orphan.id)).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------

describe('logCookPortion', () => {
  it('records the portion and moves the batch, in one go', async () => {
    const db = freshDb()
    await db.cookEvents.add(aBatch())

    const result = await logCookPortion(db, { cookEventId: 'cook_1', fraction: 0.25 }, NOW)

    expect(result.fraction).toBe(0.25)
    expect(result.remainingFraction).toBeCloseTo(0.75)
    expect((await db.cookEvents.get('cook_1'))?.fractionConsumed).toBe(0.25)
    expect(await db.consumptionEvents.get(result.event.id)).toBeDefined()
  })

  it('takes the macros as that fraction of the batch snapshot', async () => {
    const db = freshDb()
    // CHEDDAR_PER_100G is the batch total here: 402 calories for the whole lot.
    await db.cookEvents.add(aBatch())

    const { event } = await logCookPortion(db, { cookEventId: 'cook_1', fraction: 0.5 }, NOW)

    expect(event.macros.calories).toBeCloseTo(201)
    expect(event.macros.cholesterolMg).toBeCloseTo(52.5)
  })

  it('names the entry after the batch, not after a recipe lookup', async () => {
    const db = freshDb()
    await db.cookEvents.add(aBatch({ label: 'Sunday stew' }))

    const { event } = await logCookPortion(db, { cookEventId: 'cook_1', fraction: 0.5 }, NOW)

    expect(event.label).toBe('Sunday stew')
  })

  it('takes no food out of any packet', async () => {
    const db = freshDb()
    const { lot } = await aPacketOfCheddar(db)
    await db.cookEvents.add(aBatch())

    await logCookPortion(db, { cookEventId: 'cook_1', fraction: 0.5 }, NOW)

    // The ingredients left when the recipe was cooked. Debiting again here
    // would take the same food out twice.
    expect((await getLot(db, lot.id))?.remainingG).toBe(200)
  })

  it('adds up across several helpings', async () => {
    const db = freshDb()
    await db.cookEvents.add(aBatch())

    await logCookPortion(db, { cookEventId: 'cook_1', fraction: 0.25 }, NOW)
    await logCookPortion(db, { cookEventId: 'cook_1', fraction: 0.25 }, NOW)

    expect((await db.cookEvents.get('cook_1'))?.fractionConsumed).toBeCloseTo(0.5)
  })

  /*
   * The stale-screen case. A sheet opened when the batch was whole, tapped
   * after someone had already had most of it: clamp, record what was actually
   * there, and hand the difference back so the screen can say so — the same
   * shape as `shortfallG` on a logged ingredient.
   */
  it('takes only what is left, and reports the difference', async () => {
    const db = freshDb()
    await db.cookEvents.add(aBatch({ fractionConsumed: 0.8 }))

    const result = await logCookPortion(db, { cookEventId: 'cook_1', fraction: 0.5 }, NOW)

    expect(result.requestedFraction).toBe(0.5)
    expect(result.fraction).toBeCloseTo(0.2)
    expect(result.remainingFraction).toBe(0)
    expect((await db.cookEvents.get('cook_1'))?.fractionConsumed).toBe(1)
  })

  it('refuses a batch with nothing left rather than logging a zero', async () => {
    const db = freshDb()
    await db.cookEvents.add(aBatch({ fractionConsumed: 1 }))

    await expect(
      logCookPortion(db, { cookEventId: 'cook_1', fraction: 0.25 }, NOW),
    ).rejects.toThrow(/none of/)
    expect(await db.consumptionEvents.count()).toBe(0)
  })

  it('refuses a batch that does not exist', async () => {
    const db = freshDb()
    await expect(
      logCookPortion(db, { cookEventId: 'cook_nope', fraction: 0.25 }, NOW),
    ).rejects.toThrow(/unknown cook event/)
  })

  it('refuses a portion that is not a portion', async () => {
    const db = freshDb()
    await db.cookEvents.add(aBatch())

    await expect(
      logCookPortion(db, { cookEventId: 'cook_1', fraction: 0 }, NOW),
    ).rejects.toThrow(RangeError)
  })

  it('keeps the meal when one was said, and invents none when it was not', async () => {
    const db = freshDb()
    await db.cookEvents.add(aBatch())

    const withMeal = await logCookPortion(
      db,
      { cookEventId: 'cook_1', fraction: 0.25, meal: 'dinner' },
      NOW,
    )
    const without = await logCookPortion(db, { cookEventId: 'cook_1', fraction: 0.25 }, NOW)

    expect(withMeal.event.meal).toBe('dinner')
    expect('meal' in without.event).toBe(false)
  })
})

describe('reading a day back', () => {
  it('finds an evening meal that UTC files under tomorrow', async () => {
    const db = freshDb()
    // 9pm on the 20th in New York is 01:00 UTC on the 21st.
    const evening = '2026-08-21T01:00:00.000Z'
    await logIngredient(
      db,
      { canonicalId: 'cheddar-shredded', grams: 50, label: 'Cheddar', macros: FIFTY_GRAMS },
      evening,
    )

    const { startAt, endAt } = localDayRange('2026-08-20')
    const events = await listConsumptionBetween(db, startAt, endAt)

    expect(events).toHaveLength(1)
    // And it does not also show up on the 21st.
    const next = localDayRange('2026-08-21')
    expect(await listConsumptionBetween(db, next.startAt, next.endAt)).toHaveLength(0)
  })

  it('counts a midnight entry once, on the day starting', async () => {
    const db = freshDb()
    const { startAt } = localDayRange('2026-08-20')
    await logIngredient(
      db,
      { canonicalId: 'cheddar-shredded', grams: 50, label: 'Cheddar', macros: FIFTY_GRAMS },
      startAt,
    )

    const yesterday = localDayRange('2026-08-19')
    const today = localDayRange('2026-08-20')

    expect(await listConsumptionBetween(db, yesterday.startAt, yesterday.endAt)).toHaveLength(0)
    expect(await listConsumptionBetween(db, today.startAt, today.endAt)).toHaveLength(1)
  })

  it('returns a day oldest first', async () => {
    const db = freshDb()
    for (const at of ['2026-08-20T22:00:00.000Z', '2026-08-20T14:00:00.000Z']) {
      await logIngredient(
        db,
        { canonicalId: 'cheddar-shredded', grams: 50, label: 'Cheddar', macros: FIFTY_GRAMS },
        at,
      )
    }

    const { startAt, endAt } = localDayRange('2026-08-20')
    const events = await listConsumptionBetween(db, startAt, endAt)

    expect(events.map((event) => event.consumedAt)).toEqual([
      '2026-08-20T14:00:00.000Z',
      '2026-08-20T22:00:00.000Z',
    ])
  })

  it('knows how far back there is to go', async () => {
    const db = freshDb()
    expect(await firstConsumptionAt(db)).toBeUndefined()

    for (const at of ['2026-08-20T14:00:00.000Z', '2026-08-12T14:00:00.000Z']) {
      await logIngredient(
        db,
        { canonicalId: 'cheddar-shredded', grams: 50, label: 'Cheddar', macros: FIFTY_GRAMS },
        at,
      )
    }

    expect(await firstConsumptionAt(db)).toBe('2026-08-12T14:00:00.000Z')
  })
})
