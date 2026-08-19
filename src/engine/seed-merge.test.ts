import { describe, it, expect } from 'vitest'
import type { CanonicalIngredient } from '../types/schema'
import { describeSeedMerge, mergeSeedOntology, needsSeedMerge } from './seed-merge'

function entry(overrides: Partial<CanonicalIngredient> & { id: string }): CanonicalIngredient {
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

const seed = (id: string, extra: Partial<CanonicalIngredient> = {}) =>
  entry({ id, isSeed: true, ...extra })
const mine = (id: string, extra: Partial<CanonicalIngredient> = {}) =>
  entry({ id, isSeed: false, ...extra })

const ids = (list: readonly CanonicalIngredient[]) => list.map((e) => e.id)

// ---------------------------------------------------------------------------

describe('needsSeedMerge', () => {
  it('merges on a fresh install, where nothing has been seeded yet', () => {
    expect(needsSeedMerge({}, '2026-08-19')).toBe(true)
    expect(needsSeedMerge({ seedVersion: undefined }, '2026-08-19')).toBe(true)
  })

  it('does not merge when the stored version already matches', () => {
    expect(needsSeedMerge({ seedVersion: '2026-08-19' }, '2026-08-19')).toBe(false)
  })

  it('merges when the versions differ in either direction', () => {
    expect(needsSeedMerge({ seedVersion: '2026-08-01' }, '2026-08-19')).toBe(true)
    // Rolling back to an older build should re-merge, not silently do nothing.
    expect(needsSeedMerge({ seedVersion: '2026-09-01' }, '2026-08-19')).toBe(true)
  })
})

describe('mergeSeedOntology — first run', () => {
  it('seeds an empty database with everything bundled', () => {
    const bundled = [seed('butter'), seed('flour')]
    const result = mergeSeedOntology([], bundled)
    expect(ids(result.ingredients)).toEqual(['butter', 'flour'])
    expect(result.added).toEqual(['butter', 'flour'])
    expect(result.updated).toEqual([])
    expect(result.unchanged).toBe(false)
  })

  it('handles an empty bundle without losing local data', () => {
    const local = [mine('goat')]
    const result = mergeSeedOntology(local, [])
    expect(ids(result.ingredients)).toEqual(['goat'])
    expect(result.retainedUserAdded).toEqual(['goat'])
  })
})

describe('mergeSeedOntology — adding and updating', () => {
  it('adds bundled entries that are new', () => {
    const result = mergeSeedOntology([seed('butter')], [seed('butter'), seed('miso')])
    expect(result.added).toEqual(['miso'])
    expect(ids(result.ingredients)).toEqual(['butter', 'miso'])
  })

  it('updates a seed entry whose bundled version changed', () => {
    const before = seed('butter', { cupWeightG: 220 })
    const after = seed('butter', { cupWeightG: 227 })
    const result = mergeSeedOntology([before], [after])
    expect(result.updated).toEqual(['butter'])
    expect(result.ingredients[0]?.cupWeightG).toBe(227)
  })

  it('reports no change when the bundle is identical', () => {
    const local = [seed('butter', { cupWeightG: 227, aliases: ['butter'] })]
    const bundled = [seed('butter', { cupWeightG: 227, aliases: ['butter'] })]
    const result = mergeSeedOntology(local, bundled)
    expect(result.unchanged).toBe(true)
    expect(result.updated).toEqual([])
    // Unchanged entries come back as the original objects.
    expect(result.ingredients[0]).toBe(local[0])
  })

  it('notices a change in any field, not just the obvious ones', () => {
    const cases: Partial<CanonicalIngredient>[] = [
      { name: 'Renamed' },
      { category: 'dairy' },
      { trackBy: 'count', unitWeightG: 5 },
      { tracked: false },
      { perishable: true },
      { cupWeightG: 1 },
      { unitWeightG: 1 },
      { defaultShelfLifeDays: 3 },
      { aliases: ['new'] },
      { interchangeableWith: ['other'] },
    ]
    for (const change of cases) {
      const result = mergeSeedOntology([seed('x')], [seed('x', change)])
      expect(result.updated, JSON.stringify(change)).toEqual(['x'])
    }
  })

  it('notices an alias reordering, since order is part of the stored value', () => {
    const result = mergeSeedOntology(
      [seed('x', { aliases: ['a', 'b'] })],
      [seed('x', { aliases: ['b', 'a'] })],
    )
    expect(result.updated).toEqual(['x'])
  })
})

describe('mergeSeedOntology — the User always wins', () => {
  it('skips a bundled entry whose id the User already owns', () => {
    const local = [mine('goat', { name: 'Goat, mine', cupWeightG: 150 })]
    const bundled = [seed('goat', { name: 'Goat leg', cupWeightG: 999 })]
    const result = mergeSeedOntology(local, bundled)

    expect(result.skippedUserOwned).toEqual(['goat'])
    expect(result.updated).toEqual([])
    expect(result.ingredients).toHaveLength(1)
    expect(result.ingredients[0]).toBe(local[0])
    expect(result.ingredients[0]?.name).toBe('Goat, mine')
    expect(result.ingredients[0]?.isSeed).toBe(false)
  })

  it('never alters a user entry the bundle does not mention', () => {
    const local = [seed('butter'), mine('goat')]
    const result = mergeSeedOntology(local, [seed('butter'), seed('miso')])
    expect(result.retainedUserAdded).toEqual(['goat'])
    expect(result.ingredients.find((e) => e.id === 'goat')).toBe(local[1])
  })

  it('an update to another ingredient does not disturb the User\'s entries', () => {
    const local = [seed('butter', { cupWeightG: 220 }), mine('goat'), mine('biltong')]
    const result = mergeSeedOntology(local, [seed('butter', { cupWeightG: 227 })])
    expect(result.updated).toEqual(['butter'])
    expect(result.retainedUserAdded).toEqual(['goat', 'biltong'])
    expect(result.ingredients.filter((e) => !e.isSeed)).toEqual([local[1], local[2]])
  })
})

describe('mergeSeedOntology — nothing is ever deleted', () => {
  it('retains a seed entry the bundle dropped', () => {
    // A Product points at a canonicalId and a Lot points at a Product, so
    // removing an ingredient would orphan inventory the User still owns.
    const local = [seed('butter'), seed('discontinued')]
    const result = mergeSeedOntology(local, [seed('butter')])
    expect(ids(result.ingredients)).toEqual(['butter', 'discontinued'])
    expect(result.retainedMissing).toEqual(['discontinued'])
  })

  it('never loses an entry, whatever the combination', () => {
    const local = [seed('a'), seed('gone'), mine('mine'), mine('clash')]
    const bundled = [seed('a', { cupWeightG: 5 }), seed('new'), seed('clash')]
    const result = mergeSeedOntology(local, bundled)

    for (const original of local) {
      expect(ids(result.ingredients), original.id).toContain(original.id)
    }
    expect(result.ingredients).toHaveLength(5) // 4 local + 1 genuinely new
    expect(result.added).toEqual(['new'])
    expect(result.updated).toEqual(['a'])
    expect(result.skippedUserOwned).toEqual(['clash'])
    expect(result.retainedMissing).toEqual(['gone'])
    expect(result.retainedUserAdded).toEqual(['mine'])
  })
})

describe('mergeSeedOntology — safety properties', () => {
  const local = [seed('a'), seed('gone'), mine('mine')]
  const bundled = [seed('a', { cupWeightG: 5 }), seed('new')]

  it('mutates neither input', () => {
    const localSnapshot = JSON.stringify(local)
    const bundledSnapshot = JSON.stringify(bundled)
    mergeSeedOntology(local, bundled)
    expect(JSON.stringify(local)).toBe(localSnapshot)
    expect(JSON.stringify(bundled)).toBe(bundledSnapshot)
  })

  it('produces no duplicate ids', () => {
    const result = mergeSeedOntology(local, bundled)
    expect(new Set(ids(result.ingredients)).size).toBe(result.ingredients.length)
  })

  it('is idempotent — merging the result again changes nothing', () => {
    const first = mergeSeedOntology(local, bundled)
    const second = mergeSeedOntology(first.ingredients, bundled)
    expect(second.unchanged).toBe(true)
    expect(ids(second.ingredients)).toEqual(ids(first.ingredients))
  })

  it('forces isSeed true on incoming entries, whatever the file claims', () => {
    // Guards against a hand-edited ontology.json shipping isSeed:false, which
    // would make the entry permanently un-updatable by later merges.
    const result = mergeSeedOntology([], [entry({ id: 'sneaky', isSeed: false })])
    expect(result.ingredients[0]?.isSeed).toBe(true)
    const again = mergeSeedOntology(result.ingredients, [entry({ id: 'sneaky', isSeed: false, name: 'v2' })])
    expect(again.updated).toEqual(['sneaky'])
  })

  it('puts bundled entries first, then local-only ones, deterministically', () => {
    const result = mergeSeedOntology(local, bundled)
    expect(ids(result.ingredients)).toEqual(['a', 'new', 'gone', 'mine'])
    const rerun = mergeSeedOntology(local, bundled)
    expect(ids(rerun.ingredients)).toEqual(ids(result.ingredients))
  })
})

describe('describeSeedMerge', () => {
  it('says so when there is nothing to do', () => {
    expect(describeSeedMerge(mergeSeedOntology([seed('a')], [seed('a')])))
      .toBe('Ingredient list already up to date.')
  })

  it('summarises what happened', () => {
    const summary = describeSeedMerge(
      mergeSeedOntology([seed('a'), mine('clash'), mine('keep')], [seed('a', { cupWeightG: 2 }), seed('new'), seed('clash')]),
    )
    expect(summary).toContain('1 added')
    expect(summary).toContain('1 updated')
    expect(summary).toContain('kept as yours')
  })
})
