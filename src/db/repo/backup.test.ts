/**
 * Export and restore, against a real (in-memory) IndexedDB.
 *
 * This is the path that exists so a broken iPad is an inconvenience rather than
 * the loss of everything, so the tests are pointed at the failure modes that
 * would matter: a restore that half-completes, and a round trip that quietly
 * drops a table.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import type { MacroSet } from '../../types/schema'
import { parseBackupFile, validateBackupFile } from '../../engine'
import { createDb, type KitchenOsDb } from '../db'
import { backupFilename, readBackup, readBackupJson, restoreBackup } from './backup'
import { readMeta, writeMeta } from './meta'
import { addProduct } from './products'
import { addLot } from './lots'
import { addUserIngredient } from './ingredients'
import { runStartupSeedMerge } from '../seed'

let dbCounter = 0
function freshDb(): KitchenOsDb {
  return createDb(`kitchen-os-backup-test-${Date.now()}-${++dbCounter}`)
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
}

/** A database with a bit of everything in it. */
async function populated(): Promise<KitchenOsDb> {
  const db = freshDb()
  await runStartupSeedMerge(db)
  await addUserIngredient(db, {
    name: 'Gochujang',
    category: 'condiment',
    trackBy: 'mass',
    tracked: true,
    perishable: false,
  })
  const product = await addProduct(
    db,
    { canonicalId: 'gochujang', name: 'Chung Jung One', macrosPer100g: MACROS },
    NOW,
  )
  await addLot(db, {
    productId: product.id,
    initialG: 500,
    expiresOn: '2026-12-01',
    acquiredOn: '2026-08-19',
  })
  await addLot(db, {
    productId: product.id,
    initialG: 900,
    expiresOn: null,
    acquiredOn: '2026-08-19',
    frozen: true,
  })
  return db
}

// ---------------------------------------------------------------------------

describe('readBackup', () => {
  it('captures every table, and passes its own validation', async () => {
    const db = await populated()

    const backup = await readBackup(db, NOW)

    expect(backup.exportedAt).toBe(NOW)
    expect(backup.canonicalIngredients.length).toBe(311) // 310 bundled + 1 of the User's
    expect(backup.products).toHaveLength(1)
    expect(backup.lots).toHaveLength(2)
    expect(validateBackupFile(JSON.parse(JSON.stringify(backup))).ok).toBe(true)
    db.close()
  })

  it('carries the seed version, so a restore does not re-seed from scratch', async () => {
    const db = await populated()
    const backup = await readBackup(db, NOW)
    expect(backup.meta.seedVersion).toBeDefined()
    db.close()
  })

  it('writes readable JSON with a sortable filename', async () => {
    const db = await populated()

    const json = await readBackupJson(db, NOW)

    expect(json).toContain('\n  "schemaVersion"')
    expect(parseBackupFile(json).ok).toBe(true)
    expect(backupFilename(NOW)).toBe('kitchen-os-backup-2026-08-19T12-00-00-000Z.json')
    db.close()
  })
})

describe('restoreBackup', () => {
  it('reproduces a database exactly in a different one', async () => {
    const source = await populated()
    const backup = await readBackup(source, NOW)

    const target = freshDb()
    await restoreBackup(target, backup)

    expect(await readBackup(target, NOW)).toEqual(backup)
    source.close()
    target.close()
  })

  it('survives the trip through a file rather than only through memory', async () => {
    const source = await populated()
    const json = await readBackupJson(source, NOW)

    const parsed = parseBackupFile(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const target = freshDb()
    await restoreBackup(target, parsed.backup)

    expect(await target.canonicalIngredients.count()).toBe(311)
    expect(await target.lots.count()).toBe(2)
    // The one detail most likely to be lost in a JSON round trip.
    const lots = await target.lots.toArray()
    expect(lots.find((lot) => lot.frozen)?.initialG).toBe(900)
    expect(lots.find((lot) => lot.expiresOn === null)).toBeDefined()
    source.close()
    target.close()
  })

  it('replaces what was there rather than merging into it', async () => {
    const source = await populated()
    const backup = await readBackup(source, NOW)

    const target = freshDb()
    await addProduct(
      target,
      { canonicalId: 'ghost', name: 'Should Not Survive', macrosPer100g: MACROS },
      NOW,
    )
    await addLot(target, {
      productId: 'prod_ghost',
      initialG: 1,
      expiresOn: null,
      acquiredOn: '2026-08-01',
    })

    await restoreBackup(target, backup)

    const products = await target.products.toArray()
    expect(products).toHaveLength(1)
    expect(products[0]?.name).toBe('Chung Jung One')
    expect(await target.lots.count()).toBe(2)
    source.close()
    target.close()
  })

  it('restores the metadata from the file, not the metadata already there', async () => {
    const source = await populated()
    const backup = await readBackup(source, NOW)

    const target = freshDb()
    await writeMeta(target, { seedVersion: 'something-else', lastExportAt: '2020-01-01T00:00:00.000Z' })

    await restoreBackup(target, backup)

    expect((await readMeta(target)).seedVersion).toBe(backup.meta.seedVersion)
    source.close()
    target.close()
  })

  it('leaves the database untouched when the restore fails part-way', async () => {
    const source = await populated()
    const backup = await readBackup(source, NOW)

    const target = await populated()
    const before = await readBackup(target, NOW)
    vi.spyOn(target.lots, 'bulkAdd').mockRejectedValue(new Error('disk full'))

    await expect(restoreBackup(target, backup)).rejects.toThrow()
    vi.restoreAllMocks()

    // The clear() ran before the failure. If the transaction did not roll back,
    // the User would be left with an empty app and no way back.
    expect(await readBackup(target, NOW)).toEqual(before)
    source.close()
    target.close()
  })
})
