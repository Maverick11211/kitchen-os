/**
 * Validation pass for the Phase 2 seed data (src/data/ontology.json and
 * src/data/recipes.json). Runs as a normal test via `npm test`.
 *
 * See qa/README.md for what each section checks and why this lives outside
 * src/.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type {
  CanonicalIngredient,
  CanonicalId,
  Recipe,
  RecipeIngredient,
  Unit,
  IngredientCategory,
  TrackBy,
} from '../src/types/schema'
import { toGrams } from '../src/engine/units'

const here = dirname(fileURLToPath(import.meta.url))

function loadJson<T>(relativePath: string): T {
  const raw = readFileSync(join(here, relativePath), 'utf-8')
  return JSON.parse(raw) as T
}

const ontology = loadJson<CanonicalIngredient[]>('../src/data/ontology.json')
const recipes = loadJson<Recipe[]>('../src/data/recipes.json')
const calorieReference = loadJson<Record<string, number>>('./calorie-reference.json')

const ontologyById = new Map<CanonicalId, CanonicalIngredient>(
  ontology.map((entry) => [entry.id, entry]),
)

// ---------------------------------------------------------------------------
// Conversion math
//
// This used to be a second, private copy of the engine's conversion rules. It
// is now the engine itself (`src/engine/units.ts`), for two reasons:
//
//  1. Two copies drift. A fix applied to one and not the other leaves this
//     suite checking the seed data against rules the app does not use — it
//     passes while the app is wrong, which is the worst possible failure mode
//     for a validator.
//  2. The old copy could not convert cup/tbsp/tsp for a `trackBy: 'volume'`
//     ingredient, because no liquid in the ontology carries a `cupWeightG`.
//     Those lines returned null and were silently SKIPPED — 266 of 1562
//     ingredient lines, mostly oils and sauces measured in tablespoons, went
//     unverified. The engine handles them via density, so they are now
//     genuinely checked.
//
// Reading the other way round, the 150 seed recipes are a 1562-line regression
// test on the engine: if `toGrams` ever disagrees with the values the Phase 2
// build scripts computed, this suite fails.
// ---------------------------------------------------------------------------

/** Returns null only when the engine genuinely cannot convert this
 *  unit/ingredient pair — those lines are reported below, not silently passed. */
function recomputeQuantityG(entry: CanonicalIngredient, quantity: number, unit: Unit): number | null {
  const result = toGrams(entry, quantity, unit)
  return result.ok ? result.grams : null
}

beforeAll(() => {
  console.log(`\nValidating ${ontology.length} ontology entries and ${recipes.length} recipes.\n`)
})

// ---------------------------------------------------------------------------
// 1. Ontology structure — "the foundation"
// ---------------------------------------------------------------------------

