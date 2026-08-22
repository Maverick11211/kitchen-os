/**
 * The version 1 -> 2 upgrade, run against a real version 1 database.
 *
 * This is the first migration this app has ever had, and it runs on a database
 * that holds the User's only copy of their data. A migration that is merely
 * plausible is not good enough: the test below builds a database exactly as
 * version 1 wrote it — no `cholesterolMg` anywhere — then opens it with today's
 * code and checks what came out the other side.
 *
 * The version 1 store layout is duplicated here on purpose. It is a historical
 * record of what was on disk, and it must NOT be updated when `db.ts` changes;
 * that would make this test agree with whatever the code does today, which is
 * the opposite of what it is for.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import Dexie from 'dexie'
import { SCHEMA_VERSION } from '../types/schema'
import { createDb, META_KEY } from './db'
import { readMeta } from './repo/meta'

let dbCounter = 0
const freshName = () => `kitchen-os-migration-test-${Date.now()}-${++dbCounter}`

/** The store layout exactly as schema version 1 shipped it. Frozen in time. */
const V1_STORES = {
  canonicalIngredients: 'id, name, category',
  products: 'id, canonicalId, name',
  lots: 'id, productId, expiresOn, acquiredOn',
  recipes: 'id, name, *cuisines',
  appliances: 'id',
  cookEvents: 'id, recipeId, cookedAt',
  consumptionEvents: 'id, consumedAt',
  leftovers: 'id, cookEventId',
  meta: '',
}

/** A MacroSet as version 1 wrote it: eight fields, no cholesterol. */
const V1_MACROS = {
  calories: 402,
  proteinG: 25,
  carbsG: 1.3,
  fatG: 33,
  fiberG: 0,
  sugarG: 0.5,
  sodiumMg: 621,
  saturatedFatG: 19,
}

/** Build and populate a database the way version 1 of the app would have. */
async function writeVersion1Database(name: string): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(1).stores(V1_STORES)
  await legacy.open()

  await legacy.table('products').add({
    id: 'prod_1',
    canonicalId: 'ground-beef-93-7',
    name: 'Organic 90/10 Ground Beef',
    macrosPer100g: { ...V1_MACROS },
    createdAt: '2026-08-20T10:00:00.000Z',
  })
  await legacy.table('lots').add({
    id: 'lot_1',
    productId: 'prod_1',
    initialG: 448,
    remainingG: 448,
    expiresOn: '2026-08-23',
    acquiredOn: '2026-08-20',
    depleted: false,
  })
  await legacy.table('cookEvents').add({
    id: 'cook_1',
    recipeId: 'recipe_1',
    scaleFactor: 1,
    cookedAt: '2026-08-20T18:00:00.000Z',
    deductions: [{ lotId: 'lot_1', canonicalId: 'ground-beef-93-7', grams: 200 }],
    batchMacros: { ...V1_MACROS },
    fractionConsumed: 0,
  })
  await legacy.table('consumptionEvents').add({
    id: 'ate_1',
    consumedAt: '2026-08-20T18:30:00.000Z',
    source: { type: 'cook', cookEventId: 'cook_1', fraction: 0.5 },
    macros: { ...V1_MACROS },
    label: 'Chilli',
  })
  await legacy.table('meta').put({ schemaVersion: 1, seedVersion: '2026-08-19-ontology-310' }, META_KEY)

  legacy.close()
}

// ---------------------------------------------------------------------------

