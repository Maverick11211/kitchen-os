/**
 * Kitchen OS — Inventory and FEFO deduction
 *
 * Deduction is first-expiring-first-out (DECISIONS.md), which makes waste
 * reduction structural rather than something you have to remember to do.
 *
 * Planning and applying are deliberately separate:
 *   `planDeduction`  works out what WOULD happen and mutates nothing
 *   `applyDeductions` produces the new lots
 * That split is what lets the cook flow (Phase 7) show a deduction preview
 * before anything is committed.
 *
 * Error handling differs from `units.ts` on purpose. `units.ts` deals with user
 * and seed input, so it never throws — a bad conversion is a normal outcome to
 * report. The functions here deal with values the app itself computed, so a
 * negative gram request or an unknown lot id is a programming mistake, and
 * failing loudly beats silently deducting nothing.
 */
import type {
  CanonicalId,
  DateOnly,
  Deduction,
  Lot,
  LotId,
  MacroSet,
  Product,
  ProductId,
  Recipe,
  RecipeId,
  Timestamp,
} from '../types/schema'
import type { MacroLine } from './macros'
import { macrosForLines } from './macros'
import type { OntologyIndex } from './ontology'
import { isTracked } from './ontology'

/**
 * Below this, a remaining quantity is treated as zero. Floating-point
 * subtraction leaves crumbs like 1e-13g behind; without a floor, a lot that is
 * plainly empty never gets marked depleted. A microgram is far below any
 * quantity this app can meaningfully represent.
 */
export const GRAM_EPSILON = 1e-6

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface InventoryIndex {
  readonly productsById: ReadonlyMap<ProductId, Product>
  readonly lotsById: ReadonlyMap<LotId, Lot>
  /** Every lot for a canonical, already in FEFO order. Includes depleted lots. */
  readonly lotsByCanonical: ReadonlyMap<CanonicalId, readonly Lot[]>
}

/**
 * FEFO ordering. Soonest expiry first.
 *
 * Null expiry sorts LAST: things that will actually go bad get used before
 * things that won't (Jack, 2026-08-19). `acquiredOn` and then `id` break ties
 * so the same inventory always deducts in the same order — without a total
 * ordering, two lots sharing a date could come back in whatever order the
 * database happened to hand them over, and a test that passes today would fail
 * next week for no visible reason.
 */
