import { describe, it, expect } from 'vitest'
import type { CanonicalIngredient, Product } from '../types/schema'
import { validateIngredientDraft } from '../engine'
import {
  addDays,
  defaultExpiry,
  emptyIngredientDraft,
  emptyLotDraft,
  emptyProductDraft,
  parseAmount,
  productDraftFrom,
  rankSearch,
  splitAliases,
  toIngredientDraft,
  validateLotDraft,
  validateProductDraft,
  type LotDraft,
  type MacroKey,
  type ProductDraft,
} from './entry-forms'

const TODAY = '2026-08-19'

function ingredient(overrides: Partial<CanonicalIngredient> = {}): CanonicalIngredient {
  return {
    id: 'chicken-breast',
    name: 'Chicken breast',
    category: 'protein',
    trackBy: 'mass',
    tracked: true,
    perishable: true,
    defaultShelfLifeDays: 2,
    aliases: [],
    isSeed: true,
    ...overrides,
  }
}

function productDraft(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return { ...emptyProductDraft(), name: 'Kroger Chicken', servingSizeG: '100', ...overrides }
}

function withMacros(draft: ProductDraft, macros: Partial<Record<MacroKey, string>>): ProductDraft {
  return { ...draft, macros: { ...draft.macros, ...macros } }
}

function lotDraft(overrides: Partial<LotDraft> = {}): LotDraft {
  return {
    quantity: '500',
    unit: 'g',
    acquiredOn: TODAY,
    expiresOn: '',
    frozen: false,
    note: '',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('parseAmount', () => {
  it('tells blank apart from zero', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('   ')).toBeNull()
    expect(parseAmount('0')).toBe(0)
  })

  it('rejects text that is not a number', () => {
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('12abc')).toBeNull()
    expect(parseAmount(' 2.5 ')).toBe(2.5)
  })
})

describe('addDays', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-08-19', 5)).toBe('2026-08-24')
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02')
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(addDays('2026-08-19', -1)).toBe('2026-08-18')
  })
})

describe('validateProductDraft — label maths', () => {
  it('scales a per-serving label up to per 100g', () => {
    const draft = withMacros(productDraft({ servingSizeG: '50' }), {
      calories: '100',
      proteinG: '10',
    })

    const result = validateProductDraft(draft, 'chicken-breast')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.macrosPer100g.calories).toBe(200)
    expect(result.product.macrosPer100g.proteinG).toBe(20)
    expect(result.product.labelServingSizeG).toBe(50)
  })

  it('takes per-100g figures exactly as typed', () => {
    const draft = withMacros(productDraft({ basis: 'per100g', servingSizeG: '' }), {
      calories: '165',
      proteinG: '31',
    })

    const result = validateProductDraft(draft, 'chicken-breast')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.macrosPer100g.calories).toBe(165)
  })

  it('scales whole-package figures down to per 100g', () => {
    const draft = withMacros(
      productDraft({ basis: 'package', servingSizeG: '', packageSizeG: '400' }),
      { calories: '800', proteinG: '40' },
    )

    const result = validateProductDraft(draft, 'x')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.macrosPer100g.calories).toBe(200)
    expect(result.product.packageSizeG).toBe(400)
    // Nothing on the label said what a serving is, so nothing is invented.
    expect(result.product.labelServingSizeG).toBeUndefined()
  })

  it('works the package size out from servings, so it need not be typed', () => {
    const draft = productDraft({ servingSizeG: '112', servingsPerPackage: '4' })

    const result = validateProductDraft(draft, 'x')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.packageSizeG).toBe(448)
    expect(result.product.labelServingSizeG).toBe(112)
  })

  it('saves without a serving count, just without a pre-filled amount later', () => {
    const result = validateProductDraft(productDraft({ servingsPerPackage: '' }), 'x')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.packageSizeG).toBeUndefined()
  })

  it('needs a package size when the label is per package', () => {
    const result = validateProductDraft(
      productDraft({ basis: 'package', servingSizeG: '', packageSizeG: '' }),
      'x',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.field).toBe('packageSizeG')
  })

  it('treats blank macro fields as zero rather than blocking the save', () => {
    const result = validateProductDraft(withMacros(productDraft(), { calories: '165' }), 'x')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.macrosPer100g.fiberG).toBe(0)
    expect(result.product.macrosPer100g.sodiumMg).toBe(0)
  })
})