describe('opening a version 1 database with today’s code', () => {
  it('fills in cholesterol on a product, leaving every other figure alone', async () => {
    const name = freshName()
    await writeVersion1Database(name)

    const db = createDb(name)
    const product = await db.products.get('prod_1')

    expect(product?.macrosPer100g.cholesterolMg).toBe(0)
    expect(product?.macrosPer100g.calories).toBe(402)
    expect(product?.macrosPer100g.saturatedFatG).toBe(19)
    expect(product?.name).toBe('Organic 90/10 Ground Beef')
    db.close()
  })

  it('fills it in on stored snapshots too, which nothing else could repair', async () => {
    const name = freshName()
    await writeVersion1Database(name)

    const db = createDb(name)

    // Cook and consumption events hold SNAPSHOTS. DECISIONS.md forbids
    // recomputing them from products, so if the migration skipped them they
    // would stay broken forever with no way back.
    expect((await db.cookEvents.get('cook_1'))?.batchMacros.cholesterolMg).toBe(0)
    expect((await db.consumptionEvents.get('ate_1'))?.macros.cholesterolMg).toBe(0)
    db.close()
  })

  it('moves the recorded schema version forward', async () => {
    const name = freshName()
    await writeVersion1Database(name)

    const db = createDb(name)

    expect((await readMeta(db)).schemaVersion).toBe(SCHEMA_VERSION)
    // and does not lose what else was in there
    expect((await readMeta(db)).seedVersion).toBe('2026-08-19-ontology-310')
    db.close()
  })

  it('leaves rows with nothing to migrate untouched', async () => {
    const name = freshName()
    await writeVersion1Database(name)

    const db = createDb(name)
    const lot = await db.lots.get('lot_1')

    expect(lot?.remainingG).toBe(448)
    expect(lot?.expiresOn).toBe('2026-08-23')
    db.close()
  })

  it('is safe to open twice — the second open changes nothing', async () => {
    const name = freshName()
    await writeVersion1Database(name)

    const first = createDb(name)
    await first.open()
    first.close()

    const second = createDb(name)
    expect((await second.products.get('prod_1'))?.macrosPer100g.cholesterolMg).toBe(0)
    expect(await second.products.count()).toBe(1)
    second.close()
  })
})

// ---------------------------------------------------------------------------
// Version 2 -> 3
// ---------------------------------------------------------------------------

/**
 * The version 2 store layout, frozen the same way V1_STORES is.
 *
 * Identical to version 1's: neither bump has added a table or an index, only
 * fields inside the stored objects. It is written out again rather than reusing
 * the constant above so that changing one cannot silently change the other —
 * they are two historical records that happen to match today, not one fact.
 */
const V2_STORES = {
  canonicalIngredients: 'id, name, category',
  products: 'id, canonicalId, name',
  lots: 'id, productId, expiresOn, acquiredOn',
  recipes: 'id, name, *cuisines',
  appliances: 'id',
  cookEvents: 'id, recipeId, cookedAt',
  consumptionEvents: 'id, consumedAt',
  leftovers: 'id, cookEventId',
  meta: '',
}

/** A MacroSet as version 2 wrote it: nine fields, cholesterol included. */
const V2_MACROS = { ...V1_MACROS, cholesterolMg: 88 }

/** Build and populate a database the way version 2 of the app would have. */
async function writeVersion2Database(name: string): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(1).stores(V1_STORES)
  legacy.version(2).stores(V2_STORES)
  await legacy.open()

  await legacy.table('products').add({
    id: 'prod_2',
    canonicalId: 'tortilla-flour',
    name: 'Mission Flour Tortillas',
    macrosPer100g: { ...V2_MACROS },
    packageSizeG: 413,
    createdAt: '2026-08-20T10:00:00.000Z',
  })
  await legacy.table('consumptionEvents').add({
    id: 'ate_2',
    consumedAt: '2026-08-20T18:30:00.000Z',
    source: { type: 'ingredient', canonicalId: 'tortilla-flour', grams: 69 },
    macros: { ...V2_MACROS },
    label: 'Mission Flour Tortillas',
  })
  await legacy.table('meta').put({ schemaVersion: 2, seedVersion: '2026-08-19-ontology-310' }, META_KEY)

  legacy.close()
}

describe('opening a version 2 database with today’s code', () => {
  it('moves the recorded schema version forward', async () => {
    const name = freshName()
    await writeVersion2Database(name)

    const db = createDb(name)
    expect((await readMeta(db)).schemaVersion).toBe(SCHEMA_VERSION)
    expect((await readMeta(db)).seedVersion).toBe('2026-08-19-ontology-310')
    db.close()
  })

  /*
   * The point of version 3. Both fields it adds are optional, and an entry
   * logged before meals existed genuinely has no meal — so the migration must
   * leave it ABSENT rather than inventing "snack" to make the column look full.
   * `consumptionEvents` is the table DECISIONS.md promises never to rewrite,
   * which makes an invented value here worse than a missing one.
   */
  it('invents no meal on an entry logged before meals existed', async () => {
    const name = freshName()
    await writeVersion2Database(name)

    const db = createDb(name)
    const event = await db.consumptionEvents.get('ate_2')

    expect(event).toBeDefined()
    expect(event && 'meal' in event).toBe(false)
    expect(event?.macros.cholesterolMg).toBe(88)
    expect(event?.label).toBe('Mission Flour Tortillas')
    db.close()
  })

  it('invents no pack count on a product entered before counts existed', async () => {
    const name = freshName()
    await writeVersion2Database(name)

    const db = createDb(name)
    const product = await db.products.get('prod_2')

    expect(product && 'unitsPerPackage' in product).toBe(false)
    // and leaves what WAS there alone
    expect(product?.packageSizeG).toBe(413)
    expect(product?.macrosPer100g.cholesterolMg).toBe(88)
    db.close()
  })

  it('is safe to open twice', async () => {
    const name = freshName()
    await writeVersion2Database(name)

    const first = createDb(name)
    await first.open()
    first.close()

    const second = createDb(name)
    expect((await readMeta(second)).schemaVersion).toBe(SCHEMA_VERSION)
    expect(await second.products.count()).toBe(1)
    second.close()
  })
})

