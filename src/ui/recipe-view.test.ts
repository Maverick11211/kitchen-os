import { describe, it, expect } from 'vitest'
import type {
  CanonicalIngredient,
  Lot,
  MacroSet,
  Product,
  Recipe,
  RecipeIngredient,
} from '../types/schema'
import { buildInventoryIndex, buildOntologyIndex, evaluateOwnership, rankRecipes } from '../engine'
import type { Appliance, ApplianceId } from '../types/schema'
import {
  batchFractionLabel,
  batchLabel,
  buildRecipeCards,
  buildRecipeLines,
  cuisineOptions,
  expiringLabel,
  formatQuantity,
  formatRecipeAmount,
  missingLabel,
  kitWarning,
  kitWarnings,
  ownershipPercent,
  splitTiers,
  summariseLibrary,
} from './recipe-view'

const TODAY = '2026-08-21'
const NOW = '2026-08-21T12:00:00.000Z'

const NO_MACROS: MacroSet = {
  calories: 0, proteinG: 0, carbsG: 0, fatG: 0,
  fiberG: 0, sugarG: 0, sodiumMg: 0, saturatedFatG: 0, cholesterolMg: 0,
}

function ingredient(overrides: Partial<CanonicalIngredient> & { id: string }): CanonicalIngredient {
  return {
    name: overrides.id,
    category: 'other',
    trackBy: 'mass',
    tracked: true,
    perishable: true,
    isSeed: true,
    aliases: [],
    ...overrides,
  }
}

function product(id: string, canonicalId: string): Product {
  return { id, canonicalId, name: id, macrosPer100g: NO_MACROS, createdAt: NOW }
}

function lot(overrides: Partial<Lot> & { id: string; productId: string }): Lot {
  const initialG = overrides.initialG ?? overrides.remainingG ?? 100
  return {
    initialG,
    remainingG: initialG,
    expiresOn: null,
    acquiredOn: '2026-08-01',
    depleted: false,
    ...overrides,
  }
}

function line(canonicalId: string, quantityG: number, optional = false): RecipeIngredient {
  return { canonicalId, quantity: quantityG, unit: 'g', quantityG, optional }
}

function recipe(overrides: Partial<Recipe> & { id: string }): Recipe {
  return {
    name: overrides.id,
    cuisines: ['Test'],
    ingredients: [],
    requiredAppliances: [],
    tools: [],
    steps: [{ order: 1, text: 'Cook it.' }],
    isSeed: true,
    createdAt: NOW,
    ...overrides,
  }
}

const ontology = buildOntologyIndex([
  ingredient({ id: 'chicken', name: 'Chicken thighs' }),
  ingredient({ id: 'rice', name: 'Jasmine rice', perishable: false }),
  ingredient({ id: 'soy', name: 'Soy sauce', perishable: false }),
  ingredient({ id: 'salt', name: 'Salt', tracked: false, perishable: false }),
])

/** An inventory holding exactly the grams asked for, with no expiry dates. */
function stockOf(holdings: Record<string, number>, expiresOn: string | null = null) {
  const products = Object.keys(holdings).map((id) => product(`p-${id}`, id))
  const lots = Object.entries(holdings).map(([id, grams]) =>
    lot({ id: `l-${id}`, productId: `p-${id}`, remainingG: grams, initialG: grams, expiresOn }),
  )
  return buildInventoryIndex(products, lots)
}

const own = (r: Recipe, holdings: Record<string, number>, expiresOn: string | null = null) =>
  evaluateOwnership(r, stockOf(holdings, expiresOn), ontology, { today: TODAY })

// ---------------------------------------------------------------------------

describe('ownershipPercent', () => {
  it('gives the round numbers only to exactly none and exactly all', () => {
    expect(ownershipPercent(0)).toBe(0)
    expect(ownershipPercent(1)).toBe(100)
  })

  it('never rounds a partial holding to 0% or 100%', () => {
    // Shown as 100% it is a lie you discover at the stove.
    expect(ownershipPercent(0.999)).toBe(99)
    expect(ownershipPercent(0.001)).toBe(1)
  })

  it('rounds normally in between', () => {
    expect(ownershipPercent(0.5)).toBe(50)
    expect(ownershipPercent(2 / 3)).toBe(67)
  })
})

