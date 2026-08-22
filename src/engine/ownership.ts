/**
 * Kitchen OS — Ownership and recipe ranking
 *
 * Answers "what can I actually cook right now?" — the thing the recipe grid
 * (Phase 6) sorts on and draws its ownership rings from.
 *
 * The rules come from DECISIONS.md, not from taste:
 *  - Ownership is BINARY. You have enough of an ingredient or you don't.
 *  - It is evaluated at 1x scale. Scaling happens after you pick a recipe.
 *  - An ingredient named on two lines is ONE ingredient needing the sum of
 *    both. See `pooledRequirements`.
 *  - Untracked staples (salt, pepper, water) and `optional` garnishes are
 *    excluded from the percentage. They are still shown, and still deducted
 *    when you cook.
 *  - A LOW QUANTITY warning fires between 90% and 100% of the requirement, and
 *    still counts as not-owned.
 *  - MAX BATCH SIZE tells you when you have everything but only enough for a
 *    half batch.
 *
 * v1 matches on exact `canonicalId` only. `interchangeableWith` exists in the
 * schema but is populated on none of the 310 ontology entries, so substitution
 * awareness is deferred (Jack, 2026-08-19). Every ownership question routes
 * through `availableGramsForLine` below, so wiring substitutes in later is a
 * change to one function rather than to this whole module.
 */
import type { CanonicalId, DateOnly, Recipe, RecipeIngredient } from '../types/schema'
import type { InventoryIndex } from './inventory'
import { GRAM_EPSILON, availableGramsFor, expiringSoonLotsFor } from './inventory'
import type { OntologyIndex } from './ontology'

/**
 * Default window for "expiring soon", in days.
 *
 * Settled at 5 by Jack on 2026-08-19, replacing the "likely 3 and 7 day tiers"
 * guess in DECISIONS.md's Open Items. Still a parameter everywhere it is used,
 * so a Phase 6 UI can offer a shorter "urgent" window on top of it without
 * changing the engine.
 */
export const DEFAULT_EXPIRING_SOON_DAYS = 5

/** Below this fraction of the requirement, an ingredient is simply missing. */
export const LOW_QUANTITY_THRESHOLD = 0.9

export interface IngredientOwnership {
  readonly canonicalId: CanonicalId
  /** Grams THIS LINE calls for at 1x scale. What the recipe has written on it. */
  readonly requiredG: number
  /**
   * Grams of this ingredient the whole recipe calls for at 1x scale, summed
   * across every counted line that names it.
   *
   * Usually identical to `requiredG`. It differs when a recipe lists the same
   * ingredient twice — Chakchouka calls for one red bell pepper on one line and
   * one green on another — and it is the figure ownership is judged against.
   * See `pooledRequirements` below for why.
   */
  readonly requiredTotalG: number
  readonly availableG: number
  /** Enough on hand for a full 1x batch. */
  readonly owned: boolean
  /** At least 90% but under 100%. Still counts as not-owned. */
  readonly lowQuantity: boolean
  /** Does this line count toward the percentage? `tracked && !optional`. */
  readonly counted: boolean
  readonly optional: boolean
  readonly tracked: boolean
  /** Some of this is going off soon — a reason to cook this recipe now. */
  readonly expiringSoon: boolean
  /** Batches this one ingredient could support. Infinity when none is needed. */
  readonly maxScale: number
}

export interface RecipeOwnership {
  readonly recipeId: string
  readonly recipeName: string
  /** One entry per recipe ingredient, in recipe order, including excluded ones. */
  readonly lines: readonly IngredientOwnership[]
  /**
   * How many distinct ingredients count toward the percentage.
   *
   * Distinct, not per line: a recipe naming bell pepper twice needs one
   * ingredient, not two, and "3 of 9" should not become "3 of 10" because the
   * source wrote the peppers on separate lines.
   */
  readonly countedCount: number
  readonly ownedCount: number
  /** 0..1. Exactly 1 when everything countable is on hand. */
  readonly ownershipFraction: number
  /** Countable ingredients you do not have enough of, in recipe order. */
  readonly missing: readonly CanonicalId[]
  /** Countable ingredients between 90% and 100%. A subset of `missing`. */
  readonly lowQuantity: readonly CanonicalId[]
  /** Exactly one countable ingredient away. Drives the "Missing One" tier. */
  readonly isMissingOne: boolean
  /**
   * Largest batch the limiting ingredient allows. 1 or more means a full batch
   * is possible; 0.5 means "you have everything, but only enough for a half
   * batch". Infinity when nothing countable is required.
   */
  readonly maxBatchScale: number
  /** Fraction of countable ingredients with stock going off soon. Tie-breaker. */
  readonly expiringSoonFraction: number
}

