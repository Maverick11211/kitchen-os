/**
 * Kitchen OS — The logic behind the add-product and add-lot forms
 *
 * Forms deal in strings: every input hands back text, including the empty
 * string. Turning that text into numbers, deciding whether it is usable, and
 * saying what is wrong in words a person can act on is what this module does.
 * Keeping it out of the components means it can be tested without a browser,
 * and means the components genuinely do no arithmetic (CLAUDE.md).
 *
 * Errors and warnings are separate, the same convention as
 * `engine/ingredients.ts`: an error means the entry would be broken, a warning
 * means it will work but something looks off. Warnings never block a save.
 *
 * Clock-free. `today` is passed in.
 */
import type {
  CanonicalIngredient,
  DateOnly,
  IngredientCategory,
  MacroSet,
  Product,
  ProductId,
  TrackBy,
  Unit,
} from '../types/schema'
import type { CanonicalIngredientDraft, CountSource } from '../engine'
import { MACRO_KEYS, multiplyMacros, toGrams } from '../engine'
import type { NewProduct } from '../db/repo/products'
import type { NewLot } from '../db/repo/lots'

export type MacroKey = (typeof MACRO_KEYS)[number]

export interface FieldIssue {
  readonly field: string
  readonly message: string
}

/**
 * Labels for the macro inputs, in the order the form shows them.
 *
 * US nutrition-label order, so typing follows the panel top to bottom without
 * hunting for the next number.
 */
export const MACRO_FIELDS: readonly { readonly key: MacroKey; readonly label: string }[] = [
  { key: 'calories', label: 'Calories' },
  { key: 'fatG', label: 'Fat (g)' },
  { key: 'saturatedFatG', label: 'Sat fat (g)' },
  { key: 'cholesterolMg', label: 'Cholesterol (mg)' },
  { key: 'sodiumMg', label: 'Sodium (mg)' },
  { key: 'carbsG', label: 'Carbs (g)' },
  { key: 'fiberG', label: 'Fibre (g)' },
  { key: 'sugarG', label: 'Sugar (g)' },
  { key: 'proteinG', label: 'Protein (g)' },
]

// ---------------------------------------------------------------------------
// Numbers and dates
// ---------------------------------------------------------------------------

/**
 * Read a number out of an input.
 *
 * Empty is `null` (absent), not zero — "I left this blank" and "this is zero"
 * are different answers and the caller decides which is acceptable. Anything
 * unparseable is also null; the caller reports it.
 */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** Whether text was typed at all, regardless of whether it was a number. */
export function hasText(text: string): boolean {
  return text.trim() !== ''
}

/**
 * `date` plus `days`, as YYYY-MM-DD.
 *
 * Read and written as UTC midnight so the answer never shifts by a day
 * depending on timezone or daylight saving — same reasoning as `daysUntil` in
 * the engine.
 */
