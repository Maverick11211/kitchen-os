import { describe, it, expect } from 'vitest'
import type { CanonicalIngredient, Lot, MacroSet, Product } from '../types/schema'
import { buildInventoryIndex, buildOntologyIndex } from '../engine'
import {
  buildInventoryItems,
  countByCategory,
  expiryBand,
  formatGrams,
  itemsInCategory,
  itemsNeedingUse,
  needsUsingUp,
} from './inventory-view'

const TODAY = '2026-08-19'

const MACROS: MacroSet = {
  calories: 0,
  proteinG: 0,
  carbsG: 0,
  fatG: 0,
  fiberG: 0,
  sugarG: 0,
  sodiumMg: 0,
  saturatedFatG: 0,
  cholesterolMg: 0,
}

function ingredient(
  id: string,
  overrides: Partial<CanonicalIngredient> = {},
): CanonicalIngredient {
  return {
    id,
    name: id,
    category: 'other',
    trackBy: 'mass',
    tracked: true,
    perishable: true,
    aliases: [],
    isSeed: true,
    ...overrides,
  }
}

function product(id: string, canonicalId: string): Product {
  return { id, canonicalId, name: id, macrosPer100g: MACROS, createdAt: `${TODAY}T00:00:00.000Z` }
}

function lot(id: string, productId: string, overrides: Partial<Lot> = {}): Lot {
  return {
    id,
    productId,
    initialG: 100,
    remainingG: 100,
    expiresOn: null,
    acquiredOn: TODAY,
    depleted: false,
    ...overrides,
  }
}

function view(
  ingredients: CanonicalIngredient[],
  products: Product[],
  lots: Lot[],
  today: string = TODAY,
) {
  return buildInventoryItems(
    buildOntologyIndex(ingredients),
    buildInventoryIndex(products, lots),
    today,
  )
}

// ---------------------------------------------------------------------------

describe('expiryBand', () => {
  it('separates never-expires from comfortably-far-off', () => {
    expect(expiryBand(lot('l', 'p', { expiresOn: null }), TODAY)).toBe('none')
    expect(expiryBand(lot('l', 'p', { expiresOn: '2026-12-01' }), TODAY)).toBe('fine')
  })

  it('bands the days before the edge at 2 and 5', () => {
    expect(expiryBand(lot('l', 'p', { expiresOn: '2026-08-19' }), TODAY)).toBe('urgent')
    expect(expiryBand(lot('l', 'p', { expiresOn: '2026-08-21' }), TODAY)).toBe('urgent')
    expect(expiryBand(lot('l', 'p', { expiresOn: '2026-08-22' }), TODAY)).toBe('soon')
    expect(expiryBand(lot('l', 'p', { expiresOn: '2026-08-24' }), TODAY)).toBe('soon')
    expect(expiryBand(lot('l', 'p', { expiresOn: '2026-08-25' }), TODAY)).toBe('fine')
  })

  it('calls a date already gone by expired, not urgent', () => {
    expect(expiryBand(lot('l', 'p', { expiresOn: '2026-08-18' }), TODAY)).toBe('expired')
  })

  it('leaves a frozen lot with no date alone, which is the point of the flag', () => {
    const frozen = lot('l', 'p', { expiresOn: null, frozen: true })
    expect(expiryBand(frozen, TODAY)).toBe('none')
    expect(needsUsingUp(expiryBand(frozen, TODAY))).toBe(false)
  })

  it('still warns about a frozen lot the User gave a real date', () => {
    expect(expiryBand(lot('l', 'p', { expiresOn: '2026-08-20', frozen: true }), TODAY)).toBe('urgent')
  })
})

