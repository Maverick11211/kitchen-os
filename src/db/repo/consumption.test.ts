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
import type { ConsumptionEvent, Lot, MacroSet, Product } from '../../types/schema'
import { localDayRange } from '../../lib/clock'
import { createDb, type KitchenOsDb } from '../db'
import { addProduct } from './products'
import { addLot, deleteLot, getLot } from './lots'
import {
  deleteConsumption,
  firstConsumptionAt,
  listConsumptionBetween,
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

  it('refuses to remove a portion of a cooked batch', async () => {
    const db = freshDb()
    const fromCooking: ConsumptionEvent = {
      id: 'cons_cooked',
      consumedAt: NOW,
      source: { type: 'cook', cookEventId: 'cook_1', fraction: 0.25 },
      macros: FIFTY_GRAMS,
      label: 'Chicken Tikka Masala',
    }
    await db.consumptionEvents.add(fromCooking)

    // Nothing creates these yet. Reaching this is a Phase 7 mistake, and a
    // silent success would leave CookEvent.fractionConsumed wrong forever.
    await expect(deleteConsumption(db, fromCooking.id)).rejects.toThrow(/Phase 7/)
    expect(await db.consumptionEvents.get(fromCooking.id)).toBeDefined()
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