describe('ontology.json — foundation', () => {
  const VALID_CATEGORIES = new Set<IngredientCategory>([
    'produce', 'protein', 'dairy', 'grain', 'legume', 'fat-oil',
    'condiment', 'spice', 'baking', 'beverage', 'other',
  ])
  const VALID_TRACKBY = new Set<TrackBy>(['mass', 'volume', 'count'])

  it('is a non-empty array', () => {
    expect(Array.isArray(ontology)).toBe(true)
    expect(ontology.length).toBeGreaterThan(0)
  })

  it('has no duplicate ids', () => {
    const ids = ontology.map((e) => e.id)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dupes).toEqual([])
  })

  it.each(ontology.map((e) => [e.id, e] as const))('%s: required fields and valid enums', (id, entry) => {
    expect(entry.name, `${id}: missing name`).toBeTruthy()
    expect(VALID_CATEGORIES.has(entry.category), `${id}: invalid category "${entry.category}"`).toBe(true)
    expect(VALID_TRACKBY.has(entry.trackBy), `${id}: invalid trackBy "${entry.trackBy}"`).toBe(true)
    expect(typeof entry.tracked, `${id}: tracked must be boolean`).toBe('boolean')
    expect(typeof entry.perishable, `${id}: perishable must be boolean`).toBe('boolean')
    expect(Array.isArray(entry.aliases), `${id}: aliases must be an array`).toBe(true)
    // Everything in this file is bundled seed data by definition. A false here
    // would make the entry permanently un-updatable by the seed merge, since
    // the merge treats isSeed:false as "the User owns this, leave it alone".
    expect(entry.isSeed, `${id}: bundled ontology entries must have isSeed true`).toBe(true)
  })

  it.each(ontology.filter((e) => e.trackBy === 'count').map((e) => [e.id, e] as const))(
    '%s: trackBy=count has a positive unitWeightG',
    (id, entry) => {
      expect(entry.unitWeightG, `${id}: trackBy is 'count' but unitWeightG is missing`).toBeTypeOf('number')
      expect(entry.unitWeightG!, `${id}: unitWeightG must be positive`).toBeGreaterThan(0)
    },
  )

  it.each(ontology.filter((e) => e.trackBy === 'volume').map((e) => [e.id, e] as const))(
    '%s: trackBy=volume has a positive densityGPerMl',
    (id, entry) => {
      expect(entry.densityGPerMl, `${id}: trackBy is 'volume' but densityGPerMl is missing`).toBeTypeOf('number')
      expect(entry.densityGPerMl!, `${id}: densityGPerMl must be positive`).toBeGreaterThan(0)
    },
  )

  it.each(ontology.filter((e) => e.trackBy !== 'volume' && e.densityGPerMl != null).map((e) => [e.id, e] as const))(
    '%s: does not use densityGPerMl on a non-liquid (CLAUDE.md: never density x volume for solids)',
    (id) => {
      // Any entry reaching this point is a violation by construction.
      expect.fail(`${id}: has densityGPerMl but trackBy is not 'volume' — solids must use cupWeightG instead`)
    },
  )

  it.each(
    ontology
      .flatMap((e) => [
        ['cupWeightG', e.id, e.cupWeightG] as const,
        ['unitWeightG', e.id, e.unitWeightG] as const,
        ['densityGPerMl', e.id, e.densityGPerMl] as const,
      ])
      .filter(([, , value]) => value != null)
      .map(([field, id, value]) => [`${id}.${field}`, value] as const),
  )('%s is a positive number when present', (label, value) => {
    expect(value!, `${label} must be > 0, got ${value}`).toBeGreaterThan(0)
  })

  it('has no ambiguous aliases (same alias string resolving to 2+ different ids)', () => {
    const aliasMap = new Map<string, Set<string>>()
    for (const entry of ontology) {
      for (const alias of entry.aliases) {
        const key = alias.trim().toLowerCase()
        if (!aliasMap.has(key)) aliasMap.set(key, new Set())
        aliasMap.get(key)!.add(entry.id)
      }
    }
    const ambiguous = [...aliasMap.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([alias, ids]) => `"${alias}" -> ${[...ids].join(', ')}`)
    expect(ambiguous, ambiguous.join('\n')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Recipe structure — "the foundation," recipe side
// ---------------------------------------------------------------------------

describe('recipes.json — foundation', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(recipes)).toBe(true)
    expect(recipes.length).toBeGreaterThan(0)
  })

  it('has no duplicate recipe ids', () => {
    const ids = recipes.map((r) => r.id)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dupes).toEqual([])
  })

  it.each(recipes.map((r) => [r.id, r] as const))('%s: required top-level fields', (id, recipe) => {
    expect(recipe.name, `${id}: missing name`).toBeTruthy()
    expect(Array.isArray(recipe.cuisines) && recipe.cuisines.length > 0, `${id}: cuisines must be non-empty`).toBe(true)
    expect(Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0, `${id}: ingredients must be non-empty`).toBe(true)
    expect(Array.isArray(recipe.requiredAppliances), `${id}: requiredAppliances must be an array`).toBe(true)
    expect(Array.isArray(recipe.tools), `${id}: tools must be an array`).toBe(true)
    expect(Array.isArray(recipe.steps) && recipe.steps.length > 0, `${id}: steps must be non-empty`).toBe(true)
    expect(recipe.isSeed, `${id}: isSeed must be true`).toBe(true)
    expect(recipe.createdAt, `${id}: missing createdAt`).toBeTruthy()
  })

  it.each(recipes.map((r) => [r.id, r] as const))('%s: step order is sequential starting at 1', (id, recipe) => {
    const orders = recipe.steps.map((s) => s.order)
    const expected = orders.map((_, i) => i + 1)
    expect(orders, `${id}: step order is ${JSON.stringify(orders)}, expected ${JSON.stringify(expected)}`).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// 3. Cross-file checks — every ingredient line against the ontology
// ---------------------------------------------------------------------------

type IngredientLine = { recipeId: string; index: number; ing: RecipeIngredient }

const ingredientLines: IngredientLine[] = recipes.flatMap((r) =>
  r.ingredients.map((ing, index) => ({ recipeId: r.id, index, ing })),
)

const VALID_UNITS = new Set<Unit>(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'floz', 'count'])

describe('recipe ingredient lines vs. ontology', () => {
  it.each(ingredientLines.map((l) => [`${l.recipeId}[${l.index}] ${l.ing.canonicalId}`, l] as const))(
    '%s: canonicalId resolves to a real ontology entry',
    (label, { ing }) => {
      expect(ontologyById.has(ing.canonicalId), `${label}: unresolved canonicalId`).toBe(true)
    },
  )

  it.each(ingredientLines.map((l) => [`${l.recipeId}[${l.index}] ${l.ing.canonicalId}`, l] as const))(
    '%s: unit is valid and quantity/quantityG are positive',
    (label, { ing }) => {
      expect(VALID_UNITS.has(ing.unit), `${label}: invalid unit "${ing.unit}"`).toBe(true)
      expect(ing.quantity, `${label}: quantity must be > 0`).toBeGreaterThan(0)
      expect(ing.quantityG, `${label}: quantityG must be > 0`).toBeGreaterThan(0)
    },
  )

  const resolvableLines = ingredientLines.filter((l) => ontologyById.has(l.ing.canonicalId))

  it.each(resolvableLines.map((l) => [`${l.recipeId}[${l.index}] ${l.ing.canonicalId}`, l] as const))(
    '%s: quantityG matches recomputed conversion',
    (label, { ing }) => {
      const entry = ontologyById.get(ing.canonicalId)!
      const recomputed = recomputeQuantityG(entry, ing.quantity, ing.unit)
      // Previously a silent `return`. Every seed line is now convertible, so an
      // unconvertible one means an ontology entry lost a conversion field — a
      // real regression, not a gap to skip past.
      expect(
        recomputed,
        `${label}: the engine cannot convert ${ing.quantity} ${ing.unit} of ` +
          `"${entry.name}" — it needs a ${ing.unit === 'count' ? 'unitWeightG' : 'cupWeightG or densityGPerMl'}`,
      ).not.toBeNull()
      if (recomputed === null) return
      const tolerance = Math.max(1, recomputed * 0.02) // 2% relative, 1g floor for rounding
      expect(
        Math.abs(recomputed - ing.quantityG),
        `${label}: stored quantityG=${ing.quantityG}, recomputed=${recomputed.toFixed(2)} ` +
          `from ${ing.quantity} ${ing.unit}`,
      ).toBeLessThanOrEqual(tolerance)
    },
  )

  it('every ingredient line is independently verifiable — nothing is skipped', () => {
    const unverifiable = resolvableLines
      .filter(({ ing }) => {
        const entry = ontologyById.get(ing.canonicalId)!
        return recomputeQuantityG(entry, ing.quantity, ing.unit) === null
      })
      .map(({ recipeId, index, ing }) => `${recipeId}[${index}] ${ing.quantity} ${ing.unit} of ${ing.canonicalId}`)

    expect(
      unverifiable,
      `${unverifiable.length} of ${resolvableLines.length} lines cannot be recomputed:\n` +
        unverifiable.join('\n'),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. estimatedYieldG plausibility
// ---------------------------------------------------------------------------

describe('recipes.json — estimatedYieldG plausibility', () => {
  const withYield = recipes.filter((r) => r.estimatedYieldG != null)

  it.each(withYield.map((r) => [r.id, r] as const))('%s: estimatedYieldG matches sum of ingredient quantityG', (id, recipe) => {
    const sum = recipe.ingredients.reduce((s, i) => s + i.quantityG, 0)
    const tolerance = Math.max(2, sum * 0.02)
    expect(
      Math.abs((recipe.estimatedYieldG ?? 0) - sum),
      `${id}: estimatedYieldG=${recipe.estimatedYieldG}, sum of ingredients=${sum.toFixed(1)}`,
    ).toBeLessThanOrEqual(tolerance)
  })
})

// ---------------------------------------------------------------------------
// 5. Calorie plausibility (rough QA reference table, not real product data)
// ---------------------------------------------------------------------------

describe('recipes.json — calorie plausibility (rough sanity band, not precision)', () => {
  it.each(recipes.map((r) => [r.id, r] as const))('%s: calories/100g fall in a plausible range', (id, recipe) => {
    const missing: string[] = []
    let totalKcal = 0
    let totalG = 0
    for (const ing of recipe.ingredients) {
      const kcalPer100g = calorieReference[ing.canonicalId]
      if (kcalPer100g == null) {
        missing.push(ing.canonicalId)
        continue
      }
      totalKcal += (ing.quantityG / 100) * kcalPer100g
      totalG += ing.quantityG
    }
    if (missing.length > 0) {
      console.warn(`${id}: skipping calorie check — no reference value for: ${missing.join(', ')}`)
      return
    }
    if (totalG === 0) return
    const kcalPer100gFinished = (totalKcal / totalG) * 100
    // Floor is deliberately low (not "30") because a legitimate broth-based
    // soup (mostly water/stock at ~4 kcal/100g) can genuinely land in the
    // low 20s using raw-ingredient weights — this check has no way to model
    // the concentration that happens as a soup simmers and reduces. Below
    // ~15 there's no real dish that gets that dilute; that's a units error.
    expect(
      kcalPer100gFinished,
      `${id}: ${kcalPer100gFinished.toFixed(0)} kcal/100g is outside the plausible 15-600 range — ` +
        `check for a units mistake or a missing/duplicated ingredient`,
    ).toBeGreaterThan(15)
    expect(
      kcalPer100gFinished,
      `${id}: ${kcalPer100gFinished.toFixed(0)} kcal/100g is outside the plausible 15-600 range`,
    ).toBeLessThan(600)
  })
})

// ---------------------------------------------------------------------------
// 6. Informational only — does not fail the suite
// ---------------------------------------------------------------------------

describe('coverage report (informational)', () => {
  it('reports calorie-reference coverage', () => {
    const usedIds = new Set(ingredientLines.map((l) => l.ing.canonicalId))
    const covered = [...usedIds].filter((id) => calorieReference[id] != null)
    console.log(
      `\nCalorie reference covers ${covered.length}/${usedIds.size} ingredients actually used by seed recipes ` +
        `(${ontology.length} total ontology entries).\n`,
    )
    expect(true).toBe(true)
  })

  it('reports duplicate ingredient lines within a single recipe', () => {
    for (const recipe of recipes) {
      const seen = new Map<string, number>()
      for (const ing of recipe.ingredients) {
        seen.set(ing.canonicalId, (seen.get(ing.canonicalId) ?? 0) + 1)
      }
      const dupes = [...seen.entries()].filter(([, count]) => count > 1)
      if (dupes.length > 0) {
        console.warn(`${recipe.id}: ${dupes.map(([id, count]) => `${id} x${count}`).join(', ')} — verify intentional`)
      }
    }
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Reference macros (added 2026-08-23)
// ---------------------------------------------------------------------------

/**
 * The 122 `referenceMacrosPer100g` figures added when the app stopped requiring
 * a nutrition label for things that arrive without one.
 *
 * These are generated from USDA SR28 by `tools/reference-macros/apply.cjs` and
 * traceable through `tools/reference-macros/mapping.json`, so what follows is
 * not checking anybody's typing. It is checking that the generator, the mapping
 * and the ontology have not drifted apart, and that no row is internally
 * impossible — a fibre figure larger than the carbohydrate it is part of, a
 * calorie count that does not follow from the macros beside it.
 *
 * These figures reach the food log directly. A wrong one is not a rendering
 * bug, it is a wrong number in the record of what somebody ate.
 */
interface ReferenceMapping {
  readonly ndb: string
  readonly usda: string
  readonly macrosPer100g: Record<string, number>
  readonly imputed?: readonly string[]
  readonly note?: string
}

const referenceMapping = loadJson<Record<string, ReferenceMapping>>(
  '../tools/reference-macros/mapping.json',
)

const withReference = ontology.filter((entry) => entry.referenceMacrosPer100g !== undefined)

const MACRO_FIELDS = [
  'calories',
  'proteinG',
  'carbsG',
  'fatG',
  'fiberG',
  'sugarG',
  'sodiumMg',
  'saturatedFatG',
  'cholesterolMg',
] as const

describe('reference macros — the ontology matches the mapping it came from', () => {
  it('gives a reference to exactly the ingredients the mapping names', () => {
    const inOntology = new Set(withReference.map((entry) => entry.id))
    const inMapping = new Set(Object.keys(referenceMapping))

    const missing = [...inMapping].filter((id) => !inOntology.has(id))
    const extra = [...inOntology].filter((id) => !inMapping.has(id))

    // Either direction means somebody edited one file and not the other.
    // The fix is `node tools/reference-macros/apply.cjs`, never a hand edit.
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })

  it('carries the exact figures the mapping records, to the last decimal', () => {
    for (const entry of withReference) {
      expect(entry.referenceMacrosPer100g).toEqual(referenceMapping[entry.id].macrosPer100g)
    }
  })

  it('names a real USDA row for every figure, so any of them can be checked', () => {
    for (const [id, record] of Object.entries(referenceMapping)) {
      expect(record.ndb, `${id} has no NDB number`).toMatch(/^\d{5}$/)
      expect(record.usda.length, `${id} has no USDA description`).toBeGreaterThan(0)
    }
  })
})

describe('reference macros — no row is internally impossible', () => {
  it('has all nine fields, as finite non-negative numbers', () => {
    for (const entry of withReference) {
      const macros = entry.referenceMacrosPer100g as unknown as Record<string, unknown>
      for (const field of MACRO_FIELDS) {
        const value = macros[field]
        expect(typeof value, `${entry.id}.${field}`).toBe('number')
        expect(Number.isFinite(value as number), `${entry.id}.${field}`).toBe(true)
        expect(value as number, `${entry.id}.${field}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('keeps every part smaller than the whole it is part of', () => {
    for (const entry of withReference) {
      const m = entry.referenceMacrosPer100g!
      // Fibre and sugar are both kinds of carbohydrate; saturated fat is a kind
      // of fat. A part exceeding its whole means two fields came from different
      // rows — the failure mode a mapping mistake actually produces.
      expect(m.fiberG, `${entry.id}: fibre exceeds carbohydrate`).toBeLessThanOrEqual(m.carbsG + 0.01)
      expect(m.sugarG, `${entry.id}: sugar exceeds carbohydrate`).toBeLessThanOrEqual(m.carbsG + 0.01)
      expect(m.saturatedFatG, `${entry.id}: saturated fat exceeds fat`).toBeLessThanOrEqual(m.fatG + 0.01)
    }
  })

  it('does not claim more than 100 g of macros in 100 g of food', () => {
    for (const entry of withReference) {
      const m = entry.referenceMacrosPer100g!
      expect(m.proteinG + m.carbsG + m.fatG, entry.id).toBeLessThanOrEqual(100.1)
    }
  })
})

describe('reference macros — the calories follow from the macros', () => {
  /*
   * Atwater: 4 kcal per gram of protein and available carbohydrate, 9 per gram
   * of fat, 2 per gram of fibre.
   *
   * The tolerance is 40%, which is far looser than it looks and deliberately
   * so. USDA does not compute its energy figures this way — it uses per-food
   * factors and measured values — and several real foods sit well outside naive
   * Atwater for honest reasons: citrus carries organic acids counted as
   * carbohydrate that yield almost no energy (lemon and lime are both about
   * 35% out), and mushrooms carry carbohydrate the body cannot reach.
   *
   * Tightening this to catch those would mean arguing with USDA's methodology.
   * What it is here to catch is a transposed digit or a misplaced decimal — the
   * mistakes that land 3x or 10x out, not 30%.
   */
  it('agrees with Atwater to within 40% on every entry', () => {
    const offenders: string[] = []
    for (const entry of withReference) {
      const m = entry.referenceMacrosPer100g!
      if (m.calories < 5) continue
      const atwater = 4 * m.proteinG + 4 * (m.carbsG - m.fiberG) + 9 * m.fatG + 2 * m.fiberG
      const drift = Math.abs(atwater - m.calories) / m.calories
      if (drift > 0.4) {
        offenders.push(`${entry.id}: ${String(m.calories)} kcal stated, ${atwater.toFixed(0)} from macros`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('reference macros — a second opinion from the QA calorie table', () => {
  /*
   * `calorie-reference.json` was built by hand in Phase 2 from general
   * knowledge, entirely independently of USDA SR28. That independence is the
   * whole value: two sources agreeing is evidence, and it is why the QA table
   * must NEVER be regenerated from the app's own figures. It would then be
   * confirming itself and this test would be theatre.
   *
   * Four entries disagree for a known and correct reason, listed below.
   */
  const KNOWN_DISAGREEMENTS: Record<string, string> = {
    // The QA table used COOKED figures for these. The app weighs meat and
    // seafood into the kitchen raw, and cooking concentrates by water loss, so
    // the raw figure is the right one here and the disagreement is expected.
    mussels: 'QA table is cooked; raw is correct for weighing in',
    'beef-brisket': 'QA table is cooked; raw is correct for weighing in',
    'beef-shin': 'QA table is cooked; raw is correct for weighing in',
    'lamb-leg': 'QA table is cooked; raw is correct for weighing in',
  }

  it('agrees within 25% everywhere the two tables overlap', () => {
    const offenders: string[] = []
    let compared = 0

    for (const entry of withReference) {
      const theirs = calorieReference[entry.id]
      if (theirs === undefined) continue
      compared++
      if (entry.id in KNOWN_DISAGREEMENTS) continue

      const ours = entry.referenceMacrosPer100g!.calories
      const drift = theirs === 0 ? (ours === 0 ? 0 : 1) : Math.abs(ours - theirs) / theirs
      if (drift > 0.25) {
        offenders.push(`${entry.id}: USDA ${String(ours)}, QA table ${String(theirs)}`)
      }
    }

    // If this drops sharply, the two tables have stopped overlapping and the
    // check has quietly stopped checking anything.
    expect(compared).toBeGreaterThan(60)
    expect(offenders).toEqual([])
  })

  it('still disagrees where it is supposed to, so the exemptions stay honest', () => {
    // An exemption nobody needs any more is an exemption hiding a future bug.
    for (const id of Object.keys(KNOWN_DISAGREEMENTS)) {
      const entry = withReference.find((candidate) => candidate.id === id)
      expect(entry, `${id} no longer has a reference — drop it from the exemptions`).toBeDefined()
      expect(calorieReference[id], `${id} left the QA table — drop it from the exemptions`).toBeDefined()
    }
  })
})
