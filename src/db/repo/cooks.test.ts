/**
 * Kitchen OS — Cooking a recipe, against a real (in-memory) IndexedDB.
 *
 * The first thing in this app that ever writes a `CookEvent`. What is worth
 * testing here is what a person would notice, and what nothing else can repair
 * afterwards:
 *
 *  - cooking debits the right packets, first-expiring first, in one go
 *  - the batch's calories are snapshotted from what actually left the kitchen
 *  - `deductions` records exactly what moved, because reversal depends on it
 *  - a shortfall does not stop the cook, it is recorded and reported
 *  - undoing a cook is refused once the batch has been eaten from
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { CanonicalIngredient, MacroSet, Recipe } from '../../types/schema'
import { buildOntologyIndex } from '../../engine'
import { createDb, type KitchenOsDb } from '../db'
import { addProduct } from './products'
import { addLot, getLot } from './lots'
import { logCookPortion } from './consumption'
import { commitCook, deleteCookEvent, listCookEvents, listOpenCooks } from './cooks'

let dbCounter = 0
function freshDb(): KitchenOsDb {
  return createDb(`kitchen-os-cooks-test-${Date.now()}-${++dbCounter}`)
}

const NOW = '2026-08-22T18:00:00.000Z'

/** 100 calories and 10 g of protein per 100 g. Round numbers, easy to check. */
const SIMPLE_PER_100G: MacroSet = {
  calories: 100,
  proteinG: 10,
  carbsG: 5,
  fatG: 2,
  fiberG: 1,
  sugarG: 1,
  sodiumMg: 50,
  saturatedFatG: 1,
  cholesterolMg: 10,
}

function ingredient(
  id: string,
  overrides: Partial<CanonicalIngredient> = {},
): CanonicalIngredient {
  return {
    id,
    name: id,
    category: 'other',
    trackBy: 'mass',
    tracked: true,
    perishable: true,
    aliases: [],
    isSeed: true,
    ...overrides,
  }
}

/** Rice and salt: one thing to debit, one staple that must be skipped entirely. */
const ONTOLOGY = buildOntologyIndex([
  ingredient('rice-white'),
  ingredient('chicken-breast'),
  ingredient('salt', { tracked: false, perishable: false, category: 'spice' }),
])

function aRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'rice-and-chicken',
    name: 'Rice and Chicken',
    cuisines: ['Other'],
    ingredients: [
      { canonicalId: 'rice-white', quantity: 150, unit: 'g', quantityG: 150, optional: false },
      {
        canonicalId: 'chicken-breast',
        quantity: 200,
        unit: 'g',
        quantityG: 200,
        optional: false,
      },
      { canonicalId: 'salt', quantity: 5, unit: 'g', quantityG: 5, optional: false },
    ],
    requiredAppliances: [],
    tools: [],
    steps: [{ order: 1, text: 'Cook it.' }],
    isSeed: true,
    createdAt: NOW,
    ...overrides,
  }
}

/** A packet of something, with an expiry so FEFO order is decidable. */
async function aPacket(
  db: KitchenOsDb,
  canonicalId: string,
  grams: number,
  expiresOn: string,
): Promise<string> {
  const product = await addProduct(
    db,
    { canonicalId, name: `${canonicalId} packet`, macrosPer100g: SIMPLE_PER_100G },
    NOW,
  )
  const lot = await addLot(db, {
    productId: product.id,
    initialG: grams,
    expiresOn,
    acquiredOn: '2026-08-18',
  })
  return lot.id
}

// ---------------------------------------------------------------------------

