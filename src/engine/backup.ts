/**
 * Kitchen OS — Backup files
 *
 * Browser storage is the only copy of the User's data (CLAUDE.md), which makes
 * export a v1 requirement rather than a nicety. This module is the pure half of
 * it: assembling a `BackupFile` and deciding whether a file handed back to the
 * app is safe to restore from. Reading and writing the database is
 * `src/db/repo/backup.ts`; choosing a file and downloading one is the UI.
 *
 * Validation follows the same shape as `ingredients.ts`: errors block, warnings
 * do not. An error means restoring would lose or corrupt data. A warning means
 * the file is restorable but something in it looks odd, and the User should get
 * to decide — refusing outright would be worse, because the alternative to a
 * slightly odd backup is usually no backup at all.
 *
 * No clock is read here. `exportedAt` is a parameter, as everywhere in the
 * engine.
 */
import type { BackupFile } from '../types/schema'
import { SCHEMA_VERSION } from '../types/schema'

/** Everything a backup holds, minus the two fields the export itself stamps. */
export type BackupContents = Omit<BackupFile, 'schemaVersion' | 'exportedAt'>

/**
 * The collections that hold records with ids.
 *
 * Derived from `BackupFile` via the type below, so adding a collection to the
 * schema and forgetting it here is a compile error rather than a backup that
 * quietly omits the new table.
 */
export const BACKUP_COLLECTIONS = [
  'canonicalIngredients',
  'products',
  'lots',
  'recipes',
  'appliances',
  'cookEvents',
  'consumptionEvents',
  'leftovers',
] as const satisfies readonly (keyof BackupContents)[]

export type BackupCollection = (typeof BACKUP_COLLECTIONS)[number]

/**
 * Compile-time check that no collection is missing from the list above.
 *
 * `satisfies` on its own only catches a name that should not be there. This
 * catches the dangerous direction: adding a table to `BackupFile` and
 * forgetting it here, which would produce backups that silently omit it. If
 * this line goes red, add the missing name to `BACKUP_COLLECTIONS`.
 */
type UnlistedCollection = Exclude<keyof BackupContents, BackupCollection | 'meta'>
const everyCollectionIsListed: [UnlistedCollection] extends [never] ? true : false = true
void everyCollectionIsListed

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Assemble a backup file from the current contents of the database.
 *
 * `schemaVersion` is the version of the app that wrote the file, which is what
 * a future import needs in order to know whether it must convert anything.
 */
export function buildBackupFile(contents: BackupContents, exportedAt: string): BackupFile {
  return { schemaVersion: SCHEMA_VERSION, exportedAt, ...contents }
}

