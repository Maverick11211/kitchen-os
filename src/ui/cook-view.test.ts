/**
 * What the cook sheet shows.
 *
 * Built against real engine output rather than hand-written plans — the point
 * of these functions is that they describe what `planRecipeDeduction` and
 * `evaluateOwnership` actually decided, and a faked plan would let them drift
 * apart without a test noticing.
 */
import { describe, expect, it } from 'vitest'
import type {
  CanonicalIngredient,
  Lot,
  MacroSet,
  Product,
  Recipe,
} from '../types/schema'
import {
  buildInventoryIndex,
  buildOntologyIndex,
  evaluateOwnership,
  planRecipeDeduction,
} from '../engine'
import {
  BATCH_OLD_DAYS,
  DEFAULT_SCALE,
  SCALE_STEPS,
  batchAgeWarning,
  batchSummary,
  buildCookLines,
  cookPreviewNotes,
  planChanged,
  portionLabel,
  portionOptions,
  readPercent,
  remainingNote,
  scaleNote,
  scaleOptions,
} from './cook-view'

const PER_100G: MacroSet = {
  calories: 100,
  proteinG: 10,
  carbsG: 5,
  fatG: 2,
  fiberG: 1,
  sugarG: 1,
  sodiumMg: 50,
  saturatedFatG: 1,
  cholesterolMg: 10,
}

function ingredient(id: string, name: string, tracked = true): CanonicalIngredient {
  return {
    id,
    name,
    category: 'other',
    trackBy: 'mass',
    tracked,
    perishable: true,
    aliases: [],
    isSeed: true,
  }
}

const ONTOLOGY = buildOntologyIndex([
  ingredient('rice-white', 'Rice, white'),
  ingredient('chicken-breast', 'Chicken breast'),
  ingredient('salt', 'Salt', false),
])

function product(id: string, canonicalId: string, name: string): Product {
  return { id, canonicalId, name, macrosPer100g: PER_100G, createdAt: '2026-08-20T00:00:00.000Z' }
}

function lot(id: string, productId: string, remainingG: number, expiresOn: string | null): Lot {
  return {
    id,
    productId,
    initialG: remainingG,
    remainingG,
    expiresOn,
    acquiredOn: '2026-08-18',
    depleted: false,
  }
}

const RECIPE: Recipe = {
  id: 'rice-and-chicken',
  name: 'Rice and Chicken',
  cuisines: ['Other'],
  ingredients: [
    { canonicalId: 'rice-white', quantity: 150, unit: 'g', quantityG: 150, optional: false },
    { canonicalId: 'chicken-breast', quantity: 200, unit: 'g', quantityG: 200, optional: false },
    { canonicalId: 'salt', quantity: 5, unit: 'g', quantityG: 5, optional: false },
  ],
  requiredAppliances: [],
  tools: [],
  steps: [{ order: 1, text: 'Cook it.' }],
  isSeed: true,
  createdAt: '2026-08-20T00:00:00.000Z',
}

/** A well-stocked kitchen: plenty of both tracked ingredients. */
function fullKitchen() {
  return buildInventoryIndex(
    [product('p_rice', 'rice-white', 'Tilda Basmati'), product('p_chx', 'chicken-breast', 'Chicken breasts')],
    [lot('l_rice', 'p_rice', 900, '2026-12-01'), lot('l_chx', 'p_chx', 800, '2026-08-25')],
  )
}

const TODAY = '2026-08-22'

// ---------------------------------------------------------------------------

