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

// ---------------------------------------------------------------------------
// Upgrading older files
// ---------------------------------------------------------------------------

/** Add the cholesterol field to one stored MacroSet. Version 1 -> 2. */
function withCholesterol(macros: unknown): unknown {
  if (!isRecord(macros)) return macros
  if (typeof macros.cholesterolMg === 'number') return macros
  return { ...macros, cholesterolMg: 0 }
}

function mapMacrosOn(rows: unknown, field: string): unknown {
  if (!Array.isArray(rows)) return rows
  return rows.map((row) => (isRecord(row) ? { ...row, [field]: withCholesterol(row[field]) } : row))
}

/** Give every stored cook event the name field it predates. Version 4 -> 5. */
function withCookLabels(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows
  return rows.map((row) => {
    if (!isRecord(row)) return row
    if (typeof row.label === 'string' && row.label !== '') return row
    const fallback = typeof row.recipeId === 'string' ? row.recipeId : 'A cooked batch'
    return { ...row, label: fallback }
  })
}

/**
 * Convert a backup written by an older version of the app into today's shape.
 *
 * Works on the raw parsed JSON rather than on a typed `BackupFile`, because the
 * whole point is that it does NOT match today's types yet — claiming otherwise
 * to the compiler would defeat the check that matters.
 *
 * Steps are cumulative and run in order, so a version 1 file passing through a
 * future version 4 app goes 1 -> 2 -> 3 -> 4. Add the next step here when
 * `SCHEMA_VERSION` next moves.
 */
function upgradeBackup(value: Record<string, unknown>, from: number): Record<string, unknown> {
  let current = value

  if (from < 2) {
    // Version 2 added MacroSet.cholesterolMg. Same backfill as the database
    // migration in src/db/db.ts, and for the same reason: a MacroSet missing a
    // field breaks every sum it takes part in.
    current = {
      ...current,
      products: mapMacrosOn(current.products, 'macrosPer100g'),
      cookEvents: mapMacrosOn(current.cookEvents, 'batchMacros'),
      consumptionEvents: mapMacrosOn(current.consumptionEvents, 'macros'),
    }
  }

  if (from < 3) {
    // Version 3 added ConsumptionEvent.meal and Product.unitsPerPackage, both
    // optional. Nothing to convert: absent is what those fields mean on a row
    // written before they existed, and the same reasoning as the database
    // migration applies — an invented meal in a restored backup would be
    // indistinguishable from one the User typed.
  }

  if (from < 4) {
    // Version 4 added Appliance.size and AppMeta.kitSetUpAt, when the appliance
    // question grew into the kit list. Nothing to convert — but note what
    // restoring an older file therefore does: `kitSetUpAt` comes back absent,
    // so the kit questions appear again afterwards. That is correct rather than
    // annoying. The file predates the question and genuinely holds no answer,
    // and asking is cheaper than assuming.
  }

  if (from < 5) {
    // Version 5 added CookEvent.label and ConsumptionSource.deductions.
    //
    // `deductions` is optional and is left absent, which every reader treats as
    // "fall back to grams" — the behaviour the file was written under.
    //
    // `label` is required, so it is filled in here rather than left to break a
    // reader. No file from an older app can actually contain a cook event —
    // nothing wrote one before this version — but a backup is a file that could
    // say anything, and this is the same defensive reasoning `combineRecipes`
    // uses when it forces `isSeed`. The recipe id is the only name available.
    current = { ...current, cookEvents: withCookLabels(current.cookEvents) }
  }

  const meta = isRecord(current.meta)
    ? { ...current.meta, schemaVersion: SCHEMA_VERSION }
    : current.meta

  return { ...current, schemaVersion: SCHEMA_VERSION, meta }
}

/**
 * What changed between a file's version and today's, in words a person can act
 * on.
 *
 * Kept beside `upgradeBackup` because the two go stale together: a step added
 * there without a note here produces a restore that quietly claims to have done
 * something else. The old message said every old file had its cholesterol
 * filled in, which stopped being true the moment version 3 existed.
 */
function upgradeNotes(from: number): string[] {
  const notes: string[] = []
  if (from < 2) {
    notes.push('cholesterol reads as 0 on anything saved before the app started asking for it')
  }
  if (from < 3) {
    notes.push('entries from before have no meal on them, and products no pack count')
  }
  if (from < 4) {
    notes.push('the app will ask again what you cook with, since the file was saved before it asked')
  }
  if (from < 5) {
    notes.push('anything cooked before the file was saved is named by its recipe id rather than its title')
  }
  return notes
}

/**
 * Decide whether an arbitrary parsed JSON value is a backup this app can
 * restore from, upgrading it if it is older.
 *
 * A file from a NEWER app is refused outright rather than restored partially —
 * this app cannot know what that version added, so anything it wrote through
 * would be guesswork, and guessing is how a restore destroys data without ever
 * throwing. Older files are converted explicitly, step by step, and the
 * conversion is reported as a warning so it is never silent.
 */
export function validateBackupFile(value: unknown): BackupValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isRecord(value)) {
    return { ok: false, errors: ['That file is not a Kitchen OS backup.'], warnings }
  }

  // --- version --------------------------------------------------------------
  const rawVersion = value.schemaVersion
  const version =
    typeof rawVersion === 'number' && Number.isInteger(rawVersion) ? rawVersion : null

  if (version === null) {
    errors.push('That file is missing its version number, so it may not be a Kitchen OS backup.')
  } else if (version > SCHEMA_VERSION) {
    // Forward conversion is impossible: this app does not know what a newer
    // version added, so anything it wrote through would be guesswork.
    errors.push(
      `That backup was made by a newer version of the app (data version ${version}, this app reads ${SCHEMA_VERSION}). Update the app first.`,
    )
  } else if (version < 1) {
    errors.push(`That backup claims data version ${version}, which is not a real version.`)
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

  if (errors.length > 0 || version === null) return { ok: false, errors, warnings }

  // --- bring an older file up to date ---------------------------------------
  let upgraded = value
  if (version < SCHEMA_VERSION) {
    upgraded = upgradeBackup(value, version)
    const notes = upgradeNotes(version)
    warnings.push(
      `That backup was made by an older version of the app (data version ${version}). It has been brought up to date` +
        (notes.length > 0 ? ` — ${notes.join('; ')}.` : '.'),
    )
  }

  // --- cross-references (never blocking) ------------------------------------
  const backup = upgraded as unknown as BackupFile
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
