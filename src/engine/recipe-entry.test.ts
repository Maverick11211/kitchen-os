import { describe, it, expect } from 'vitest'
import type { CanonicalIngredient, Recipe } from '../types/schema'
import {
  OTHER_CUISINE,
  createUserRecipe,
  draftLinesFromParse,
  emptyRecipeDraft,
  generateRecipeId,
  matchIngredient,
  parseIngredientLines,
  recipeDraftFrom,
  validateRecipeDraft,
} from './recipe-entry'

const NOW = '2026-08-21T12:00:00.000Z'

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

const ontology: CanonicalIngredient[] = [
  ingredient({ id: 'chicken-thighs', name: 'Chicken thighs', aliases: ['chicken thigh'] }),
  ingredient({ id: 'rice-jasmine', name: 'Jasmine rice', cupWeightG: 185, aliases: ['jasmine rice'] }),
  ingredient({ id: 'egg-large', name: 'Large egg', trackBy: 'count', unitWeightG: 50, aliases: ['egg', 'eggs'] }),
  ingredient({ id: 'soy-sauce', name: 'Soy sauce', trackBy: 'volume', densityGPerMl: 1.2, aliases: ['soy sauce'] }),
  ingredient({ id: 'cilantro', name: 'Cilantro', aliases: ['coriander leaves'] }),
  // No conversion data at all: a count of these cannot become grams.
  ingredient({ id: 'mystery', name: 'Mystery item', trackBy: 'count' }),
]

const draftWith = (over: Partial<ReturnType<typeof emptyRecipeDraft>>) => ({
  ...emptyRecipeDraft(),
  name: 'Test dish',
  cuisine: 'Chinese',
  ...over,
})

const line = (over: Partial<ReturnType<typeof emptyRecipeDraft>['lines'][number]> = {}) => ({
  canonicalId: 'rice-jasmine' as const,
  quantity: '100',
  unit: 'g' as const,
  optional: false,
  preparation: '',
  raw: '',
  ...over,
})

// ---------------------------------------------------------------------------

describe('parseIngredientLines — amounts', () => {
  const parse = (text: string) => parseIngredientLines(text, ontology)

  it('reads a plain number and unit', () => {
    const [row] = parse('400 g jasmine rice')
    expect([row.quantity, row.unit]).toEqual([400, 'g'])
  })

  it('reads a unit written out in full, and its plural', () => {
    expect(parse('2 tablespoons soy sauce')[0].unit).toBe('tbsp')
    expect(parse('3 ounces jasmine rice')[0].unit).toBe('oz')
    expect(parse('2 litres soy sauce')[0].unit).toBe('l')
  })

  it('reads fractions, however they are written', () => {
    expect(parse('1/2 cup jasmine rice')[0].quantity).toBe(0.5)
    expect(parse('½ cup jasmine rice')[0].quantity).toBe(0.5)
    expect(parse('1 1/2 cups jasmine rice')[0].quantity).toBe(1.5)
    expect(parse('1½ cups jasmine rice')[0].quantity).toBe(1.5)
  })

  it('takes the top of a range', () => {
    // "2-3 cloves" means three to be sure. A recipe you thought you could cook
    // is the failure worth avoiding.
    expect(parse('2-3 large eggs')[0].quantity).toBe(3)
  })

  it('treats a bare number as a count, which is the commonest line in any recipe', () => {
    const [row] = parse('3 large eggs')
    expect([row.quantity, row.unit]).toEqual([3, 'count'])
  })

  it('leaves an amount-less line for the User rather than inventing one', () => {
    const [row] = parse('soy sauce to taste')
    expect(row.quantity).toBeNull()
    expect(row.unit).toBeNull()
  })
})

