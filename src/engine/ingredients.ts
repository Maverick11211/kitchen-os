/**
 * Kitchen OS — Creating canonical ingredients in the app
 *
 * Backs the "can't find it? add it" path in the Phase 4 add-product flow. The
 * form collects a draft; this module decides whether the draft is usable, what
 * to tell the User if it isn't, and what the resulting `CanonicalIngredient`
 * looks like.
 *
 * v1 is ADD-ONLY (Jack, 2026-08-19). There is deliberately no "edit an existing
 * ingredient" function: if the User can never modify a bundled entry, the seed
 * merge in `seed-merge.ts` can always replace bundled entries safely, which
 * keeps the trickiest part of this feature simple.
 *
 * Validation returns errors AND warnings separately. An error means the entry
 * would be broken (a count-tracked ingredient with no weight per unit can never
 * be converted to grams). A warning means it will work but something useful is
 * missing, and the form should say so without blocking the save.
 */
import type {
  CanonicalId,
  CanonicalIngredient,
  IngredientCategory,
  TrackBy,
} from '../types/schema'

export const INGREDIENT_CATEGORIES = [
  'produce', 'protein', 'dairy', 'grain', 'legume', 'fat-oil',
  'condiment', 'spice', 'baking', 'beverage', 'other',
] as const satisfies readonly IngredientCategory[]

export const TRACK_BY_MODES = ['mass', 'volume', 'count'] as const satisfies readonly TrackBy[]

/** What the add-ingredient form collects. No id — the app generates that. */
export interface CanonicalIngredientDraft {
  readonly name: string
  readonly category: IngredientCategory
  readonly trackBy: TrackBy
  readonly tracked: boolean
  readonly perishable: boolean
  readonly cupWeightG?: number
  readonly unitWeightG?: number
  readonly densityGPerMl?: number
  readonly aliases?: readonly string[]
  readonly defaultShelfLifeDays?: number
}

export type IssueField =
  | 'name' | 'category' | 'trackBy' | 'cupWeightG' | 'unitWeightG'
  | 'densityGPerMl' | 'aliases' | 'defaultShelfLifeDays'

export interface ValidationIssue {
  /** Which input to highlight. */
  readonly field: IssueField
  readonly severity: 'error' | 'warning'
  /** Written to be shown to the User as-is. */
  readonly message: string
}