describe('commitCook', () => {
  it('debits the packets and records what came out', async () => {
    const db = freshDb()
    const rice = await aPacket(db, 'rice-white', 500, '2026-12-01')
    const chicken = await aPacket(db, 'chicken-breast', 400, '2026-08-25')

    const { cook, plan } = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      NOW,
    )

    expect(plan.complete).toBe(true)
    expect((await getLot(db, rice))?.remainingG).toBe(350)
    expect((await getLot(db, chicken))?.remainingG).toBe(200)

    // The source of truth for reversal. Salt is absent: an untracked staple has
    // no packet to debit, and reporting it would be noise.
    expect(cook.deductions).toEqual([
      { lotId: rice, canonicalId: 'rice-white', grams: 150 },
      { lotId: chicken, canonicalId: 'chicken-breast', grams: 200 },
    ])
    expect(cook.fractionConsumed).toBe(0)
    expect(cook.scaleFactor).toBe(1)
  })

  it('snapshots the batch calories from what was actually debited', async () => {
    const db = freshDb()
    await aPacket(db, 'rice-white', 500, '2026-12-01')
    await aPacket(db, 'chicken-breast', 400, '2026-08-25')

    const { cook } = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      NOW,
    )

    // 350 g at 100 cal/100 g.
    expect(cook.batchMacros.calories).toBeCloseTo(350)
    expect(cook.batchMacros.proteinG).toBeCloseTo(35)
  })

  it('names the batch after the recipe, so a deleted recipe cannot orphan it', async () => {
    const db = freshDb()
    await aPacket(db, 'rice-white', 500, '2026-12-01')
    await aPacket(db, 'chicken-breast', 400, '2026-08-25')

    const { cook } = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      NOW,
    )

    expect(cook.label).toBe('Rice and Chicken')
    // The id is kept too — it is still the way back to the recipe when it exists.
    expect(cook.recipeId).toBe('rice-and-chicken')
  })

  it('scales the whole recipe', async () => {
    const db = freshDb()
    const rice = await aPacket(db, 'rice-white', 500, '2026-12-01')
    await aPacket(db, 'chicken-breast', 400, '2026-08-25')

    await commitCook(db, { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 0.5 }, NOW)

    expect((await getLot(db, rice))?.remainingG).toBe(425)
  })

  it('takes from the soonest-expiring packet first', async () => {
    const db = freshDb()
    const later = await aPacket(db, 'rice-white', 200, '2026-12-01')
    const sooner = await aPacket(db, 'rice-white', 100, '2026-08-24')
    await aPacket(db, 'chicken-breast', 400, '2026-08-25')

    await commitCook(db, { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 }, NOW)

    // 150 g wanted: the 100 g packet emptied, then 50 g from the other.
    expect((await getLot(db, sooner))?.remainingG).toBe(0)
    expect((await getLot(db, sooner))?.depleted).toBe(true)
    expect((await getLot(db, later))?.remainingG).toBe(150)
  })

  /*
   * Jack, 2026-08-22: warn and proceed. The engine has always behaved this way;
   * what this pins is that the repository does not add a refusal on top, and
   * that what gets STORED is what actually left — not what the recipe wanted.
   */
  it('cooks anyway when short, recording only what actually left', async () => {
    const db = freshDb()
    await aPacket(db, 'rice-white', 500, '2026-12-01')
    const chicken = await aPacket(db, 'chicken-breast', 50, '2026-08-25')

    const { cook, plan } = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      NOW,
    )

    expect(plan.complete).toBe(false)
    expect(plan.shortfalls).toEqual([
      { canonicalId: 'chicken-breast', requestedG: 200, shortfallG: 150, optional: false },
    ])
    expect((await getLot(db, chicken))?.remainingG).toBe(0)
    expect(cook.deductions).toContainEqual({
      lotId: chicken,
      canonicalId: 'chicken-breast',
      grams: 50,
    })
    // The accuracy note from the handoff, now a deliberate choice (Jack,
    // 2026-08-22): the batch reads as what was deducted, so a batch cooked
    // short of the chicken reads lighter. 200 g total, not 350 g.
    expect(cook.batchMacros.calories).toBeCloseTo(200)
  })

  it('records a cook with nothing in the kitchen rather than refusing', async () => {
    const db = freshDb()

    const { cook, plan } = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      NOW,
    )

    expect(cook.deductions).toEqual([])
    expect(cook.batchMacros.calories).toBe(0)
    expect(plan.shortfalls).toHaveLength(2)
  })

  it('refuses a scale that is not a real batch size', async () => {
    const db = freshDb()
    await expect(
      commitCook(db, { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 0 }, NOW),
    ).rejects.toThrow(RangeError)
    await expect(
      commitCook(db, { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: -1 }, NOW),
    ).rejects.toThrow(RangeError)
  })

  it('leaves packets it did not touch exactly as they were', async () => {
    const db = freshDb()
    await aPacket(db, 'rice-white', 500, '2026-12-01')
    await aPacket(db, 'chicken-breast', 400, '2026-08-25')
    const unrelated = await aPacket(db, 'salt', 900, '2026-12-01')
    const before = await getLot(db, unrelated)

    await commitCook(db, { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 }, NOW)

    expect(await getLot(db, unrelated)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------

describe('deleteCookEvent', () => {
  it('puts the ingredients back and removes the record', async () => {
    const db = freshDb()
    const rice = await aPacket(db, 'rice-white', 500, '2026-12-01')
    const chicken = await aPacket(db, 'chicken-breast', 400, '2026-08-25')
    const { cook } = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      NOW,
    )

    const undone = await deleteCookEvent(db, cook.id)

    expect(undone?.restoredG).toBeCloseTo(350)
    expect((await getLot(db, rice))?.remainingG).toBe(500)
    expect((await getLot(db, chicken))?.remainingG).toBe(400)
    expect(await db.cookEvents.get(cook.id)).toBeUndefined()
  })

  it('un-depletes a packet the cook had emptied', async () => {
    const db = freshDb()
    await aPacket(db, 'rice-white', 500, '2026-12-01')
    const chicken = await aPacket(db, 'chicken-breast', 200, '2026-08-25')
    const { cook } = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      NOW,
    )
    expect((await getLot(db, chicken))?.depleted).toBe(true)

    await deleteCookEvent(db, cook.id)

    const restored = await getLot(db, chicken)
    expect(restored?.depleted).toBe(false)
    expect(restored?.depletedAt).toBeUndefined()
  })

  /*
   * The decision the handoff asked for (Jack, 2026-08-22): undo is for a batch
   * nobody has eaten from. Reverting after a portion has been logged would put
   * raw ingredients back that are already counted as a meal on some day's
   * totals — the same food twice, with nothing afterwards able to tell.
   */
  it('refuses once the batch has been eaten from, and says what is in the way', async () => {
    const db = freshDb()
    const rice = await aPacket(db, 'rice-white', 500, '2026-12-01')
    await aPacket(db, 'chicken-breast', 400, '2026-08-25')
    const { cook } = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      NOW,
    )
    await logCookPortion(db, { cookEventId: cook.id, fraction: 0.25 }, NOW)

    await expect(deleteCookEvent(db, cook.id)).rejects.toThrow(/Rice and Chicken/)
    await expect(deleteCookEvent(db, cook.id)).rejects.toThrow(/food log/)

    // And nothing half-happened: the batch is still there and the rice stayed out.
    expect(await db.cookEvents.get(cook.id)).toBeDefined()
    expect((await getLot(db, rice))?.remainingG).toBe(350)
  })

  it('can be undone again once the portion is removed', async () => {
    const db = freshDb()
    const rice = await aPacket(db, 'rice-white', 500, '2026-12-01')
    await aPacket(db, 'chicken-breast', 400, '2026-08-25')
    const { cook } = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      NOW,
    )
    const { event } = await logCookPortion(db, { cookEventId: cook.id, fraction: 0.25 }, NOW)

    await db.consumptionEvents.delete(event.id)
    await db.cookEvents.put({ ...cook, fractionConsumed: 0 })
    await deleteCookEvent(db, cook.id)

    expect((await getLot(db, rice))?.remainingG).toBe(500)
  })

  it('says nothing happened for a batch that is already gone', async () => {
    const db = freshDb()
    expect(await deleteCookEvent(db, 'cook_nope')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('listing cooks', () => {
  it('gives the most recent first', async () => {
    const db = freshDb()
    await aPacket(db, 'rice-white', 5000, '2026-12-01')
    await aPacket(db, 'chicken-breast', 5000, '2026-08-25')

    const first = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      '2026-08-20T12:00:00.000Z',
    )
    const second = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      '2026-08-22T12:00:00.000Z',
    )

    expect((await listCookEvents(db)).map((cook) => cook.id)).toEqual([
      second.cook.id,
      first.cook.id,
    ])
  })

  /*
   * This is the list that answers the question the whole phase was shaped
   * around: how Sunday's batch is found on Tuesday.
   */
  it('offers only batches with something left', async () => {
    const db = freshDb()
    await aPacket(db, 'rice-white', 5000, '2026-12-01')
    await aPacket(db, 'chicken-breast', 5000, '2026-08-25')

    const eaten = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      '2026-08-20T12:00:00.000Z',
    )
    const open = await commitCook(
      db,
      { recipe: aRecipe(), ontology: ONTOLOGY, scaleFactor: 1 },
      '2026-08-22T12:00:00.000Z',
    )
    await logCookPortion(db, { cookEventId: eaten.cook.id, fraction: 1 }, NOW)

    expect((await listOpenCooks(db)).map((cook) => cook.id)).toEqual([open.cook.id])
    // Finished, not deleted: it is still the evidence for the day it fed.
    expect(await listCookEvents(db)).toHaveLength(2)
  })
})
