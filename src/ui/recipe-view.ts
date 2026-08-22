/**
 * Kitchen OS — Turning ranked recipes into what a card shows
 *
 * View logic, not domain logic. Every number here was worked out by
 * `src/engine/ownership.ts`; this module decides which of them earn space on a
 * card and what they read as in words (CLAUDE.md: the UI does no arithmetic).
 *
 * Pure and clock-free, same as `inventory-view.ts` and `nutrition-view.ts`.
 * `today` never appears — it was already applied upstream when the ranking was
 * computed.
 *
 * ## One mark, one meaning
 *
 * The ring is `ownershipFraction` and nothing else (Jack, 2026-08-21).
 * Max batch size and expiring stock are words underneath rather than a second
 * variable tinted into the same arc, which reads as one number and is then
 * misread. That is why this module produces labels and not a second fraction.
 *
 * ## A conflict with DECISIONS.md, flagged rather than worked around
 *
 * The Recipes section gives max batch size the example *"You have everything,
 * but only enough for a ½ batch"* and calls it "a 100% recipe you can't
 * actually make". As the engine was built in Phase 3, that sentence cannot
 * happen: `owned` means `availableG >= requiredG` at 1x, so if every counted
 * line is owned then every `maxScale` is at least 1 and `maxBatchScale` cannot
 * be below it. A 100% recipe is always makeable.
 *
 * The useful reading — and the one used here — is the mirror image: a recipe
 * that is NOT fully owned can still have some of everything. `maxBatchScale` of
 * 0.6 means every counted ingredient has at least 60% of what a full batch
 * needs, so a half batch is genuinely on the table even though the card shows
 * less than 100%. That is worth saying out loud, because the alternative is
 * scrolling past a recipe you could actually cook tonight at half size.
 *
 * The decision itself is untouched: max batch is still shown when the limiting
 * ingredient allows less than a full batch. Only the example was unreachable.
 */
import type { Appliance, ApplianceId, Recipe, RecipeId, RecipeIngredient } from '../types/schema'
import type { IngredientOwnership, OntologyIndex, RecipeOwnership } from '../engine'
import { equipmentNeeds, kitProblems } from '../engine'
import { formatGrams } from './inventory-view'

// ---------------------------------------------------------------------------
// Batch sizes in words
// ---------------------------------------------------------------------------

/**
 * Rounded DOWN to the nearest step, always. A card that says "½ batch" when
 * two thirds is possible costs nothing; one that says "½ batch" when only
 * 40% is there sends someone to the kitchen to find out the hard way.
 *
 * Below a quarter batch there is no honest encouragement left, so nothing is
 * shown rather than "⅛ batch", which is not a meal.
 */
const BATCH_STEPS: readonly { readonly atLeast: number; readonly label: string }[] = [
  { atLeast: 0.75, label: '¾' },
  { atLeast: 0.5, label: '½' },
  { atLeast: 1 / 3, label: '⅓' },
  { atLeast: 0.25, label: '¼' },
]

/** The largest fraction of a batch the stock supports, in words. Null under a quarter. */
export function batchFractionLabel(maxBatchScale: number): string | null {
  if (!Number.isFinite(maxBatchScale)) return null
  const step = BATCH_STEPS.find((candidate) => maxBatchScale >= candidate.atLeast)
  return step?.label ?? null
}

/**
 * What the card says about batch size, or null when there is nothing to add.
 *
 * Two different sentences, because the two cases are different questions:
 *   not fully owned — "could I still cook this tonight, smaller?"
 *   fully owned     — "is there enough here to cook once, or to cook for the week?"
 *
 * A fully owned recipe with enough for exactly one batch says nothing at all.
 * That is the normal case and it is already implied by a full ring.
 */
export function batchLabel(ownership: RecipeOwnership): string | null {
  const { ownershipFraction, maxBatchScale } = ownership

  if (ownershipFraction < 1) {
    const fraction = batchFractionLabel(maxBatchScale)
    return fraction === null ? null : `Enough for a ${fraction} batch`
  }

  if (!Number.isFinite(maxBatchScale) || maxBatchScale < 2) return null
  return `Enough for ${Math.floor(maxBatchScale)} batches`
}

// ---------------------------------------------------------------------------
// What is missing
// ---------------------------------------------------------------------------

