import { describe, it, expect } from 'vitest'
import type { CanonicalIngredient } from '../types/schema'
import {
  INGREDIENT_CATEGORIES,
  TRACK_BY_MODES,
  type CanonicalIngredientDraft,
  createUserIngredient,
  generateIngredientId,
  isUserAdded,
  normaliseAliases,
  slugifyIngredientId,
  validateIngredientDraft,
} from './ingredients'
import { toGrams } from './units'

function existing(overrides: Partial<CanonicalIngredient> & { id: string }): CanonicalIngredient {
  return {
    name: overrides.id,
    category: 'other',
    trackBy: 'mass',
    tracked: true,
    perishable: false,
    isSeed: true,
    aliases: [],
    ...overrides,
  }
}

/** A draft that passes cleanly, for tests that vary one field at a time. */
function draft(overrides: Partial<CanonicalIngredientDraft> = {}): CanonicalIngredientDraft {
  return {
    name: 'Smoked paprika',
    category: 'spice',
    trackBy: 'mass',
    tracked: true,
    perishable: false,
    cupWeightG: 110,
    ...overrides,
  }
}

const ONTOLOGY: CanonicalIngredient[] = [
  existing({ id: 'butter', name: 'Butter', aliases: ['butter', 'unsalted butter'] }),
  existing({ id: 'chilli', name: 'Chilli', aliases: ['chilli', 'chili'] }),
]

// ---------------------------------------------------------------------------

describe('slugifyIngredientId', () => {
  it('matches the style of the seed ontology', () => {
    expect(slugifyIngredientId('Shredded cheddar')).toBe('shredded-cheddar')
    expect(slugifyIngredientId('Chicken breast, boneless skinless')).toBe(
      'chicken-breast-boneless-skinless',
    )
  })

  it('strips accents rather than dropping the letter', () => {
    expect(slugifyIngredientId('Gruyère')).toBe('gruyere')
    expect(slugifyIngredientId('Jalapeño')).toBe('jalapeno')
    expect(slugifyIngredientId('Crème fraîche')).toBe('creme-fraiche')
  })

  it('collapses punctuation and whitespace into single hyphens', () => {
    expect(slugifyIngredientId('  Sun-dried   tomatoes!! ')).toBe('sun-dried-tomatoes')
    expect(slugifyIngredientId('85/15 ground beef')).toBe('85-15-ground-beef')
  })

  it('returns an empty string when there is nothing usable', () => {
    expect(slugifyIngredientId('   ')).toBe('')
    expect(slugifyIngredientId('!!!')).toBe('')
  })
})

describe('generateIngredientId', () => {
  it('uses the plain slug when it is free', () => {
    expect(generateIngredientId('Smoked paprika', new Set())).toBe('smoked-paprika')
  })

  it('suffixes on collision instead of reusing an id', () => {
    // Ids are foreign keys for every Product — a silent collision would
    // repoint real inventory at the wrong ingredient.
    expect(generateIngredientId('Chilli', new Set(['chilli']))).toBe('chilli-2')
    expect(generateIngredientId('Chilli', new Set(['chilli', 'chilli-2']))).toBe('chilli-3')
  })

  it('keeps counting past a gap', () => {
    expect(generateIngredientId('Chilli', new Set(['chilli', 'chilli-2', 'chilli-3']))).toBe('chilli-4')
  })

  it('returns empty for an unusable name', () => {
    expect(generateIngredientId('!!!', new Set())).toBe('')
  })
})

describe('normaliseAliases', () => {
  it('trims, lowercases and de-duplicates', () => {
    expect(normaliseAliases([' Paprika ', 'PAPRIKA', 'smoked paprika'])).toEqual([
      'paprika',
      'smoked paprika',
    ])
  })

  it('drops blanks and handles undefined', () => {
    expect(normaliseAliases(['', '   ', 'ok'])).toEqual(['ok'])
    expect(normaliseAliases(undefined)).toEqual([])
  })
})

