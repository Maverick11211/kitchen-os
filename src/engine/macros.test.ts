import { describe, it, expect } from 'vitest'
import type { MacroSet } from '../types/schema'
import {
  MACRO_KEYS,
  ZERO_MACROS,
  addMacros,
  fractionOfMacros,
  isZeroMacros,
  macrosForLines,
  multiplyMacros,
  roundMacros,
  scaleMacros,
  subtractMacros,
  sumMacros,
  totalMacros,
} from './macros'

/** Distinct value in every field so a field-swap bug can't hide. */
function macros(overrides: Partial<MacroSet> = {}): MacroSet {
  return {
    calories: 100,
    proteinG: 20,
    carbsG: 30,
    fatG: 40,
    fiberG: 5,
    sugarG: 6,
    sodiumMg: 700,
    saturatedFatG: 8,
    cholesterolMg: 0,
    ...overrides,
  }
}

/** Real shape: chicken breast, per 100g. */
const chickenPer100g: MacroSet = {
  calories: 165,
  proteinG: 31,
  carbsG: 0,
  fatG: 3.6,
  fiberG: 0,
  sugarG: 0,
  sodiumMg: 74,
  saturatedFatG: 1,
  cholesterolMg: 0,
}

describe('MACRO_KEYS', () => {
  it('covers every field of MacroSet exactly once', () => {
    expect(new Set(MACRO_KEYS).size).toBe(MACRO_KEYS.length)
    expect([...MACRO_KEYS].sort()).toEqual(Object.keys(macros()).sort())
  })
})

describe('ZERO_MACROS', () => {
  it('is all zeroes', () => {
    for (const key of MACRO_KEYS) expect(ZERO_MACROS[key]).toBe(0)
    expect(isZeroMacros(ZERO_MACROS)).toBe(true)
  })

  it('is frozen so a caller cannot corrupt the shared value', () => {
    expect(Object.isFrozen(ZERO_MACROS)).toBe(true)
  })
})

describe('scaleMacros', () => {
  it('scales a per-100g label by grams', () => {
    const result = scaleMacros(chickenPer100g, 200)
    expect(result.calories).toBeCloseTo(330, 10)
    expect(result.proteinG).toBeCloseTo(62, 10)
    expect(result.fatG).toBeCloseTo(7.2, 10)
  })

  it('is identity at exactly 100g', () => {
    expect(scaleMacros(chickenPer100g, 100)).toEqual(chickenPer100g)
  })

  it('handles a partial portion', () => {
    const result = scaleMacros(chickenPer100g, 37.5)
    expect(result.proteinG).toBeCloseTo(11.625, 10)
  })

  it('gives zero for zero grams', () => {
    expect(isZeroMacros(scaleMacros(chickenPer100g, 0))).toBe(true)
  })

  it('scales every field, not just the headline four', () => {
    const result = scaleMacros(macros(), 50)
    expect(result).toEqual({
      calories: 50,
      proteinG: 10,
      carbsG: 15,
      fatG: 20,
      fiberG: 2.5,
      sugarG: 3,
      sodiumMg: 350,
      saturatedFatG: 4,
      cholesterolMg: 0,
    })
  })

  it('does not mutate its input', () => {
    const input = macros()
    const snapshot = { ...input }
    scaleMacros(input, 250)
    expect(input).toEqual(snapshot)
  })
})

describe('multiplyMacros / fractionOfMacros', () => {
  it('fractionOfMacros takes a portion of a cooked batch', () => {
    const batch = macros({ calories: 2400, proteinG: 120 })
    const quarter = fractionOfMacros(batch, 0.25)
    expect(quarter.calories).toBe(600)
    expect(quarter.proteinG).toBe(30)
  })

  it('a fraction of 1 returns the whole batch', () => {
    const batch = macros()
    expect(fractionOfMacros(batch, 1)).toEqual(batch)
  })

  it('multiplyMacros scales a batch up (cooking 1.5x)', () => {
    expect(multiplyMacros(macros(), 1.5).calories).toBe(150)
  })
})

describe('addMacros / subtractMacros / sumMacros', () => {
  it('adds field by field', () => {
    expect(addMacros(macros(), macros())).toEqual(macros({
      calories: 200, proteinG: 40, carbsG: 60, fatG: 80,
      fiberG: 10, sugarG: 12, sodiumMg: 1400, saturatedFatG: 16, cholesterolMg: 0,
    }))
  })

  it('adding zero is identity', () => {
    expect(addMacros(macros(), ZERO_MACROS)).toEqual(macros())
  })

  it('subtract undoes add', () => {
    const a = macros()
    const b = macros({ calories: 33, proteinG: 7 })
    expect(subtractMacros(addMacros(a, b), b)).toEqual(a)
  })

  it('sums an empty list to zero rather than failing', () => {
    expect(sumMacros([])).toEqual({ ...ZERO_MACROS })
  })

  it('sums a list', () => {
    expect(sumMacros([macros(), macros(), macros()]).calories).toBe(300)
  })

  it('totalMacros sums the day from consumption events', () => {
    const day = [
      { macros: macros({ calories: 400 }) },
      { macros: macros({ calories: 650 }) },
      { macros: macros({ calories: 220 }) },
    ]
    expect(totalMacros(day).calories).toBe(1270)
  })

  it('totalMacros of an empty day is zero, not an error', () => {
    expect(isZeroMacros(totalMacros([]))).toBe(true)
  })
})

