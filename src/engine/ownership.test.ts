import { describe, it, expect } from 'vitest'
import type {
  CanonicalIngredient,
  Lot,
  MacroSet,
  Product,
  Recipe,
  RecipeIngredient,
} from '../types/schema'
import { buildInventoryIndex } from './inventory'
import { buildOntologyIndex } from './ontology'
import {
  DEFAULT_EXPIRING_SOON_DAYS,
  compareByOwnership,
  evaluateOwnership,
  fullyOwned,
  missingOneTier,
  rankRecipes,
} from './ownership'

const TODAY = '2026-08-19'
const NOW = '2026-08-19T12:00:00.000Z'

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
    isSeed: false,
    createdAt: NOW,
    ...overrides,
  }
}

// Ontology shared by most tests: two real ingredients, one untracked staple.
const ontology = buildOntologyIndex([
  ingredient({ id: 'chicken' }),
  ingredient({ id: 'rice', perishable: false }),
  ingredient({ id: 'parsley' }),
  ingredient({ id: 'salt', tracked: false, perishable: false }),
])

/** Inventory holding exactly the grams named. */
function stockedWith(holdings: Record<string, number>, expiresOn: string | null = null) {
  const products: Product[] = []
  const lots: Lot[] = []
  for (const [canonicalId, grams] of Object.entries(holdings)) {
    products.push(product(`p-${canonicalId}`, canonicalId))
    lots.push(lot({ id: `l-${canonicalId}`, productId: `p-${canonicalId}`, remainingG: grams, expiresOn }))
  }
  return buildInventoryIndex(products, lots)
}

// ---------------------------------------------------------------------------

describe('evaluateOwnership — the percentage', () => {
  const dish = recipe({
    id: 'chicken-rice',
    ingredients: [line('chicken', 300), line('rice', 200)],
  })

  it('is 1 when everything is on hand', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 500, rice: 500 }), ontology)
    expect(result.ownershipFraction).toBe(1)
    expect(result.ownedCount).toBe(2)
    expect(result.missing).toEqual([])
  })

  it('is 0 with an empty kitchen', () => {
    const result = evaluateOwnership(dish, stockedWith({}), ontology)
    expect(result.ownershipFraction).toBe(0)
    expect(result.missing).toEqual(['chicken', 'rice'])
  })

  it('is a half when one of two is on hand', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 500 }), ontology)
    expect(result.ownershipFraction).toBe(0.5)
    expect(result.missing).toEqual(['rice'])
  })

  it('is binary — having 299 of 300 grams is not owned', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 299, rice: 500 }), ontology)
    expect(result.lines[0]?.owned).toBe(false)
    expect(result.ownershipFraction).toBe(0.5)
  })

  it('counts an exact match as owned', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 300, rice: 200 }), ontology)
    expect(result.ownershipFraction).toBe(1)
  })

  it('is not defeated by floating-point dust', () => {
    const index = stockedWith({ chicken: 300 - 1e-12, rice: 200 })
    expect(evaluateOwnership(dish, index, ontology).ownershipFraction).toBe(1)
  })

  it('pools multiple lots and products of the same ingredient', () => {
    const index = buildInventoryIndex(
      [product('cheap', 'chicken'), product('fancy', 'chicken')],
      [
        lot({ id: 'a', productId: 'cheap', remainingG: 150 }),
        lot({ id: 'b', productId: 'fancy', remainingG: 200 }),
      ],
    )
    expect(evaluateOwnership(dish, index, ontology).lines[0]?.availableG).toBe(350)
  })

  it('ignores depleted lots', () => {
    const index = buildInventoryIndex(
      [product('p', 'chicken')],
      [lot({ id: 'a', productId: 'p', initialG: 900, remainingG: 0, depleted: true })],
    )
    expect(evaluateOwnership(dish, index, ontology).lines[0]?.owned).toBe(false)
  })
})