describe('parseIngredientLines — the rest of the line', () => {
  const parse = (text: string) => parseIngredientLines(text, ontology)

  it('splits the preparation off after a comma', () => {
    const [row] = parse('2 lb chicken thighs, cut into chunks')
    expect(row.name).toBe('chicken thighs')
    expect(row.preparation).toBe('cut into chunks')
  })

  it('takes a bracketed note as preparation too', () => {
    const [row] = parse('1 large egg (whisked)')
    expect(row.name).toBe('large egg')
    expect(row.preparation).toBe('whisked')
  })

  it('drops section headings and blank lines', () => {
    const rows = parse('For the marinade:\n\n400 g jasmine rice\n\nFor the sauce:')
    expect(rows.map((row) => row.name)).toEqual(['jasmine rice'])
  })

  it('drops list bullets', () => {
    expect(parse('- 400 g jasmine rice')[0].quantity).toBe(400)
  })

  it('keeps the raw line, so a row that failed can show what it was', () => {
    expect(parse('  a handful of something  ')[0].raw).toBe('a handful of something')
  })
})

describe('matchIngredient', () => {
  it('matches an exact name and an exact alias', () => {
    expect(matchIngredient('Jasmine rice', ontology)).toBe('rice-jasmine')
    expect(matchIngredient('coriander leaves', ontology)).toBe('cilantro')
  })

  it('sees through the words that describe rather than name', () => {
    expect(matchIngredient('freshly chopped cilantro', ontology)).toBe('cilantro')
    expect(matchIngredient('boneless skinless chicken thighs', ontology)).toBe('chicken-thighs')
  })

  it('handles plurals', () => {
    expect(matchIngredient('eggs', ontology)).toBe('egg-large')
  })

  it('prefers the longest thing it recognises inside the line', () => {
    expect(matchIngredient('good quality jasmine rice', ontology)).toBe('rice-jasmine')
  })

  it('gives up rather than guessing', () => {
    // A wrong match is silently wrong in the ownership figures for as long as
    // the recipe exists. A blank is visibly blank.
    expect(matchIngredient('sumac', ontology)).toBeNull()
    expect(matchIngredient('', ontology)).toBeNull()
  })
})

describe('draftLinesFromParse', () => {
  it('carries an unmatched line through with its text, ready to be fixed', () => {
    const [row] = draftLinesFromParse(parseIngredientLines('a handful of sumac', ontology))
    expect(row.canonicalId).toBe('')
    expect(row.raw).toBe('a handful of sumac')
  })

  it('fills what it did work out', () => {
    const [row] = draftLinesFromParse(parseIngredientLines('1½ cups jasmine rice', ontology))
    expect(row).toMatchObject({ canonicalId: 'rice-jasmine', quantity: '1.5', unit: 'cup' })
  })
})

