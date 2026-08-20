import { describe, it, expect } from 'vitest'
import type {
  CanonicalIngredient,
  Lot,
  MacroSet,
  Product,
  Recipe,
  RecipeIngredient,
} from '../types/schema'
import {
  GRAM_EPSILON,
  applyDeductions,
  availableGramsFor,
  availableLotsFor,
  batchMacrosForDeductions,
  buildInventoryIndex,
  compareLotsFefo,
  isLotAvailable,
  macroLinesForDeductions,
  ownsAny,
  planDeduction,
  planRecipeDeduction,
  revertDeductions,
} from './inventory'
import { buildOntologyIndex } from './ontology'

const NOW = '2026-08-19T12:00:00.000Z'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function product(overrides: Partial<Product> & { id: string; canonicalId: string }): Product {
  return {
    name: overrides.id,
    macrosPer100g: NO_MACROS,
    createdAt: NOW,
    ...overrides,
  }
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

function recipeIngredient(
  canonicalId: string,
  quantityG: number,
  optional = false,
): RecipeIngredient {
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

// ---------------------------------------------------------------------------

describe('compareLotsFefo', () => {
  it('puts the soonest expiry first', () => {
    const early = lot({ id: 'a', productId: 'p', expiresOn: '2026-09-01' })
    const late = lot({ id: 'b', productId: 'p', expiresOn: '2026-12-25' })
    expect(compareLotsFefo(early, late)).toBeLessThan(0)
    expect(compareLotsFefo(late, early)).toBeGreaterThan(0)
  })

  it('puts null-expiry lots LAST, so perishables get used first', () => {
    const dated = lot({ id: 'a', productId: 'p', expiresOn: '2099-01-01' })
    const forever = lot({ id: 'b', productId: 'p', expiresOn: null })
    expect(compareLotsFefo(dated, forever)).toBeLessThan(0)
    expect(compareLotsFefo(forever, dated)).toBeGreaterThan(0)
  })

  it('breaks an expiry tie with the older acquiredOn', () => {
    const older = lot({ id: 'b', productId: 'p', expiresOn: '2026-09-01', acquiredOn: '2026-08-01' })
    const newer = lot({ id: 'a', productId: 'p', expiresOn: '2026-09-01', acquiredOn: '2026-08-10' })
    expect(compareLotsFefo(older, newer)).toBeLessThan(0)
  })

  it('breaks a full tie with the lot id, so ordering is always total', () => {
    const a = lot({ id: 'aaa', productId: 'p', expiresOn: '2026-09-01' })
    const b = lot({ id: 'bbb', productId: 'p', expiresOn: '2026-09-01' })
    expect(compareLotsFefo(a, b)).toBeLessThan(0)
    expect(compareLotsFefo(a, a)).toBe(0)
  })

  it('sorts two null-expiry lots by acquiredOn, not arbitrarily', () => {
    const older = lot({ id: 'z', productId: 'p', expiresOn: null, acquiredOn: '2026-01-01' })
    const newer = lot({ id: 'a', productId: 'p', expiresOn: null, acquiredOn: '2026-06-01' })
    expect(compareLotsFefo(older, newer)).toBeLessThan(0)
  })

  it('produces a stable total order regardless of input order', () => {
    const lots = [
      lot({ id: 'no-expiry', productId: 'p', expiresOn: null }),
      lot({ id: 'late', productId: 'p', expiresOn: '2026-12-01' }),
      lot({ id: 'early', productId: 'p', expiresOn: '2026-09-01' }),
      lot({ id: 'mid', productId: 'p', expiresOn: '2026-10-01' }),
    ]
    const forwards = [...lots].sort(compareLotsFefo).map((l) => l.id)
    const backwards = [...lots].reverse().sort(compareLotsFefo).map((l) => l.id)
    expect(forwards).toEqual(['early', 'mid', 'late', 'no-expiry'])
    expect(backwards).toEqual(forwards)
  })
})

describe('buildInventoryIndex', () => {
  it('groups lots under the canonical of their product, in FEFO order', () => {
    const index = buildInventoryIndex(
      [product({ id: 'p1', canonicalId: 'butter' }), product({ id: 'p2', canonicalId: 'butter' })],
      [
        lot({ id: 'l1', productId: 'p1', expiresOn: '2026-12-01' }),
        lot({ id: 'l2', productId: 'p2', expiresOn: '2026-09-01' }),
      ],
    )
    expect(index.lotsByCanonical.get('butter')?.map((l) => l.id)).toEqual(['l2', 'l1'])
  })

  it('pools two different products of the same ingredient', () => {
    const index = buildInventoryIndex(
      [product({ id: 'store', canonicalId: 'butter' }), product({ id: 'fancy', canonicalId: 'butter' })],
      [
        lot({ id: 'l1', productId: 'store', remainingG: 200 }),
        lot({ id: 'l2', productId: 'fancy', remainingG: 300 }),
      ],
    )
    expect(availableGramsFor(index, 'butter')).toBe(500)
  })

  it('skips a lot whose product is missing instead of crashing', () => {
    const index = buildInventoryIndex(
      [product({ id: 'p1', canonicalId: 'butter' })],
      [lot({ id: 'good', productId: 'p1' }), lot({ id: 'orphan', productId: 'gone' })],
    )
    expect(index.lotsByCanonical.get('butter')?.map((l) => l.id)).toEqual(['good'])
    expect(index.lotsById.has('orphan')).toBe(true)
  })

  it('is empty, not broken, with no inventory at all', () => {
    const index = buildInventoryIndex([], [])
    expect(availableLotsFor(index, 'butter')).toEqual([])
    expect(availableGramsFor(index, 'butter')).toBe(0)
    expect(ownsAny(index, 'butter')).toBe(false)
  })
})

describe('availability', () => {
  it('excludes depleted lots and empty lots', () => {
    expect(isLotAvailable(lot({ id: 'a', productId: 'p', remainingG: 50 }))).toBe(true)
    expect(isLotAvailable(lot({ id: 'b', productId: 'p', remainingG: 0, depleted: true }))).toBe(false)
    expect(isLotAvailable(lot({ id: 'c', productId: 'p', remainingG: 0 }))).toBe(false)
  })

  it('treats a floating-point crumb as empty', () => {
    expect(isLotAvailable(lot({ id: 'd', productId: 'p', remainingG: 1e-13 }))).toBe(false)
  })

  it('a depleted lot is retained in the index but not counted as stock', () => {
    const index = buildInventoryIndex(
      [product({ id: 'p1', canonicalId: 'butter' })],
      [
        lot({ id: 'empty', productId: 'p1', initialG: 200, remainingG: 0, depleted: true }),
        lot({ id: 'full', productId: 'p1', remainingG: 150 }),
      ],
    )
    expect(index.lotsByCanonical.get('butter')).toHaveLength(2)
    expect(availableLotsFor(index, 'butter').map((l) => l.id)).toEqual(['full'])
    expect(availableGramsFor(index, 'butter')).toBe(150)
  })
})

describe('planDeduction', () => {
  const index = buildInventoryIndex(
    [product({ id: 'p1', canonicalId: 'butter' })],
    [
      lot({ id: 'soon', productId: 'p1', remainingG: 100, expiresOn: '2026-09-01' }),
      lot({ id: 'later', productId: 'p1', remainingG: 200, expiresOn: '2026-11-01' }),
      lot({ id: 'never', productId: 'p1', remainingG: 400, expiresOn: null }),
    ],
  )

  it('takes from the first-expiring lot only, when it covers the request', () => {
    const plan = planDeduction(index, 'butter', 60)
    expect(plan.deductions).toEqual([{ lotId: 'soon', canonicalId: 'butter', grams: 60 }])
    expect(plan.complete).toBe(true)
    expect(plan.shortfallG).toBe(0)
  })

  it('spills into the next lot in FEFO order', () => {
    const plan = planDeduction(index, 'butter', 250)
    expect(plan.deductions).toEqual([
      { lotId: 'soon', canonicalId: 'butter', grams: 100 },
      { lotId: 'later', canonicalId: 'butter', grams: 150 },
    ])
    expect(plan.deductedG).toBe(250)
    expect(plan.complete).toBe(true)
  })

  it('reaches the null-expiry lot only after the dated ones are exhausted', () => {
    const plan = planDeduction(index, 'butter', 350)
    expect(plan.deductions.map((d) => d.lotId)).toEqual(['soon', 'later', 'never'])
    expect(plan.deductions[2]?.grams).toBe(50)
  })

  it('consumes a lot exactly without touching the next one', () => {
    const plan = planDeduction(index, 'butter', 100)
    expect(plan.deductions).toHaveLength(1)
    expect(plan.deductions[0]?.lotId).toBe('soon')
  })

  it('takes everything available and reports the shortfall', () => {
    const plan = planDeduction(index, 'butter', 1000)
    expect(plan.deductedG).toBe(700)
    expect(plan.shortfallG).toBe(300)
    expect(plan.complete).toBe(false)
    expect(plan.requestedG).toBe(1000)
  })

  it('reports the whole request as a shortfall when nothing is on hand', () => {
    const plan = planDeduction(index, 'saffron', 5)
    expect(plan.deductions).toEqual([])
    expect(plan.deductedG).toBe(0)
    expect(plan.shortfallG).toBe(5)
    expect(plan.complete).toBe(false)
  })

  it('plans nothing for a zero request', () => {
    const plan = planDeduction(index, 'butter', 0)
    expect(plan.deductions).toEqual([])
    expect(plan.complete).toBe(true)
    expect(plan.shortfallG).toBe(0)
  })

  it('mutates nothing — the same plan can be built twice', () => {
    const first = planDeduction(index, 'butter', 250)
    const second = planDeduction(index, 'butter', 250)
    expect(second).toEqual(first)
    expect(availableGramsFor(index, 'butter')).toBe(700)
  })

  it('never returns a deduction larger than the lot holds', () => {
    const plan = planDeduction(index, 'butter', 700)
    for (const deduction of plan.deductions) {
      const source = index.lotsById.get(deduction.lotId)
      expect(deduction.grams).toBeLessThanOrEqual(source?.remainingG ?? 0)
    }
  })

  it.each([-1, NaN, Infinity])('throws on an invalid request (%s)', (grams) => {
    expect(() => planDeduction(index, 'butter', grams)).toThrow(RangeError)
  })
})

describe('applyDeductions', () => {
  const lots = [
    lot({ id: 'soon', productId: 'p1', initialG: 100, remainingG: 100, expiresOn: '2026-09-01' }),
    lot({ id: 'later', productId: 'p1', initialG: 200, remainingG: 200, expiresOn: '2026-11-01' }),
  ]

  it('reduces remainingG', () => {
    const next = applyDeductions(lots, [{ lotId: 'soon', canonicalId: 'butter', grams: 40 }], NOW)
    expect(next.find((l) => l.id === 'soon')?.remainingG).toBe(60)
  })

  it('does not mutate the input lots', () => {
    applyDeductions(lots, [{ lotId: 'soon', canonicalId: 'butter', grams: 40 }], NOW)
    expect(lots[0]?.remainingG).toBe(100)
  })

  it('leaves untouched lots as the identical object', () => {
    const next = applyDeductions(lots, [{ lotId: 'soon', canonicalId: 'butter', grams: 10 }], NOW)
    expect(next.find((l) => l.id === 'later')).toBe(lots[1])
  })

  it('marks a lot depleted at zero and stamps depletedAt', () => {
    const next = applyDeductions(lots, [{ lotId: 'soon', canonicalId: 'butter', grams: 100 }], NOW)
    const emptied = next.find((l) => l.id === 'soon')
    expect(emptied?.remainingG).toBe(0)
    expect(emptied?.depleted).toBe(true)
    expect(emptied?.depletedAt).toBe(NOW)
  })

  it('retains the depleted lot rather than dropping it', () => {
    const next = applyDeductions(lots, [{ lotId: 'soon', canonicalId: 'butter', grams: 100 }], NOW)
    expect(next).toHaveLength(2)
    expect(next.map((l) => l.id)).toEqual(['soon', 'later'])
  })

  it('does not overwrite depletedAt on an already-depleted lot', () => {
    const already = [lot({
      id: 'x', productId: 'p1', initialG: 50, remainingG: 0,
      depleted: true, depletedAt: '2026-01-01T00:00:00.000Z',
    })]
    const next = applyDeductions(already, [{ lotId: 'x', canonicalId: 'butter', grams: 0 }], NOW)
    expect(next[0]?.depletedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('treats a floating-point crumb as depleted', () => {
    const next = applyDeductions(
      lots,
      [{ lotId: 'soon', canonicalId: 'butter', grams: 100 - GRAM_EPSILON / 2 }],
      NOW,
    )
    const emptied = next.find((l) => l.id === 'soon')
    expect(emptied?.remainingG).toBe(0)
    expect(emptied?.depleted).toBe(true)
  })

  it('combines two deductions against the same lot', () => {
    const next = applyDeductions(
      lots,
      [
        { lotId: 'soon', canonicalId: 'butter', grams: 30 },
        { lotId: 'soon', canonicalId: 'butter', grams: 20 },
      ],
      NOW,
    )
    expect(next.find((l) => l.id === 'soon')?.remainingG).toBe(50)
  })

  it('clamps at zero rather than going negative on a stale plan', () => {
    const next = applyDeductions(lots, [{ lotId: 'soon', canonicalId: 'butter', grams: 5000 }], NOW)
    const emptied = next.find((l) => l.id === 'soon')
    expect(emptied?.remainingG).toBe(0)
    expect(emptied?.depleted).toBe(true)
  })

  it('throws when a deduction names a lot that does not exist', () => {
    expect(() =>
      applyDeductions(lots, [{ lotId: 'ghost', canonicalId: 'butter', grams: 1 }], NOW),
    ).toThrow(/unknown lot/)
  })

  it.each([-1, NaN, Infinity])('throws on an invalid deduction amount (%s)', (grams) => {
    expect(() => applyDeductions(lots, [{ lotId: 'soon', canonicalId: 'butter', grams }], NOW))
      .toThrow(RangeError)
  })

  it('plan then apply leaves exactly the planned stock behind', () => {
    const index = buildInventoryIndex([product({ id: 'p1', canonicalId: 'butter' })], lots)
    const plan = planDeduction(index, 'butter', 250)
    const next = applyDeductions(lots, plan.deductions, NOW)
    const after = buildInventoryIndex([product({ id: 'p1', canonicalId: 'butter' })], next)
    expect(availableGramsFor(after, 'butter')).toBe(300 - 250)
  })
})

describe('revertDeductions', () => {
  it('puts the grams back where they came from', () => {
    const lots = [lot({ id: 'a', productId: 'p1', initialG: 200, remainingG: 50 })]
    const next = revertDeductions(lots, [{ lotId: 'a', canonicalId: 'butter', grams: 100 }])
    expect(next[0]?.remainingG).toBe(150)
  })

  it('un-depletes a lot that had been emptied', () => {
    const lots = [lot({
      id: 'a', productId: 'p1', initialG: 200, remainingG: 0,
      depleted: true, depletedAt: NOW,
    })]
    const next = revertDeductions(lots, [{ lotId: 'a', canonicalId: 'butter', grams: 80 }])
    expect(next[0]?.remainingG).toBe(80)
    expect(next[0]?.depleted).toBe(false)
    expect(next[0]?.depletedAt).toBeUndefined()
  })

  it('never restores more than the lot originally held', () => {
    const lots = [lot({ id: 'a', productId: 'p1', initialG: 200, remainingG: 150 })]
    const next = revertDeductions(lots, [{ lotId: 'a', canonicalId: 'butter', grams: 500 }])
    expect(next[0]?.remainingG).toBe(200)
  })

  it('round-trips an apply', () => {
    const lots = [
      lot({ id: 'a', productId: 'p1', initialG: 100, remainingG: 100, expiresOn: '2026-09-01' }),
      lot({ id: 'b', productId: 'p1', initialG: 200, remainingG: 200, expiresOn: '2026-11-01' }),
    ]
    const index = buildInventoryIndex([product({ id: 'p1', canonicalId: 'butter' })], lots)
    const plan = planDeduction(index, 'butter', 175)
    const after = applyDeductions(lots, plan.deductions, NOW)
    const restored = revertDeductions(after, plan.deductions)
    expect(restored.map((l) => l.remainingG)).toEqual([100, 200])
    expect(restored.every((l) => !l.depleted)).toBe(true)
  })
})

describe('planRecipeDeduction', () => {
  const ontology = buildOntologyIndex([
    ingredient({ id: 'butter' }),
    ingredient({ id: 'parsley' }),
    ingredient({ id: 'salt', tracked: false }),
  ])
  const products = [
    product({ id: 'p-butter', canonicalId: 'butter' }),
    product({ id: 'p-parsley', canonicalId: 'parsley' }),
  ]
  const lots = [
    lot({ id: 'l-butter', productId: 'p-butter', remainingG: 500 }),
    lot({ id: 'l-parsley', productId: 'p-parsley', remainingG: 10 }),
  ]
  const index = buildInventoryIndex(products, lots)

  const dish = recipe({
    id: 'buttered-thing',
    ingredients: [
      recipeIngredient('butter', 100),
      recipeIngredient('salt', 5),
      recipeIngredient('parsley', 4, true),
    ],
  })

  it('plans one line per deductible ingredient', () => {
    const plan = planRecipeDeduction(index, ontology, dish)
    expect(plan.lines.map((l) => l.canonicalId)).toEqual(['butter', 'parsley'])
  })

  it('skips untracked staples entirely — no deduction and no shortfall', () => {
    const plan = planRecipeDeduction(index, ontology, dish)
    expect(plan.lines.some((l) => l.canonicalId === 'salt')).toBe(false)
    expect(plan.shortfalls).toEqual([])
    expect(plan.complete).toBe(true)
  })

  it('DOES deduct optional garnishes that are actually on hand', () => {
    const plan = planRecipeDeduction(index, ontology, dish)
    expect(plan.deductions.map((d) => d.canonicalId)).toContain('parsley')
  })

  it('scales every line by scaleFactor', () => {
    const plan = planRecipeDeduction(index, ontology, dish, 1.5)
    expect(plan.lines[0]?.requestedG).toBe(150)
    expect(plan.lines[1]?.requestedG).toBe(6)
    expect(plan.scaleFactor).toBe(1.5)
  })

  it('flattens deductions ready for CookEvent.deductions', () => {
    const plan = planRecipeDeduction(index, ontology, dish)
    expect(plan.deductions).toEqual([
      { lotId: 'l-butter', canonicalId: 'butter', grams: 100 },
      { lotId: 'l-parsley', canonicalId: 'parsley', grams: 4 },
    ])
  })

  it('reports per-ingredient shortfalls when scaled beyond stock', () => {
    const plan = planRecipeDeduction(index, ontology, dish, 4)
    expect(plan.complete).toBe(false)
    expect(plan.shortfalls).toEqual([
      { canonicalId: 'parsley', requestedG: 16, shortfallG: 6 },
    ])
  })

  it('treats an ingredient the ontology does not know as tracked, so it surfaces', () => {
    const mystery = recipe({ id: 'x', ingredients: [recipeIngredient('unobtainium', 10)] })
    const plan = planRecipeDeduction(index, ontology, mystery)
    expect(plan.shortfalls).toEqual([
      { canonicalId: 'unobtainium', requestedG: 10, shortfallG: 10 },
    ])
  })

  it('defaults to scaleFactor 1', () => {
    expect(planRecipeDeduction(index, ontology, dish).scaleFactor).toBe(1)
  })

  it('throws on a negative scale factor', () => {
    expect(() => planRecipeDeduction(index, ontology, dish, -1)).toThrow(RangeError)
  })
})

describe('macros for deductions', () => {
  const chicken: MacroSet = {
    calories: 165, proteinG: 31, carbsG: 0, fatG: 3.6,
    fiberG: 0, sugarG: 0, sodiumMg: 74, saturatedFatG: 1, cholesterolMg: 0,
  }
  const rice: MacroSet = {
    calories: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3,
    fiberG: 0.4, sugarG: 0.1, sodiumMg: 1, saturatedFatG: 0.1, cholesterolMg: 0,
  }
  const index = buildInventoryIndex(
    [
      product({ id: 'p-chicken', canonicalId: 'chicken', macrosPer100g: chicken }),
      product({ id: 'p-rice', canonicalId: 'rice', macrosPer100g: rice }),
    ],
    [
      lot({ id: 'l-chicken', productId: 'p-chicken', remainingG: 1000 }),
      lot({ id: 'l-rice', productId: 'p-rice', remainingG: 1000 }),
    ],
  )

  it('walks lot -> product -> macrosPer100g', () => {
    const lines = macroLinesForDeductions(index, [
      { lotId: 'l-chicken', canonicalId: 'chicken', grams: 300 },
    ])
    expect(lines).toEqual([{ grams: 300, macrosPer100g: chicken }])
  })

  it('totals a whole batch', () => {
    const total = batchMacrosForDeductions(index, [
      { lotId: 'l-chicken', canonicalId: 'chicken', grams: 300 },
      { lotId: 'l-rice', canonicalId: 'rice', grams: 200 },
    ])
    expect(total.calories).toBeCloseTo(165 * 3 + 130 * 2, 10)
    expect(total.proteinG).toBeCloseTo(31 * 3 + 2.7 * 2, 10)
  })

  it('uses the macros of the product actually deducted, not an average', () => {
    const cheap = product({ id: 'cheap', canonicalId: 'chicken', macrosPer100g: chicken })
    const rich = product({
      id: 'rich', canonicalId: 'chicken',
      macrosPer100g: { ...chicken, calories: 300 },
    })
    const twoProducts = buildInventoryIndex(
      [cheap, rich],
      [
        lot({ id: 'l-cheap', productId: 'cheap', remainingG: 100, expiresOn: '2026-09-01' }),
        lot({ id: 'l-rich', productId: 'rich', remainingG: 100, expiresOn: '2026-10-01' }),
      ],
    )
    const plan = planDeduction(twoProducts, 'chicken', 150)
    const total = batchMacrosForDeductions(twoProducts, plan.deductions)
    // 100g of the first-expiring cheap lot + 50g of the richer one.
    expect(total.calories).toBeCloseTo(165 + 150, 10)
  })

  it('skips a deduction whose lot is unknown rather than throwing', () => {
    const total = batchMacrosForDeductions(index, [
      { lotId: 'ghost', canonicalId: 'chicken', grams: 300 },
      { lotId: 'l-rice', canonicalId: 'rice', grams: 100 },
    ])
    expect(total.calories).toBeCloseTo(130, 10)
  })

  it('an empty deduction list totals zero', () => {
    expect(batchMacrosForDeductions(index, []).calories).toBe(0)
  })
})