export function addDays(date: DateOnly, days: number): DateOnly {
  const base = Date.parse(`${date}T00:00:00.000Z`)
  if (Number.isNaN(base)) return date
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

/**
 * What the numbers on the label are measured against.
 *
 * All three appear on real packaging — US labels give a serving, most EU labels
 * give 100g, and small or single-portion items often just give the whole
 * package. Guessing wrong is a silent 2-4x error on every meal made from that
 * product ever after, so it is asked rather than inferred.
 *
 * Each basis asks for exactly the one measurement it needs, and the rest is
 * worked out. Per serving, that means servings per package rather than a
 * package weight: the label says "about 4 servings", so that is the number in
 * front of you, and multiplying is the app's job.
 */
export type MacroBasis = 'package' | 'serving' | 'per100g'

export interface ProductDraft {
  readonly name: string
  readonly brand: string
  readonly basis: MacroBasis
  readonly packageSizeG: string
  readonly servingSizeG: string
  readonly servingsPerPackage: string
  /**
   * How many items are in a full package — "6" for a pack of six tortillas.
   *
   * Only asked for when the ingredient is counted rather than weighed. It is
   * the number that makes "1 tortilla" mean one of THESE tortillas instead of
   * the ontology's average across every brand (added 2026-08-21, see
   * DECISIONS.md).
   */
  readonly unitsPerPackage: string
  readonly macros: Readonly<Record<MacroKey, string>>
}

export function emptyProductDraft(): ProductDraft {
  const macros = {} as Record<MacroKey, string>
  for (const key of MACRO_KEYS) macros[key] = ''
  return {
    name: '',
    brand: '',
    basis: 'serving',
    packageSizeG: '',
    servingSizeG: '',
    servingsPerPackage: '',
    unitsPerPackage: '',
    macros,
  }
}

/**
 * Fill the product form in from a product already stored, for correcting it.
 *
 * Opened on the per-100g basis because that is what the schema keeps — the
 * basis originally typed is not stored, so claiming to know it would be a
 * guess. The serving size and pack count are prefilled where they were
 * recorded, so the common correction (a wrong calorie figure, a pack count
 * never entered) needs no retyping of anything else.
 *
 * Switching the basis afterwards means the figures shown no longer match what
 * they are measured against; the edit sheet says so rather than silently
 * clearing them, because deleting eight numbers someone might only be passing
 * through is worse than a sentence asking them to check.
 */
export function productDraftFrom(product: Product): ProductDraft {
  const macros = {} as Record<MacroKey, string>
  for (const key of MACRO_KEYS) macros[key] = String(product.macrosPer100g[key])

  return {
    name: product.name,
    brand: product.brand ?? '',
    basis: 'per100g',
    packageSizeG: product.packageSizeG === undefined ? '' : String(product.packageSizeG),
    servingSizeG: product.labelServingSizeG === undefined ? '' : String(product.labelServingSizeG),
    servingsPerPackage: '',
    unitsPerPackage:
      product.unitsPerPackage === undefined ? '' : String(product.unitsPerPackage),
    macros,
  }
}

export type ProductValidation =
  | {
      readonly ok: true
      readonly product: NewProduct
      readonly warnings: readonly FieldIssue[]
    }
  | { readonly ok: false; readonly errors: readonly FieldIssue[]; readonly warnings: readonly FieldIssue[] }

/**
 * Rough energy check.
 *
 * 4 kcal per gram of protein and carbohydrate, 9 per gram of fat. This is not a
 * precision tool and must not become one — the tolerance is deliberately wide,
 * because fibre, sugar alcohols and rounding on the label all move it legitimately.
 * What it catches is the misplaced decimal point, which is the mistake that
 * quietly corrupts every meal made from the product afterwards.
 */
function energyWarning(macros: MacroSet): FieldIssue | null {
  const fromMacros = macros.proteinG * 4 + macros.carbsG * 4 + macros.fatG * 9
  if (macros.calories <= 0 || fromMacros <= 0) return null
  const ratio = macros.calories / fromMacros
  if (ratio >= 0.6 && ratio <= 1.6) return null
  return {
    field: 'calories',
    message: `The calories do not match the protein, carbs and fat — those add up to about ${Math.round(fromMacros)}. Worth a second look, but you can save it anyway.`,
  }
}

/**
 * Turn what was typed into a storable product.
 *
 * Blank macro fields become zero: a label that omits fibre means there is none
 * worth counting, and forcing eight numbers before anything can be saved is
 * exactly the entry friction DECISIONS.md names as the main abandonment risk.
 * Text that is not a number is an error, because that is a typo rather than an
 * omission.
 */
export function validateProductDraft(
  draft: ProductDraft,
  canonicalId: string,
): ProductValidation {
  const errors: FieldIssue[] = []
  const warnings: FieldIssue[] = []

  const name = draft.name.trim()
  if (name === '') errors.push({ field: 'name', message: 'Give the product a name.' })

  const packageSizeG = parseAmount(draft.packageSizeG)
  const servingSizeG = parseAmount(draft.servingSizeG)
  const servingsPerPackage = parseAmount(draft.servingsPerPackage)

  // How many grams the typed figures describe. Everything else is derived.
  let basisGrams: number | null = null

  if (draft.basis === 'package') {
    if (packageSizeG === null || packageSizeG <= 0) {
      errors.push({ field: 'packageSizeG', message: 'How many grams is the whole package?' })
    } else {
      basisGrams = packageSizeG
    }
  } else if (draft.basis === 'serving') {
    if (servingSizeG === null || servingSizeG <= 0) {
      errors.push({
        field: 'servingSizeG',
        message: 'How many grams is one serving? It is on the label next to the nutrition figures.',
      })
    } else {
      basisGrams = servingSizeG
    }
    if (hasText(draft.servingsPerPackage) && (servingsPerPackage === null || servingsPerPackage <= 0)) {
      errors.push({
        field: 'servingsPerPackage',
        message: 'Servings per package must be a number greater than zero.',
      })
    }
  } else {
    basisGrams = 100
    if (hasText(draft.packageSizeG) && (packageSizeG === null || packageSizeG <= 0)) {
      errors.push({ field: 'packageSizeG', message: 'Package size must be a number greater than zero.' })
    }
  }

  const unitsPerPackage = parseAmount(draft.unitsPerPackage)
  if (hasText(draft.unitsPerPackage) && (unitsPerPackage === null || unitsPerPackage <= 0)) {
    errors.push({
      field: 'unitsPerPackage',
      message: 'How many are in the pack? It needs to be a number greater than zero.',
    })
  }

  const entered = {} as Record<MacroKey, number>
  for (const key of MACRO_KEYS) {
    const text = draft.macros[key]
    if (!hasText(text)) {
      entered[key] = 0
      continue
    }
    const value = parseAmount(text)
    if (value === null) {
      errors.push({ field: key, message: 'That is not a number.' })
      entered[key] = 0
    } else if (value < 0) {
      errors.push({ field: key, message: 'That cannot be less than zero.' })
      entered[key] = 0
    } else {
      entered[key] = value
    }
  }

  if (errors.length > 0 || basisGrams === null) return { ok: false, errors, warnings }

  const asEntered = entered as MacroSet
  const energy = energyWarning(asEntered)
  if (energy) warnings.push(energy)

  // Whatever the figures described, the schema stores per 100g.
  const macrosPer100g =
    basisGrams === 100 ? asEntered : multiplyMacros(asEntered, 100 / basisGrams)

  // Per serving, the package weight is servings x serving size — the label
  // gives "about 4 servings", so that is the number to ask for and the
  // multiplication is the app's job.
  const resolvedPackageSizeG =
    draft.basis === 'serving'
      ? servingSizeG !== null && servingsPerPackage !== null && servingsPerPackage > 0
        ? servingSizeG * servingsPerPackage
        : undefined
      : packageSizeG !== null && packageSizeG > 0
        ? packageSizeG
        : undefined

  const product: NewProduct = { canonicalId, name, macrosPer100g }
  const brand = draft.brand.trim()
  if (brand !== '') product.brand = brand
  if (draft.basis === 'serving' && servingSizeG !== null && servingSizeG > 0) {
    product.labelServingSizeG = servingSizeG
  }
  if (resolvedPackageSizeG !== undefined) product.packageSizeG = resolvedPackageSizeG

  /*
   * A pack count is only worth storing next to a package weight, since one
   * without the other cannot say what a single item weighs. Stored alone it
   * would look like an answer while still leaving the count unconvertible.
   */
  if (unitsPerPackage !== null && unitsPerPackage > 0 && resolvedPackageSizeG !== undefined) {
    product.unitsPerPackage = unitsPerPackage
  } else if (unitsPerPackage !== null && unitsPerPackage > 0) {
    warnings.push({
      field: 'unitsPerPackage',
      message:
        'Without the weight of the whole package, a pack count cannot say what one of them weighs — so it has not been saved.',
    })
  }

  return { ok: true, product, warnings }
}

// ---------------------------------------------------------------------------
// Lot
// ---------------------------------------------------------------------------

export interface LotDraft {
  readonly quantity: string
  readonly unit: Unit
  readonly acquiredOn: DateOnly
  readonly expiresOn: string
  readonly frozen: boolean
  readonly note: string
}

/**
 * What the expiry field should say before the User touches it.
 *
 * Frozen lots get nothing (Jack, 2026-08-19): the ontology's shelf lives are
 * fridge/fresh figures, so pre-filling one on a frozen lot would warn about
 * food that is fine and train the User to ignore the warning. A date typed
 * deliberately on a frozen lot is still honoured — this only governs the
 * default.
 */
export function defaultExpiry(
  ingredient: CanonicalIngredient,
  acquiredOn: DateOnly,
  frozen: boolean,
): DateOnly | null {
  if (frozen) return null
  if (!ingredient.perishable) return null
  const shelfLife = ingredient.defaultShelfLifeDays
  if (shelfLife === undefined || shelfLife <= 0) return null
  return addDays(acquiredOn, shelfLife)
}

export function emptyLotDraft(
  ingredient: CanonicalIngredient,
  today: DateOnly,
  packageSizeG?: number,
): LotDraft {
  const expiry = defaultExpiry(ingredient, today, false)
  return {
    quantity: packageSizeG !== undefined ? String(packageSizeG) : '',
    unit: 'g',
    acquiredOn: today,
    expiresOn: expiry ?? '',
    frozen: false,
    note: '',
  }
}

export type LotValidation =
  | { readonly ok: true; readonly lot: NewLot; readonly grams: number }
  | { readonly ok: false; readonly errors: readonly FieldIssue[] }

/**
 * Turn what was typed into a storable lot.
 *
 * The quantity goes through the engine's `toGrams` rather than being converted
 * here, so the "never density for solids" rule is enforced in the one place it
 * lives. When that conversion fails the engine's own message is shown as-is —
 * it is already written for a person.
 */
export function validateLotDraft(
  draft: LotDraft,
  ingredient: CanonicalIngredient,
  productId: ProductId,
  product?: CountSource,
): LotValidation {
  const errors: FieldIssue[] = []

  const quantity = parseAmount(draft.quantity)
  if (quantity === null) {
    errors.push({ field: 'quantity', message: 'How much did you get?' })
  } else if (quantity <= 0) {
    errors.push({ field: 'quantity', message: 'That has to be more than zero.' })
  }

  if (draft.acquiredOn === '') {
    errors.push({ field: 'acquiredOn', message: 'When did you get it?' })
  }

  let grams = 0
  if (quantity !== null && quantity > 0) {
    // The product is passed so that "6" in counts means six of THESE, using the
    // pack count on the label rather than the ontology's average (2026-08-21).
    const converted = toGrams(ingredient, quantity, draft.unit, product)
    if (!converted.ok) errors.push({ field: 'unit', message: converted.message })
    else grams = converted.grams
  }

  if (errors.length > 0) return { ok: false, errors }

  const lot: NewLot = {
    productId,
    initialG: grams,
    expiresOn: hasText(draft.expiresOn) ? draft.expiresOn : null,
    acquiredOn: draft.acquiredOn,
  }
  if (draft.frozen) lot.frozen = true
  const note = draft.note.trim()
  if (note !== '') lot.note = note

  return { ok: true, lot, grams }
}

// ---------------------------------------------------------------------------
// New ingredient
// ---------------------------------------------------------------------------

/**
 * What the inline "can't find it? add it" form collects.
 *
 * Strings, because that is what inputs give back. The rules about what makes a
 * valid ingredient live in `engine/ingredients.ts` and are not repeated here —
 * this only turns text into the shape that module expects.
 */
export interface IngredientDraft {
  readonly name: string
  readonly category: IngredientCategory
  readonly trackBy: TrackBy
  readonly tracked: boolean
  readonly perishable: boolean
  readonly cupWeightG: string
  readonly unitWeightG: string
  readonly densityGPerMl: string
  readonly defaultShelfLifeDays: string
  readonly aliases: string
}

/**
 * A blank form, pre-filled with whatever was typed into the search box.
 *
 * Defaults are the common case: something you weigh, that you want counted, and
 * that goes off. Wrong defaults are cheap here — they are two taps to change —
 * whereas an empty required field is a wall.
 */
export function emptyIngredientDraft(name = ''): IngredientDraft {
  return {
    name,
    category: 'other',
    trackBy: 'mass',
    tracked: true,
    perishable: true,
    cupWeightG: '',
    unitWeightG: '',
    densityGPerMl: '',
    defaultShelfLifeDays: '',
    aliases: '',
  }
}

/**
 * Read an optional number out of a form field.
 *
 * Three outcomes, not two. Blank is `undefined` — the field was left alone, and
 * for an optional measurement that is a legitimate answer. Text that is not a
 * number becomes `NaN`, which is deliberately NOT the same as blank: it is
 * present and wrong, so it flows into the engine's validation and comes back as
 * "must be a number greater than zero" against that specific field. Silently
 * treating a typo as "not provided" would let a mistyped weight vanish.
 */
function optionalNumber(text: string): number | undefined {
  if (!hasText(text)) return undefined
  const value = Number(text.trim())
  return Number.isFinite(value) ? value : Number.NaN
}

/** Split the comma-separated alias field. The engine does the tidying. */
export function splitAliases(text: string): string[] {
  return text
    .split(',')
    .map((alias) => alias.trim())
    .filter((alias) => alias !== '')
}

/** Turn the form into the draft `engine/ingredients.ts` validates and stores. */
export function toIngredientDraft(draft: IngredientDraft): CanonicalIngredientDraft {
  const result: {
    name: string
    category: IngredientCategory
    trackBy: TrackBy
    tracked: boolean
    perishable: boolean
    cupWeightG?: number
    unitWeightG?: number
    densityGPerMl?: number
    defaultShelfLifeDays?: number
    aliases?: string[]
  } = {
    name: draft.name,
    category: draft.category,
    trackBy: draft.trackBy,
    tracked: draft.tracked,
    perishable: draft.perishable,
    aliases: splitAliases(draft.aliases),
  }

  const cupWeightG = optionalNumber(draft.cupWeightG)
  const unitWeightG = optionalNumber(draft.unitWeightG)
  const densityGPerMl = optionalNumber(draft.densityGPerMl)
  const shelfLife = optionalNumber(draft.defaultShelfLifeDays)

  if (cupWeightG !== undefined) result.cupWeightG = cupWeightG
  if (unitWeightG !== undefined) result.unitWeightG = unitWeightG
  // Only ever sent for a true liquid. The engine rejects it on a solid with an
  // explanation, which is the message the form shows — the rule is enforced in
  // one place, not restated here.
  if (densityGPerMl !== undefined) result.densityGPerMl = densityGPerMl
  if (shelfLife !== undefined) result.defaultShelfLifeDays = shelfLife

  return result
}

/** Plain-language labels for the measurement modes. */
export const TRACK_BY_LABELS: Record<TrackBy, string> = {
  mass: 'by weight',
  volume: 'by volume (a liquid)',
  count: 'by the item',
}

// ---------------------------------------------------------------------------
// Searching for what to add
// ---------------------------------------------------------------------------

/**
 * Match against name and aliases.
 *
 * Aliases matter more here than they look: the ontology carries the names
 * recipe sources use, so someone typing "coriander" finds cilantro without
 * having to know which one this app settled on.
 */
export function matchesSearch(ingredient: CanonicalIngredient, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  if (ingredient.name.toLowerCase().includes(needle)) return true
  return ingredient.aliases.some((alias) => alias.toLowerCase().includes(needle))
}

/** Best matches first: names that start with what was typed, then the rest. */
export function rankSearch(
  ingredients: readonly CanonicalIngredient[],
  query: string,
  limit = 40,
): CanonicalIngredient[] {
  const needle = query.trim().toLowerCase()
  const matched = ingredients.filter((item) => matchesSearch(item, query))
  matched.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1
    const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1
    if (aStarts !== bStarts) return aStarts - bStarts
    return a.name.localeCompare(b.name)
  })
  return matched.slice(0, limit)
}