describe('exclusions from the percentage', () => {
  it('excludes untracked staples but still reports them', () => {
    const dish = recipe({
      id: 'x',
      ingredients: [line('chicken', 300), line('salt', 5)],
    })
    const result = evaluateOwnership(dish, stockedWith({ chicken: 500 }), ontology)
    expect(result.countedCount).toBe(1)
    expect(result.ownershipFraction).toBe(1)
    expect(result.missing).toEqual([])
    expect(result.lines).toHaveLength(2)
    expect(result.lines[1]?.counted).toBe(false)
    expect(result.lines[1]?.tracked).toBe(false)
  })

  it('excludes optional garnishes but still reports them', () => {
    const dish = recipe({
      id: 'x',
      ingredients: [line('chicken', 300), line('parsley', 5, true)],
    })
    const result = evaluateOwnership(dish, stockedWith({ chicken: 500 }), ontology)
    expect(result.countedCount).toBe(1)
    expect(result.ownershipFraction).toBe(1)
    expect(result.lines[1]?.counted).toBe(false)
    expect(result.lines[1]?.optional).toBe(true)
    expect(result.lines[1]?.owned).toBe(false)
  })

  it('a recipe of nothing but staples is fully owned, not a divide by zero', () => {
    const dish = recipe({ id: 'salted-water', ingredients: [line('salt', 5)] })
    const result = evaluateOwnership(dish, stockedWith({}), ontology)
    expect(result.countedCount).toBe(0)
    expect(result.ownershipFraction).toBe(1)
    expect(Number.isNaN(result.ownershipFraction)).toBe(false)
    expect(result.maxBatchScale).toBe(Number.POSITIVE_INFINITY)
  })

  it('counts an ingredient the ontology does not know, so it cannot hide', () => {
    const dish = recipe({ id: 'x', ingredients: [line('unobtainium', 10)] })
    const result = evaluateOwnership(dish, stockedWith({}), ontology)
    expect(result.countedCount).toBe(1)
    expect(result.missing).toEqual(['unobtainium'])
  })
})

describe('low quantity warning', () => {
  const dish = recipe({ id: 'x', ingredients: [line('chicken', 100)] })

  it('fires at exactly 90% of the requirement', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 90 }), ontology)
    expect(result.lines[0]?.lowQuantity).toBe(true)
    expect(result.lowQuantity).toEqual(['chicken'])
  })

  it('fires at 99%', () => {
    expect(evaluateOwnership(dish, stockedWith({ chicken: 99 }), ontology).lines[0]?.lowQuantity)
      .toBe(true)
  })

  it('does NOT fire below 90%', () => {
    expect(evaluateOwnership(dish, stockedWith({ chicken: 89 }), ontology).lines[0]?.lowQuantity)
      .toBe(false)
  })

  it('does NOT fire once the ingredient is actually owned', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 100 }), ontology)
    expect(result.lines[0]?.lowQuantity).toBe(false)
    expect(result.lowQuantity).toEqual([])
  })

  it('still counts as NOT owned — a warning, not a pass', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 95 }), ontology)
    expect(result.lines[0]?.owned).toBe(false)
    expect(result.ownershipFraction).toBe(0)
    expect(result.missing).toEqual(['chicken'])
  })

  it('low-quantity ingredients are a subset of missing ones', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 95 }), ontology)
    for (const id of result.lowQuantity) expect(result.missing).toContain(id)
  })
})

