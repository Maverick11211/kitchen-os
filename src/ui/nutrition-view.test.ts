import { describe, it, expect } from 'vitest'
import type { ConsumptionEvent, MacroSet } from '../types/schema'
import {
  canPageBack,
  canPageForward,
  dayEntries,
  emptyDayNote,
  headlineFigures,
  nextDay,
  previousDay,
  relativeDayName,
} from './nutrition-view'

const TODAY = '2026-08-20'

function macros(overrides: Partial<MacroSet> = {}): MacroSet {
  return {
    calories: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    fiberG: 0,
    sugarG: 0,
    sodiumMg: 0,
    saturatedFatG: 0,
    cholesterolMg: 0,
    ...overrides,
  }
}

function ate(id: string, grams: number, figures: Partial<MacroSet>): ConsumptionEvent {
  return {
    id,
    consumedAt: `${TODAY}T18:00:00.000Z`,
    source: { type: 'ingredient', canonicalId: 'cheddar-shredded', grams },
    macros: macros(figures),
    label: 'Cheddar',
  }
}

describe('headlineFigures', () => {
  it('gives the four DECISIONS.md names, in that order', () => {
    expect(headlineFigures([]).map((figure) => figure.label)).toEqual([
      'Calories',
      'Carbs',
      'Fat',
      'Protein',
    ])
  })

  it('adds the day up', () => {
    const day = [
      ate('a', 50, { calories: 201, carbsG: 0.7, fatG: 16.5, proteinG: 12.5 }),
      ate('b', 30, { calories: 120, carbsG: 15, fatG: 4, proteinG: 3 }),
    ]

    expect(headlineFigures(day).map((figure) => figure.value)).toEqual([321, 15.7, 20.5, 15.5])
  })

  it('rounds for display, because nobody has that precision', () => {
    const day = [ate('a', 33, { calories: 132.666, proteinG: 8.2531 })]
    const [calories, , , protein] = headlineFigures(day)

    expect(calories?.value).toBe(133)
    expect(protein?.value).toBe(8.3)
  })

  it('shows an empty day as four zeroes rather than nothing', () => {
    expect(headlineFigures([]).map((figure) => figure.value)).toEqual([0, 0, 0, 0])
  })

  it('reads the stored snapshot and never a product', () => {
    // The whole immutability rule in one assertion: whatever is on the event is
    // what the day shows, even if it disagrees with any product on record.
    const odd = ate('a', 50, { calories: 9999 })
    expect(headlineFigures([odd])[0]?.value).toBe(9999)
  })
})

describe('dayEntries', () => {
  it('says how much was eaten', () => {
    const rows = dayEntries([ate('a', 50, { calories: 201 })])
    expect(rows[0]?.detail).toBe('50 g')
    expect(rows[0]?.calories).toBe(201)
  })

  it('describes a cooked portion as a share of the batch', () => {
    const fromCooking: ConsumptionEvent = {
      id: 'b',
      consumedAt: `${TODAY}T18:00:00.000Z`,
      source: { type: 'cook', cookEventId: 'cook_1', fraction: 0.4 },
      macros: macros({ calories: 500 }),
      label: 'Chicken Tikka Masala',
    }

    expect(dayEntries([fromCooking])[0]?.detail).toBe('40% of the batch')
  })

  it('offers Delete only on entries logged directly', () => {
    const fromCooking: ConsumptionEvent = {
      id: 'b',
      consumedAt: `${TODAY}T18:00:00.000Z`,
      source: { type: 'cook', cookEventId: 'cook_1', fraction: 0.4 },
      macros: macros(),
      label: 'Chicken Tikka Masala',
    }

    // deleteConsumption refuses a cook source, so the button must not be there.
    expect(dayEntries([ate('a', 50, {})])[0]?.canDelete).toBe(true)
    expect(dayEntries([fromCooking])[0]?.canDelete).toBe(false)
  })

  it('keeps the order it was given', () => {
    const rows = dayEntries([ate('a', 10, {}), ate('b', 20, {})])
    expect(rows.map((row) => row.event.id)).toEqual(['a', 'b'])
  })
})

describe('moving between days', () => {
  it('steps a day at a time', () => {
    expect(previousDay('2026-08-01')).toBe('2026-07-31')
    expect(nextDay('2026-08-31')).toBe('2026-09-01')
  })

  it('will not page into the future', () => {
    expect(canPageForward('2026-08-19', TODAY)).toBe(true)
    expect(canPageForward(TODAY, TODAY)).toBe(false)
  })

  it('stops where the history stops', () => {
    expect(canPageBack(TODAY, '2026-08-12')).toBe(true)
    expect(canPageBack('2026-08-12', '2026-08-12')).toBe(false)
  })

  it('has nowhere to go back to before anything was logged', () => {
    expect(canPageBack(TODAY, undefined)).toBe(false)
  })

  it('names the two days worth naming and leaves the rest to the caller', () => {
    expect(relativeDayName(TODAY, TODAY)).toBe('Today')
    expect(relativeDayName('2026-08-19', TODAY)).toBe('Yesterday')
    expect(relativeDayName('2026-08-12', TODAY)).toBeNull()
  })
})

describe('emptyDayNote', () => {
  it('reads as unfinished today and finished on a past day', () => {
    expect(emptyDayNote(TODAY, TODAY)).toBe('Nothing logged yet today.')
    expect(emptyDayNote('2026-08-12', TODAY)).toBe('Nothing was logged this day.')
  })
})