describe('buildInventoryItems', () => {
  it('totals grams across every product and lot of one ingredient', () => {
    const items = view(
      [ingredient('butter')],
      [product('p1', 'butter'), product('p2', 'butter')],
      [lot('l1', 'p1', { remainingG: 200 }), lot('l2', 'p2', { remainingG: 50 })],
    )

    expect(items).toHaveLength(1)
    expect(items[0]?.totalG).toBe(250)
    expect(items[0]?.lotCount).toBe(2)
  })

  it('leaves out empty packets, which are history rather than inventory', () => {
    const items = view(
      [ingredient('butter')],
      [product('p1', 'butter')],
      [lot('l1', 'p1', { remainingG: 0, depleted: true })],
    )
    expect(items).toEqual([])
  })

  it('takes the worst band held, so one turning carton is not hidden by a fresh one', () => {
    const items = view(
      [ingredient('milk')],
      [product('p1', 'milk')],
      [
        lot('l1', 'p1', { expiresOn: '2026-12-01' }),
        lot('l2', 'p1', { expiresOn: '2026-08-20' }),
      ],
    )

    expect(items[0]?.band).toBe('urgent')
    expect(items[0]?.soonestExpiry).toBe('2026-08-20')
  })

  it('sorts by name so the list does not reshuffle between renders', () => {
    const items = view(
      [ingredient('zucchini'), ingredient('apple')],
      [product('p1', 'zucchini'), product('p2', 'apple')],
      [lot('l1', 'p1'), lot('l2', 'p2')],
    )
    expect(items.map((item) => item.ingredient.name)).toEqual(['apple', 'zucchini'])
  })

  it('skips a lot whose ingredient is unknown rather than breaking the screen', () => {
    const items = view([], [product('p1', 'ghost')], [lot('l1', 'p1')])
    expect(items).toEqual([])
  })
})

describe('filtering', () => {
  const items = () =>
    view(
      [
        ingredient('milk', { category: 'dairy' }),
        ingredient('butter', { category: 'dairy' }),
        ingredient('rice', { category: 'grain' }),
      ],
      [product('p1', 'milk'), product('p2', 'butter'), product('p3', 'rice')],
      [
        lot('l1', 'p1', { expiresOn: '2026-08-20' }),
        lot('l2', 'p2', { expiresOn: '2026-08-17' }),
        lot('l3', 'p3', { expiresOn: null }),
      ],
    )

  it('groups by category', () => {
    expect(itemsInCategory(items(), 'dairy').map((item) => item.ingredient.name)).toEqual([
      'butter',
      'milk',
    ])
    expect(itemsInCategory(items(), 'grain')).toHaveLength(1)
  })

  it('counts each category', () => {
    const counts = countByCategory(items())
    expect(counts.get('dairy')).toBe(2)
    expect(counts.get('grain')).toBe(1)
    expect(counts.get('spice')).toBeUndefined()
  })

  it('lists what needs using up, already-gone first', () => {
    const urgent = itemsNeedingUse(items())
    expect(urgent.map((item) => item.ingredient.name)).toEqual(['butter', 'milk'])
  })

  it('includes the softer "use soon" band, not just the urgent ones', () => {
    // Three days out: tagged "Use soon" in the list, so it must be in the list
    // that collects tagged items. The two bands set the tone, not the membership.
    const soon = view(
      [ingredient('beef', { category: 'protein' })],
      [product('p1', 'beef')],
      [lot('l1', 'p1', { expiresOn: '2026-08-22' })],
    )

    expect(soon[0]?.band).toBe('soon')
    expect(itemsNeedingUse(soon).map((item) => item.ingredient.name)).toEqual(['beef'])
  })

  it('still leaves alone anything that does not expire at all', () => {
    const never = view(
      [ingredient('rice')],
      [product('p1', 'rice')],
      [lot('l1', 'p1', { expiresOn: null })],
    )
    expect(itemsNeedingUse(never)).toEqual([])
  })
})

describe('formatGrams', () => {
  it('says grams and kilograms the way a person would', () => {
    expect(formatGrams(2.5)).toBe('2.5 g')
    expect(formatGrams(226)).toBe('226 g')
    expect(formatGrams(1500)).toBe('1.5 kg')
    expect(formatGrams(12_000)).toBe('12 kg')
  })
})