describe('max batch scale', () => {
  const dish = recipe({
    id: 'x',
    ingredients: [line('chicken', 300), line('rice', 200)],
  })

  it('is set by the limiting ingredient', () => {
    // Chicken allows 2 batches, rice only 1.5 — rice is the limit.
    const result = evaluateOwnership(dish, stockedWith({ chicken: 600, rice: 300 }), ontology)
    expect(result.maxBatchScale).toBeCloseTo(1.5, 10)
  })

  it('reports a half batch when you have everything but not enough', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 150, rice: 100 }), ontology)
    expect(result.maxBatchScale).toBeCloseTo(0.5, 10)
    // The surprise this exists to remove: NOT a 100% recipe.
    expect(result.ownershipFraction).toBe(0)
  })

  it('is at least 1 whenever the recipe is fully owned', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 300, rice: 200 }), ontology)
    expect(result.ownershipFraction).toBe(1)
    expect(result.maxBatchScale).toBeGreaterThanOrEqual(1)
  })

  it('is zero when the limiting ingredient is absent', () => {
    expect(evaluateOwnership(dish, stockedWith({ chicken: 600 }), ontology).maxBatchScale).toBe(0)
  })

  it('ignores optional and untracked lines', () => {
    const withGarnish = recipe({
      id: 'y',
      ingredients: [line('chicken', 100), line('parsley', 100, true), line('salt', 100)],
    })
    const result = evaluateOwnership(withGarnish, stockedWith({ chicken: 500 }), ontology)
    expect(result.maxBatchScale).toBe(5)
  })
})

describe('Missing One tier', () => {
  const dish = recipe({
    id: 'x',
    ingredients: [line('chicken', 100), line('rice', 100), line('parsley', 100)],
  })

  it('flags a recipe exactly one ingredient short, and names it', () => {
    const result = evaluateOwnership(dish, stockedWith({ chicken: 500, rice: 500 }), ontology)
    expect(result.isMissingOne).toBe(true)
    expect(result.missing).toEqual(['parsley'])
  })

  it('does not flag a fully owned recipe', () => {
    const index = stockedWith({ chicken: 500, rice: 500, parsley: 500 })
    expect(evaluateOwnership(dish, index, ontology).isMissingOne).toBe(false)
  })

  it('does not flag a recipe two short', () => {
    expect(evaluateOwnership(dish, stockedWith({ chicken: 500 }), ontology).isMissingOne).toBe(false)
  })

  it('fires on a low-quantity ingredient too — 95% is still a shopping trip', () => {
    const index = stockedWith({ chicken: 500, rice: 500, parsley: 95 })
    const result = evaluateOwnership(dish, index, ontology)
    expect(result.isMissingOne).toBe(true)
    expect(result.lowQuantity).toEqual(['parsley'])
  })

  it('missingOneTier selects exactly those recipes', () => {
    const index = stockedWith({ chicken: 500, rice: 500 })
    const ranked = rankRecipes(
      [dish, recipe({ id: 'all-there', ingredients: [line('chicken', 10)] })],
      index,
      ontology,
    )
    expect(missingOneTier(ranked).map((r) => r.recipeId)).toEqual(['x'])
  })
})

