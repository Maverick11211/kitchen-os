import { describe, it, expect } from 'vitest'
import type { CanonicalIngredient, Lot, MacroSet, Product } from '../types/schema'
import { buildInventoryIndex, buildOntologyIndex } from '../engine'
import {
  buildInventoryItems,
  countByCategory,
  expiryBand,
  formatAmount,
  formatCount,
  formatGrams,
  itemsInCategory,
  itemsNeedingUse,
  lotAmountText,
  needsUsingUp,
  pluralize,
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

// ---------------------------------------------------------------------------
// Counted things read as counts
// ---------------------------------------------------------------------------

describe('counts on the shelf', () => {
  const TORTILLA: CanonicalIngredient = {
    id: 'tortilla-flour',
    name: 'Tortilla, flour',
    category: 'grain',
    trackBy: 'count',
    tracked: true,
    perishable: true,
    unitWeightG: 45,
    aliases: [],
    isSeed: true,
  }

  const BAG = {
    id: 'prod_mission',
    canonicalId: 'tortilla-flour',
    name: 'Mission Flour Tortillas',
    macrosPer100g: MACROS,
    packageSizeG: 413,
    unitsPerPackage: 6,
    createdAt: '2026-08-01T00:00:00.000Z',
  }

  function packet(id: string, remainingG: number, productId = 'prod_mission') {
    return {
      id,
      productId,
      initialG: 413,
      remainingG,
      expiresOn: null,
      acquiredOn: '2026-08-18',
      depleted: false,
    }
  }

  it('says how many are left, not how much they weigh', () => {
    const items = buildInventoryItems(
      buildOntologyIndex([TORTILLA]),
      buildInventoryIndex([BAG], [packet('lot_1', 413)]),
      TODAY,
    )

    expect(items[0]?.totalCount).toBeCloseTo(6, 5)
    expect(formatAmount(items[0]!)).toBe('6 tortillas')
  })

  it('adds up packets of different sizes, each in its own terms', () => {
    const tenPack = { ...BAG, id: 'prod_ten', packageSizeG: 500, unitsPerPackage: 10 }
    const items = buildInventoryItems(
      buildOntologyIndex([TORTILLA]),
      buildInventoryIndex(
        [BAG, tenPack],
        [packet('lot_1', 413), packet('lot_2', 250, 'prod_ten')],
      ),
      TODAY,
    )

    // Six from the bag of six, five from the half-used bag of ten.
    expect(items[0]?.totalCount).toBeCloseTo(11, 5)
  })

  it('gives up the count when a packet cannot say what one weighs', () => {
    const { unitWeightG, ...noAverage } = TORTILLA
    void unitWeightG
    const unlabelled = { ...BAG, id: 'prod_plain', packageSizeG: undefined, unitsPerPackage: undefined }
    const items = buildInventoryItems(
      buildOntologyIndex([noAverage]),
      buildInventoryIndex([unlabelled], [packet('lot_1', 300, 'prod_plain')]),
      TODAY,
    )

    expect(items[0]?.totalCount).toBeNull()
    expect(formatAmount(items[0]!)).toBe('300 g')
  })

  it('leaves things that are weighed in grams', () => {
    const cheese: CanonicalIngredient = { ...TORTILLA, id: 'cheddar', name: 'Cheddar', trackBy: 'mass' }
    const items = buildInventoryItems(
      buildOntologyIndex([cheese]),
      buildInventoryIndex(
        [{ ...BAG, id: 'prod_c', canonicalId: 'cheddar' }],
        [packet('lot_1', 226, 'prod_c')],
      ),
      TODAY,
    )

    expect(items[0]?.totalCount).toBeNull()
    expect(formatAmount(items[0]!)).toBe('226 g')
  })

  it('reads a part-used packet as a fraction rather than pretending it is whole', () => {
    const half = lotAmountText(packet('lot_1', 206.5), TORTILLA, BAG)
    expect(half.remaining).toBe('3')
    expect(half.initial).toBe('6 tortillas')
  })

  it('says one of a thing in the singular', () => {
    expect(formatCount(1, TORTILLA)).toBe('1 tortilla')
    expect(formatCount(2, TORTILLA)).toBe('2 tortillas')
  })

  it('pluralises well enough for a kitchen', () => {
    expect(pluralize('egg', 2)).toBe('eggs')
    expect(pluralize('box', 2)).toBe('boxes')
    expect(pluralize('berry', 2)).toBe('berries')
    expect(pluralize('egg', 1)).toBe('egg')
  })

  it('uses the head of a catalogue name, not the whole thing', () => {
    // "Tortilla, flour" is a catalogue entry; nobody says "six tortilla, flours".
    expect(formatCount(6, TORTILLA)).toBe('6 tortillas')
  })
})