describe('validateProductDraft — what it refuses', () => {
  it('needs a name', () => {
    const result = validateProductDraft(productDraft({ name: '  ' }), 'x')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.field).toBe('name')
  })

  it('needs a serving size when the label is per serving', () => {
    const result = validateProductDraft(productDraft({ servingSizeG: '' }), 'x')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.field).toBe('servingSizeG')
  })

  it('does not need a serving size when the label is per 100g', () => {
    const result = validateProductDraft(productDraft({ basis: 'per100g', servingSizeG: '' }), 'x')
    expect(result.ok).toBe(true)
  })

  it('rejects a macro that is not a number, naming the field', () => {
    const result = validateProductDraft(withMacros(productDraft(), { proteinG: 'lots' }), 'x')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.field).toBe('proteinG')
  })

  it('rejects negative macros', () => {
    const result = validateProductDraft(withMacros(productDraft(), { fatG: '-3' }), 'x')
    expect(result.ok).toBe(false)
  })
})

describe('validateProductDraft — the energy sanity check', () => {
  it('says nothing when the numbers roughly agree', () => {
    const draft = withMacros(productDraft({ basis: 'per100g', servingSizeG: '' }), {
      calories: '165',
      proteinG: '31',
      fatG: '3.6',
    })
    const result = validateProductDraft(draft, 'x')
    expect(result.warnings).toEqual([])
  })

  it('catches a misplaced decimal point without blocking the save', () => {
    const draft = withMacros(productDraft({ basis: 'per100g', servingSizeG: '' }), {
      calories: '1650',
      proteinG: '31',
      fatG: '3.6',
    })

    const result = validateProductDraft(draft, 'x')

    expect(result.ok).toBe(true)
    expect(result.warnings[0]?.field).toBe('calories')
    expect(result.warnings[0]?.message).toContain('156')
  })
})

describe('defaultExpiry', () => {
  it('uses the ingredient shelf life from the day it was bought', () => {
    expect(defaultExpiry(ingredient(), TODAY, false)).toBe('2026-08-21')
  })

  it('leaves a frozen lot with no date, which is the point of the flag', () => {
    expect(defaultExpiry(ingredient(), TODAY, true)).toBeNull()
  })

  it('gives nothing to something that does not perish', () => {
    expect(defaultExpiry(ingredient({ perishable: false }), TODAY, false)).toBeNull()
  })

  it('gives nothing when the ontology has no shelf life to offer', () => {
    expect(defaultExpiry(ingredient({ defaultShelfLifeDays: undefined }), TODAY, false)).toBeNull()
  })

  it('pre-fills a new draft from the package size, so a repeat is one tap', () => {
    const draft = emptyLotDraft(ingredient(), TODAY, 907)
    expect(draft.quantity).toBe('907')
    expect(draft.unit).toBe('g')
    expect(draft.expiresOn).toBe('2026-08-21')
  })
})

describe('validateLotDraft', () => {
  it('converts through the engine and stores grams', () => {
    const result = validateLotDraft(lotDraft({ quantity: '2', unit: 'lb' }), ingredient(), 'prod_1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lot.initialG).toBeCloseTo(907.18, 1)
  })

  it('shows the engine’s own message when a unit cannot convert', () => {
    const solid = ingredient({ cupWeightG: undefined, densityGPerMl: undefined })

    const result = validateLotDraft(lotDraft({ quantity: '1', unit: 'cup' }), solid, 'prod_1')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.field).toBe('unit')
    expect(result.errors[0]?.message.length).toBeGreaterThan(0)
  })

  it('refuses a quantity that is missing or not positive', () => {
    expect(validateLotDraft(lotDraft({ quantity: '' }), ingredient(), 'p').ok).toBe(false)
    expect(validateLotDraft(lotDraft({ quantity: '0' }), ingredient(), 'p').ok).toBe(false)
    expect(validateLotDraft(lotDraft({ quantity: '-4' }), ingredient(), 'p').ok).toBe(false)
  })

  it('stores no expiry when the field is left blank', () => {
    const result = validateLotDraft(lotDraft({ expiresOn: '' }), ingredient(), 'p')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lot.expiresOn).toBeNull()
  })

  it('carries the frozen flag and a note through', () => {
    const result = validateLotDraft(
      lotDraft({ frozen: true, note: '  back of the freezer  ' }),
      ingredient(),
      'p',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lot.frozen).toBe(true)
    expect(result.lot.note).toBe('back of the freezer')
  })

  it('leaves frozen off entirely when it is false', () => {
    const result = validateLotDraft(lotDraft(), ingredient(), 'p')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lot.frozen).toBeUndefined()
  })
})

