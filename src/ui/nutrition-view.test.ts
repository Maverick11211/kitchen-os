import { describe, it, expect } from 'vitest'
import type { ConsumptionEvent, MacroSet, MealSlot } from '../types/schema'
import {
  canPageBack,
  canPageForward,
  dayEntries,
  emptyDayNote,
  headlineFigures,
  mealGroups,
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

  /*
   * Until Phase 7 this asserted the opposite for a cook source, because
   * `deleteConsumption` refused one. It no longer refuses — the portion goes
   * back onto the batch and the batch becomes eatable again — so the button
   * belongs there. A meal logged by mistake is as much a mistake as an
   * ingredient logged by mistake.
   */
  it('offers Delete on anything but a leftover', () => {
    const fromCooking: ConsumptionEvent = {
      id: 'b',
      consumedAt: `${TODAY}T18:00:00.000Z`,
      source: { type: 'cook', cookEventId: 'cook_1', fraction: 0.4 },
      macros: macros(),
      label: 'Chicken Tikka Masala',
    }
    const fromLeftover: ConsumptionEvent = {
      id: 'c',
      consumedAt: `${TODAY}T18:00:00.000Z`,
      source: { type: 'leftover', leftoverId: 'left_1', fraction: 0.4 },
      macros: macros(),
      label: 'Yesterday’s stew',
    }

    expect(dayEntries([ate('a', 50, {})])[0]?.canDelete).toBe(true)
    expect(dayEntries([fromCooking])[0]?.canDelete).toBe(true)
    // Leftovers are a v2 feature nothing writes, and the repository still
    // refuses one — so the button must not be there.
    expect(dayEntries([fromLeftover])[0]?.canDelete).toBe(false)
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

// ---------------------------------------------------------------------------
// Meals
// ---------------------------------------------------------------------------

describe('mealGroups', () => {
  const ZERO = macros()
  const at = (hour: number, meal?: MealSlot, calories = 100): ConsumptionEvent => ({
    id: `cons_${hour}_${meal ?? 'none'}`,
    consumedAt: `2026-08-21T${String(hour).padStart(2, '0')}:00:00.000Z`,
    source: { type: 'ingredient', canonicalId: 'oats-rolled', grams: 50 },
    macros: { ...ZERO, calories },
    label: 'Porridge',
    ...(meal === undefined ? {} : { meal }),
  })

  it('puts the meals in the order they are eaten, snacks last', () => {
    const groups = mealGroups([at(20, 'dinner'), at(8, 'breakfast'), at(15, 'snack'), at(12, 'lunch')])
    expect(groups.map((group) => group.meal)).toEqual(['breakfast', 'lunch', 'dinner', 'snack'])
  })

  it('leaves out a meal that did not happen', () => {
    const groups = mealGroups([at(12, 'lunch')])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.heading).toBe('Lunch')
  })

  it('subtotals each section', () => {
    const groups = mealGroups([at(12, 'lunch', 300), at(13, 'lunch', 250), at(20, 'dinner', 600)])
    expect(groups.map((group) => group.calories)).toEqual([550, 600])
  })

  /*
   * The reason `meal` is optional. Every entry logged before meals existed has
   * none, and filing those under a guessed meal would put invented data in the
   * one table DECISIONS.md promises never to rewrite.
   */
  it('gathers unlabelled entries under their own heading, at the end', () => {
    const groups = mealGroups([at(9), at(8, 'breakfast')])
    expect(groups.map((group) => group.heading)).toEqual(['Breakfast', 'Other'])
    expect(groups[1]?.meal).toBeNull()
  })

  it('counts unlabelled entries towards the day, not away from it', () => {
    const events = [at(9, undefined, 400), at(8, 'breakfast', 300)]
    const day = headlineFigures(events).find((figure) => figure.key === 'calories')
    const sections = mealGroups(events).reduce((total, group) => total + group.calories, 0)

    expect(day?.value).toBe(700)
    expect(sections).toBe(700)
  })

  it('has nothing to show for a day with nothing in it', () => {
    expect(mealGroups([])).toEqual([])
  })
})