function ingredientName(ontology: OntologyIndex, id: string): string {
  // Falling back to the id keeps an unknown ingredient visible rather than
  // rendering an empty label — the same reasoning as `evaluateLine` treating an
  // unknown id as tracked.
  return ontology.get(id)?.name ?? id
}

/**
 * The missing-ingredient line, or null when nothing is missing.
 *
 * One missing ingredient is NAMED — that is the whole point of the Missing One
 * tier, and "one thing away" is useless if you have to open the recipe to find
 * out what the thing is. Beyond one, a count is more use than a list that
 * would not fit on a card.
 *
 * A single missing ingredient you nearly have enough of gets its own wording.
 * DECISIONS.md is firm that 90-99% counts as not owned, and this respects that
 * — it still appears as missing — but "just short on rice" and "no rice at all"
 * send you to different places, and only one of them is the shop.
 */
export function missingLabel(ownership: RecipeOwnership, ontology: OntologyIndex): string | null {
  const { missing, lowQuantity } = ownership
  if (missing.length === 0) return null

  if (missing.length === 1) {
    const id = missing[0]
    const name = ingredientName(ontology, id)
    return lowQuantity.includes(id) ? `Just short on ${name}` : `Missing ${name}`
  }

  return `Missing ${missing.length} ingredients`
}

/** "Uses 2 things going off", or null when nothing in it needs using up. */
export function expiringLabel(ownership: RecipeOwnership): string | null {
  const count = ownership.lines.filter((line) => line.counted && line.expiringSoon).length
  if (count === 0) return null
  return count === 1 ? 'Uses 1 thing going off' : `Uses ${count} things going off`
}

/**
 * Everything wrong with the kit for this recipe, in words. Usually empty.
 *
 * The work is the engine's (`equipmentNeeds` reads the recipe's tool text,
 * `kitProblems` checks it against what he owns). This is only the join.
 *
 * Silence covers two different things and deliberately does not distinguish
 * them: he owns it, or he has never been asked. A row exists only once he has
 * answered (Jack, 2026-08-21), so an absent row is "unknown" — warning about a
 * stovetop nobody asked about would put a warning on 57 of the 150 seed
 * recipes and teach him to ignore warnings.
 *
 * A recipe is never hidden for any of this. DECISIONS.md, Appliances.
 */
export function kitWarnings(
  recipe: Recipe,
  kit: ReadonlyMap<ApplianceId, Appliance>,
): string[] {
  return kitProblems(equipmentNeeds(recipe), kit).map((problem) => problem.message)
}