export function compareLotsFefo(a: Lot, b: Lot): number {
  if (a.expiresOn !== b.expiresOn) {
    if (a.expiresOn === null) return 1
    if (b.expiresOn === null) return -1
    // ISO dates (YYYY-MM-DD) sort correctly as plain strings.
    if (a.expiresOn < b.expiresOn) return -1
    if (a.expiresOn > b.expiresOn) return 1
  }
  if (a.acquiredOn !== b.acquiredOn) return a.acquiredOn < b.acquiredOn ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

export function buildInventoryIndex(
  products: readonly Product[],
  lots: readonly Lot[],
): InventoryIndex {
  const productsById = new Map(products.map((product) => [product.id, product]))
  const lotsById = new Map(lots.map((lot) => [lot.id, lot]))

  const grouped = new Map<CanonicalId, Lot[]>()
  for (const lot of lots) {
    const product = productsById.get(lot.productId)
    // A lot whose product is missing is unusable — it has no canonical to match
    // a recipe against and no macros. Skipped rather than crashing, so one bad
    // record can't take down the whole inventory view.
    if (!product) continue
    const bucket = grouped.get(product.canonicalId)
    if (bucket) bucket.push(lot)
    else grouped.set(product.canonicalId, [lot])
  }
  for (const bucket of grouped.values()) bucket.sort(compareLotsFefo)

  return { productsById, lotsById, lotsByCanonical: grouped }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** A lot with something actually left in it. */
export function isLotAvailable(lot: Lot): boolean {
  return !lot.depleted && lot.remainingG > GRAM_EPSILON
}

/** Lots with stock, in the order they will be consumed. */
export function availableLotsFor(index: InventoryIndex, canonicalId: CanonicalId): Lot[] {
  return (index.lotsByCanonical.get(canonicalId) ?? []).filter(isLotAvailable)
}

/** Total grams of this ingredient on hand, across every product and lot. */
export function availableGramsFor(index: InventoryIndex, canonicalId: CanonicalId): number {
  return availableLotsFor(index, canonicalId).reduce((total, lot) => total + lot.remainingG, 0)
}

/** Binary ownership: is there any of this at all? */
export function ownsAny(index: InventoryIndex, canonicalId: CanonicalId): boolean {
  return availableLotsFor(index, canonicalId).length > 0
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Whole days from `today` until `date`. Negative when already past.
 *
 * Both are `DateOnly` (YYYY-MM-DD) and are read as UTC midnight, so the answer
 * never shifts by a day depending on the device's timezone or on daylight
 * saving. Returns null for an unparseable date rather than NaN.
 */
export function daysUntil(date: DateOnly, today: DateOnly): number | null {
  const target = Date.parse(`${date}T00:00:00.000Z`)
  const from = Date.parse(`${today}T00:00:00.000Z`)
  if (Number.isNaN(target) || Number.isNaN(from)) return null
  return Math.round((target - from) / 86_400_000)
}

/**
 * Whether a lot needs using up. Already-expired lots count as expiring soon —
 * they are the most urgent case, not an excluded one. Null-expiry lots never do.
 */
export function isExpiringSoon(lot: Lot, today: DateOnly, withinDays: number): boolean {
  if (lot.expiresOn === null) return false
  const days = daysUntil(lot.expiresOn, today)
  return days !== null && days <= withinDays
}

/** Available lots of this ingredient that need using up. */
export function expiringSoonLotsFor(
  index: InventoryIndex,
  canonicalId: CanonicalId,
  today: DateOnly,
  withinDays: number,
): Lot[] {
  return availableLotsFor(index, canonicalId).filter((lot) => isExpiringSoon(lot, today, withinDays))
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface DeductionPlan {
  readonly canonicalId: CanonicalId
  readonly requestedG: number
  /** Which lots to debit, in FEFO order. Empty when nothing is on hand. */
  readonly deductions: readonly Deduction[]
  /** Sum of `deductions`. Equals `requestedG` when `complete`. */
  readonly deductedG: number
  /** Grams that could not be covered. Zero when `complete`. */
  readonly shortfallG: number
  readonly complete: boolean
}

function assertRequestable(grams: number, label: string): void {
  if (!Number.isFinite(grams)) {
    throw new RangeError(`${label}: grams must be a finite number, got ${grams}.`)
  }
  if (grams < 0) {
    throw new RangeError(`${label}: grams must not be negative, got ${grams}.`)
  }
}

/**
 * Work out which lots would cover `grams` of an ingredient, without changing
 * anything.
 *
 * When there isn't enough, this takes everything available and reports the
 * gap in `shortfallG` (Jack, 2026-08-19) rather than refusing outright — you
 * can still record a meal you actually cooked with slightly less butter than
 * the recipe wanted. Nothing ever goes negative.
 */
export function planDeduction(
  index: InventoryIndex,
  canonicalId: CanonicalId,
  grams: number,
): DeductionPlan {
  assertRequestable(grams, `planDeduction(${canonicalId})`)

  const deductions: Deduction[] = []
  let outstanding = grams

  for (const lot of availableLotsFor(index, canonicalId)) {
    if (outstanding <= GRAM_EPSILON) break
    const take = Math.min(lot.remainingG, outstanding)
    if (take <= GRAM_EPSILON) continue
    deductions.push({ lotId: lot.id, canonicalId, grams: take })
    outstanding -= take
  }

  const deductedG = deductions.reduce((total, deduction) => total + deduction.grams, 0)
  const shortfallG = Math.max(0, grams - deductedG)

  return {
    canonicalId,
    requestedG: grams,
    deductions,
    deductedG,
    shortfallG: shortfallG <= GRAM_EPSILON ? 0 : shortfallG,
    complete: shortfallG <= GRAM_EPSILON,
  }
}

export interface Shortfall {
  readonly canonicalId: CanonicalId
  readonly requestedG: number
  readonly shortfallG: number
}

export interface RecipeDeductionPlan {
  readonly recipeId: RecipeId
  readonly scaleFactor: number
  /** One plan per deductible ingredient line, in recipe order. */
  readonly lines: readonly DeductionPlan[]
  /** Every deduction flattened, ready to store on `CookEvent.deductions`. */
  readonly deductions: readonly Deduction[]
  readonly shortfalls: readonly Shortfall[]
  readonly complete: boolean
}

/**
 * Plan the deductions for cooking a whole recipe at `scaleFactor` (1 = as
 * written, 1.5 = one and a half batches).
 *
 * Optional ingredients ARE deducted — a garnish you actually used leaves your
 * inventory (DECISIONS.md). Untracked staples are skipped entirely: salt and
 * water never get a product or a lot, so there is nothing to debit and
 * reporting "short 5g of salt" would be noise, not information.
 */
export function planRecipeDeduction(
  index: InventoryIndex,
  ontology: OntologyIndex,
  recipe: Recipe,
  scaleFactor = 1,
): RecipeDeductionPlan {
  assertRequestable(scaleFactor, `planRecipeDeduction(${recipe.id}) scaleFactor`)

  const lines: DeductionPlan[] = []
  for (const ingredient of recipe.ingredients) {
    if (!isTracked(ontology, ingredient.canonicalId)) continue
    lines.push(planDeduction(index, ingredient.canonicalId, ingredient.quantityG * scaleFactor))
  }

  const deductions = lines.flatMap((line) => line.deductions)
  const shortfalls: Shortfall[] = lines
    .filter((line) => !line.complete)
    .map((line) => ({
      canonicalId: line.canonicalId,
      requestedG: line.requestedG,
      shortfallG: line.shortfallG,
    }))

  return {
    recipeId: recipe.id,
    scaleFactor,
    lines,
    deductions,
    shortfalls,
    complete: shortfalls.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Produce the new state of `lots` after `deductions`.
 *
 * Returns a fresh array; the input lots are not modified. A lot that reaches
 * zero is marked `depleted` and kept, never deleted (DECISIONS.md) — depleted
 * lots are what make consumption history and usage rates recoverable later.
 *
 * `now` is passed in rather than read from the clock so the result is
 * reproducible in tests and in an import/replay.
 */
export function applyDeductions(
  lots: readonly Lot[],
  deductions: readonly Deduction[],
  now: Timestamp,
): Lot[] {
  const takenByLot = new Map<LotId, number>()
  for (const deduction of deductions) {
    assertRequestable(deduction.grams, `applyDeductions(lot ${deduction.lotId})`)
    takenByLot.set(deduction.lotId, (takenByLot.get(deduction.lotId) ?? 0) + deduction.grams)
  }

  const knownIds = new Set(lots.map((lot) => lot.id))
  for (const lotId of takenByLot.keys()) {
    if (!knownIds.has(lotId)) {
      throw new Error(`applyDeductions: deduction references unknown lot "${lotId}".`)
    }
  }

  return lots.map((lot) => {
    const taken = takenByLot.get(lot.id)
    if (taken === undefined || taken === 0) return lot

    // Clamped, never negative. A plan built against a stale snapshot could ask
    // for more than is left; the Reconcile screen exists to fix that drift, and
    // corrupting inventory state is not an acceptable way to record it.
    const remainingG = Math.max(0, lot.remainingG - taken)
    const depleted = remainingG <= GRAM_EPSILON

    const next: Lot = {
      ...lot,
      remainingG: depleted ? 0 : remainingG,
      depleted,
    }
    if (depleted && !lot.depleted) next.depletedAt = now
    return next
  })
}

// ---------------------------------------------------------------------------
// Correcting a lot by hand
// ---------------------------------------------------------------------------

/**
 * How many grams a given fraction of a lot is.
 *
 * Trivial arithmetic, but it lives here rather than in the Reconcile screen so
 * that CLAUDE.md's "components never do the maths" rule stays literally true
 * and there is one place to change if fractions ever mean something else.
 */
export function gramsForFraction(lot: Lot, fraction: number): number {
  return lot.initialG * fraction
}

/**
 * Set what is left in a lot to an observed amount.
 *
 * This is the Reconcile screen's one operation, and the accepted mitigation for
 * quantity drift (DECISIONS.md): milk poured without logging, handfuls of nuts.
 * Drift is not preventable, so correction is made cheap instead.
 *
 * Clamped to the lot's original size. A lot cannot come to hold more than it
 * did when it was added — `initialG` is by definition what was there — so
 * "there is more than the app thinks" is a second lot, not a bigger one. The
 * same ceiling `revertDeductions` uses, for the same reason.
 *
 * Reaching zero marks the lot depleted and keeps it, never deletes it. Going
 * back UP from zero un-depletes it and clears `depletedAt`, because the usual
 * reason for that is having just marked the wrong packet empty.
 */
export function setLotRemaining(lot: Lot, grams: number, now: Timestamp): Lot {
  assertRequestable(grams, `setLotRemaining(${lot.id})`)

  const remainingG = Math.min(lot.initialG, grams)
  const depleted = remainingG <= GRAM_EPSILON

  const next: Lot = { ...lot, remainingG: depleted ? 0 : remainingG, depleted }
  if (depleted && !lot.depleted) next.depletedAt = now
  if (!depleted) delete next.depletedAt
  return next
}

/**
 * Reverse a committed cook event, putting the grams back on the lots they came
 * from. `CookEvent.deductions` is the source of truth for exactly this.
 */
export function revertDeductions(lots: readonly Lot[], deductions: readonly Deduction[]): Lot[] {
  const returnedByLot = new Map<LotId, number>()
  for (const deduction of deductions) {
    returnedByLot.set(deduction.lotId, (returnedByLot.get(deduction.lotId) ?? 0) + deduction.grams)
  }

  return lots.map((lot) => {
    const returned = returnedByLot.get(lot.id)
    if (returned === undefined || returned === 0) return lot

    // A lot cannot come back holding more than it originally did.
    const remainingG = Math.min(lot.initialG, lot.remainingG + returned)
    const next: Lot = { ...lot, remainingG, depleted: remainingG <= GRAM_EPSILON }
    if (!next.depleted) delete next.depletedAt
    return next
  })
}

// ---------------------------------------------------------------------------
// Macros for a set of deductions
// ---------------------------------------------------------------------------

/**
 * Turn deductions into macro lines by walking lot -> product -> macrosPer100g.
 *
 * A deduction whose lot or product is missing contributes nothing rather than
 * throwing: an incomplete inventory should under-report calories, not make the
 * day's total impossible to compute.
 */
export function macroLinesForDeductions(
  index: InventoryIndex,
  deductions: readonly Deduction[],
): MacroLine[] {
  const lines: MacroLine[] = []
  for (const deduction of deductions) {
    const lot = index.lotsById.get(deduction.lotId)
    if (!lot) continue
    const product = index.productsById.get(lot.productId)
    if (!product) continue
    lines.push({ grams: deduction.grams, macrosPer100g: product.macrosPer100g })
  }
  return lines
}

/**
 * Total macros of an entire cooked batch, from the products actually consumed.
 *
 * The caller stores this on `CookEvent.batchMacros`. That stored value is the
 * snapshot — nothing recomputes it afterwards, so correcting a product's label
 * next month leaves this batch exactly as it was.
 */
export function batchMacrosForDeductions(
  index: InventoryIndex,
  deductions: readonly Deduction[],
): MacroSet {
  return macrosForLines(macroLinesForDeductions(index, deductions))
}