/**
 * Grams of a recipe line available in inventory.
 *
 * The single choke point for "what counts as having this ingredient". Exact
 * canonical match today; when `interchangeableWith` is populated, summing
 * substitutes belongs here and nowhere else.
 */
export function availableGramsForLine(
  index: InventoryIndex,
  canonicalId: CanonicalId,
): number {
  return availableGramsFor(index, canonicalId)
}

export interface OwnershipOptions {
  /** Today, as YYYY-MM-DD. Passed in so results are reproducible. */
  readonly today?: DateOnly
  readonly expiringSoonWithinDays?: number
}

function isCounted(ontology: OntologyIndex, ingredient: RecipeIngredient): boolean {
  // An ingredient the ontology does not know is treated as tracked, so an
  // unknown id shows up as missing instead of quietly making a recipe look
  // more makeable than it is.
  const tracked = ontology.get(ingredient.canonicalId)?.tracked ?? true
  return tracked && !ingredient.optional
}

/**
 * Grams of each ingredient the recipe needs IN TOTAL, across all its lines.
 *
 * Six of the 150 seed recipes name the same ingredient twice — Chakchouka's red
 * and green bell peppers, Spanish tortilla's two pours of olive oil, the sherry
 * and soy in beef and broccoli. Judging each line on its own against the whole
 * kitchen said you owned both peppers when you had one, so the recipe read 100%
 * and "ready" with half the peppers it needs. That is the exact surprise the
 * max-batch decision exists to prevent (Jack, 2026-08-21).
 *
 * Only counted lines are pooled. An optional garnish of the same ingredient is
 * a bonus, not part of what the recipe requires, and an untracked staple is not
 * measured at all.
 */
function pooledRequirements(
  recipe: Recipe,
  ontology: OntologyIndex,
): Map<CanonicalId, number> {
  const totals = new Map<CanonicalId, number>()
  for (const ingredient of recipe.ingredients) {
    if (!isCounted(ontology, ingredient)) continue
    const soFar = totals.get(ingredient.canonicalId) ?? 0
    totals.set(ingredient.canonicalId, soFar + ingredient.quantityG)
  }
  return totals
}

function evaluateLine(
  index: InventoryIndex,
  ontology: OntologyIndex,
  ingredient: RecipeIngredient,
  totals: ReadonlyMap<CanonicalId, number>,
  today: DateOnly | undefined,
  withinDays: number,
): IngredientOwnership {
  const counted = isCounted(ontology, ingredient)
  const tracked = ontology.get(ingredient.canonicalId)?.tracked ?? true

  const requiredG = ingredient.quantityG
  // A line that is not counted has no pooled total, so it is judged on its own
  // — which is what its display needs, and nothing else reads it.
  const requiredTotalG = totals.get(ingredient.canonicalId) ?? requiredG
  const availableG = availableGramsForLine(index, ingredient.canonicalId)

  const owned = availableG + GRAM_EPSILON >= requiredTotalG
  const lowQuantity =
    !owned && requiredTotalG > 0 && availableG >= requiredTotalG * LOW_QUANTITY_THRESHOLD

  const expiringSoon =
    today !== undefined &&
    expiringSoonLotsFor(index, ingredient.canonicalId, today, withinDays).length > 0

  const maxScale =
    requiredTotalG > 0 ? availableG / requiredTotalG : Number.POSITIVE_INFINITY

  return {
    canonicalId: ingredient.canonicalId,
    requiredG,
    requiredTotalG,
    availableG,
    owned,
    lowQuantity,
    counted,
    optional: ingredient.optional,
    tracked,
    expiringSoon,
    maxScale,
  }
}

/** First entry per canonical id, in recipe order. */
function distinctByCanonical(
  lines: readonly IngredientOwnership[],
): IngredientOwnership[] {
  const seen = new Set<CanonicalId>()
  const distinct: IngredientOwnership[] = []
  for (const line of lines) {
    if (seen.has(line.canonicalId)) continue
    seen.add(line.canonicalId)
    distinct.push(line)
  }
  return distinct
}

/**
 * Work out how much of a recipe you can currently make.
 *
 * Always evaluated at 1x scale — `maxBatchScale` reports what a bigger or
 * smaller batch would allow, rather than the caller re-running this per scale.
 */