export interface ValidationResult {
  /** True when there are no errors. Warnings do not block saving. */
  readonly ok: boolean
  readonly errors: readonly ValidationIssue[]
  readonly warnings: readonly ValidationIssue[]
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Turn a display name into an id in the same style as the seed ontology:
 * lowercase, hyphen-separated, ASCII. "Gruyère, shredded" -> "gruyere-shredded".
 *
 * Returns an empty string when the name has nothing usable in it, which the
 * caller must treat as invalid rather than saving an entry with a blank id.
 */
export function slugifyIngredientId(name: string): CanonicalId {
  return name
    .normalize('NFD')
    // Strip combining accents so "è" becomes "e" rather than being dropped.
    // Written as escapes because the literal characters are invisible in most editors.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A slug that nothing else is using. Collisions get a numeric suffix, so
 * adding a second "Chilli" yields "chilli-2" rather than silently overwriting
 * the first — ids are foreign keys for every Product, so a collision would
 * quietly repoint real inventory.
 */
export function generateIngredientId(name: string, taken: ReadonlySet<CanonicalId>): CanonicalId {
  const base = slugifyIngredientId(name)
  if (base === '') return ''
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Trim, lowercase and de-duplicate aliases, dropping blanks. */
export function normaliseAliases(aliases: readonly string[] | undefined): string[] {
  if (!aliases) return []
  const seen = new Set<string>()
  for (const alias of aliases) {
    const clean = alias.trim().toLowerCase()
    if (clean !== '') seen.add(clean)
  }
  return [...seen]
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPositive(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value > 0
}

function checkOptionalPositive(
  value: number | undefined,
  field: IssueField,
  label: string,
  errors: ValidationIssue[],
): void {
  if (value === undefined) return
  if (!isPositive(value)) {
    errors.push({ field, severity: 'error', message: `${label} must be a number greater than zero.` })
  }
}

/**
 * Check a draft against the ontology rules and the existing entries.
 *
 * `existing` is the full current ingredient list — bundled and user-added
 * together — because uniqueness has to hold across both.
 */
export function validateIngredientDraft(
  draft: CanonicalIngredientDraft,
  existing: readonly CanonicalIngredient[],
): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  // --- name -----------------------------------------------------------------
  const name = draft.name.trim()
  if (name === '') {
    errors.push({ field: 'name', severity: 'error', message: 'Give the ingredient a name.' })
  } else if (slugifyIngredientId(name) === '') {
    errors.push({
      field: 'name',
      severity: 'error',
      message: 'That name has no letters or numbers in it, so it cannot be given an id.',
    })
  } else {
    const clash = existing.find((entry) => entry.name.trim().toLowerCase() === name.toLowerCase())
    if (clash) {
      errors.push({
        field: 'name',
        severity: 'error',
        message: `"${clash.name}" already exists. Add a lot to that instead, or use a more specific name.`,
      })
    }
  }

  // --- enums ----------------------------------------------------------------
  if (!INGREDIENT_CATEGORIES.includes(draft.category)) {
    errors.push({ field: 'category', severity: 'error', message: 'Pick a category.' })
  }
  if (!TRACK_BY_MODES.includes(draft.trackBy)) {
    errors.push({ field: 'trackBy', severity: 'error', message: 'Pick how this is measured.' })
  }

  // --- conversion fields ----------------------------------------------------
  checkOptionalPositive(draft.cupWeightG, 'cupWeightG', 'Weight of one cup', errors)
  checkOptionalPositive(draft.unitWeightG, 'unitWeightG', 'Weight of one', errors)
  checkOptionalPositive(draft.densityGPerMl, 'densityGPerMl', 'Grams per millilitre', errors)

  if (draft.trackBy === 'count' && !isPositive(draft.unitWeightG)) {
    errors.push({
      field: 'unitWeightG',
      severity: 'error',
      message: 'Counted ingredients need the weight of one, or quantities cannot be converted to grams.',
    })
  }

  if (draft.trackBy === 'volume' && !isPositive(draft.densityGPerMl)) {
    errors.push({
      field: 'densityGPerMl',
      severity: 'error',
      message: 'Liquids need a grams-per-millilitre value. Water is 1.0; most oils are around 0.92.',
    })
  }

  // CLAUDE.md: density x volume is wrong for solids. Blocked at the door rather
  // than left for the conversion code to trip over later.
  if (draft.trackBy !== 'volume' && draft.densityGPerMl !== undefined) {
    errors.push({
      field: 'densityGPerMl',
      severity: 'error',
      message:
        'Only true liquids use grams per millilitre. For a solid, give the weight of one cup instead — ' +
        'density gets shredded and chopped foods wrong.',
    })
  }

  if (draft.trackBy !== 'volume' && draft.cupWeightG === undefined) {
    warnings.push({
      field: 'cupWeightG',
      severity: 'warning',
      message: 'Without the weight of one cup, recipes cannot measure this in cups, tablespoons or teaspoons.',
    })
  }

  // --- shelf life -----------------------------------------------------------
  if (draft.defaultShelfLifeDays !== undefined) {
    if (!isPositive(draft.defaultShelfLifeDays) || !Number.isInteger(draft.defaultShelfLifeDays)) {
      errors.push({
        field: 'defaultShelfLifeDays',
        severity: 'error',
        message: 'Shelf life must be a whole number of days greater than zero.',
      })
    }
  } else if (draft.perishable) {
    warnings.push({
      field: 'defaultShelfLifeDays',
      severity: 'warning',
      message: 'Without a shelf life, the expiry date will not be filled in for you when adding a lot.',
    })
  }

  // --- aliases --------------------------------------------------------------
  const aliases = normaliseAliases(draft.aliases)
  const aliasOwners = new Map<string, string>()
  for (const entry of existing) {
    for (const alias of entry.aliases) aliasOwners.set(alias.trim().toLowerCase(), entry.name)
  }
  for (const alias of aliases) {
    const owner = aliasOwners.get(alias)
    if (owner !== undefined) {
      // The seed validator treats an alias resolving to two ingredients as a
      // hard failure, because matching becomes ambiguous. Same rule here.
      errors.push({
        field: 'aliases',
        severity: 'error',
        message: `"${alias}" is already an alternate name for ${owner}. An alias can only mean one ingredient.`,
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export type CreateIngredientResult =
  | { readonly ok: true; readonly ingredient: CanonicalIngredient; readonly warnings: readonly ValidationIssue[] }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[]; readonly warnings: readonly ValidationIssue[] }

/**
 * Build a user-added `CanonicalIngredient` from a validated draft.
 *
 * Always `isSeed: false`. That single flag is what lets a future bundled
 * ontology update leave this entry alone.
 */
export function createUserIngredient(
  draft: CanonicalIngredientDraft,
  existing: readonly CanonicalIngredient[],
): CreateIngredientResult {
  const validation = validateIngredientDraft(draft, existing)
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings }
  }

  const taken = new Set(existing.map((entry) => entry.id))
  const ingredient: CanonicalIngredient = {
    id: generateIngredientId(draft.name, taken),
    name: draft.name.trim(),
    category: draft.category,
    trackBy: draft.trackBy,
    tracked: draft.tracked,
    perishable: draft.perishable,
    isSeed: false,
    aliases: normaliseAliases(draft.aliases),
  }
  if (draft.cupWeightG !== undefined) ingredient.cupWeightG = draft.cupWeightG
  if (draft.unitWeightG !== undefined) ingredient.unitWeightG = draft.unitWeightG
  if (draft.densityGPerMl !== undefined) ingredient.densityGPerMl = draft.densityGPerMl
  if (draft.defaultShelfLifeDays !== undefined) {
    ingredient.defaultShelfLifeDays = draft.defaultShelfLifeDays
  }

  return { ok: true, ingredient, warnings: validation.warnings }
}

/** True for entries the User created rather than ones that shipped with the app. */
export function isUserAdded(ingredient: CanonicalIngredient): boolean {
  return !ingredient.isSeed
}
