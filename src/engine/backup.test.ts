import { describe, it, expect } from 'vitest'
import type { BackupFile, MacroSet } from '../types/schema'
import { SCHEMA_VERSION } from '../types/schema'
import {
  buildBackupFile,
  describeBackupContents,
  parseBackupFile,
  validateBackupFile,
  type BackupContents,
} from './backup'

const EXPORTED_AT = '2026-08-19T12:00:00.000Z'

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

function emptyContents(): BackupContents {
  return {
    canonicalIngredients: [],
    products: [],
    lots: [],
    recipes: [],
    appliances: [],
    cookEvents: [],
    consumptionEvents: [],
    leftovers: [],
    meta: { schemaVersion: SCHEMA_VERSION },
  }
}

function populatedContents(): BackupContents {
  return {
    ...emptyContents(),
    canonicalIngredients: [
      {
        id: 'cheddar-shredded',
        name: 'Cheddar, shredded',
        category: 'dairy',
        trackBy: 'mass',
        tracked: true,
        perishable: true,
        aliases: [],
        isSeed: true,
      },
    ],
    products: [
      {
        id: 'prod_1',
        canonicalId: 'cheddar-shredded',
        name: 'Kroger Sharp Cheddar',
        macrosPer100g: MACROS,
        createdAt: EXPORTED_AT,
      },
    ],
    lots: [
      {
        id: 'lot_1',
        productId: 'prod_1',
        initialG: 226,
        remainingG: 226,
        expiresOn: '2026-09-01',
        acquiredOn: '2026-08-19',
        depleted: false,
      },
    ],
  }
}

const goodBackup = (): BackupFile => buildBackupFile(populatedContents(), EXPORTED_AT)

/** A backup as it arrives from a file: parsed JSON, no type information. */
const asParsed = (backup: BackupFile): unknown => JSON.parse(JSON.stringify(backup))

function errorsFor(value: unknown): readonly string[] {
  const result = validateBackupFile(value)
  return result.ok ? [] : result.errors
}

// ---------------------------------------------------------------------------

describe('buildBackupFile', () => {
  it('stamps the version and the time, and carries every collection', () => {
    const backup = buildBackupFile(populatedContents(), EXPORTED_AT)

    expect(backup.schemaVersion).toBe(SCHEMA_VERSION)
    expect(backup.exportedAt).toBe(EXPORTED_AT)
    expect(backup.canonicalIngredients).toHaveLength(1)
    expect(backup.products).toHaveLength(1)
    expect(backup.lots).toHaveLength(1)
    expect(backup.recipes).toEqual([])
    expect(backup.meta.schemaVersion).toBe(SCHEMA_VERSION)
  })
})

describe('describeBackupContents', () => {
  it('always names the three inventory tiers', () => {
    expect(describeBackupContents(goodBackup())).toBe('1 ingredient, 1 product, 1 lot')
  })

  it('leaves out what is not there yet', () => {
    const summary = describeBackupContents(buildBackupFile(emptyContents(), EXPORTED_AT))
    expect(summary).not.toContain('recipes')
    expect(summary).not.toContain('cooks')
  })
})