export function evaluateOwnership(
  recipe: Recipe,
  index: InventoryIndex,
  ontology: OntologyIndex,
  options: OwnershipOptions = {},
): RecipeOwnership {
  const withinDays = options.expiringSoonWithinDays ?? DEFAULT_EXPIRING_SOON_DAYS
  const totals = pooledRequirements(recipe, ontology)

  const lines = recipe.ingredients.map((ingredient) =>
    evaluateLine(index, ontology, ingredient, totals, options.today, withinDays),
  )

  // Every figure below is per distinct INGREDIENT, not per line. The two are
  // the same for 144 of the 150 seed recipes; where they differ, an ingredient
  // written on two lines is still one thing to have, one thing to be missing,
  // and one thing to count toward the percentage.
  const counted = distinctByCanonical(lines.filter((line) => line.counted))
  const ownedCount = counted.filter((line) => line.owned).length
  const missing = counted.filter((line) => !line.owned).map((line) => line.canonicalId)
  const lowQuantity = counted.filter((line) => line.lowQuantity).map((line) => line.canonicalId)

  // A recipe made entirely of staples is fully owned, not a divide-by-zero.
  const ownershipFraction = counted.length === 0 ? 1 : ownedCount / counted.length

  const maxBatchScale = counted.reduce(
    (limit, line) => Math.min(limit, line.maxScale),
    Number.POSITIVE_INFINITY,
  )

  const expiringSoonFraction =
    counted.length === 0
      ? 0
      : counted.filter((line) => line.expiringSoon).length / counted.length

  return {
    recipeId: recipe.id,
    recipeName: recipe.name,
    lines,
    countedCount: counted.length,
    ownedCount,
    ownershipFraction,
    missing,
    lowQuantity,
    isMissingOne: missing.length === 1,
    maxBatchScale,
    expiringSoonFraction,
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export type RecipeSort = 'ownership' | 'alphabetical'

export interface RankingOptions extends OwnershipOptions {
  /** Only recipes carrying this cuisine tag. Case-insensitive. */
  readonly cuisine?: string
  /** Only recipes using something that needs using up. */
  readonly expiringSoonOnly?: boolean
  readonly sort?: RecipeSort
}

function compareByName(a: RecipeOwnership, b: RecipeOwnership): number {
  const byName = a.recipeName.localeCompare(b.recipeName)
  // Fall back to id so two recipes sharing a name still order deterministically.
  return byName !== 0 ? byName : a.recipeId.localeCompare(b.recipeId)
}

/**
 * DECISIONS.md ranking: most-owned first, then whatever uses up the most
 * expiring stock, then alphabetical so the order never wobbles between renders.
 */
export function compareByOwnership(a: RecipeOwnership, b: RecipeOwnership): number {
  if (a.ownershipFraction !== b.ownershipFraction) {
    return b.ownershipFraction - a.ownershipFraction
  }
  if (a.expiringSoonFraction !== b.expiringSoonFraction) {
    return b.expiringSoonFraction - a.expiringSoonFraction
  }
  return compareByName(a, b)
}

/** Evaluate and sort a whole recipe library. Does not mutate the input array. */
export function rankRecipes(
  recipes: readonly Recipe[],
  index: InventoryIndex,
  ontology: OntologyIndex,
  options: RankingOptions = {},
): RecipeOwnership[] {
  const cuisine = options.cuisine?.trim().toLowerCase()

  const selected = recipes.filter((recipe) => {
    if (cuisine === undefined || cuisine === '') return true
    return recipe.cuisines.some((tag) => tag.trim().toLowerCase() === cuisine)
  })

  let evaluated = selected.map((recipe) => evaluateOwnership(recipe, index, ontology, options))

  if (options.expiringSoonOnly === true) {
    evaluated = evaluated.filter((result) => result.expiringSoonFraction > 0)
  }

  const comparator = options.sort === 'alphabetical' ? compareByName : compareByOwnership
  return evaluated.sort(comparator)
}

/**
 * The "Missing One" tier that sits above the main list — recipes you could
 * cook tonight if you picked up a single thing.
 */
export function missingOneTier(ranked: readonly RecipeOwnership[]): RecipeOwnership[] {
  return ranked.filter((result) => result.isMissingOne)
}

/** Recipes with everything on hand for a full batch. */
export function fullyOwned(ranked: readonly RecipeOwnership[]): RecipeOwnership[] {
  return ranked.filter((result) => result.ownershipFraction === 1 && result.maxBatchScale >= 1)
}