describe('expiring soon', () => {
  const dish = recipe({ id: 'x', ingredients: [line('chicken', 100), line('rice', 100)] })

  it('flags an ingredient with stock going off inside the window', () => {
    const index = stockedWith({ chicken: 500, rice: 500 }, '2026-08-21')
    const result = evaluateOwnership(dish, index, ontology, { today: TODAY })
    expect(result.lines[0]?.expiringSoon).toBe(true)
    expect(result.expiringSoonFraction).toBe(1)
  })

  it('does not flag stock outside the window', () => {
    const index = stockedWith({ chicken: 500, rice: 500 }, '2026-12-25')
    const result = evaluateOwnership(dish, index, ontology, { today: TODAY })
    expect(result.expiringSoonFraction).toBe(0)
  })

  it('treats already-expired stock as the most urgent case, not an excluded one', () => {
    const index = stockedWith({ chicken: 500, rice: 500 }, '2026-08-01')
    const result = evaluateOwnership(dish, index, ontology, { today: TODAY })
    expect(result.lines[0]?.expiringSoon).toBe(true)
  })

  it('never flags a null-expiry lot', () => {
    const index = stockedWith({ chicken: 500, rice: 500 }, null)
    expect(evaluateOwnership(dish, index, ontology, { today: TODAY }).expiringSoonFraction).toBe(0)
  })

  it('honours a custom window', () => {
    const index = stockedWith({ chicken: 500, rice: 500 }, '2026-08-24')
    expect(
      evaluateOwnership(dish, index, ontology, { today: TODAY, expiringSoonWithinDays: 3 })
        .expiringSoonFraction,
    ).toBe(0)
    expect(
      evaluateOwnership(dish, index, ontology, { today: TODAY, expiringSoonWithinDays: 7 })
        .expiringSoonFraction,
    ).toBe(1)
  })

  it('defaults to a 5 day window', () => {
    expect(DEFAULT_EXPIRING_SOON_DAYS).toBe(5)
    // Today is 2026-08-19, so the 24th is the last day inside the window.
    const inside = stockedWith({ chicken: 500, rice: 500 }, '2026-08-24')
    expect(evaluateOwnership(dish, inside, ontology, { today: TODAY }).expiringSoonFraction).toBe(1)

    const outside = stockedWith({ chicken: 500, rice: 500 }, '2026-08-25')
    expect(evaluateOwnership(dish, outside, ontology, { today: TODAY }).expiringSoonFraction).toBe(0)
  })

  it('includes stock expiring today and stock expiring on the boundary day', () => {
    for (const date of ['2026-08-19', '2026-08-24']) {
      const index = stockedWith({ chicken: 500, rice: 500 }, date)
      expect(
        evaluateOwnership(dish, index, ontology, { today: TODAY }).expiringSoonFraction,
        `${date} should be inside the 5 day window`,
      ).toBe(1)
    }
  })

  it('reports nothing expiring when no date is supplied', () => {
    const index = stockedWith({ chicken: 500, rice: 500 }, '2026-08-20')
    expect(evaluateOwnership(dish, index, ontology).expiringSoonFraction).toBe(0)
  })
})

