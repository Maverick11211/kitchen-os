/**
 * The startup seed merge, against a real (in-memory) IndexedDB.
 *
 * The merge algorithm itself is tested in `src/engine/seed-merge.test.ts`. What
 * is tested here is the part the engine cannot cover: that the result actually
 * reaches storage, that the version stamp and the ingredients move together, and
 * that running it twice does nothing the second time.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import type { CanonicalIngredient } from '../types/schema'
import { SCHEMA_VERSION } from '../types/schema'
import { BUNDLED_ONTOLOGY, BUNDLED_SEED_VERSION } from '../data/bundled'
import { createDb, type KitchenOsDb } from './db'
import { readMeta } from './repo/meta'
import { runStartupSeedMerge } from './seed'

let dbCounter = 0
function freshDb(): KitchenOsDb {
  return createDb(`kitchen-os-seed-test-${Date.now()}-${++dbCounter}`)
}

function entry(id: string, overrides: Partial<CanonicalIngredient> = {}): CanonicalIngredient {
  return {
    id,
    name: id,
    category: 'other',
    trackBy: 'mass',
    tracked: true,
    perishable: false,
    isSeed: true,
    aliases: [],
    ...overrides,
  }
}

const V1 = 'test-v1'
const V2 = 'test-v2'

// ---------------------------------------------------------------------------

describe('runStartupSeedMerge — first run', () => {
  it('seeds an empty database and records the version', async () => {
    const db = freshDb()
    const bundle = [entry('salt'), entry('flour')]

    const outcome = await runStartupSeedMerge(db, bundle, V1)

    expect(outcome.ran).toBe(true)
    expect(outcome.result?.added).toEqual(['salt', 'flour'])
    expect(await db.canonicalIngredients.count()).toBe(2)
    expect((await readMeta(db)).seedVersion).toBe(V1)
    db.close()
  })

  it('seeds the real bundled ontology, every entry marked as seed', async () => {
    const db = freshDb()

    // Pinned on purpose. If ontology.json grows and this fails, the fix is to
    // update the number here AND bump BUNDLED_SEED_VERSION — without the bump,
    // `needsSeedMerge` never fires and the new entries silently never reach a
    // device that already ran an earlier build.
    expect(BUNDLED_ONTOLOGY).toHaveLength(310)

    const outcome = await runStartupSeedMerge(db)

    expect(outcome.ran).toBe(true)
    expect(await db.canonicalIngredients.count()).toBe(BUNDLED_ONTOLOGY.length)
    const stored = await db.canonicalIngredients.toArray()
    expect(stored.every((item) => item.isSeed)).toBe(true)
    expect((await readMeta(db)).seedVersion).toBe(BUNDLED_SEED_VERSION)
    db.close()
  })

  it('leaves schemaVersion at the default rather than inventing one', async () => {
    const db = freshDb()
    await runStartupSeedMerge(db, [entry('salt')], V1)
    expect((await readMeta(db)).schemaVersion).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe('runStartupSeedMerge — repeat runs', () => {
  it('does nothing the second time the same version is seen', async () => {
    const db = freshDb()
    const bundle = [entry('salt')]

    await runStartupSeedMerge(db, bundle, V1)
    const second = await runStartupSeedMerge(db, bundle, V1)

    expect(second.ran).toBe(false)
    expect(second.result).toBeNull()
    expect(await db.canonicalIngredients.count()).toBe(1)
    db.close()
  })

  it('folds in new entries when the bundle version changes', async () => {
    const db = freshDb()
    await runStartupSeedMerge(db, [entry('salt')], V1)

    const outcome = await runStartupSeedMerge(db, [entry('salt'), entry('pepper')], V2)

    expect(outcome.ran).toBe(true)
    expect(outcome.result?.added).toEqual(['pepper'])
    expect(await db.canonicalIngredients.count()).toBe(2)
    expect((await readMeta(db)).seedVersion).toBe(V2)
    db.close()
  })

  it('updates a seed entry whose bundled version changed', async () => {
    const db = freshDb()
    await runStartupSeedMerge(db, [entry('flour', { cupWeightG: 120 })], V1)

    await runStartupSeedMerge(db, [entry('flour', { cupWeightG: 125 })], V2)

    expect((await db.canonicalIngredients.get('flour'))?.cupWeightG).toBe(125)
    db.close()
  })
})

describe("runStartupSeedMerge — the User's own entries", () => {
  it('never overwrites an entry the User created, even on an id collision', async () => {
    const db = freshDb()
    await db.canonicalIngredients.add(
      entry('gochujang', { isSeed: false, name: 'Gochujang', cupWeightG: 300 }),
    )

    const outcome = await runStartupSeedMerge(
      db,
      [entry('gochujang', { name: 'Gochujang (bundled)', cupWeightG: 275 })],
      V1,
    )

    const stored = await db.canonicalIngredients.get('gochujang')
    expect(stored?.name).toBe('Gochujang')
    expect(stored?.cupWeightG).toBe(300)
    expect(stored?.isSeed).toBe(false)
    expect(outcome.result?.skippedUserOwned).toEqual(['gochujang'])
    db.close()
  })

  it('carries the User’s unrelated entries through untouched', async () => {
    const db = freshDb()
    await runStartupSeedMerge(db, [entry('salt')], V1)
    await db.canonicalIngredients.add(entry('nduja', { isSeed: false, name: 'Nduja' }))

    const outcome = await runStartupSeedMerge(db, [entry('salt'), entry('pepper')], V2)

    expect(outcome.result?.retainedUserAdded).toEqual(['nduja'])
    expect(await db.canonicalIngredients.get('nduja')).toBeDefined()
    db.close()
  })

  it('keeps a seed entry the bundle has dropped, so nothing is orphaned', async () => {
    const db = freshDb()
    await runStartupSeedMerge(db, [entry('salt'), entry('kohlrabi')], V1)

    const outcome = await runStartupSeedMerge(db, [entry('salt')], V2)

    expect(outcome.result?.retainedMissing).toEqual(['kohlrabi'])
    expect(await db.canonicalIngredients.get('kohlrabi')).toBeDefined()
    db.close()
  })
})

describe('runStartupSeedMerge — all or nothing', () => {
  it('does not record the version when the ingredients fail to write', async () => {
    const db = freshDb()
    vi.spyOn(db.canonicalIngredients, 'bulkPut').mockRejectedValue(new Error('disk full'))

    await expect(runStartupSeedMerge(db, [entry('salt')], V1)).rejects.toThrow()

    expect((await readMeta(db)).seedVersion).toBeUndefined()
    vi.restoreAllMocks()
    db.close()
  })

  it('rolls the ingredients back when recording the version fails', async () => {
    const db = freshDb()
    vi.spyOn(db.meta, 'put').mockRejectedValue(new Error('disk full'))

    await expect(runStartupSeedMerge(db, [entry('salt')], V1)).rejects.toThrow()

    // The important half: a failure here must not leave a partly-merged
    // ingredient list behind, because the next launch would see no stored
    // version, merge again, and have to be correct anyway.
    expect(await db.canonicalIngredients.count()).toBe(0)
    vi.restoreAllMocks()
    db.close()
  })
})
