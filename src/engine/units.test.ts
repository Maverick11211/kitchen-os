import { describe, it, expect } from 'vitest'
import type { CanonicalIngredient, Unit } from '../types/schema'
import {
  CUP_ML,
  FLOZ_ML,
  LB_G,
  OZ_G,
  canConvert,
  convertibleUnits,
  fromGrams,
  gramsPerCount,
  gramsPerMl,
  isMassUnit,
  isVolumeUnit,
  toGrams,
} from './units'

// ---------------------------------------------------------------------------
// Fixtures — one per conversion path, mirroring real ontology shapes.
// ---------------------------------------------------------------------------

function ingredient(overrides: Partial<CanonicalIngredient>): CanonicalIngredient {
  return {
    id: 'test',
    name: 'Test ingredient',
    category: 'other',
    trackBy: 'mass',
    tracked: true,
    perishable: false,
    isSeed: true,
    aliases: [],
    ...overrides,
  }
}

/** Solid measured by weight, with a cup weight. Real shape: cheddar-shredded. */
const shreddedCheese = ingredient({
  id: 'cheddar-shredded',
  name: 'Shredded cheddar',
  trackBy: 'mass',
  cupWeightG: 113,
})

/** True liquid. Real shape: vegetable-oil. */
const oil = ingredient({
  id: 'vegetable-oil',
  name: 'Vegetable oil',
  trackBy: 'volume',
  densityGPerMl: 0.92,
})

/** Discrete item. Real shape: egg-large. */
const egg = ingredient({
  id: 'egg-large',
  name: 'Large egg',
  trackBy: 'count',
  unitWeightG: 50,
})

/** Carries no conversion fields at all. Real shape: ground-beef-85-15. */
const groundBeef = ingredient({ id: 'ground-beef', name: 'Ground beef', trackBy: 'mass' })

const ALL_UNITS: Unit[] = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'floz', 'count']

// ---------------------------------------------------------------------------

describe('unit classification', () => {
  it.each(['g', 'kg', 'oz', 'lb'] as const)('%s is a mass unit', (unit) => {
    expect(isMassUnit(unit)).toBe(true)
    expect(isVolumeUnit(unit)).toBe(false)
  })

  it.each(['ml', 'l', 'floz', 'tsp', 'tbsp', 'cup'] as const)('%s is a volume unit', (unit) => {
    expect(isVolumeUnit(unit)).toBe(true)
    expect(isMassUnit(unit)).toBe(false)
  })

  it('count is neither mass nor volume', () => {
    expect(isMassUnit('count')).toBe(false)
    expect(isVolumeUnit('count')).toBe(false)
  })

  it('every Unit is classified or handled as count', () => {
    for (const unit of ALL_UNITS) {
      expect(isMassUnit(unit) || isVolumeUnit(unit) || unit === 'count').toBe(true)
    }
  })
})

describe('toGrams — mass units', () => {
  it('passes grams through unchanged regardless of the ingredient', () => {
    for (const entry of [shreddedCheese, oil, egg, groundBeef]) {
      expect(toGrams(entry, 250, 'g')).toEqual({ ok: true, grams: 250 })
    }
  })

  it('converts kg, oz and lb', () => {
    expect(toGrams(groundBeef, 1.5, 'kg')).toEqual({ ok: true, grams: 1500 })
    expect(toGrams(groundBeef, 4, 'oz')).toEqual({ ok: true, grams: 4 * OZ_G })
    expect(toGrams(groundBeef, 2, 'lb')).toEqual({ ok: true, grams: 2 * LB_G })
  })

  it('works for an ingredient with no conversion fields at all', () => {
    // Mass units need nothing from the ontology entry — this must never fail.
    expect(canConvert(groundBeef, 'g')).toBe(true)
    expect(canConvert(groundBeef, 'lb')).toBe(true)
  })
})

describe('toGrams — count', () => {
  it('multiplies by unitWeightG', () => {
    expect(toGrams(egg, 3, 'count')).toEqual({ ok: true, grams: 150 })
  })

  it('handles fractional counts (half an onion)', () => {
    expect(toGrams(egg, 0.5, 'count')).toEqual({ ok: true, grams: 25 })
  })

  it('fails with missing-unit-weight when unitWeightG is absent', () => {
    const result = toGrams(groundBeef, 2, 'count')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('missing-unit-weight')
    expect(result.message).toContain('Ground beef')
  })
})

describe('toGrams — volume on solids (cupWeightG path)', () => {
  it('cup is exactly cupWeightG', () => {
    const result = toGrams(shreddedCheese, 1, 'cup')
    expect(result.ok && result.grams).toBeCloseTo(113, 10)
  })

  it('tbsp is a sixteenth of a cup', () => {
    const result = toGrams(shreddedCheese, 1, 'tbsp')
    expect(result.ok && result.grams).toBeCloseTo(113 / 16, 10)
  })

  it('tsp is a forty-eighth of a cup', () => {
    const result = toGrams(shreddedCheese, 1, 'tsp')
    expect(result.ok && result.grams).toBeCloseTo(113 / 48, 10)
  })

  it('ml derives from cup weight, not from a looked-up bulk density', () => {
    const result = toGrams(shreddedCheese, CUP_ML, 'ml')
    expect(result.ok && result.grams).toBeCloseTo(113, 10)
  })

  it('fails with missing-volume-conversion when the solid has no cupWeightG', () => {
    const result = toGrams(groundBeef, 1, 'cup')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('missing-volume-conversion')
  })
})