describe('validateBackupFile — files it must refuse', () => {
  it('refuses things that are not backups at all', () => {
    expect(errorsFor(null)[0]).toContain('not a Kitchen OS backup')
    expect(errorsFor('hello')[0]).toContain('not a Kitchen OS backup')
    expect(errorsFor([])[0]).toContain('not a Kitchen OS backup')
  })

  it('refuses a file with no version number', () => {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    delete backup.schemaVersion
    expect(errorsFor(backup)[0]).toContain('missing its version number')
  })

  it('refuses a backup from a newer app, naming the versions', () => {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    backup.schemaVersion = SCHEMA_VERSION + 1
    const message = errorsFor(backup)[0] ?? ''
    expect(message).toContain('newer version of the app')
    expect(message).toContain('Update the app first')
  })

  it('refuses a version number that is not a real version', () => {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    backup.schemaVersion = 0
    expect(errorsFor(backup)[0]).toContain('not a real version')
  })

  it('refuses a file missing a whole collection', () => {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    delete backup.lots
    expect(errorsFor(backup)[0]).toContain('missing its lots list')
  })

  it('refuses a collection that is not a list', () => {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    backup.products = 'nope'
    expect(errorsFor(backup)[0]).toContain('missing its products list')
  })

  it('refuses records with no id, which could not be restored', () => {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    backup.lots = [{ productId: 'prod_1' }, null]
    expect(errorsFor(backup)[0]).toContain('2 entries in lots are damaged')
  })

  it('refuses repeated ids, because one would silently overwrite the other', () => {
    const backup = asParsed(goodBackup()) as unknown as BackupFile
    backup.lots = [backup.lots[0]!, backup.lots[0]!]
    expect(errorsFor(backup)[0]).toContain('1 repeated entry')
  })

  it('refuses a file with no app settings', () => {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    delete backup.meta
    expect(errorsFor(backup)[0]).toContain('missing its app settings')
  })

  it('reports every problem at once rather than one at a time', () => {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    delete backup.lots
    delete backup.meta
    expect(errorsFor(backup)).toHaveLength(2)
  })
})

describe('validateBackupFile — files it must accept', () => {
  it('accepts a well-formed backup and hands back the typed contents', () => {
    const result = validateBackupFile(asParsed(goodBackup()))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup.lots[0]?.remainingG).toBe(226)
    expect(result.warnings).toEqual([])
  })

  it('accepts an empty database — a fresh export is still a valid backup', () => {
    const result = validateBackupFile(asParsed(buildBackupFile(emptyContents(), EXPORTED_AT)))
    expect(result.ok).toBe(true)
  })
})

describe('validateBackupFile — warnings never block', () => {
  it('warns, but still accepts, when the export time is missing', () => {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    delete backup.exportedAt

    const result = validateBackupFile(backup)

    expect(result.ok).toBe(true)
    expect(result.warnings[0]).toContain('does not say when it was made')
  })

  it('warns about a lot whose product is not in the file', () => {
    const backup = asParsed(goodBackup()) as unknown as BackupFile
    backup.products = []

    const result = validateBackupFile(backup)

    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toContain('1 lot points at a missing product')
  })

  it('warns about a product whose ingredient is not in the file', () => {
    const backup = asParsed(goodBackup()) as unknown as BackupFile
    backup.canonicalIngredients = []

    const result = validateBackupFile(backup)

    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toContain('1 product points at a missing ingredient')
  })
})

describe('validateBackupFile — upgrading an older file', () => {
  /** A backup as version 1 wrote it: no cholesterol anywhere. */
  function version1Backup(): Record<string, unknown> {
    const backup = asParsed(goodBackup()) as Record<string, unknown>
    backup.schemaVersion = 1
    const products = backup.products as Record<string, Record<string, number>>[]
    delete products[0]!.macrosPer100g!.cholesterolMg
    ;(backup.meta as Record<string, unknown>).schemaVersion = 1
    return backup
  }

  it('accepts it and fills the missing field with zero', () => {
    const result = validateBackupFile(version1Backup())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup.products[0]?.macrosPer100g.cholesterolMg).toBe(0)
    expect(result.backup.schemaVersion).toBe(SCHEMA_VERSION)
    expect(result.backup.meta.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('says out loud that it converted something', () => {
    const result = validateBackupFile(version1Backup())
    expect(result.warnings.join(' ')).toContain('brought up to date')
  })

  it('leaves the figures that were there alone', () => {
    const result = validateBackupFile(version1Backup())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup.products[0]?.macrosPer100g.calories).toBe(402)
    expect(result.backup.lots[0]?.remainingG).toBe(226)
  })

  it('does not touch a file that is already current', () => {
    const result = validateBackupFile(asParsed(goodBackup()))
    expect(result.warnings).toEqual([])
  })
})

describe('parseBackupFile', () => {
  it('survives a file that is not JSON at all', () => {
    const result = parseBackupFile('this is not json {')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('not readable as a backup')
  })

  it('round-trips a real export through text unchanged', () => {
    const original = goodBackup()

    const result = parseBackupFile(JSON.stringify(original))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup).toEqual(original)
  })
})