describe('validateIngredientDraft — accepts a good draft', () => {
  it('passes with no errors', () => {
    const result = validateIngredientDraft(draft(), ONTOLOGY)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('accepts every category and tracking mode the schema allows', () => {
    for (const category of INGREDIENT_CATEGORIES) {
      expect(validateIngredientDraft(draft({ category }), ONTOLOGY).ok).toBe(true)
    }
    const byMode = {
      mass: draft({ trackBy: 'mass' }),
      volume: draft({ trackBy: 'volume', cupWeightG: undefined, densityGPerMl: 1 }),
      count: draft({ trackBy: 'count', unitWeightG: 5 }),
    }
    for (const mode of TRACK_BY_MODES) {
      expect(validateIngredientDraft(byMode[mode], ONTOLOGY).ok, mode).toBe(true)
    }
  })
})

describe('validateIngredientDraft — names', () => {
  it('rejects a blank name', () => {
    const result = validateIngredientDraft(draft({ name: '   ' }), ONTOLOGY)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.field).toBe('name')
  })

  it('rejects a name that produces no id', () => {
    const result = validateIngredientDraft(draft({ name: '!!!' }), ONTOLOGY)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('rejects a duplicate name, case- and whitespace-insensitively', () => {
    for (const name of ['Butter', 'butter', '  BUTTER  ']) {
      const result = validateIngredientDraft(draft({ name }), ONTOLOGY)
      expect(result.ok, name).toBe(false)
      expect(result.errors[0]?.message).toContain('already exists')
    }
  })

  it('allows a more specific name alongside an existing one', () => {
    expect(validateIngredientDraft(draft({ name: 'Salted butter' }), ONTOLOGY).ok).toBe(true)
  })
})

describe('validateIngredientDraft — conversion fields', () => {
  it('requires unitWeightG when counted', () => {
    const result = validateIngredientDraft(
      draft({ trackBy: 'count', unitWeightG: undefined }),
      ONTOLOGY,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.field === 'unitWeightG')).toBe(true)
  })

  it('requires densityGPerMl for a liquid', () => {
    const result = validateIngredientDraft(
      draft({ trackBy: 'volume', cupWeightG: undefined, densityGPerMl: undefined }),
      ONTOLOGY,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.field === 'densityGPerMl')).toBe(true)
  })

  it('REFUSES a density on a solid — the never-density-for-solids rule', () => {
    const result = validateIngredientDraft(
      draft({ trackBy: 'mass', densityGPerMl: 0.6 }),
      ONTOLOGY,
    )
    expect(result.ok).toBe(false)
    const issue = result.errors.find((e) => e.field === 'densityGPerMl')
    expect(issue?.message).toContain('weight of one cup')
  })

  it('refuses a density on a counted ingredient too', () => {
    const result = validateIngredientDraft(
      draft({ trackBy: 'count', unitWeightG: 50, densityGPerMl: 1 }),
      ONTOLOGY,
    )
    expect(result.ok).toBe(false)
  })

  it.each([0, -1, NaN, Infinity])('rejects a non-positive cupWeightG (%s)', (cupWeightG) => {
    const result = validateIngredientDraft(draft({ cupWeightG }), ONTOLOGY)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.field === 'cupWeightG')).toBe(true)
  })

  it('warns, but does not block, when a solid has no cup weight', () => {
    const result = validateIngredientDraft(draft({ cupWeightG: undefined }), ONTOLOGY)
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.field === 'cupWeightG')).toBe(true)
  })

  it('does not warn about a cup weight on a liquid — density covers it', () => {
    const result = validateIngredientDraft(
      draft({ trackBy: 'volume', cupWeightG: undefined, densityGPerMl: 0.92 }),
      ONTOLOGY,
    )
    expect(result.warnings.some((w) => w.field === 'cupWeightG')).toBe(false)
  })
})

describe('validateIngredientDraft — shelf life', () => {
  it('warns when a perishable has no shelf life', () => {
    const result = validateIngredientDraft(draft({ perishable: true }), ONTOLOGY)
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.field === 'defaultShelfLifeDays')).toBe(true)
  })

  it('does not warn for a non-perishable', () => {
    const result = validateIngredientDraft(draft({ perishable: false }), ONTOLOGY)
    expect(result.warnings.some((w) => w.field === 'defaultShelfLifeDays')).toBe(false)
  })

  it.each([0, -5, 2.5])('rejects an invalid shelf life (%s)', (defaultShelfLifeDays) => {
    const result = validateIngredientDraft(
      draft({ perishable: true, defaultShelfLifeDays }),
      ONTOLOGY,
    )
    expect(result.ok).toBe(false)
  })
})

describe('validateIngredientDraft — aliases', () => {
  it('rejects an alias already used by another ingredient', () => {
    // An alias resolving to two ingredients makes matching ambiguous — the
    // seed validator treats this as a hard failure too.
    const result = validateIngredientDraft(draft({ aliases: ['chili'] }), ONTOLOGY)
    expect(result.ok).toBe(false)
    const issue = result.errors.find((e) => e.field === 'aliases')
    expect(issue?.message).toContain('Chilli')
  })

  it('catches a clash regardless of case or padding', () => {
    expect(validateIngredientDraft(draft({ aliases: ['  CHILI '] }), ONTOLOGY).ok).toBe(false)
  })

  it('accepts fresh aliases', () => {
    expect(validateIngredientDraft(draft({ aliases: ['pimenton', 'smoked pepper'] }), ONTOLOGY).ok)
      .toBe(true)
  })
})

