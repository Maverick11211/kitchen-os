import { describe, it, expect } from 'vitest'
import type { Appliance, ApplianceId, Recipe } from '../types/schema'
import {
  KIT_CATALOGUE,
  equipmentNeeds,
  findKitItem,
  kitProblems,
  kitQuestions,
  parseStatedSize,
  sizeUnitLabel,
} from './equipment'

function recipe(overrides: Partial<Recipe> & { id: string }): Recipe {
  return {
    name: overrides.id,
    cuisines: ['Test'],
    ingredients: [],
    requiredAppliances: [],
    tools: [],
    steps: [{ order: 1, text: 'Cook it.' }],
    isSeed: true,
    createdAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  }
}

const kit = (rows: readonly Appliance[]): ReadonlyMap<ApplianceId, Appliance> =>
  new Map(rows.map((row) => [row.id, row]))

const has = (id: ApplianceId, size?: number): Appliance => ({
  id,
  name: findKitItem(id)?.name ?? id,
  owned: true,
  ...(size === undefined ? {} : { size }),
})

const hasNot = (id: ApplianceId): Appliance => ({
  id,
  name: findKitItem(id)?.name ?? id,
  owned: false,
})

// ---------------------------------------------------------------------------

describe('the catalogue', () => {
  it('has no duplicate ids', () => {
    const ids = KIT_CATALOGUE.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the four appliance ids that are already in the database', () => {
    // Rows written before the kit list existed must stay valid.
    for (const id of ['stovetop', 'oven', 'grill-bbq', 'grill-broiler']) {
      expect(findKitItem(id), id).toBeDefined()
    }
  })

  it('only measures things where size is a real question', () => {
    expect(findKitItem('pot')?.sizeUnit).toBe('qt')
    expect(findKitItem('frying-pan')?.sizeUnit).toBe('in')
    // Nobody owns a blender that is too small in a way this app could check.
    expect(findKitItem('blender')?.sizeUnit).toBeUndefined()
    expect(findKitItem('colander')?.sizeUnit).toBeUndefined()
  })

  it('names its units in words a person would type next to', () => {
    expect(sizeUnitLabel('qt')).toBe('quarts')
    expect(sizeUnitLabel('in')).toBe('inches')
  })
})

describe('parseStatedSize', () => {
  it('reads quarts', () => {
    expect(parseStatedSize('6 qt pot', 'qt')).toBe(6)
    expect(parseStatedSize('large 5-quart saucepan', 'qt')).toBe(5)
  })

  it('converts litres, without rounding them down', () => {
    // A litre is 1.057 quarts. Rounding to 1 would make his pot look smaller.
    expect(parseStatedSize('1.5-litre gratin dish', 'qt')).toBeCloseTo(1.5855, 3)
  })

  it('reads inches, however they are written', () => {
    expect(parseStatedSize('12-inch skillet', 'in')).toBe(12)
    expect(parseStatedSize('9 inch pie plate', 'in')).toBe(9)
    expect(parseStatedSize('8-inch square baking dish', 'in')).toBe(8)
  })

  it('converts centimetres', () => {
    expect(parseStatedSize('20cm non-stick frying pan', 'in')).toBeCloseTo(7.874, 2)
  })

  it('takes the longest side of a multi-dimension size', () => {
    // The question is whether the food fits, so 10x14x2 is a 14 inch pan.
    expect(parseStatedSize('10x14x2-inch baking pan', 'in')).toBe(14)
    expect(parseStatedSize('30x25 cm tin', 'in')).toBeCloseTo(11.81, 2)
  })

  it('will not compare a volume with a length', () => {
    // A gratin dish is measured across here, so a litre figure is dropped
    // rather than converted through an invented depth.
    expect(parseStatedSize('1.5-litre gratin dish', 'in')).toBeNull()
    expect(parseStatedSize('12-inch skillet', 'qt')).toBeNull()
  })

  it('finds nothing where nothing is stated', () => {
    expect(parseStatedSize('large pot', 'qt')).toBeNull()
    expect(parseStatedSize('wok', 'in')).toBeNull()
  })
})

describe('equipmentNeeds', () => {
  it('reads the structured appliances', () => {
    const dish = recipe({ id: 'a', requiredAppliances: ['oven'] })
    expect(equipmentNeeds(dish).map((need) => need.anyOf)).toEqual([['oven']])
  })

  it('reads the free-text tools', () => {
    const dish = recipe({ id: 'a', tools: ['wok', 'colander'] })
    expect(equipmentNeeds(dish).map((need) => need.anyOf)).toEqual([['wok'], ['colander']])
  })

  it('matches the longest name, so a dutch oven is not an oven', () => {
    const dish = recipe({ id: 'a', tools: ['dutch oven'] })
    expect(equipmentNeeds(dish)[0].anyOf).toEqual(['dutch-oven'])
  })

  it('matches a non-stick pan ahead of a plain frying pan', () => {
    const dish = recipe({ id: 'a', tools: ['non-stick frying pan'] })
    expect(equipmentNeeds(dish)[0].anyOf).toEqual(['non-stick-pan'])
  })

  it('treats "or" as a choice, satisfied by either', () => {
    const dish = recipe({ id: 'a', tools: ['wok or large frying pan'] })
    expect(equipmentNeeds(dish)[0].anyOf).toEqual(['wok', 'frying-pan'])
  })

  it('does not split a description that merely contains a lid', () => {
    const dish = recipe({ id: 'a', tools: ['large pan with lid'] })
    expect(equipmentNeeds(dish)[0].anyOf).toEqual(['frying-pan'])
  })

  it('says nothing about a tool it does not recognise', () => {
    // The parser failing is not the same as him lacking equipment, and a
    // warning invented out of "two forks" teaches him to ignore warnings.
    const dish = recipe({ id: 'a', tools: ['two forks', 'kitchen string'] })
    expect(equipmentNeeds(dish)).toEqual([])
  })

  it('picks up a stated size from the tool text', () => {
    const dish = recipe({ id: 'a', tools: ['6 qt pot'] })
    expect(equipmentNeeds(dish)[0].statedSize).toBe(6)
  })
})