// ---------------------------------------------------------------------------
// Version 3 -> 4
// ---------------------------------------------------------------------------

/**
 * The version 3 store layout, frozen like the two above it.
 *
 * Still identical to version 1's. Four bumps and no table or index has changed
 * — every one of them has added optional fields inside stored objects.
 */
const V3_STORES = {
  canonicalIngredients: 'id, name, category',
  products: 'id, canonicalId, name',
  lots: 'id, productId, expiresOn, acquiredOn',
  recipes: 'id, name, *cuisines',
  appliances: 'id',
  cookEvents: 'id, recipeId, cookedAt',
  consumptionEvents: 'id, consumedAt',
  leftovers: 'id, cookEventId',
  meta: '',
}

/** Build and populate a database the way version 3 of the app would have. */
async function writeVersion3Database(name: string): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(1).stores(V1_STORES)
  legacy.version(2).stores(V2_STORES)
  legacy.version(3).stores(V3_STORES)
  await legacy.open()

  // Version 3 knew about appliances, but not about sizes and not about
  // cookware. These two rows are exactly what it could have written.
  await legacy.table('appliances').add({ id: 'oven', name: 'Oven', owned: true })
  await legacy.table('appliances').add({ id: 'grill-bbq', name: 'Barbecue', owned: false })
  await legacy.table('meta').put(
    { schemaVersion: 3, seedVersion: '2026-08-19-ontology-310', lastExportAt: '2026-08-21T09:00:00.000Z' },
    META_KEY,
  )

  legacy.close()
}

describe('opening a version 3 database with today’s code', () => {
  it('moves the recorded schema version forward and leaves the rest alone', async () => {
    const name = freshName()
    await writeVersion3Database(name)

    const db = createDb(name)
    const meta = await readMeta(db)
    expect(meta.schemaVersion).toBe(SCHEMA_VERSION)
    expect(meta.seedVersion).toBe('2026-08-19-ontology-310')
    expect(meta.lastExportAt).toBe('2026-08-21T09:00:00.000Z')
    db.close()
  })

  /*
   * The point of version 4. `kitSetUpAt` absent is what makes the app ask what
   * he cooks with — so a migration that stamped it would silence a question he
   * has never been asked, permanently and invisibly.
   */
  it('does not pretend he has been asked about his kit', async () => {
    const name = freshName()
    await writeVersion3Database(name)

    const db = createDb(name)
    const meta = await readMeta(db)
    expect('kitSetUpAt' in meta).toBe(false)
    db.close()
  })

  it('keeps the appliance answers he had already given, without inventing sizes', async () => {
    const name = freshName()
    await writeVersion3Database(name)

    const db = createDb(name)
    const oven = await db.appliances.get('oven')
    const bbq = await db.appliances.get('grill-bbq')

    expect(oven?.owned).toBe(true)
    expect(bbq?.owned).toBe(false)
    // No size on either: he was never asked how big his oven is.
    expect(oven && 'size' in oven).toBe(false)
    db.close()
  })

  it('is safe to open twice', async () => {
    const name = freshName()
    await writeVersion3Database(name)

    const first = createDb(name)
    await first.open()
    first.close()

    const second = createDb(name)
    expect((await readMeta(second)).schemaVersion).toBe(SCHEMA_VERSION)
    expect(await second.appliances.count()).toBe(2)
    second.close()
  })
})
