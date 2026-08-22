import { describe, it, expect } from 'vitest'
import type { Recipe } from '../types/schema'
import { combineRecipes } from './recipe-source'
import { BUNDLED_RECIPES } from '../data/bundled'

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

const seed = (id: string, extra: Partial<Recipe> = {}) => recipe({ id, isSeed: true, ...extra })
const mine = (id: string, extra: Partial<Recipe> = {}) => recipe({ id, isSeed: false, ...extra })

const ids = (list: readonly Recipe[]) => list.map((r) => r.id)

// ---------------------------------------------------------------------------

describe('combineRecipes', () => {
  it('is the bundled set when nothing has been typed in', () => {
    const bundled = [seed('a'), seed('b')]
    expect(combineRecipes(bundled, [])).toEqual(bundled)
  })

  it('is the User’s recipes when nothing is bundled', () => {
    expect(ids(combineRecipes([], [mine('mine-1')]))).toEqual(['mine-1'])
  })

  it('is empty when both are', () => {
    expect(combineRecipes([], [])).toEqual([])
  })

  it('appends the User’s own after the seed set', () => {
    const combined = combineRecipes([seed('a'), seed('b')], [mine('mine-1'), mine('mine-2')])
    expect(ids(combined)).toEqual(['a', 'b', 'mine-1', 'mine-2'])
  })

  it('keeps both flags right, so a screen can tell whose recipe it is', () => {
    const combined = combineRecipes([seed('a')], [mine('mine-1')])
    expect(combined.map((r) => r.isSeed)).toEqual([true, false])
  })
})

describe('combineRecipes — the User always wins', () => {
  it('shadows a seed recipe of the same id IN PLACE, never twice', () => {
    const combined = combineRecipes(
      [seed('a'), seed('b'), seed('c')],
      [mine('b', { name: 'My better version' })],
    )
    expect(ids(combined)).toEqual(['a', 'b', 'c'])
    expect(combined[1].name).toBe('My better version')
    expect(combined[1].isSeed).toBe(false)
  })

  it('takes the last row when the table holds one id twice, and lists it once', () => {
    // Not reachable through the app — `id` is the primary key — but a restored
    // backup is a file, and one recipe appearing twice on screen is worse than
    // an arbitrary-but-deterministic winner.
    const combined = combineRecipes([], [mine('dup', { name: 'first' }), mine('dup', { name: 'second' })])
    expect(ids(combined)).toEqual(['dup'])
    expect(combined[0].name).toBe('second')
  })
})

describe('combineRecipes — flags are forced, not trusted', () => {
  it('marks a stored recipe as the User’s even if the row claims to be seed', () => {
    // A hand-edited backup file could say anything. Rows in `db.recipes` are
    // the User's by construction, so the invariant is made true rather than
    // assumed.
    const combined = combineRecipes([], [seed('smuggled')])
    expect(combined[0].isSeed).toBe(false)
  })

  it('marks a bundled recipe as seed even if the file forgot to', () => {
    const combined = combineRecipes([mine('sloppy')], [])
    expect(combined[0].isSeed).toBe(true)
  })
})

describe('combineRecipes — purity', () => {
  it('does not modify either input', () => {
    const bundled = [seed('a')]
    const user = [seed('a', { name: 'shadow' })]
    const bundledBefore = structuredClone(bundled)
    const userBefore = structuredClone(user)

    combineRecipes(bundled, user)

    expect(bundled).toEqual(bundledBefore)
    expect(user).toEqual(userBefore)
  })

  it('returns the original object where nothing needed changing', () => {
    const a = seed('a')
    const combined = combineRecipes([a], [])
    expect(combined[0]).toBe(a)
  })
})

describe('the real bundle', () => {
  it('ships the seed recipes, all flagged as seed', () => {
    expect(BUNDLED_RECIPES.length).toBeGreaterThan(0)
    expect(BUNDLED_RECIPES.every((r) => r.isSeed)).toBe(true)
  })

  it('passes through untouched when the User has added nothing', () => {
    const combined = combineRecipes(BUNDLED_RECIPES, [])
    expect(combined.length).toBe(BUNDLED_RECIPES.length)
    expect(ids(combined)).toEqual(ids(BUNDLED_RECIPES))
  })
})