/** Counts, for the confirmation the User sees before overwriting everything. */
export function describeBackupContents(backup: BackupFile): string {
  const parts = [
    count(backup.canonicalIngredients.length, 'ingredient', 'ingredients'),
    count(backup.products.length, 'product', 'products'),
    count(backup.lots.length, 'lot', 'lots'),
  ]
  if (backup.recipes.length > 0) {
    parts.push(count(backup.recipes.length, 'recipe', 'recipes'))
  }
  if (backup.cookEvents.length > 0) {
    parts.push(count(backup.cookEvents.length, 'cook', 'cooks'))
  }
  if (backup.consumptionEvents.length > 0) {
    parts.push(count(backup.consumptionEvents.length, 'logged item', 'logged items'))
  }
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type BackupValidation =
  | { readonly ok: true; readonly backup: BackupFile; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[]; readonly warnings: readonly string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** "1 entry" / "2 entries". These messages are shown to the User as written. */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

function idsOf(rows: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const row of rows) {
    if (isRecord(row) && typeof row.id === 'string') ids.push(row.id)
  }
  return ids
}

function referenceWarning(
  rows: readonly unknown[],
  field: string,
  known: ReadonlySet<string>,
  singular: string,
  plural: string,
  target: string,
): string | null {
  let orphaned = 0
  for (const row of rows) {
    if (!isRecord(row)) continue
    const reference = row[field]
    if (typeof reference === 'string' && !known.has(reference)) orphaned += 1
  }
  if (orphaned === 0) return null
  const verb = orphaned === 1 ? 'points' : 'point'
  return `${count(orphaned, singular, plural)} ${verb} at a ${target} that is not in this file. They will be restored but will not show up properly.`
}

/**
 * Decide whether an arbitrary parsed JSON value is a backup this app can
 * restore from.
 *
 * Deliberately strict about the schema version. Only an exact match is
 * accepted, because there is no migration machinery yet — silently restoring a
 * file written under different rules is exactly the kind of failure that
 * destroys data without throwing. When `SCHEMA_VERSION` is first bumped, the
 * conversion belongs here, in place of the mismatch error.
 */
export function validateBackupFile(value: unknown): BackupValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isRecord(value)) {
    return { ok: false, errors: ['That file is not a Kitchen OS backup.'], warnings }
  }

  // --- version --------------------------------------------------------------
  const version = value.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    errors.push('That file is missing its version number, so it may not be a Kitchen OS backup.')
  } else if (version > SCHEMA_VERSION) {
    errors.push(
      `That backup was made by a newer version of the app (data version ${version}, this app reads ${SCHEMA_VERSION}). Update the app first.`,
    )
  } else if (version < SCHEMA_VERSION) {
    errors.push(
      `That backup was made by an older version of the app (data version ${version}, this app reads ${SCHEMA_VERSION}) and cannot be converted yet.`,
    )
  }

  if (typeof value.exportedAt !== 'string' || value.exportedAt === '') {
    warnings.push('That backup does not say when it was made.')
  }

  // --- collections ----------------------------------------------------------
  for (const key of BACKUP_COLLECTIONS) {
    const rows = value[key]
    if (!Array.isArray(rows)) {
      errors.push(`That backup is missing its ${key} list, so it is incomplete.`)
      continue
    }

    const withoutId = rows.filter((row) => !isRecord(row) || typeof row.id !== 'string').length
    if (withoutId > 0) {
      errors.push(
        `${count(withoutId, 'entry', 'entries')} in ${key} ${withoutId === 1 ? 'is' : 'are'} damaged and cannot be restored.`,
      )
      continue
    }

    // A duplicate id is not survivable: the second row would overwrite the
    // first on restore, losing one silently.
    const ids = idsOf(rows)
    const duplicates = ids.length - new Set(ids).size
    if (duplicates > 0) {
      errors.push(
        `${key} contains ${count(duplicates, 'repeated entry', 'repeated entries')}, so that file is damaged.`,
      )
    }
  }

  // --- metadata -------------------------------------------------------------
  const meta = value.meta
  if (!isRecord(meta) || typeof meta.schemaVersion !== 'number') {
    errors.push('That backup is missing its app settings.')
  }

  if (errors.length > 0) return { ok: false, errors, warnings }

  // --- cross-references (never blocking) ------------------------------------
  const backup = value as unknown as BackupFile
  const ingredientIds = new Set(backup.canonicalIngredients.map((item) => item.id))
  const productIds = new Set(backup.products.map((item) => item.id))

  const productWarning = referenceWarning(
    backup.products,
    'canonicalId',
    ingredientIds,
    'product',
    'products',
    'missing ingredient',
  )
  if (productWarning) warnings.push(productWarning)

  const lotWarning = referenceWarning(
    backup.lots,
    'productId',
    productIds,
    'lot',
    'lots',
    'missing product',
  )
  if (lotWarning) warnings.push(lotWarning)

  return { ok: true, backup, warnings }
}

/** Convenience for the import flow: parse text, then validate it. */
export function parseBackupFile(text: string): BackupValidation {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['That file is not readable as a backup.'], warnings: [] }
  }
  return validateBackupFile(parsed)
}