describe('rankRecipes', () => {
  const index = stockedWith({ chicken: 500, rice: 500 })
  const recipes = [
    recipe({ id: 'none', name: 'Nothing I Have', ingredients: [line('parsley', 10)] }),
    recipe({ id: 'all', name: 'All Of It', ingredients: [line('chicken', 10), line('rice', 10)] }),
    recipe({ id: 'half', name: 'Half Of It', ingredients: [line('chicken', 10), line('parsley', 10)] }),
  ]

  it('sorts most-owned first', () => {
    expect(rankRecipes(recipes, index, ontology).map((r) => r.recipeId))
      .toEqual(['all', 'half', 'none'])
  })

  it('does not mutate the input array', () => {
    const original = [...recipes]
    rankRecipes(recipes, index, ontology)
    expect(recipes).toEqual(original)
  })

  it('breaks an ownership tie with expiring-soon, descending', () => {
    const soon = buildInventoryIndex(
      [product('p-chicken', 'chicken'), product('p-rice', 'rice')],
      [
        lot({ id: 'l-chicken', productId: 'p-chicken', remainingG: 500, expiresOn: '2026-08-20' }),
        lot({ id: 'l-rice', productId: 'p-rice', remainingG: 500, expiresOn: null }),
      ],
    )
    const tied = [
      recipe({ id: 'uses-rice', name: 'A', ingredients: [line('rice', 10)] }),
      recipe({ id: 'uses-chicken', name: 'B', ingredients: [line('chicken', 10)] }),
    ]
    const ranked = rankRecipes(tied, soon, ontology, { today: TODAY })
    expect(ranked.map((r) => r.ownershipFraction)).toEqual([1, 1])
    expect(ranked[0]?.recipeId).toBe('uses-chicken')
  })

  it('falls back to alphabetical so the order never wobbles', () => {
    const tied = [
      recipe({ id: 'z', name: 'Zebra Stew', ingredients: [line('chicken', 10)] }),
      recipe({ id: 'a', name: 'Apple Bake', ingredients: [line('rice', 10)] }),
    ]
    expect(rankRecipes(tied, index, ontology).map((r) => r.recipeId)).toEqual(['a', 'z'])
    expect(rankRecipes([...tied].reverse(), index, ontology).map((r) => r.recipeId))
      .toEqual(['a', 'z'])
  })

  it('sorts alphabetically on request, ignoring ownership', () => {
    expect(rankRecipes(recipes, index, ontology, { sort: 'alphabetical' }).map((r) => r.recipeId))
      .toEqual(['all', 'half', 'none'].sort())
  })

  it('filters by cuisine, case-insensitively', () => {
    const mixed = [
      recipe({ id: 'thai', cuisines: ['Thai'], ingredients: [line('rice', 10)] }),
      recipe({ id: 'italian', cuisines: ['Italian'], ingredients: [line('rice', 10)] }),
      recipe({ id: 'both', cuisines: ['Thai', 'Fusion'], ingredients: [line('rice', 10)] }),
    ]
    expect(rankRecipes(mixed, index, ontology, { cuisine: 'thai' }).map((r) => r.recipeId).sort())
      .toEqual(['both', 'thai'])
  })

  it('an unmatched cuisine filter returns nothing rather than everything', () => {
    expect(rankRecipes(recipes, index, ontology, { cuisine: 'Martian' })).toEqual([])
  })

  it('filters to recipes that use up expiring stock', () => {
    const soon = stockedWith({ chicken: 500 }, '2026-08-20')
    const candidates = [
      recipe({ id: 'uses-it', ingredients: [line('chicken', 10)] }),
      recipe({ id: 'does-not', ingredients: [line('parsley', 10)] }),
    ]
    const ranked = rankRecipes(candidates, soon, ontology, {
      today: TODAY,
      expiringSoonOnly: true,
    })
    expect(ranked.map((r) => r.recipeId)).toEqual(['uses-it'])
  })

  it('handles an empty library', () => {
    expect(rankRecipes([], index, ontology)).toEqual([])
  })

  it('compareByOwnership is a consistent comparator', () => {
    const evaluated = recipes.map((r) => evaluateOwnership(r, index, ontology))
    for (const a of evaluated) {
      expect(compareByOwnership(a, a)).toBe(0)
      for (const b of evaluated) {
        // `|| 0` normalises -0, which Object.is treats as distinct from 0.
        const forwards = Math.sign(compareByOwnership(a, b)) || 0
        const backwards = -Math.sign(compareByOwnership(b, a)) || 0
        expect(forwards).toBe(backwards)
      }
    }
  })
})

describe('fullyOwned', () => {
  it('excludes a 100% recipe you only have a half batch of', () => {
    const index = stockedWith({ chicken: 50 })
    const dish = recipe({ id: 'x', ingredients: [line('chicken', 100)] })
    const ranked = rankRecipes([dish], index, ontology)
    expect(ranked[0]?.ownershipFraction).toBe(0)
    expect(fullyOwned(ranked)).toEqual([])
  })

  it('includes a recipe with a full batch available', () => {
    const index = stockedWith({ chicken: 500 })
    const dish = recipe({ id: 'x', ingredients: [line('chicken', 100)] })
    expect(fullyOwned(rankRecipes([dish], index, ontology)).map((r) => r.recipeId)).toEqual(['x'])
  })
})

describe('v1 matches on exact canonicalId only', () => {
  it('does not treat a related ingredient as a substitute', () => {
    // interchangeableWith is empty on all 310 ontology entries, so substitution
    // is deliberately deferred. Owning shredded mozzarella does NOT satisfy a
    // recipe calling for block mozzarella.
    const withSubs = buildOntologyIndex([
      ingredient({ id: 'mozzarella-block', interchangeableWith: ['mozzarella-shredded'] }),
      ingredient({ id: 'mozzarella-shredded', interchangeableWith: ['mozzarella-block'] }),
    ])
    const dish = recipe({ id: 'x', ingredients: [line('mozzarella-block', 100)] })
    const index = stockedWith({ 'mozzarella-shredded': 500 })
    const result = evaluateOwnership(dish, index, withSubs)
    expect(result.ownershipFraction).toBe(0)
    expect(result.missing).toEqual(['mozzarella-block'])
  })
})