describe('toGrams — volume on liquids (density path)', () => {
  it('ml is quantity x density', () => {
    expect(toGrams(oil, 100, 'ml')).toEqual({ ok: true, grams: 92 })
  })

  it('l is 1000ml x density', () => {
    const result = toGrams(oil, 1, 'l')
    expect(result.ok && result.grams).toBeCloseTo(920, 10)
  })

  it('floz converts through millilitres', () => {
    const result = toGrams(oil, 2, 'floz')
    expect(result.ok && result.grams).toBeCloseTo(2 * FLOZ_ML * 0.92, 10)
  })

  // This is the case the old QA copy of this math could not handle: no liquid
  // in the ontology carries a cupWeightG, so cup/tbsp/tsp on a liquid used to
  // be silently skipped rather than verified.
  it('cup on a liquid works via density even with no cupWeightG', () => {
    expect(oil.cupWeightG).toBeUndefined()
    const result = toGrams(oil, 1, 'cup')
    expect(result.ok && result.grams).toBeCloseTo(CUP_ML * 0.92, 10)
  })

  it('tbsp on a liquid works via density', () => {
    const result = toGrams(oil, 3, 'tbsp')
    expect(result.ok && result.grams).toBeCloseTo(3 * (CUP_ML / 16) * 0.92, 10)
    // Matches the value the Phase 2 build scripts stored for 3 tbsp of oil.
    expect(result.ok && result.grams).toBeCloseTo(40.8, 1)
  })

  it('tsp on a liquid works via density', () => {
    const result = toGrams(oil, 1, 'tsp')
    expect(result.ok && result.grams).toBeCloseTo((CUP_ML / 48) * 0.92, 10)
  })
})

describe('the "never density x volume for solids" rule', () => {
  it('gramsPerMl ignores densityGPerMl unless trackBy is volume', () => {
    // The ontology test forbids this shape, but the engine must not rely on
    // that being true — if a malformed entry ever appears, it must not silently
    // switch a solid onto the density path.
    const malformed = ingredient({
      name: 'Malformed solid',
      trackBy: 'mass',
      cupWeightG: 113,
      densityGPerMl: 0.65,
    })
    expect(gramsPerMl(malformed)).toBeCloseTo(113 / CUP_ML, 10)
    expect(gramsPerMl(malformed)).not.toBeCloseTo(0.65, 2)
  })

  it('a solid with only a bogus density cannot be converted at all', () => {
    const malformed = ingredient({ trackBy: 'mass', densityGPerMl: 0.65 })
    const result = toGrams(malformed, 1, 'cup')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('missing-volume-conversion')
  })

  it('prefers density over cupWeightG for a true liquid that has both', () => {
    const both = ingredient({ trackBy: 'volume', densityGPerMl: 1.03, cupWeightG: 200 })
    expect(gramsPerMl(both)).toBe(1.03)
  })

  it('falls back to cupWeightG for a volume-tracked entry with no density', () => {
    const noDensity = ingredient({ trackBy: 'volume', cupWeightG: 240 })
    expect(gramsPerMl(noDensity)).toBeCloseTo(240 / CUP_ML, 10)
  })

  it('returns null when neither field is present', () => {
    expect(gramsPerMl(groundBeef)).toBeNull()
  })
})

describe('invalid quantities', () => {
  it.each([NaN, Infinity, -Infinity])('rejects %s', (quantity) => {
    const result = toGrams(groundBeef, quantity, 'g')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('invalid-quantity')
  })

  it('rejects negative quantities', () => {
    const result = toGrams(groundBeef, -5, 'g')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('invalid-quantity')
  })

  it('allows zero', () => {
    expect(toGrams(groundBeef, 0, 'g')).toEqual({ ok: true, grams: 0 })
    expect(toGrams(egg, 0, 'count')).toEqual({ ok: true, grams: 0 })
  })

  it('checks the quantity before the ingredient fields', () => {
    // A negative count on an ingredient that also lacks unitWeightG reports the
    // quantity problem, which is the one the user can actually act on.
    const result = toGrams(groundBeef, -1, 'count')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('invalid-quantity')
  })
})