describe('batchFractionLabel', () => {
  it('rounds down to the nearest step it can honestly promise', () => {
    expect(batchFractionLabel(0.74)).toBe('½')
    expect(batchFractionLabel(0.75)).toBe('¾')
    expect(batchFractionLabel(0.5)).toBe('½')
    expect(batchFractionLabel(0.34)).toBe('⅓')
    expect(batchFractionLabel(0.25)).toBe('¼')
  })

  it('says nothing below a quarter batch, which is not a meal', () => {
    expect(batchFractionLabel(0.2)).toBeNull()
    expect(batchFractionLabel(0)).toBeNull()
  })

  it('says nothing for a recipe of pure staples, where the limit is infinite', () => {
    expect(batchFractionLabel(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('batchLabel', () => {
  const dish = recipe({ id: 'dish', ingredients: [line('chicken', 200), line('rice', 100)] })

  it('offers a smaller batch when you have some of everything but not enough', () => {
    // Half of each. Ownership at 1x fails, but a half batch is real.
    expect(batchLabel(own(dish, { chicken: 100, rice: 50 }))).toBe('Enough for a ½ batch')
  })

  it('says nothing when one ingredient is missing altogether', () => {
    expect(batchLabel(own(dish, { chicken: 200 }))).toBeNull()
  })

  it('says nothing when there is enough for exactly one batch', () => {
    // The full ring already says this. A badge repeating it is noise.
    expect(batchLabel(own(dish, { chicken: 200, rice: 100 }))).toBeNull()
  })

  it('mentions cooking more than once when there is plenty', () => {
    // Chicken allows 4.5 batches, rice 4. The limiting ingredient wins, and
    // the count is rounded down: promising a fifth batch you cannot cook is
    // the one direction this must never round.
    expect(batchLabel(own(dish, { chicken: 900, rice: 400 }))).toBe('Enough for 4 batches')
  })

  it('says nothing about a recipe of pure staples', () => {
    const seasoning = recipe({ id: 'seasoning', ingredients: [line('salt', 5)] })
    expect(batchLabel(own(seasoning, {}))).toBeNull()
  })
})

describe('missingLabel', () => {
  const dish = recipe({
    id: 'dish',
    ingredients: [line('chicken', 200), line('rice', 100), line('soy', 30)],
  })

  it('is silent when nothing is missing', () => {
    expect(missingLabel(own(dish, { chicken: 200, rice: 100, soy: 30 }), ontology)).toBeNull()
  })

  it('names the one thing you need, which is the point of the tier', () => {
    expect(missingLabel(own(dish, { chicken: 200, rice: 100 }), ontology)).toBe('Missing Soy sauce')
  })

  it('distinguishes nearly enough from none at all', () => {
    // 90-99% still counts as not owned (DECISIONS.md) — but one of these sends
    // you to the shop and the other does not.
    expect(missingLabel(own(dish, { chicken: 200, rice: 100, soy: 28 }), ontology)).toBe(
      'Just short on Soy sauce',
    )
  })

  it('counts rather than lists once more than one is missing', () => {
    expect(missingLabel(own(dish, { chicken: 200 }), ontology)).toBe('Missing 2 ingredients')
  })

  it('falls back to the id for an ingredient the ontology has never heard of', () => {
    const odd = recipe({ id: 'odd', ingredients: [line('sumac', 10)] })
    expect(missingLabel(own(odd, {}), ontology)).toBe('Missing sumac')
  })

  it('ignores untracked staples, which are never missing', () => {
    const salted = recipe({ id: 'salted', ingredients: [line('rice', 100), line('salt', 5)] })
    expect(missingLabel(own(salted, { rice: 100 }), ontology)).toBeNull()
  })
})

describe('expiringLabel', () => {
  const dish = recipe({ id: 'dish', ingredients: [line('chicken', 200), line('rice', 100)] })

  it('is silent when nothing needs using up', () => {
    expect(expiringLabel(own(dish, { chicken: 200, rice: 100 }))).toBeNull()
  })

  it('counts the ingredients with stock going off', () => {
    const soon = own(dish, { chicken: 200, rice: 100 }, '2026-08-23')
    expect(expiringLabel(soon)).toBe('Uses 2 things going off')
  })

  it('reads as one thing in the singular', () => {
    const one = recipe({ id: 'one', ingredients: [line('chicken', 200)] })
    expect(expiringLabel(own(one, { chicken: 200 }, '2026-08-23'))).toBe('Uses 1 thing going off')
  })
})

// ---------------------------------------------------------------------------

describe('buildRecipeCards', () => {
  const stew = recipe({
    id: 'stew',
    name: 'Chicken stew',
    cuisines: ['Irish', 'British'],
    ingredients: [line('chicken', 200), line('rice', 100)],
  })
  const bowl = recipe({
    id: 'bowl',
    name: 'Rice bowl',
    cuisines: ['Japanese'],
    isSeed: false,
    ingredients: [line('rice', 100)],
  })
  const recipes = [stew, bowl]

  function cardsFor(holdings: Record<string, number>) {
    const index = stockOf(holdings)
    const ranked = rankRecipes(recipes, index, ontology, { today: TODAY })
    return buildRecipeCards(ranked, recipes, ontology)
  }

  it('keeps the ranking order it was given', () => {
    // Rice bowl is fully owned, chicken stew is not.
    expect(cardsFor({ rice: 100 }).map((card) => card.recipeId)).toEqual(['bowl', 'stew'])
  })

  it('shows one cuisine on the card and marks the User’s own recipes', () => {
    const cards = cardsFor({ rice: 100, chicken: 200 })
    const stewCard = cards.find((card) => card.recipeId === 'stew')
    const bowlCard = cards.find((card) => card.recipeId === 'bowl')
    expect(stewCard?.cuisine).toBe('Irish')
    expect(stewCard?.isSeed).toBe(true)
    expect(bowlCard?.isSeed).toBe(false)
  })

  it('carries the counted ingredients, not every line', () => {
    const salted = recipe({
      id: 'salted',
      ingredients: [line('rice', 100), line('salt', 5), line('soy', 10, true)],
    })
    const index = stockOf({ rice: 100 })
    const cards = buildRecipeCards(
      rankRecipes([salted], index, ontology, { today: TODAY }),
      [salted],
      ontology,
    )
    // Salt is untracked and the soy is optional: one line counts, and it is met.
    expect(cards[0].countedCount).toBe(1)
    expect(cards[0].ownedCount).toBe(1)
    expect(cards[0].ready).toBe(true)
    expect(cards[0].percent).toBe(100)
  })

  it('skips a ranked recipe it has no recipe for rather than drawing a blank card', () => {
    const index = stockOf({ rice: 100 })
    const ranked = rankRecipes(recipes, index, ontology, { today: TODAY })
    expect(buildRecipeCards(ranked, [bowl], ontology).map((card) => card.recipeId)).toEqual(['bowl'])
  })

  it('treats an empty library as an empty grid, not an error', () => {
    expect(buildRecipeCards([], [], ontology)).toEqual([])
  })
})

describe('splitTiers', () => {
  const three = recipe({
    id: 'three',
    ingredients: [line('chicken', 200), line('rice', 100), line('soy', 30)],
  })
  const one = recipe({ id: 'one', ingredients: [line('rice', 100)] })
  const recipes = [three, one]

  it('lifts the one-thing-away recipes out so nothing appears twice', () => {
    // `three` needs 11-of-12 treatment: two of three ingredients on hand, and
    // it ranks BELOW the fully-owned single-ingredient recipe.
    const index = stockOf({ chicken: 200, rice: 100 })
    const cards = buildRecipeCards(
      rankRecipes(recipes, index, ontology, { today: TODAY }),
      recipes,
      ontology,
    )
    const tiers = splitTiers(cards)

    expect(tiers.missingOne.map((card) => card.recipeId)).toEqual(['three'])
    expect(tiers.rest.map((card) => card.recipeId)).toEqual(['one'])
  })

  it('leaves everything in the main list when nothing is one away', () => {
    const index = stockOf({ rice: 100 })
    const cards = buildRecipeCards(
      rankRecipes(recipes, index, ontology, { today: TODAY }),
      recipes,
      ontology,
    )
    const tiers = splitTiers(cards)
    expect(tiers.missingOne).toEqual([])
    expect(tiers.rest.length).toBe(2)
  })
})

describe('cuisineOptions', () => {
  it('is every cuisine once, alphabetically', () => {
    const recipes = [
      recipe({ id: 'a', cuisines: ['Thai', 'Chinese'] }),
      recipe({ id: 'b', cuisines: ['Chinese'] }),
      recipe({ id: 'c', cuisines: ['British'] }),
    ]
    expect(cuisineOptions(recipes)).toEqual(['British', 'Chinese', 'Thai'])
  })

  it('ignores blank tags', () => {
    expect(cuisineOptions([recipe({ id: 'a', cuisines: ['  ', 'Thai'] })])).toEqual(['Thai'])
  })
})

describe('kit warnings on a recipe', () => {
  const kit = (rows: readonly Appliance[]): ReadonlyMap<ApplianceId, Appliance> =>
    new Map(rows.map((row) => [row.id, row]))

  const stirFry = recipe({ id: 'stir-fry', tools: ['wok', '6 qt pot'] })

  it('is silent when he has never been asked', () => {
    expect(kitWarnings(stirFry, kit([]))).toEqual([])
    expect(kitWarning(stirFry, kit([]))).toBeNull()
  })

  it('lists every problem for the recipe page', () => {
    const answers = kit([
      { id: 'wok', name: 'Wok', owned: false },
      { id: 'pot', name: 'Pot', owned: true, size: 3 },
    ])
    expect(kitWarnings(stirFry, answers)).toEqual([
      'You have no wok',
      'Your biggest pot is 3 qt; this needs 6',
    ])
  })

  it('gives a card one line and a count of the rest', () => {
    // A card listing three equipment problems has stopped being a card.
    const answers = kit([
      { id: 'wok', name: 'Wok', owned: false },
      { id: 'pot', name: 'Pot', owned: true, size: 3 },
    ])
    expect(kitWarning(stirFry, answers)).toBe('You have no wok (+1 more)')
  })

  it('gives a card the problem itself when there is only one', () => {
    expect(kitWarning(stirFry, kit([{ id: 'wok', name: 'Wok', owned: false }]))).toBe(
      'You have no wok',
    )
  })
})

describe('formatQuantity', () => {
  it('writes the fractions a recipe is written in', () => {
    expect(formatQuantity(0.5)).toBe('½')
    expect(formatQuantity(0.25)).toBe('¼')
    expect(formatQuantity(0.75)).toBe('¾')
  })

  it('recognises the stored thirds, which are not exact', () => {
    // recipes.json holds 0.667, because arithmetic needs a number.
    expect(formatQuantity(0.667)).toBe('⅔')
    expect(formatQuantity(0.333)).toBe('⅓')
  })

  it('keeps whole numbers whole and mixes the rest', () => {
    expect(formatQuantity(2)).toBe('2')
    expect(formatQuantity(1.5)).toBe('1½')
    expect(formatQuantity(2.667)).toBe('2⅔')
  })

  it('falls back to one decimal for anything that is not a nice fraction', () => {
    expect(formatQuantity(1.4)).toBe('1.4')
    expect(formatQuantity(0.15)).toBe('0.2')
  })
})

describe('formatRecipeAmount', () => {
  it('puts the unit after the number', () => {
    expect(formatRecipeAmount(line('rice', 100))).toBe('100 g')
  })

  it('leaves a count bare, because the name says what it is', () => {
    expect(
      formatRecipeAmount({ canonicalId: 'egg', quantity: 3, unit: 'count', quantityG: 150, optional: false }),
    ).toBe('3')
  })

  it('writes cups as fractions', () => {
    expect(
      formatRecipeAmount({ canonicalId: 'rice', quantity: 0.667, unit: 'cup', quantityG: 123, optional: false }),
    ).toBe('⅔ cup')
  })
})

describe('buildRecipeLines', () => {
  const dish = recipe({
    id: 'dish',
    ingredients: [
      { canonicalId: 'chicken', quantity: 1, unit: 'lb', quantityG: 453.6, optional: false, preparation: 'cubed' },
      line('rice', 100),
      line('salt', 5),
      line('soy', 30, true),
    ],
  })

  const linesFor = (holdings: Record<string, number>) =>
    buildRecipeLines(dish, own(dish, holdings), ontology)

  it('shows every line, staples and garnishes included', () => {
    // Hiding them would mean the list on screen was not the recipe.
    expect(linesFor({}).map((row) => row.canonicalId)).toEqual(['chicken', 'rice', 'salt', 'soy'])
  })

  it('marks each line with what it is doing', () => {
    const rows = linesFor({ chicken: 453.6, rice: 95 })
    expect(rows.map((row) => row.status)).toEqual(['have', 'low', 'staple', 'optional'])
  })

  it('says nothing about stock on a line you have', () => {
    expect(linesFor({ chicken: 453.6 })[0].stockLabel).toBeNull()
  })

  it('shows what is there against what is needed when it is short', () => {
    expect(linesFor({ rice: 95 })[1].stockLabel).toBe('95 g of 100 g')
  })

  it('says so plainly when there is none at all', () => {
    expect(linesFor({})[1].stockLabel).toBe('None in the kitchen')
  })

  it('carries the amount as written and the preparation note', () => {
    const rows = linesFor({})
    expect(rows[0].amount).toBe('1 lb')
    expect(rows[0].preparation).toBe('cubed')
    expect(rows[1].preparation).toBeNull()
  })

  it('walks the two lists in step, so a repeated ingredient stays two rows', () => {
    const twice = recipe({ id: 'twice', ingredients: [line('rice', 100), line('rice', 50)] })
    const rows = buildRecipeLines(twice, own(twice, { rice: 60 }), ontology)
    expect(rows.length).toBe(2)
    // 150 g needed between them and 60 g in the kitchen: both rows are short.
    // Before the pooling fix the second row read "have", because 60 g covers
    // its own 50 g if you forget about the first line.
    expect(rows.map((row) => row.status)).toEqual(['missing', 'missing'])
  })

  it('explains the bigger number on a row whose ingredient is listed twice', () => {
    const twice = recipe({ id: 'twice', ingredients: [line('rice', 100), line('rice', 50)] })
    const rows = buildRecipeLines(twice, own(twice, { rice: 60 }), ontology)
    expect(rows[1].stockLabel).toBe('60 g of 150 g needed in total')
  })
})

describe('summariseLibrary', () => {
  it('counts what the header and the rail badge show', () => {
    const three = recipe({
      id: 'three',
      ingredients: [line('chicken', 200), line('rice', 100), line('soy', 30)],
    })
    const one = recipe({ id: 'one', ingredients: [line('rice', 100)] })
    const recipes = [three, one]
    const index = stockOf({ chicken: 200, rice: 100 })
    const cards = buildRecipeCards(
      rankRecipes(recipes, index, ontology, { today: TODAY }),
      recipes,
      ontology,
    )

    expect(summariseLibrary(cards)).toEqual({ total: 2, ready: 1, missingOne: 1 })
  })
})