describe('kitProblems — missing', () => {
  const wokDish = recipe({ id: 'a', tools: ['wok'] })

  it('says nothing when he has never been asked', () => {
    expect(kitProblems(equipmentNeeds(wokDish), kit([]))).toEqual([])
  })

  it('says nothing when he owns it', () => {
    expect(kitProblems(equipmentNeeds(wokDish), kit([has('wok')]))).toEqual([])
  })

  it('warns once he has said he has not got one', () => {
    const problems = kitProblems(equipmentNeeds(wokDish), kit([hasNot('wok')]))
    expect(problems.map((problem) => problem.kind)).toEqual(['missing'])
    expect(problems[0].message).toBe('You have no wok')
  })

  it('is satisfied by either half of a choice', () => {
    const either = recipe({ id: 'a', tools: ['wok or large frying pan'] })
    expect(kitProblems(equipmentNeeds(either), kit([hasNot('wok'), has('frying-pan')]))).toEqual([])
  })

  it('stays quiet when one half of a choice has never been asked about', () => {
    // Unknown is not a problem. He may well have a frying pan.
    const either = recipe({ id: 'a', tools: ['wok or large frying pan'] })
    expect(kitProblems(equipmentNeeds(either), kit([hasNot('wok')]))).toEqual([])
  })

  it('warns only when he has said no to every alternative', () => {
    const either = recipe({ id: 'a', tools: ['wok or large frying pan'] })
    const problems = kitProblems(
      equipmentNeeds(either),
      kit([hasNot('wok'), hasNot('frying-pan')]),
    )
    expect(problems[0].message).toBe('You have no wok or frying pan / skillet')
  })
})

describe('kitProblems — too small', () => {
  const bigPot = recipe({ id: 'a', tools: ['6 qt pot'] })

  it('warns when his biggest is smaller than the recipe asks for', () => {
    const problems = kitProblems(equipmentNeeds(bigPot), kit([has('pot', 3)]))
    expect(problems.map((problem) => problem.kind)).toEqual(['too-small'])
    expect(problems[0].message).toBe('Your biggest pot is 3 qt; this needs 6')
  })

  it('says nothing when his is big enough', () => {
    expect(kitProblems(equipmentNeeds(bigPot), kit([has('pot', 8)]))).toEqual([])
  })

  it('says nothing when he has not recorded a size', () => {
    // He owns a pot. How big it is, this app has not been told, and it does
    // not answer that question on his behalf.
    expect(kitProblems(equipmentNeeds(bigPot), kit([has('pot')]))).toEqual([])
  })

  it('allows a little slack, because pans are not machined parts', () => {
    // 20 cm converts to 7.874 inches; a 12 inch pan against a 12 inch recipe
    // must not warn on a rounding difference either.
    const pan = recipe({ id: 'a', tools: ['20cm non-stick frying pan'] })
    expect(kitProblems(equipmentNeeds(pan), kit([has('non-stick-pan', 8)]))).toEqual([])
  })

  it('reports the missing kit rather than its size when he has not got one', () => {
    const problems = kitProblems(equipmentNeeds(bigPot), kit([hasNot('pot')]))
    expect(problems.map((problem) => problem.kind)).toEqual(['missing'])
  })
})

describe('kitQuestions', () => {
  const library = [
    recipe({ id: 'a', requiredAppliances: ['stovetop'], tools: ['wok'] }),
    recipe({ id: 'b', requiredAppliances: ['stovetop'], tools: ['large pot'] }),
    recipe({ id: 'c', tools: ['wok', 'colander'] }),
  ]

  it('asks about what the library needs, most needed first', () => {
    expect(kitQuestions(library).map((question) => [question.item.id, question.recipeCount])).toEqual(
      [
        ['stovetop', 2],
        ['wok', 2],
        ['colander', 1],
        ['pot', 1],
      ],
    )
  })

  it('counts a recipe once however many times it names the same thing', () => {
    const twice = [recipe({ id: 'a', tools: ['wok', 'large wok'] })]
    expect(kitQuestions(twice)[0].recipeCount).toBe(1)
  })

  it('asks about both halves of a choice, since either would do', () => {
    const either = [recipe({ id: 'a', tools: ['wok or large frying pan'] })]
    expect(kitQuestions(either).map((question) => question.item.id).sort()).toEqual([
      'frying-pan',
      'wok',
    ])
  })

  it('asks nothing about a library that needs nothing', () => {
    expect(kitQuestions([recipe({ id: 'a' })])).toEqual([])
  })
})