describe('rankSearch', () => {
  const list = [
    ingredient({ id: 'a', name: 'Ground chicken' }),
    ingredient({ id: 'b', name: 'Chicken breast' }),
    ingredient({ id: 'c', name: 'Cilantro', aliases: ['coriander', 'fresh coriander'] }),
  ]

  it('puts names that start with the query first', () => {
    expect(rankSearch(list, 'chick').map((item) => item.name)).toEqual([
      'Chicken breast',
      'Ground chicken',
    ])
  })

  it('finds an ingredient by the name the User actually calls it', () => {
    expect(rankSearch(list, 'coriander').map((item) => item.name)).toEqual(['Cilantro'])
  })

  it('returns everything, alphabetically, for an empty query', () => {
    expect(rankSearch(list, '').map((item) => item.name)).toEqual([
      'Chicken breast',
      'Cilantro',
      'Ground chicken',
    ])
  })

  it('caps how much it hands back', () => {
    expect(rankSearch(list, '', 2)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------

describe('the new-ingredient form', () => {
  it('starts from whatever was typed into the search box', () => {
    expect(emptyIngredientDraft('Gochujang').name).toBe('Gochujang')
    expect(emptyIngredientDraft().name).toBe('')
  })

  it('defaults to the common case: weighed, counted, perishable', () => {
    const draft = emptyIngredientDraft()
    expect(draft.trackBy).toBe('mass')
    expect(draft.tracked).toBe(true)
    expect(draft.perishable).toBe(true)
  })

  it('splits aliases, dropping blanks and stray spaces', () => {
    expect(splitAliases(' red pepper paste , gochoojang ,, ')).toEqual([
      'red pepper paste',
      'gochoojang',
    ])
    expect(splitAliases('')).toEqual([])
  })

  it('leaves out optional measurements that were not filled in', () => {
    const draft = toIngredientDraft(emptyIngredientDraft('Gochujang'))
    expect(draft.cupWeightG).toBeUndefined()
    expect(draft.unitWeightG).toBeUndefined()
    expect(draft.densityGPerMl).toBeUndefined()
    expect(draft.defaultShelfLifeDays).toBeUndefined()
  })

  it('passes typed measurements through as numbers', () => {
    const draft = toIngredientDraft({
      ...emptyIngredientDraft('Gochujang'),
      cupWeightG: '300',
      defaultShelfLifeDays: '180',
    })
    expect(draft.cupWeightG).toBe(300)
    expect(draft.defaultShelfLifeDays).toBe(180)
  })

  it('does not let a mistyped number look like a blank field', () => {
    // "abc" in the weight box must not quietly become "not provided" — the
    // engine has to see something wrong so it can point at that field.
    const draft = toIngredientDraft({
      ...emptyIngredientDraft('Gochujang'),
      trackBy: 'count',
      unitWeightG: 'abc',
    })

    const result = validateIngredientDraft(draft, [])

    expect(result.ok).toBe(false)
    expect(result.errors.map((issue) => issue.field)).toContain('unitWeightG')
  })

  it('hands the engine what it needs to enforce the density rule itself', () => {
    const draft = toIngredientDraft({
      ...emptyIngredientDraft('Gochujang'),
      trackBy: 'mass',
      densityGPerMl: '1.2',
    })

    const result = validateIngredientDraft(draft, [])

    expect(result.ok).toBe(false)
    expect(result.errors[0]?.field).toBe('densityGPerMl')
    expect(result.errors[0]?.message).toContain('weight of one cup')
  })

  it('produces a draft the engine accepts, with warnings that do not block', () => {
    const draft = toIngredientDraft({
      ...emptyIngredientDraft('Gochujang'),
      category: 'condiment',
      perishable: false,
    })

    const result = validateIngredientDraft(draft, [])

    expect(result.ok).toBe(true)
    expect(result.warnings.map((issue) => issue.field)).toContain('cupWeightG')
  })
})

// ---------------------------------------------------------------------------
// Pack counts and editing
// ---------------------------------------------------------------------------

describe('pack counts on a product', () => {
  function countDraft(overrides: Partial<ProductDraft> = {}): ProductDraft {
    return {
      ...emptyProductDraft(),
      name: 'Mission Flour Tortillas',
      basis: 'per100g',
      packageSizeG: '413',
      unitsPerPackage: '6',
      macros: { ...emptyProductDraft().macros, calories: '306' },
      ...overrides,
    }
  }

  it('stores the count when the package weight is known too', () => {
    const result = validateProductDraft(countDraft(), 'tortilla-flour')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.unitsPerPackage).toBe(6)
    expect(result.product.packageSizeG).toBe(413)
  })

  /*
   * A count with no package weight cannot say what one item weighs, which is
   * the only thing the field is for. Saving it would look like an answer.
   */
  it('declines to store a count with no package weight, and says why', () => {
    const result = validateProductDraft(countDraft({ packageSizeG: '' }), 'tortilla-flour')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.unitsPerPackage).toBeUndefined()
    expect(result.warnings.some((issue) => issue.field === 'unitsPerPackage')).toBe(true)
  })

  it('rejects a count that is not a number greater than zero', () => {
    for (const bad of ['nine', '0', '-2']) {
      const result = validateProductDraft(countDraft({ unitsPerPackage: bad }), 'tortilla-flour')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors.some((issue) => issue.field === 'unitsPerPackage')).toBe(true)
    }
  })

  it('leaves the field out entirely when it was not asked for', () => {
    const result = validateProductDraft(countDraft({ unitsPerPackage: '' }), 'tortilla-flour')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.unitsPerPackage).toBeUndefined()
    expect(result.warnings.some((issue) => issue.field === 'unitsPerPackage')).toBe(false)
  })
})

describe('productDraftFrom', () => {
  const STORED: Product = {
    id: 'prod_1',
    canonicalId: 'tortilla-flour',
    name: 'Mission Flour Tortillas',
    brand: 'Mission',
    macrosPer100g: {
      calories: 306,
      proteinG: 8,
      carbsG: 51,
      fatG: 7.4,
      fiberG: 3,
      sugarG: 2,
      sodiumMg: 590,
      saturatedFatG: 2.1,
      cholesterolMg: 0,
    },
    packageSizeG: 413,
    unitsPerPackage: 6,
    labelServingSizeG: 69,
    createdAt: '2026-08-20T10:00:00.000Z',
  }

  it('fills the form in from what was stored', () => {
    const draft = productDraftFrom(STORED)
    expect(draft.name).toBe('Mission Flour Tortillas')
    expect(draft.brand).toBe('Mission')
    expect(draft.packageSizeG).toBe('413')
    expect(draft.unitsPerPackage).toBe('6')
    expect(draft.servingSizeG).toBe('69')
    expect(draft.macros.calories).toBe('306')
  })

  /*
   * The basis originally typed is not stored, so the form opens on the one the
   * schema actually keeps. Claiming to know which way the label read would be a
   * guess, and a guess here rewrites every figure by a factor.
   */
  it('opens on the basis the figures are actually stored in', () => {
    expect(productDraftFrom(STORED).basis).toBe('per100g')
  })

  it('round-trips: filling in and saving again changes nothing', () => {
    const result = validateProductDraft(productDraftFrom(STORED), STORED.canonicalId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.macrosPer100g).toEqual(STORED.macrosPer100g)
    expect(result.product.packageSizeG).toBe(413)
    expect(result.product.unitsPerPackage).toBe(6)
    expect(result.product.name).toBe(STORED.name)
  })

  it('leaves a blank brand blank rather than inventing one', () => {
    const noBrand = { ...STORED }
    delete noBrand.brand
    expect(productDraftFrom(noBrand).brand).toBe('')
  })
})