describe('scaleOptions', () => {
  it('offers the four steps, half first', () => {
    const ownership = evaluateOwnership(RECIPE, fullKitchen(), ONTOLOGY, { today: TODAY })
    expect(scaleOptions(ownership).map((option) => option.scale)).toEqual([...SCALE_STEPS])
    expect(scaleOptions(ownership)[0]?.label).toBe('½ batch')
    expect(scaleOptions(ownership)[1]?.label).toBe('Full batch')
    expect(scaleOptions(ownership)[2]?.label).toBe('2 batches')
  })

  it('defaults to a full batch', () => {
    expect(DEFAULT_SCALE).toBe(1)
  })

  it('marks the sizes the kitchen can cover', () => {
    // 900 g rice / 150 = 6 batches; 800 g chicken / 200 = 4. Four is the limit.
    const ownership = evaluateOwnership(RECIPE, fullKitchen(), ONTOLOGY, { today: TODAY })
    expect(scaleOptions(ownership).map((option) => option.possible)).toEqual([
      true,
      true,
      true,
      true,
    ])
  })

  it('marks the ones it cannot', () => {
    const thin = buildInventoryIndex(
      [product('p_rice', 'rice-white', 'Rice'), product('p_chx', 'chicken-breast', 'Chicken')],
      [lot('l_rice', 'p_rice', 900, null), lot('l_chx', 'p_chx', 100, null)],
    )
    const ownership = evaluateOwnership(RECIPE, thin, ONTOLOGY, { today: TODAY })

    // 100 g of chicken against 200 g wanted: half a batch and no more.
    expect(scaleOptions(ownership).map((option) => option.possible)).toEqual([
      true,
      false,
      false,
      false,
    ])
  })

  /*
   * A recipe made entirely of staples needs nothing countable, so
   * `maxBatchScale` is Infinity and every size is genuinely possible.
   */
  it('says every size is possible for a recipe of staples', () => {
    const saltOnly: Recipe = {
      ...RECIPE,
      ingredients: [
        { canonicalId: 'salt', quantity: 5, unit: 'g', quantityG: 5, optional: false },
      ],
    }
    const ownership = evaluateOwnership(saltOnly, fullKitchen(), ONTOLOGY, { today: TODAY })
    expect(scaleOptions(ownership).every((option) => option.possible)).toBe(true)
  })
})

describe('scaleNote', () => {
  it('says nothing when the kitchen covers the chosen size', () => {
    const ownership = evaluateOwnership(RECIPE, fullKitchen(), ONTOLOGY, { today: TODAY })
    expect(scaleNote(ownership, 1)).toBeNull()
  })

  it('names the largest size that would work', () => {
    const thin = buildInventoryIndex(
      [product('p_rice', 'rice-white', 'Rice'), product('p_chx', 'chicken-breast', 'Chicken')],
      [lot('l_rice', 'p_rice', 900, null), lot('l_chx', 'p_chx', 120, null)],
    )
    // 120 g of chicken against 200 g wanted: a half batch is the most there is.
    const ownership = evaluateOwnership(RECIPE, thin, ONTOLOGY, { today: TODAY })
    expect(scaleNote(ownership, 2)).toBe('There is only enough for a ½ batch.')
  })

  /* "a 2 batches" is what the first attempt said. The browser pass found it. */
  it('drops the article on a plural size', () => {
    const plenty = buildInventoryIndex(
      [product('p_rice', 'rice-white', 'Rice'), product('p_chx', 'chicken-breast', 'Chicken')],
      [lot('l_rice', 'p_rice', 9000, null), lot('l_chx', 'p_chx', 500, null)],
    )
    const ownership = evaluateOwnership(RECIPE, plenty, ONTOLOGY, { today: TODAY })
    expect(scaleNote(ownership, 3)).toBe('There is only enough for 2 batches.')
  })

  it('is plain about an empty kitchen', () => {
    const empty = buildInventoryIndex([], [])
    const ownership = evaluateOwnership(RECIPE, empty, ONTOLOGY, { today: TODAY })
    expect(scaleNote(ownership, 1)).toBe('There is none of this in the kitchen.')
  })
})

// ---------------------------------------------------------------------------