describe('an ingredient named on more than one line', () => {
  // Six of the 150 seed recipes do this. Chakchouka calls for one red bell
  // pepper on one line and one green on another; Spanish tortilla pours olive
  // oil twice. Judging each line on its own against the whole kitchen said you
  // owned both peppers when you had one (found and fixed 2026-08-21).
  const twice = recipe({
    id: 'twice',
    ingredients: [line('chicken', 100), line('chicken', 150), line('rice', 200)],
  })

  it('needs the sum of the lines, not the largest of them', () => {
    // 250 g of chicken between the two lines, and 200 g in the kitchen.
    const result = evaluateOwnership(twice, stockedWith({ chicken: 200, rice: 200 }), ontology)
    expect(result.ownershipFraction).toBe(0.5)
    expect(result.missing).toEqual(['chicken'])
  })

  it('is satisfied by the total', () => {
    const result = evaluateOwnership(twice, stockedWith({ chicken: 250, rice: 200 }), ontology)
    expect(result.ownershipFraction).toBe(1)
    expect(result.missing).toEqual([])
  })

  it('counts as ONE ingredient, on both sides of the fraction', () => {
    const result = evaluateOwnership(twice, stockedWith({ chicken: 250, rice: 200 }), ontology)
    expect(result.countedCount).toBe(2)
    expect(result.ownedCount).toBe(2)
    // Still one row per line for the detail view to render.
    expect(result.lines.length).toBe(3)
  })

  it('names the ingredient once when it is missing, so Missing One still works', () => {
    const result = evaluateOwnership(twice, stockedWith({ rice: 200 }), ontology)
    expect(result.missing).toEqual(['chicken'])
    expect(result.isMissingOne).toBe(true)
  })

  it('limits the batch by the total as well', () => {
    // 500 g of chicken is two batches of the 250 g it really needs, not five
    // batches of the 100 g on the first line.
    const result = evaluateOwnership(twice, stockedWith({ chicken: 500, rice: 800 }), ontology)
    expect(result.maxBatchScale).toBe(2)
  })

  it('carries both figures on the line, for the detail view to explain itself', () => {
    const result = evaluateOwnership(twice, stockedWith({ chicken: 200, rice: 200 }), ontology)
    expect(result.lines[0].requiredG).toBe(100)
    expect(result.lines[0].requiredTotalG).toBe(250)
    expect(result.lines[2].requiredG).toBe(200)
    expect(result.lines[2].requiredTotalG).toBe(200)
  })

  it('does not pool an optional line into what the recipe requires', () => {
    // A garnish of the same thing is a bonus, not part of the requirement.
    const garnished = recipe({
      id: 'garnished',
      ingredients: [line('chicken', 100), line('chicken', 900, true)],
    })
    const result = evaluateOwnership(garnished, stockedWith({ chicken: 100 }), ontology)
    expect(result.ownershipFraction).toBe(1)
    expect(result.lines[0].requiredTotalG).toBe(100)
  })

  it('leaves untracked staples alone', () => {
    // Montreal smoked meat lists salt twice. Salt is never counted either way.
    const salty = recipe({
      id: 'salty',
      ingredients: [line('salt', 10), line('salt', 20), line('rice', 100)],
    })
    const result = evaluateOwnership(salty, stockedWith({ rice: 100 }), ontology)
    expect(result.ownershipFraction).toBe(1)
    expect(result.countedCount).toBe(1)
  })
})