/** The one kit line a card has room for. Null when there is nothing wrong. */
export function kitWarning(
  recipe: Recipe,
  kit: ReadonlyMap<ApplianceId, Appliance>,
): string | null {
  const warnings = kitWarnings(recipe, kit)
  if (warnings.length === 0) return null
  // One line on a card, all of them on the recipe itself. A card that lists
  // three equipment problems has stopped being a card.
  return warnings.length === 1 ? warnings[0] : `${warnings[0]} (+${warnings.length - 1} more)`
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface RecipeCardView {
  readonly recipeId: RecipeId
  readonly name: string
  /** First cuisine tag. A card shows one; the rest are in the detail view. */
  readonly cuisine: string
  /** False for a recipe the User typed in. */
  readonly isSeed: boolean
  /** 0..1, what the ring draws. */
  readonly fraction: number
  /** 0..100, rounded for the number inside the ring. */
  readonly percent: number
  readonly ownedCount: number
  readonly countedCount: number
  /** Everything countable is on hand for a full batch. */
  readonly ready: boolean
  readonly missingOne: boolean
  readonly missingLabel: string | null
  readonly batchLabel: string | null
  readonly expiringLabel: string | null
  /** The one kit line the card has room for. Null when nothing is wrong. */
  readonly kitWarning: string | null
}

/**
 * Rounds toward the middle, never to a misleading 0 or 100.
 *
 * 0.996 shown as "100%" is a lie you find out about at the stove, and 0.004 as
 * "0%" hides the fact that you have something. Only exactly none and exactly
 * all get the round numbers.
 */
export function ownershipPercent(fraction: number): number {
  if (fraction <= 0) return 0
  if (fraction >= 1) return 100
  return Math.min(99, Math.max(1, Math.round(fraction * 100)))
}

/**
 * Build the cards for a ranked library.
 *
 * `ranked` carries the ownership figures and `recipes` carries what a recipe IS
 * — name, cuisine, appliances. They are joined here rather than the engine
 * being made to hold display data it has no use for.
 *
 * Ranking order is preserved. A recipe in `ranked` with no matching entry in
 * `recipes` is skipped rather than rendered half-blank; it cannot happen while
 * both come from the same list, and silently dropping one is better than a card
 * with no name on it.
 */
export function buildRecipeCards(
  ranked: readonly RecipeOwnership[],
  recipes: readonly Recipe[],
  ontology: OntologyIndex,
  appliances: ReadonlyMap<ApplianceId, Appliance> = new Map(),
): RecipeCardView[] {
  const byId = new Map<RecipeId, Recipe>(recipes.map((recipe) => [recipe.id, recipe]))

  const cards: RecipeCardView[] = []
  for (const ownership of ranked) {
    const recipe = byId.get(ownership.recipeId)
    if (recipe === undefined) continue

    cards.push({
      recipeId: recipe.id,
      name: recipe.name,
      cuisine: recipe.cuisines[0] ?? '',
      isSeed: recipe.isSeed,
      fraction: ownership.ownershipFraction,
      percent: ownershipPercent(ownership.ownershipFraction),
      ownedCount: ownership.ownedCount,
      countedCount: ownership.countedCount,
      ready: ownership.ownershipFraction === 1,
      missingOne: ownership.isMissingOne,
      missingLabel: missingLabel(ownership, ontology),
      batchLabel: batchLabel(ownership),
      expiringLabel: expiringLabel(ownership),
      kitWarning: kitWarning(recipe, appliances),
    })
  }

  return cards
}

// ---------------------------------------------------------------------------
// Tiers and filters
// ---------------------------------------------------------------------------

export interface RecipeTiers {
  /** Exactly one countable ingredient away. Shown above the main list. */
  readonly missingOne: readonly RecipeCardView[]
  /** Everything else, in ranking order. */
  readonly rest: readonly RecipeCardView[]
}

/**
 * Split the Missing One tier off the top of the list.
 *
 * Those recipes are LIFTED OUT rather than highlighted in place, so nothing
 * appears on the screen twice. Lifting is the point: ranking is by fraction, so
 * a recipe needing 11 of its 12 ingredients sits below a three-ingredient one
 * you happen to have all of, and would never be seen without this.
 */
export function splitTiers(cards: readonly RecipeCardView[]): RecipeTiers {
  return {
    missingOne: cards.filter((card) => card.missingOne),
    rest: cards.filter((card) => !card.missingOne),
  }
}

/**
 * Only the recipes you could cook tonight without buying or borrowing anything.
 *
 * An opt-in filter, which is not the same as hiding: DECISIONS.md forbids
 * HIDING a recipe you lack the equipment for, and this is the User choosing to
 * look at a shorter list (Jack, 2026-08-21).
 *
 * Kit counts as well as ingredients. Every ingredient present but no wok is not
 * a recipe you can make tonight, and a filter that said otherwise would send
 * you to the kitchen to find out.
 */
export function onlyMakeable(cards: readonly RecipeCardView[]): RecipeCardView[] {
  return cards.filter((card) => card.ready && card.kitWarning === null)
}

/** Every cuisine in the library, alphabetically, for the filter menu. */
export function cuisineOptions(recipes: readonly Recipe[]): string[] {
  const seen = new Set<string>()
  for (const recipe of recipes) {
    for (const cuisine of recipe.cuisines) {
      const trimmed = cuisine.trim()
      if (trimmed !== '') seen.add(trimmed)
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

// ---------------------------------------------------------------------------
// The detail view
// ---------------------------------------------------------------------------

/**
 * Vulgar fractions for the amounts recipes are actually written in.
 *
 * `recipes.json` stores two thirds of a cup as 0.667 because that is what
 * arithmetic needs. "0.67 cup" is not what anybody has ever said out loud, and
 * a recipe you are reading at the stove should look like a recipe.
 */
const FRACTIONS: readonly { readonly value: number; readonly glyph: string }[] = [
  { value: 1 / 4, glyph: '¼' },
  { value: 1 / 3, glyph: '⅓' },
  { value: 1 / 2, glyph: '½' },
  { value: 2 / 3, glyph: '⅔' },
  { value: 3 / 4, glyph: '¾' },
]

/** Tolerance for calling 0.667 two thirds. Well inside the ±15% this app allows. */
const FRACTION_EPSILON = 0.011

/** "1½", "⅔", "2", "1.4" — a quantity as a cook would write it. */
export function formatQuantity(quantity: number): string {
  const whole = Math.floor(quantity)
  const part = quantity - whole
  const glyph = FRACTIONS.find((candidate) => Math.abs(part - candidate.value) < FRACTION_EPSILON)

  if (glyph !== undefined) return whole === 0 ? glyph.glyph : `${whole}${glyph.glyph}`
  if (Number.isInteger(quantity)) return String(quantity)
  return String(Math.round(quantity * 10) / 10)
}

/**
 * The amount as the recipe wrote it.
 *
 * A `count` line shows the bare number: the ingredient's name is already beside
 * it, so "2 garlic clove" would be saying it twice and worse.
 */
export function formatRecipeAmount(ingredient: RecipeIngredient): string {
  const quantity = formatQuantity(ingredient.quantity)
  return ingredient.unit === 'count' ? quantity : `${quantity} ${ingredient.unit}`
}

/**
 * What one ingredient row is doing.
 *
 *   have / low / missing — counted lines, the ones the percentage is made of
 *   staple              — untracked (salt, oil, water): assumed to be there
 *   optional            — a garnish, excluded by DECISIONS.md
 *
 * Staple and optional are shown, never hidden. Leaving them off the page would
 * mean the ingredient list on screen was not the recipe.
 */
export type RecipeLineStatus = 'have' | 'low' | 'missing' | 'staple' | 'optional'

export interface RecipeLineView {
  readonly canonicalId: string
  readonly name: string
  readonly amount: string
  readonly preparation: string | null
  readonly status: RecipeLineStatus
  /** How much is in the kitchen against what is needed. Null when it is all there. */
  readonly stockLabel: string | null
}

function lineStatus(line: IngredientOwnership): RecipeLineStatus {
  if (line.optional) return 'optional'
  if (!line.tracked) return 'staple'
  if (line.owned) return 'have'
  return line.lowQuantity ? 'low' : 'missing'
}

/**
 * Measured against `requiredTotalG`, not the line's own amount.
 *
 * When a recipe names an ingredient twice, both rows are judged against the
 * sum, so both rows have to say the sum — otherwise a row reading "119 g of
 * 119 g" would sit there marked Missing with no explanation. The wording says
 * "in total" on exactly those rows so the bigger number is not a typo.
 */
function stockLabel(line: IngredientOwnership, status: RecipeLineStatus): string | null {
  if (status !== 'low' && status !== 'missing') return null
  if (line.availableG <= 0) return 'None in the kitchen'

  const against = `${formatGrams(line.availableG)} of ${formatGrams(line.requiredTotalG)}`
  return line.requiredTotalG > line.requiredG ? `${against} needed in total` : against
}

/**
 * Every ingredient row for the detail view, in recipe order.
 *
 * `ownership.lines` is already one entry per recipe ingredient in recipe order
 * (including the excluded ones), so the two lists are walked together by index
 * rather than looked up by canonical id — a recipe calling for the same
 * ingredient twice would collapse into one row otherwise.
 */
export function buildRecipeLines(
  recipe: Recipe,
  ownership: RecipeOwnership,
  ontology: OntologyIndex,
): RecipeLineView[] {
  return recipe.ingredients.map((ingredient, position) => {
    const line = ownership.lines[position]
    const status = line === undefined ? 'missing' : lineStatus(line)

    return {
      canonicalId: ingredient.canonicalId,
      name: ingredientName(ontology, ingredient.canonicalId),
      amount: formatRecipeAmount(ingredient),
      preparation: ingredient.preparation ?? null,
      status,
      stockLabel: line === undefined ? null : stockLabel(line, status),
    }
  })
}

export interface RecipeLibrarySummary {
  readonly total: number
  readonly ready: number
  readonly missingOne: number
}

/** The counts in the screen header, and the "ready" badge in the rail. */
export function summariseLibrary(cards: readonly RecipeCardView[]): RecipeLibrarySummary {
  return {
    total: cards.length,
    ready: cards.filter((card) => card.ready).length,
    missingOne: cards.filter((card) => card.missingOne).length,
  }
}
