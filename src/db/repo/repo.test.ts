/**
 * The repository layer, against a real (in-memory) IndexedDB.
 *
 * These functions are the only things in the app allowed to write to the User's
 * only copy of their data, so the tests here are about what actually lands on
 * disk: that a rejected ingredient writes nothing, that a warning does not block
 * a save, and that a lot starts full.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import type { MacroSet } from '../../types/schema'
import { createDb, type KitchenOsDb } from '../db'
import { defaultMeta, markExported, readMeta, writeMeta } from './meta'
import { addUserIngredient, listIngredients } from './ingredients'
import { addProduct, productsForCanonical } from './products'
import { addLot, deleteLot, lotsForProduct } from './lots'

let dbCounter = 0
function freshDb(): KitchenOsDb {
  return createDb(`kitchen-os-repo-test-${Date.now()}-${++dbCounter}`)
}

const NOW = '2026-08-19T12:00:00.000Z'

const MACROS: MacroSet = {
  calories: 402,
  proteinG: 25,
  carbsG: 1.3,
  fatG: 33,
  fiberG: 0,
  sugarG: 0.5,
  sodiumMg: 621,
  saturatedFatG: 19,
  cholesterolMg: 0,
}

// A draft with no cup weight, which the engine accepts with a warning.
const GOCHUJANG = {
  name: 'Gochujang',
  category: 'condiment',
  trackBy: 'mass',
  tracked: true,
  perishable: false,
} as const

// ---------------------------------------------------------------------------

describe('meta', () => {
  it('reads defaults from a database that has never been written', async () => {
    const db = freshDb()
    const meta = await readMeta(db)
    expect(meta).toEqual(defaultMeta())
    expect(meta.seedVersion).toBeUndefined()
    db.close()
  })

  it('merges rather than replaces, so one field cannot blank another', async () => {
    const db = freshDb()
    await writeMeta(db, { seedVersion: 'v1' })
    await markExported(db, NOW)

    const meta = await readMeta(db)
    expect(meta.seedVersion).toBe('v1')
    expect(meta.lastExportAt).toBe(NOW)
    db.close()
  })

  it('does not leak its storage key into the returned metadata', async () => {
    const db = freshDb()
    await writeMeta(db, { seedVersion: 'v1' })
    expect(Object.keys(await readMeta(db))).not.toContain('key')
    db.close()
  })
})

describe('addUserIngredient', () => {
  it('stores a valid ingredient as the User’s own, with a slug id', async () => {
    const db = freshDb()

    const result = await addUserIngredient(db, GOCHUJANG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ingredient.id).toBe('gochujang')
    expect(result.ingredient.isSeed).toBe(false)
    expect(await db.canonicalIngredients.get('gochujang')).toBeDefined()
    db.close()
  })

  it('saves despite a warning, and hands the warning back to be shown', async () => {
    const db = freshDb()

    const result = await addUserIngredient(db, GOCHUJANG)

    // No cup weight: usable, but it can never be measured in cups. A warning
    // must never block the save (DECISIONS.md).
    expect(result.warnings.map((issue) => issue.field)).toContain('cupWeightG')
    expect(await db.canonicalIngredients.count()).toBe(1)
    db.close()
  })

  it('writes nothing when the draft is rejected', async () => {
    const db = freshDb()
    await addUserIngredient(db, GOCHUJANG)

    const result = await addUserIngredient(db, { ...GOCHUJANG, name: 'gochujang' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.field).toBe('name')
    expect(await db.canonicalIngredients.count()).toBe(1)
    db.close()
  })

  it('never reuses an id, because ids are foreign keys for real inventory', async () => {
    const db = freshDb()
    await addUserIngredient(db, GOCHUJANG)

    // A different name that slugifies to the same id.
    const result = await addUserIngredient(db, { ...GOCHUJANG, name: 'Gochujang!' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ingredient.id).toBe('gochujang-2')
    expect(await db.canonicalIngredients.count()).toBe(2)
    db.close()
  })

  it('lists ingredients by name', async () => {
    const db = freshDb()
    await addUserIngredient(db, { ...GOCHUJANG, name: 'Zaatar' })
    await addUserIngredient(db, { ...GOCHUJANG, name: 'Ajvar' })

    expect((await listIngredients(db)).map((item) => item.name)).toEqual(['Ajvar', 'Zaatar'])
    db.close()
  })
})

describe('addProduct', () => {
  it('assigns an id and stamps the time it was passed', async () => {
    const db = freshDb()

    const product = await addProduct(
      db,
      { canonicalId: 'cheddar-shredded', name: 'Kroger Sharp Cheddar', macrosPer100g: MACROS },
      NOW,
    )

    expect(product.id).toMatch(/^prod_/)
    expect(product.createdAt).toBe(NOW)
    expect(await db.products.get(product.id)).toEqual(product)
    db.close()
  })

  it('finds every product recorded for one canonical ingredient', async () => {
    const db = freshDb()
    const base = { macrosPer100g: MACROS }
    await addProduct(db, { ...base, canonicalId: 'cheddar-shredded', name: 'Kroger' }, NOW)
    await addProduct(db, { ...base, canonicalId: 'cheddar-shredded', name: 'Tillamook' }, NOW)
    await addProduct(db, { ...base, canonicalId: 'butter', name: 'Kerrygold' }, NOW)

    const found = await productsForCanonical(db, 'cheddar-shredded')
    expect(found.map((item) => item.name).sort()).toEqual(['Kroger', 'Tillamook'])
    db.close()
  })
})

describe('addLot', () => {
  it('starts full and not depleted', async () => {
    const db = freshDb()

    const lot = await addLot(db, {
      productId: 'prod_1',
      initialG: 226,
      expiresOn: '2026-09-01',
      acquiredOn: '2026-08-19',
    })

    expect(lot.remainingG).toBe(226)
    expect(lot.depleted).toBe(false)
    expect(lot.id).toMatch(/^lot_/)
    db.close()
  })

  it('round-trips the frozen flag', async () => {
    const db = freshDb()

    const lot = await addLot(db, {
      productId: 'prod_1',
      initialG: 900,
      expiresOn: null,
      acquiredOn: '2026-08-19',
      frozen: true,
    })

    expect((await db.lots.get(lot.id))?.frozen).toBe(true)
    db.close()
  })

  it('treats a lot with no frozen flag as not frozen', async () => {
    const db = freshDb()

    const lot = await addLot(db, {
      productId: 'prod_1',
      initialG: 500,
      expiresOn: '2026-08-21',
      acquiredOn: '2026-08-19',
    })

    expect((await db.lots.get(lot.id))?.frozen).toBeUndefined()
    db.close()
  })

  it('refuses a quantity that cannot be real', async () => {
    const db = freshDb()
    const base = { productId: 'prod_1', expiresOn: null, acquiredOn: '2026-08-19' }

    await expect(addLot(db, { ...base, initialG: 0 })).rejects.toThrow(RangeError)
    await expect(addLot(db, { ...base, initialG: -5 })).rejects.toThrow(RangeError)
    await expect(addLot(db, { ...base, initialG: Number.NaN })).rejects.toThrow(RangeError)
    expect(await db.lots.count()).toBe(0)
    db.close()
  })

  it('finds every lot of one product', async () => {
    const db = freshDb()
    const base = { expiresOn: null, acquiredOn: '2026-08-19' }
    await addLot(db, { ...base, productId: 'prod_1', initialG: 100 })
    await addLot(db, { ...base, productId: 'prod_1', initialG: 200 })
    await addLot(db, { ...base, productId: 'prod_2', initialG: 300 })

    expect(await lotsForProduct(db, 'prod_1')).toHaveLength(2)
    db.close()
  })
})

/**
 * Throwing a packet out. Jack, 2026-08-20: an expired thing goes in the bin and
 * that is not an undo, so it leaves rather than joining the emptied list.
 */
describe('deleteLot', () => {
  const base = { expiresOn: null, acquiredOn: '2026-08-19' }

  it('removes the packet and leaves the others alone', async () => {
    const db = freshDb()
    const binned = await addLot(db, { ...base, productId: 'prod_1', initialG: 100 })
    const kept = await addLot(db, { ...base, productId: 'prod_1', initialG: 200 })

    await deleteLot(db, binned.id)

    expect(await db.lots.get(binned.id)).toBeUndefined()
    expect((await db.lots.get(kept.id))?.remainingG).toBe(200)
    db.close()
  })

  it('is happy to be asked twice', async () => {
    const db = freshDb()
    const lot = await addLot(db, { ...base, productId: 'prod_1', initialG: 100 })

    await deleteLot(db, lot.id)
    // A stale screen can ask again, and it means the same thing both times.
    await expect(deleteLot(db, lot.id)).resolves.toBeUndefined()
    db.close()
  })
})