describe('fromGrams', () => {
  it('inverts mass units', () => {
    expect(fromGrams(groundBeef, 1500, 'kg')).toEqual({ ok: true, quantity: 1.5 })
    expect(fromGrams(groundBeef, LB_G, 'lb')).toEqual({ ok: true, quantity: 1 })
  })

  it('inverts count', () => {
    expect(fromGrams(egg, 150, 'count')).toEqual({ ok: true, quantity: 3 })
  })

  it('inverts the solid volume path', () => {
    const result = fromGrams(shreddedCheese, 113, 'cup')
    expect(result.ok && result.quantity).toBeCloseTo(1, 10)
  })

  it('inverts the liquid volume path', () => {
    const result = fromGrams(oil, 92, 'ml')
    expect(result.ok && result.quantity).toBeCloseTo(100, 10)
  })

  it('propagates the same failures as toGrams', () => {
    const result = fromGrams(groundBeef, 100, 'count')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('missing-unit-weight')
  })

  it.each([
    ['cheese', shreddedCheese],
    ['oil', oil],
    ['egg', egg],
  ] as const)('round-trips %s through every unit it supports', (_label, entry) => {
    for (const unit of convertibleUnits(entry)) {
      const grams = toGrams(entry, 137.5, unit)
      expect(grams.ok).toBe(true)
      if (!grams.ok) continue
      const back = fromGrams(entry, grams.grams, unit)
      expect(back.ok).toBe(true)
      if (!back.ok) continue
      expect(back.quantity).toBeCloseTo(137.5, 8)
    }
  })
})

describe('canConvert / convertibleUnits', () => {
  it('a solid with a cup weight supports everything except count', () => {
    expect(convertibleUnits(shreddedCheese)).toEqual([
      'g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'floz',
    ])
  })

  it('a liquid supports everything except count', () => {
    expect(convertibleUnits(oil)).not.toContain('count')
    expect(convertibleUnits(oil)).toContain('cup')
  })

  it('a count ingredient with no cup weight supports mass units and count', () => {
    expect(convertibleUnits(egg)).toEqual(['g', 'kg', 'oz', 'lb', 'count'])
  })

  it('an ingredient with no conversion fields supports mass units only', () => {
    expect(convertibleUnits(groundBeef)).toEqual(['g', 'kg', 'oz', 'lb'])
  })
})

// ---------------------------------------------------------------------------
// Counts: whose weight wins
// ---------------------------------------------------------------------------

describe('gramsPerCount', () => {
  /** The ontology's generic tortilla: an average across every brand. */
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

  /** The bag actually in the kitchen: 413 g, six of them, so 68.83 g each. */
  const MISSION = { packageSizeG: 413, unitsPerPackage: 6 }

  it('prefers the product in the kitchen over the ontology average', () => {
    expect(gramsPerCount(TORTILLA, MISSION)).toBeCloseTo(68.83, 2)
  })

  it('falls back to the ingredient average when there is no product', () => {
    expect(gramsPerCount(TORTILLA)).toBe(45)
  })

  it('falls back when the product knows a weight but not a count', () => {
    expect(gramsPerCount(TORTILLA, { packageSizeG: 413 })).toBe(45)
  })

  it('falls back when the product knows a count but not a weight', () => {
    expect(gramsPerCount(TORTILLA, { unitsPerPackage: 6 })).toBe(45)
  })

  it('does not divide by a pack count of zero', () => {
    expect(gramsPerCount(TORTILLA, { packageSizeG: 413, unitsPerPackage: 0 })).toBe(45)
  })

  /** The same ingredient with no average weight recorded at all. */
  function withoutAverage(): CanonicalIngredient {
    const copy = { ...TORTILLA }
    delete copy.unitWeightG
    return copy
  }

  it('is null when nothing anywhere knows', () => {
    expect(gramsPerCount(withoutAverage())).toBeNull()
  })

  /*
   * The bug this was written for. Jack logged one tortilla from a 413 g bag of
   * six and the app charged him the ontology's 45 g — a third light, on every
   * count ingredient, silently.
   */
  it('converts one tortilla to the weight of one of HIS tortillas', () => {
    const generic = toGrams(TORTILLA, 1, 'count')
    const actual = toGrams(TORTILLA, 1, 'count', MISSION)

    expect(generic.ok && generic.grams).toBe(45)
    expect(actual.ok && actual.grams).toBeCloseTo(68.83, 2)
  })

  it('shows a part-used bag as a count of what is left', () => {
    // Four tortillas left out of six: 275.33 g.
    const shown = fromGrams(TORTILLA, 275.33, 'count', MISSION)
    expect(shown.ok && shown.quantity).toBeCloseTo(4, 2)
  })

  it('round-trips a count through grams and back', () => {
    const grams = toGrams(TORTILLA, 3, 'count', MISSION)
    expect(grams.ok).toBe(true)
    if (!grams.ok) return
    const back = fromGrams(TORTILLA, grams.grams, 'count', MISSION)
    expect(back.ok && back.quantity).toBeCloseTo(3, 10)
  })

  it('offers count as a unit when only the product can explain it', () => {
    expect(convertibleUnits(withoutAverage())).not.toContain('count')
    expect(convertibleUnits(withoutAverage(), MISSION)).toContain('count')
  })
})