describe('validateIngredientDraft — reporting', () => {
  it('reports every problem at once, not just the first', () => {
    const result = validateIngredientDraft(
      draft({ name: '', trackBy: 'count', unitWeightG: undefined, cupWeightG: -1 }),
      ONTOLOGY,
    )
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
    const fields = result.errors.map((e) => e.field)
    expect(fields).toContain('name')
    expect(fields).toContain('unitWeightG')
    expect(fields).toContain('cupWeightG')
  })

  it('tags every issue with the field the form should highlight', () => {
    const result = validateIngredientDraft(draft({ name: '', perishable: true }), ONTOLOGY)
    for (const issue of [...result.errors, ...result.warnings]) {
      expect(issue.field).toBeTruthy()
      expect(issue.message.length).toBeGreaterThan(10)
    }
  })

  it('warnings never make ok false', () => {
    const result = validateIngredientDraft(
      draft({ perishable: true, cupWeightG: undefined }),
      ONTOLOGY,
    )
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.ok).toBe(true)
  })
})

describe('createUserIngredient', () => {
  it('builds a complete ingredient marked as not seed', () => {
    const result = createUserIngredient(draft({ name: 'Smoked paprika' }), ONTOLOGY)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.ingredient).toEqual({
      id: 'smoked-paprika',
      name: 'Smoked paprika',
      category: 'spice',
      trackBy: 'mass',
      tracked: true,
      perishable: false,
      isSeed: false,
      aliases: [],
      cupWeightG: 110,
    })
    expect(isUserAdded(result.ingredient)).toBe(true)
  })

  it('trims the name and normalises aliases', () => {
    const result = createUserIngredient(
      draft({ name: '  Smoked paprika  ', aliases: [' Pimenton ', 'PIMENTON'] }),
      ONTOLOGY,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.ingredient.name).toBe('Smoked paprika')
    expect(result.ingredient.aliases).toEqual(['pimenton'])
  })

  it('omits optional fields rather than storing undefined', () => {
    const result = createUserIngredient(
      draft({ name: 'Plain thing', cupWeightG: undefined }),
      ONTOLOGY,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect('cupWeightG' in result.ingredient).toBe(false)
    expect('densityGPerMl' in result.ingredient).toBe(false)
    expect('defaultShelfLifeDays' in result.ingredient).toBe(false)
  })

  it('avoids colliding with an existing id', () => {
    const withSlugClash = [...ONTOLOGY, existing({ id: 'smoked-paprika', name: 'Something else' })]
    const result = createUserIngredient(draft({ name: 'Smoked paprika' }), withSlugClash)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.ingredient.id).toBe('smoked-paprika-2')
  })

  it('refuses an invalid draft and returns the reasons', () => {
    const result = createUserIngredient(
      draft({ trackBy: 'count', unitWeightG: undefined }),
      ONTOLOGY,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.some((e) => e.field === 'unitWeightG')).toBe(true)
  })

  it('passes warnings through on success so the form can still show them', () => {
    const result = createUserIngredient(
      draft({ name: 'Fresh thing', perishable: true, cupWeightG: undefined }),
      ONTOLOGY,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('does not mutate the existing ingredient list', () => {
    const snapshot = JSON.stringify(ONTOLOGY)
    createUserIngredient(draft({ name: 'Another thing' }), ONTOLOGY)
    expect(JSON.stringify(ONTOLOGY)).toBe(snapshot)
  })
})

describe('a created ingredient works with the rest of the engine', () => {
  it('converts immediately, in every mode', () => {
    const cases = [
      { d: draft({ name: 'Solid thing', trackBy: 'mass' as const, cupWeightG: 120 }), unit: 'cup' as const, expected: 120 },
      { d: draft({ name: 'Liquid thing', trackBy: 'volume' as const, cupWeightG: undefined, densityGPerMl: 0.9 }), unit: 'ml' as const, expected: 0.9 },
      { d: draft({ name: 'Counted thing', trackBy: 'count' as const, cupWeightG: undefined, unitWeightG: 42 }), unit: 'count' as const, expected: 42 },
    ]
    for (const { d, unit, expected } of cases) {
      const created = createUserIngredient(d, ONTOLOGY)
      expect(created.ok, d.name).toBe(true)
      if (!created.ok) continue
      const grams = toGrams(created.ingredient, 1, unit)
      expect(grams.ok, `${d.name} ${unit}`).toBe(true)
      if (!grams.ok) continue
      expect(grams.grams).toBeCloseTo(expected, 6)
    }
  })

  it('a validated draft can never produce an unconvertible ingredient in its own mode', () => {
    // The point of the validation rules: whatever the User picks, the natural
    // unit for that mode always converts.
    const modes = [
      { d: draft({ name: 'A', trackBy: 'count' as const, unitWeightG: 10 }), unit: 'count' as const },
      { d: draft({ name: 'B', trackBy: 'volume' as const, cupWeightG: undefined, densityGPerMl: 1 }), unit: 'cup' as const },
      { d: draft({ name: 'C', trackBy: 'mass' as const }), unit: 'g' as const },
    ]
    for (const { d, unit } of modes) {
      const created = createUserIngredient(d, ONTOLOGY)
      if (!created.ok) throw new Error(`${d.name} failed validation`)
      expect(toGrams(created.ingredient, 1, unit).ok, `${d.name} ${unit}`).toBe(true)
    }
  })
})