describe('buildCookLines', () => {
  it('shows every recipe line, staples included', () => {
    const index = fullKitchen()
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 1)
    const lines = buildCookLines(RECIPE, plan, index, ONTOLOGY)

    expect(lines.map((line) => line.name)).toEqual(['Rice, white', 'Chicken breast', 'Salt'])
  })

  it('names the packet each amount comes out of', () => {
    const index = fullKitchen()
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 1)
    const [rice] = buildCookLines(RECIPE, plan, index, ONTOLOGY)

    expect(rice?.amount).toBe('150 g')
    expect(rice?.packets).toEqual([{ lotId: 'l_rice', name: 'Tilda Basmati', amount: '150 g' }])
    expect(rice?.status).toBe('full')
    expect(rice?.shortLabel).toBeNull()
  })

  /*
   * A staple is in the recipe and not in the plan — there is nothing to debit.
   * Leaving it off the preview would mean the list on screen was not the
   * recipe, which is the same reasoning `buildRecipeLines` follows.
   */
  it('shows a staple with no packets and no shortfall', () => {
    const index = fullKitchen()
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 1)
    const salt = buildCookLines(RECIPE, plan, index, ONTOLOGY).at(-1)

    expect(salt?.status).toBe('staple')
    expect(salt?.packets).toEqual([])
    expect(salt?.shortLabel).toBeNull()
  })

  it('scales the amounts with the batch', () => {
    const index = fullKitchen()
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 2)
    const [rice] = buildCookLines(RECIPE, plan, index, ONTOLOGY)

    expect(rice?.amount).toBe('300 g')
  })

  it('says how much is short, and still shows what would come out', () => {
    const index = buildInventoryIndex(
      [product('p_rice', 'rice-white', 'Rice'), product('p_chx', 'chicken-breast', 'Chicken')],
      [lot('l_rice', 'p_rice', 900, null), lot('l_chx', 'p_chx', 50, null)],
    )
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 1)
    const chicken = buildCookLines(RECIPE, plan, index, ONTOLOGY)[1]

    expect(chicken?.status).toBe('short')
    expect(chicken?.shortLabel).toBe('150 g short')
    expect(chicken?.packets).toHaveLength(1)
  })

  it('marks a line with nothing behind it', () => {
    const index = buildInventoryIndex(
      [product('p_rice', 'rice-white', 'Rice')],
      [lot('l_rice', 'p_rice', 900, null)],
    )
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 1)
    const chicken = buildCookLines(RECIPE, plan, index, ONTOLOGY)[1]

    expect(chicken?.status).toBe('none')
    expect(chicken?.packets).toEqual([])
    expect(chicken?.shortLabel).toBe('200 g short')
  })

  /*
   * Six of the 150 seed recipes name the same ingredient on two lines. The plan
   * holds one entry per LINE in recipe order, so the two must not be matched up
   * by canonical id — that would give both rows the first line's packets.
   */
  it('keeps two lines of the same ingredient apart', () => {
    const twice: Recipe = {
      ...RECIPE,
      ingredients: [
        { canonicalId: 'rice-white', quantity: 100, unit: 'g', quantityG: 100, optional: false },
        { canonicalId: 'rice-white', quantity: 50, unit: 'g', quantityG: 50, optional: false },
      ],
    }
    const index = fullKitchen()
    const plan = planRecipeDeduction(index, ONTOLOGY, twice, 1)
    const lines = buildCookLines(twice, plan, index, ONTOLOGY)

    expect(lines).toHaveLength(2)
    expect(lines[0]?.amount).toBe('100 g')
    expect(lines[1]?.amount).toBe('50 g')
  })

  it('spreads one line across two packets, soonest-expiring first', () => {
    const index = buildInventoryIndex(
      [product('p_rice', 'rice-white', 'Rice'), product('p_chx', 'chicken-breast', 'Chicken')],
      [
        lot('l_old', 'p_rice', 100, '2026-08-24'),
        lot('l_new', 'p_rice', 900, '2026-12-01'),
        lot('l_chx', 'p_chx', 800, null),
      ],
    )
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 1)
    const [rice] = buildCookLines(RECIPE, plan, index, ONTOLOGY)

    expect(rice?.packets.map((packet) => packet.amount)).toEqual(['100 g', '50 g'])
    expect(rice?.status).toBe('full')
  })
})

// ---------------------------------------------------------------------------

describe('cookPreviewNotes', () => {
  it('counts the packets that will be used', () => {
    const index = fullKitchen()
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 1)

    expect(cookPreviewNotes(plan, ONTOLOGY)[0]).toBe(
      '2 packets will be used, soonest-expiring first.',
    )
  })

  it('says so when nothing will come out', () => {
    const plan = planRecipeDeduction(buildInventoryIndex([], []), ONTOLOGY, RECIPE, 1)
    expect(cookPreviewNotes(plan, ONTOLOGY)[0]).toContain('Nothing will come out')
  })

  it('names each shortfall by ingredient, in words', () => {
    const index = buildInventoryIndex(
      [product('p_rice', 'rice-white', 'Rice')],
      [lot('l_rice', 'p_rice', 900, null)],
    )
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 1)
    const notes = cookPreviewNotes(plan, ONTOLOGY)

    expect(notes.some((note) => note.includes('200 g short of Chicken breast'))).toBe(true)
  })
})