describe('macrosForLines — a whole cooked batch', () => {
  it('totals several ingredients', () => {
    const rice: MacroSet = {
      calories: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3,
      fiberG: 0.4, sugarG: 0.1, sodiumMg: 1, saturatedFatG: 0.1, cholesterolMg: 0,
    }
    const result = macrosForLines([
      { grams: 300, macrosPer100g: chickenPer100g },
      { grams: 200, macrosPer100g: rice },
    ])
    expect(result.calories).toBeCloseTo(165 * 3 + 130 * 2, 10)
    expect(result.proteinG).toBeCloseTo(31 * 3 + 2.7 * 2, 10)
    expect(result.carbsG).toBeCloseTo(28 * 2, 10)
  })

  it('an empty batch is zero, not an error', () => {
    expect(isZeroMacros(macrosForLines([]))).toBe(true)
  })

  it('agrees with scaling and summing each line individually', () => {
    const lines = [
      { grams: 137, macrosPer100g: chickenPer100g },
      { grams: 42.5, macrosPer100g: macros() },
    ]
    const viaLines = macrosForLines(lines)
    const viaSum = sumMacros(lines.map((l) => scaleMacros(l.macrosPer100g, l.grams)))
    for (const key of MACRO_KEYS) expect(viaLines[key]).toBeCloseTo(viaSum[key], 10)
  })

  it('ingredients with no product contribute nothing, because they produce no line', () => {
    // Salt and water are `tracked: false` and never get a Product, so a cook
    // event simply has no line for them. Nothing special-cases them here.
    const withStaples = macrosForLines([{ grams: 300, macrosPer100g: chickenPer100g }])
    expect(withStaples.calories).toBeCloseTo(495, 10)
  })
})

describe('immutability of history', () => {
  it('a stored snapshot is unaffected by later changes to the product', () => {
    // Simulates correcting a product's label after the fact: the event holds a
    // plain value, so there is no path by which it could change.
    const product = { macrosPer100g: { ...chickenPer100g } }
    const logged = scaleMacros(product.macrosPer100g, 200)
    const loggedSnapshot = { ...logged }

    product.macrosPer100g.calories = 999
    product.macrosPer100g.proteinG = 999

    expect(logged).toEqual(loggedSnapshot)
    expect(logged.calories).toBeCloseTo(330, 10)
  })
})

describe('roundMacros', () => {
  it('rounds calories and sodium to whole numbers, grams to one decimal', () => {
    const result = roundMacros({
      calories: 330.4567, proteinG: 61.99, carbsG: 0.04, fatG: 7.25,
      fiberG: 0.449, sugarG: 0.05, sodiumMg: 148.6, saturatedFatG: 2.04, cholesterolMg: 0,
    })
    expect(result).toEqual({
      calories: 330, proteinG: 62, carbsG: 0, fatG: 7.3,
      fiberG: 0.4, sugarG: 0.1, sodiumMg: 149, saturatedFatG: 2, cholesterolMg: 0,
    })
  })

  it('leaves an already-round set alone', () => {
    const clean = macros()
    expect(roundMacros(clean)).toEqual(clean)
  })
})

// ---------------------------------------------------------------------------

describe('cholesterolMg (added in schema version 2)', () => {
  // Its own fixtures rather than the shared ones above, so this reads as a
  // check that the newest field is wired into the arithmetic like every other
  // one — not as an afterthought bolted onto existing expectations.
  const withChol = (cholesterolMg: number): MacroSet => macros({ cholesterolMg })

  it('is one of the keys the engine iterates', () => {
    expect(MACRO_KEYS).toContain('cholesterolMg')
    expect(ZERO_MACROS.cholesterolMg).toBe(0)
  })

  it('scales with everything else', () => {
    expect(multiplyMacros(withChol(70), 2).cholesterolMg).toBe(140)
    expect(scaleMacros(withChol(85), 200).cholesterolMg).toBe(170)
    expect(fractionOfMacros(withChol(80), 0.25).cholesterolMg).toBe(20)
  })

  it('adds and subtracts', () => {
    expect(addMacros(withChol(30), withChol(45)).cholesterolMg).toBe(75)
    expect(subtractMacros(withChol(45), withChol(30)).cholesterolMg).toBe(15)
    expect(sumMacros([withChol(10), withChol(20), withChol(30)]).cholesterolMg).toBe(60)
  })

  it('counts towards a total across lines', () => {
    const total = macrosForLines([
      { grams: 200, macrosPer100g: withChol(85) },
      { grams: 50, macrosPer100g: withChol(20) },
    ])
    expect(total.cholesterolMg).toBe(180)
  })

  it('rounds to whole milligrams, like sodium', () => {
    expect(roundMacros(withChol(84.6)).cholesterolMg).toBe(85)
    expect(roundMacros(withChol(0.4)).cholesterolMg).toBe(0)
  })

  it('does not make a zero set look non-empty', () => {
    expect(isZeroMacros(ZERO_MACROS)).toBe(true)
    expect(isZeroMacros(multiplyMacros(ZERO_MACROS, 5))).toBe(true)
    expect(isZeroMacros({ ...ZERO_MACROS, cholesterolMg: 3 })).toBe(false)
  })
})
