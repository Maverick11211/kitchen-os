import { describe, it, expect } from 'vitest'
import type { CanonicalIngredient, Lot, MacroSet, Product } from '../types/schema'
import { buildInventoryIndex } from '../engine'
import {
  defaultChoice,
  defaultUnit,
  emptyLogDraft,
  logOptionsFor,
  validateLogDraft,
  type LogDraft,
  type LogOptions,
} from './log-forms'

const CHEDDAR: MacroSet = {
  calories: 400,
  proteinG: 25,
  carbsG: 1.3,
  fatG: 33,
  fiberG: 0,
  sugarG: 0.5,
  sodiumMg: 620,
  saturatedFatG: 19,
  cholesterolMg: 105,
}

function ingredient(overrides: Partial<CanonicalIngredient> = {}): CanonicalIngredient {
  return {
    id: 'cheddar-shredded',
    name: 'Cheddar, shredded',
    category: 'dairy',
    trackBy: 'mass',
    tracked: true,
    perishable: true,
    aliases: [],
    isSeed: true,
    ...overrides,
  }
}

function product(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    canonicalId: 'cheddar-shredded',
    name: id,
    macrosPer100g: CHEDDAR,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function lot(id: string, productId: string, overrides: Partial<Lot> = {}): Lot {
  return {
    id,
    productId,
    initialG: 200,
    remainingG: 200,
    expiresOn: null,
    acquiredOn: '2026-08-18',
    depleted: false,
    ...overrides,
  }
}

function draftFor(options: LogOptions, overrides: Partial<LogDraft> = {}): LogDraft {
  return { ...emptyLogDraft(ingredient(), options), amount: '50', ...overrides }
}

const NOTHING: LogOptions = { packets: [], otherProducts: [], quickOnly: true }

describe('logOptionsFor', () => {
  it('lists packets first-expiring first', () => {
    const products = [product('prod_kroger')]
    const lots = [
      lot('lot_later', 'prod_kroger', { expiresOn: '2026-09-10' }),
      lot('lot_sooner', 'prod_kroger', { expiresOn: '2026-09-01' }),
    ]

    const options = logOptionsFor(buildInventoryIndex(products, lots), 'cheddar-shredded')

    expect(options.packets.map((packet) => packet.lot.id)).toEqual(['lot_sooner', 'lot_later'])
  })

  it('leaves out empty packets', () => {
    const products = [product('prod_kroger')]
    const lots = [lot('lot_empty', 'prod_kroger', { remainingG: 0, depleted: true })]

    const options = logOptionsFor(buildInventoryIndex(products, lots), 'cheddar-shredded')

    expect(options.packets).toHaveLength(0)
    // The product is still a source of figures, it just cannot be deducted from.
    expect(options.otherProducts.map((item) => item.id)).toEqual(['prod_kroger'])
  })

  it('offers a run-out product, most recent first', () => {
    const products = [
      product('prod_old', { createdAt: '2026-01-01T00:00:00.000Z' }),
      product('prod_new', { createdAt: '2026-08-01T00:00:00.000Z' }),
    ]

    const options = logOptionsFor(buildInventoryIndex(products, []), 'cheddar-shredded')

    expect(options.otherProducts.map((item) => item.id)).toEqual(['prod_new', 'prod_old'])
    expect(options.quickOnly).toBe(false)
  })

  it('falls back to typing the figures when there is no product at all', () => {
    expect(logOptionsFor(buildInventoryIndex([], []), 'cheddar-shredded').quickOnly).toBe(true)
  })

  it('ignores other ingredients', () => {
    const products = [product('prod_cheddar'), product('prod_butter', { canonicalId: 'butter' })]

    const options = logOptionsFor(buildInventoryIndex(products, []), 'cheddar-shredded')

    expect(options.otherProducts.map((item) => item.id)).toEqual(['prod_cheddar'])
  })
})

describe('the starting draft', () => {
  it('defaults to the first-expiring packet', () => {
    const products = [product('prod_kroger')]
    const lots = [
      lot('lot_later', 'prod_kroger', { expiresOn: '2026-09-10' }),
      lot('lot_sooner', 'prod_kroger', { expiresOn: '2026-09-01' }),
    ]
    const options = logOptionsFor(buildInventoryIndex(products, lots), 'cheddar-shredded')

    expect(defaultChoice(options)).toEqual({ kind: 'packet', lotId: 'lot_sooner' })
  })

  it('defaults to typing figures when there is nothing to go on', () => {
    expect(defaultChoice(NOTHING)).toEqual({ kind: 'quick' })
  })

  it('starts with deduction on', () => {
    expect(emptyLogDraft(ingredient(), NOTHING).deduct).toBe(true)
  })

  it('opens in the unit the ingredient is naturally measured in', () => {
    expect(defaultUnit(ingredient())).toBe('g')
    expect(defaultUnit(ingredient({ trackBy: 'count', unitWeightG: 50 }))).toBe('count')
    expect(defaultUnit(ingredient({ trackBy: 'volume', densityGPerMl: 1.03 }))).toBe('ml')
  })

  it('does not offer a unit the engine cannot convert', () => {
    // Count-tracked but with no unit weight: "2 of them" is unanswerable.
    expect(defaultUnit(ingredient({ trackBy: 'count' }))).toBe('g')
  })
})

describe('validateLogDraft', () => {
  function stocked(remainingG = 200): LogOptions {
    const products = [product('prod_kroger')]
    const lots = [lot('lot_1', 'prod_kroger', { remainingG })]
    return logOptionsFor(buildInventoryIndex(products, lots), 'cheddar-shredded')
  }

  it('works out the macros from the packet being eaten', () => {
    const options = stocked()
    const result = validateLogDraft(draftFor(options), ingredient(), options)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.log.macros.calories).toBe(200)
    expect(result.log.macros.proteinG).toBe(12.5)
    expect(result.log.label).toBe('prod_kroger')
    expect(result.log.lotId).toBe('lot_1')
    expect(result.log.productId).toBe('prod_kroger')
  })

  it('converts whatever unit was typed', () => {
    const options = stocked()
    const eggs = ingredient({ id: 'egg', name: 'Egg', trackBy: 'count', unitWeightG: 50 })

    const result = validateLogDraft(
      { ...draftFor(options), amount: '2', unit: 'count' },
      eggs,
      options,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grams).toBe(100)
  })

  it('shows the engine’s own message when a unit cannot be converted', () => {
    const options = stocked()
    // Shredded cheese with no cup weight: cups are meaningless for it.
    const result = validateLogDraft({ ...draftFor(options), unit: 'cup' }, ingredient(), options)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.field).toBe('unit')
    expect(result.errors[0]?.message.length).toBeGreaterThan(0)
  })

  it('leaves stock alone when the switch is off', () => {
    const options = stocked()
    const result = validateLogDraft({ ...draftFor(options), deduct: false }, ingredient(), options)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Still the packet's figures — you know what you ate, it just is not yours.
    expect(result.log.macros.calories).toBe(200)
    expect(result.log.lotId).toBeUndefined()
    expect(result.deductedG).toBe(0)
  })

  it('warns, in words, when the packet cannot cover it', () => {
    const options = stocked(30)
    const result = validateLogDraft(draftFor(options), ingredient(), options)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deductedG).toBe(30)
    expect(result.shortfallG).toBe(20)
    // The full 50g is logged: you ate what you ate.
    expect(result.log.grams).toBe(50)
    expect(result.log.macros.calories).toBe(200)
    expect(result.warnings.map((issue) => issue.field)).toContain('deduct')
    expect(result.warnings[0]?.message).toContain('30 g')
  })

  it('uses a run-out product without pretending to deduct', () => {
    const options = logOptionsFor(buildInventoryIndex([product('prod_kroger')], []), 'cheddar-shredded')
    const result = validateLogDraft(draftFor(options), ingredient(), options)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.log.productId).toBe('prod_kroger')
    expect(result.log.lotId).toBeUndefined()
    expect(result.log.macros.calories).toBe(200)
  })

  it('takes typed figures as the total for what was eaten', () => {
    const result = validateLogDraft(
      draftFor(NOTHING, {
        quick: { calories: '250', carbsG: '30', fatG: '9', proteinG: '5' },
      }),
      ingredient(),
      NOTHING,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Not scaled by grams — 250 is what the thing was.
    expect(result.log.macros.calories).toBe(250)
    expect(result.log.macros.carbsG).toBe(30)
    expect(result.log.label).toBe('Cheddar, shredded')
    expect(result.log.productId).toBeUndefined()
    expect(result.log.lotId).toBeUndefined()
  })

  it('stores the five it did not ask for as zero', () => {
    const result = validateLogDraft(
      draftFor(NOTHING, { quick: { calories: '250', carbsG: '30', fatG: '9', proteinG: '5' } }),
      ingredient(),
      NOTHING,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.log.macros.fiberG).toBe(0)
    expect(result.log.macros.cholesterolMg).toBe(0)
  })

  it('needs at least the calories', () => {
    const result = validateLogDraft(draftFor(NOTHING), ingredient(), NOTHING)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((issue) => issue.field)).toContain('calories')
  })

  it('counts a blank figure as zero, and says so without blocking', () => {
    const result = validateLogDraft(
      draftFor(NOTHING, { quick: { calories: '250', carbsG: '', fatG: '', proteinG: '' } }),
      ingredient(),
      NOTHING,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.log.macros.carbsG).toBe(0)
    expect(result.warnings.map((issue) => issue.field)).toContain('quick')
  })

  it('treats text where a number belongs as a typo, not an omission', () => {
    const result = validateLogDraft(
      draftFor(NOTHING, { quick: { calories: '250', carbsG: 'thirty', fatG: '', proteinG: '' } }),
      ingredient(),
      NOTHING,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((issue) => issue.field)).toContain('carbsG')
  })

  it('asks how much before anything else', () => {
    const options = stocked()
    const result = validateLogDraft({ ...draftFor(options), amount: '' }, ingredient(), options)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.field).toBe('amount')
  })

  it('refuses an amount that is not an amount', () => {
    const options = stocked()
    for (const amount of ['0', '-5', 'some']) {
      expect(validateLogDraft({ ...draftFor(options), amount }, ingredient(), options).ok).toBe(
        false,
      )
    }
  })

  it('says so when the packet has gone since the screen was drawn', () => {
    const options = stocked()
    const result = validateLogDraft(
      { ...draftFor(options), choice: { kind: 'packet', lotId: 'lot_gone' } },
      ingredient(),
      options,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((issue) => issue.field)).toContain('choice')
  })
})