describe('planChanged', () => {
  it('is false for the same plan', () => {
    const index = fullKitchen()
    const plan = planRecipeDeduction(index, ONTOLOGY, RECIPE, 1)
    expect(planChanged(plan, plan)).toBe(false)
  })

  it('is true when the kitchen moved underneath it', () => {
    const before = planRecipeDeduction(fullKitchen(), ONTOLOGY, RECIPE, 1)
    const thinner = buildInventoryIndex(
      [product('p_rice', 'rice-white', 'Rice'), product('p_chx', 'chicken-breast', 'Chicken')],
      [lot('l_rice', 'p_rice', 900, '2026-12-01'), lot('l_chx', 'p_chx', 50, '2026-08-25')],
    )
    const after = planRecipeDeduction(thinner, ONTOLOGY, RECIPE, 1)

    expect(planChanged(before, after)).toBe(true)
  })

  /* Half a gram is below anything this app can act on. */
  it('ignores a difference too small to matter', () => {
    const plan = planRecipeDeduction(fullKitchen(), ONTOLOGY, RECIPE, 1)
    const nudged = {
      ...plan,
      deductions: plan.deductions.map((deduction) => ({
        ...deduction,
        grams: deduction.grams + 0.2,
      })),
    }
    expect(planChanged(plan, nudged)).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('portionOptions', () => {
  it('offers quarters and the whole thing for a fresh batch', () => {
    const options = portionOptions(1)
    expect(options.map((option) => option.label)).toEqual(['¼', '½', '¾', 'All of it'])
    expect(options.every((option) => option.possible)).toBe(true)
  })

  it('marks the portions that are bigger than what is left', () => {
    const options = portionOptions(0.4)
    expect(options.map((option) => option.possible)).toEqual([true, false, false, true])
  })

  /*
   * The last option is "the rest", whatever that is — the honest answer to "I
   * finished it", and the one that closes a batch exactly rather than leaving a
   * crumb that keeps it on the list forever.
   */
  it('makes the last option exactly what is left', () => {
    expect(portionOptions(0.4).at(-1)).toEqual({
      fraction: 0.4,
      label: 'The rest',
      possible: true,
    })
  })

  it('allows the final quarter despite the floating-point crumb', () => {
    const left = 1 - 0.25 - 0.5
    expect(portionOptions(left)[0]?.possible).toBe(true)
  })

  it('offers nothing on a finished batch', () => {
    expect(portionOptions(0).every((option) => option.possible)).toBe(false)
  })
})

describe('remainingNote', () => {
  it('says nothing about an untouched batch', () => {
    expect(remainingNote({ fractionConsumed: 0 })).toBeNull()
  })

  it('says how much is left in whole percent', () => {
    expect(remainingNote({ fractionConsumed: 0.25 })).toBe('75% of this batch is left.')
  })

  it('says when it is finished', () => {
    expect(remainingNote({ fractionConsumed: 1 })).toBe('All of this batch has been eaten.')
  })
})

/*
 * An optional garnish you own none of. Before 2026-08-22 this went red and made
 * the batch incomplete, which contradicted a recipe card that had already said
 * "you have everything for this" — optional lines are excluded from the
 * percentage. 102 lines across the seed set are tracked and optional.
 */
describe('an optional garnish with none on hand', () => {
  const garnished: Recipe = {
    ...RECIPE,
    ingredients: [
      { canonicalId: 'rice-white', quantity: 150, unit: 'g', quantityG: 150, optional: false },
      { canonicalId: 'chicken-breast', quantity: 5, unit: 'g', quantityG: 5, optional: true },
    ],
  }
  const riceOnly = buildInventoryIndex(
    [product('p_rice', 'rice-white', 'Rice')],
    [lot('l_rice', 'p_rice', 900, null)],
  )

  it('does not make the batch read as incomplete', () => {
    const plan = planRecipeDeduction(riceOnly, ONTOLOGY, garnished, 1)
    expect(plan.complete).toBe(true)
    expect(plan.shortfalls).toHaveLength(1)
    expect(plan.shortfalls[0]?.optional).toBe(true)
  })

  it('sits back on the row instead of going red', () => {
    const plan = planRecipeDeduction(riceOnly, ONTOLOGY, garnished, 1)
    const garnish = buildCookLines(garnished, plan, riceOnly, ONTOLOGY)[1]

    expect(garnish?.status).toBe('optional')
    // No gram figure: that would read as something to go and buy.
    expect(garnish?.shortLabel).toBeNull()
  })

  it('is mentioned in plain words, not warned about', () => {
    const plan = planRecipeDeduction(riceOnly, ONTOLOGY, garnished, 1)
    const notes = cookPreviewNotes(plan, ONTOLOGY)

    expect(notes.some((note) => note.includes('for the garnish'))).toBe(true)
    expect(notes.some((note) => note.includes('short of'))).toBe(false)
  })

  it('agrees with what the recipe card says', () => {
    const ownership = evaluateOwnership(garnished, riceOnly, ONTOLOGY, { today: TODAY })
    const plan = planRecipeDeduction(riceOnly, ONTOLOGY, garnished, 1)

    // The card says "you have everything for this"; the cook sheet must not
    // then say the batch is short.
    expect(ownership.ownershipFraction).toBe(1)
    expect(plan.complete).toBe(true)
  })
})

describe('batchAgeWarning', () => {
  it('says nothing about a batch cooked today', () => {
    expect(batchAgeWarning(TODAY, TODAY)).toBeNull()
  })

  it('says nothing for the first few days', () => {
    expect(batchAgeWarning('2026-08-19', TODAY)).toBeNull()
  })

  /*
   * Nothing ages a batch out of the log sheet, so this marker is the only thing
   * between a three-week-old stew and a portion logged without a thought. It
   * asks rather than decides: the app cannot know what went in the freezer.
   */
  it('marks one that has been sitting, and asks rather than decides', () => {
    const note = batchAgeWarning('2026-08-10', TODAY)
    expect(note).toBe('12 days ago — still good?')
  })

  it('starts marking the day after the threshold', () => {
    expect(BATCH_OLD_DAYS).toBe(4)
    expect(batchAgeWarning('2026-08-18', TODAY)).toBeNull()
    expect(batchAgeWarning('2026-08-17', TODAY)).toBe('5 days ago — still good?')
  })

  it('says nothing for an unreadable date rather than showing NaN', () => {
    expect(batchAgeWarning('not-a-date', TODAY)).toBeNull()
  })
})

describe('portionLabel', () => {
  it('reads as a person would say it', () => {
    expect(portionLabel(0.4)).toBe('40% of the batch')
    expect(portionLabel(1)).toBe('100% of the batch')
  })
})

describe('batchSummary', () => {
  it('rounds — a batch is not accurate to a tenth of a calorie', () => {
    expect(batchSummary({ ...PER_100G, calories: 1240.4 })).toBe(
      '1240 calories in the whole batch',
    )
  })
})

// ---------------------------------------------------------------------------

describe('readPercent', () => {
  it('reads a plain number', () => {
    expect(readPercent('40', 1)).toEqual({ ok: true, fraction: 0.4, warning: null })
  })

  it('reads one with a percent sign, spaced or not', () => {
    expect(readPercent('40%', 1)).toEqual({ ok: true, fraction: 0.4, warning: null })
    expect(readPercent(' 40 % ', 1)).toEqual({ ok: true, fraction: 0.4, warning: null })
  })

  it('asks for something when nothing was typed', () => {
    expect(readPercent('', 1).ok).toBe(false)
    expect(readPercent('   ', 1).ok).toBe(false)
  })

  it('refuses what is not a number', () => {
    const result = readPercent('half', 1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('That is not a number.')
  })

  it('refuses zero and below', () => {
    expect(readPercent('0', 1).ok).toBe(false)
    expect(readPercent('-10', 1).ok).toBe(false)
  })

  it('refuses more than a whole batch', () => {
    const result = readPercent('120', 1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('100%')
  })

  /*
   * Over-asking within a batch is a WARNING, not an error — the same treatment
   * a logged ingredient gets when the packet cannot cover it. Refusing would
   * mean retyping a number that was nearly right.
   */
  it('clamps to what is left and says so', () => {
    const result = readPercent('50', 0.3)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fraction).toBeCloseTo(0.3)
    expect(result.warning).toContain('30%')
  })
})
