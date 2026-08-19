/**
 * Kitchen OS — Ownership and recipe ranking
 *
 * Answers "what can I actually cook right now?" — the thing the recipe grid
 * (Phase 6) sorts on and draws its ownership rings from.
 *
 * The rules come from DECISIONS.md, not from taste:
 *  - Ownership is BINARY. You have enough of an ingredient or you don't.
 *  - It is evaluated at 1x scale. Scaling happens after you pick a recipe.
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
  /** Grams the recipe calls for at 1x scale. */
  readonly requiredG: number
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
  /** How many lines count toward the percentage. */
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

function evaluateLine(
  index: InventoryIndex,
  ontology: OntologyIndex,
  ingredient: RecipeIngredient,
  today: DateOnly | undefined,
  withinDays: number,
): IngredientOwnership {
  const entry = ontology.get(ingredient.canonicalId)
  // An ingredient the ontology does not know is treated as tracked, so an
  // unknown id shows up as missing instead of quietly making a recipe look
  // more makeable than it is.
  const tracked = entry?.tracked ?? true
  const counted = tracked && !ingredient.optional

  const requiredG = ingredient.quantityG
  const availableG = availableGramsForLine(index, ingredient.canonicalId)

  const owned = availableG + GRAM_EPSILON >= requiredG
  const lowQuantity =
    !owned && requiredG > 0 && availableG >= requiredG * LOW_QUANTITY_THRESHOLD

  const expiringSoon =
    today !== undefined &&
    expiringSoonLotsFor(index, ingredient.canonicalId, today, withinDays).length > 0

  const maxScale = requiredG > 0 ? availableG / requiredG : Number.POSITIVE_INFINITY

  return {
    canonicalId: ingredient.canonicalId,
    requiredG,
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
  const lines = recipe.ingredients.map((ingredient) =>
    evaluateLine(index, ontology, ingredient, options.today, withinDays),
  )

  const counted = lines.filter((line) => line.counted)
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