describe('validateRecipeDraft', () => {
  it('accepts a plain, complete draft', () => {
    const result = validateRecipeDraft(draftWith({ lines: [line()], steps: 'Cook it.' }), ontology)
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('wants a name and a cuisine', () => {
    const result = validateRecipeDraft(draftWith({ name: '', cuisine: '', lines: [line()] }), ontology)
    expect(result.errors.map((issue) => issue.field)).toEqual(['name', 'cuisine'])
  })

  it('accepts Other as a cuisine', () => {
    const result = validateRecipeDraft(
      draftWith({ cuisine: OTHER_CUISINE, lines: [line()], steps: 'Cook it.' }),
      ontology,
    )
    expect(result.ok).toBe(true)
  })

  it('wants at least one ingredient', () => {
    const result = validateRecipeDraft(draftWith({ lines: [] }), ontology)
    expect(result.errors.map((issue) => issue.field)).toContain('lines')
  })

  it('points at the row whose ingredient was never chosen, quoting what was pasted', () => {
    const result = validateRecipeDraft(
      draftWith({ lines: [line(), line({ canonicalId: '', raw: 'a handful of sumac' })] }),
      ontology,
    )
    const issue = result.errors.find((error) => error.line === 1)
    expect(issue?.message).toContain('a handful of sumac')
  })

  it('asks how much, naming the ingredient', () => {
    const result = validateRecipeDraft(draftWith({ lines: [line({ quantity: '' })] }), ontology)
    expect(result.errors[0].message).toBe('How much jasmine rice?')
    expect(result.errors[0].line).toBe(0)
  })

  it('rejects a quantity that is not a positive number', () => {
    expect(validateRecipeDraft(draftWith({ lines: [line({ quantity: '0' })] }), ontology).ok).toBe(false)
    expect(validateRecipeDraft(draftWith({ lines: [line({ quantity: 'lots' })] }), ontology).ok).toBe(false)
  })

  it('rejects a unit that cannot be converted for that ingredient', () => {
    // `quantityG` is computed once at save time, so a line that could not
    // convert would rank as though the recipe did not need it.
    const result = validateRecipeDraft(
      draftWith({ lines: [line({ canonicalId: 'mystery', unit: 'count', quantity: '2' })] }),
      ontology,
    )
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('Mystery item')
  })

  it('ignores a row that is entirely blank', () => {
    const result = validateRecipeDraft(
      draftWith({ lines: [line(), { canonicalId: '', quantity: '', unit: 'g', optional: false, preparation: '', raw: '' }] }),
      ontology,
    )
    expect(result.ok).toBe(true)
  })

  it('warns about a missing method without blocking it', () => {
    // A recipe you know by heart is a real recipe (Jack, 2026-08-21).
    const result = validateRecipeDraft(draftWith({ lines: [line()], steps: '' }), ontology)
    expect(result.ok).toBe(true)
    expect(result.warnings.map((issue) => issue.field)).toEqual(['steps'])
  })

  it('rejects a finished weight that is not a number, but not a blank one', () => {
    expect(validateRecipeDraft(draftWith({ lines: [line()], yieldG: 'big' }), ontology).ok).toBe(false)
    expect(validateRecipeDraft(draftWith({ lines: [line()], yieldG: '' }), ontology).ok).toBe(true)
  })
})

describe('generateRecipeId', () => {
  it('is a readable slug', () => {
    expect(generateRecipeId('Egg Fried Rice', new Set())).toBe('egg-fried-rice')
  })

  it('follows the same rules as an ingredient id, apostrophes included', () => {
    // Shared with `slugifyIngredientId` on purpose: an id turns up in the
    // address bar and in backup files, and two sets of rules for what a
    // readable id looks like would drift apart.
    expect(generateRecipeId("Nan's Beef Stew", new Set())).toBe('nan-s-beef-stew')
  })

  it('avoids an id already taken, including a bundled one', () => {
    expect(generateRecipeId('Padron Peppers', new Set(['padron-peppers']))).toBe('padron-peppers-2')
  })

  it('is empty when the name has nothing sluggable in it', () => {
    expect(generateRecipeId('!!!', new Set())).toBe('')
  })
})

describe('createUserRecipe', () => {
  const good = draftWith({
    name: 'Egg fried rice',
    cuisine: 'Chinese',
    lines: [
      line({ canonicalId: 'rice-jasmine', quantity: '2', unit: 'cup' }),
      line({ canonicalId: 'egg-large', quantity: '3', unit: 'count', preparation: 'whisked' }),
      line({ canonicalId: 'cilantro', quantity: '10', unit: 'g', optional: true }),
    ],
    steps: 'Fry the rice.\nAdd the eggs.',
    tools: 'wok, spatula',
    yieldG: '900',
    note: 'From memory.',
  })

  it('refuses a draft that does not validate', () => {
    const result = createUserRecipe(draftWith({ name: '' }), ontology, new Set(), NOW)
    expect(result.ok).toBe(false)
  })

  it('computes quantityG once, the way the seed importer did', () => {
    const result = createUserRecipe(good, ontology, new Set(), NOW)
    if (!result.ok) throw new Error('expected a recipe')
    // 2 cups of rice at 185 g a cup; 3 eggs at 50 g each.
    expect(result.recipe.ingredients[0].quantityG).toBe(370)
    expect(result.recipe.ingredients[1].quantityG).toBe(150)
  })

  it('keeps what was typed as well as the grams', () => {
    const result = createUserRecipe(good, ontology, new Set(), NOW)
    if (!result.ok) throw new Error('expected a recipe')
    expect(result.recipe.ingredients[0]).toMatchObject({ quantity: 2, unit: 'cup' })
    expect(result.recipe.ingredients[1].preparation).toBe('whisked')
    expect(result.recipe.ingredients[2].optional).toBe(true)
  })

  it('marks it as the User’s, never as seed', () => {
    const result = createUserRecipe(good, ontology, new Set(), NOW)
    if (!result.ok) throw new Error('expected a recipe')
    expect(result.recipe.isSeed).toBe(false)
    expect(result.recipe.createdAt).toBe(NOW)
  })

  it('numbers the steps and splits the tools', () => {
    const result = createUserRecipe(good, ontology, new Set(), NOW)
    if (!result.ok) throw new Error('expected a recipe')
    expect(result.recipe.steps).toEqual([
      { order: 1, text: 'Fry the rice.' },
      { order: 2, text: 'Add the eggs.' },
    ])
    expect(result.recipe.tools).toEqual(['wok', 'spatula'])
  })

  it('leaves out what was not given rather than storing a blank', () => {
    const bare = draftWith({ lines: [line()], steps: '', tools: '', yieldG: '', note: '' })
    const result = createUserRecipe(bare, ontology, new Set(), NOW)
    if (!result.ok) throw new Error('expected a recipe')
    expect('estimatedYieldG' in result.recipe).toBe(false)
    expect('note' in result.recipe).toBe(false)
    expect(result.recipe.steps).toEqual([])
    expect(result.warnings.length).toBe(1)
  })

  it('keeps the id when a recipe is edited, so its address survives', () => {
    const result = createUserRecipe(good, ontology, new Set(['egg-fried-rice']), NOW, 'egg-fried-rice')
    if (!result.ok) throw new Error('expected a recipe')
    expect(result.recipe.id).toBe('egg-fried-rice')
  })
})

describe('recipeDraftFrom', () => {
  it('loads a saved recipe back into the form unchanged', () => {
    const original = draftWith({
      name: 'Egg fried rice',
      lines: [line({ canonicalId: 'rice-jasmine', quantity: '2', unit: 'cup', preparation: 'day old' })],
      steps: 'Fry it.',
      tools: 'wok',
      yieldG: '900',
    })
    const built = createUserRecipe(original, ontology, new Set(), NOW)
    if (!built.ok) throw new Error('expected a recipe')

    const reloaded = recipeDraftFrom(built.recipe)
    expect(reloaded.name).toBe('Egg fried rice')
    expect(reloaded.cuisine).toBe('Chinese')
    expect(reloaded.steps).toBe('Fry it.')
    expect(reloaded.tools).toBe('wok')
    expect(reloaded.yieldG).toBe('900')
    expect(reloaded.lines[0]).toMatchObject({
      canonicalId: 'rice-jasmine',
      quantity: '2',
      unit: 'cup',
      preparation: 'day old',
    })
  })

  it('survives a round trip without changing the recipe', () => {
    const built = createUserRecipe(
      draftWith({ lines: [line()], steps: 'Cook it.' }),
      ontology,
      new Set(),
      NOW,
    )
    if (!built.ok) throw new Error('expected a recipe')

    const again = createUserRecipe(
      recipeDraftFrom(built.recipe),
      ontology,
      new Set(),
      NOW,
      built.recipe.id,
    )
    if (!again.ok) throw new Error('expected a recipe')
    expect(again.recipe).toEqual<Recipe>(built.recipe)
  })
})
