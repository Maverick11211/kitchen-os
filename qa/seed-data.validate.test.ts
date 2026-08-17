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
// Conversion math, mirroring the build scripts' constants exactly so this
// test recomputes quantityG the same way it was originally computed.
// ---------------------------------------------------------------------------

const CUP_ML = 236.588
const OZ_G = 28.3495
const LB_G = 453.592
const FLOZ_ML = 29.5735

/** Returns null when the ontology entry doesn't carry the field needed to
 *  independently verify this unit — those lines are skipped, not failed. */
function recomputeQuantityG(entry: CanonicalIngredient, quantity: number, unit: Unit): number | null {
  switch (unit) {
    case 'g':
      return quantity
    case 'kg':
      return quantity * 1000
    case 'oz':
      return quantity * OZ_G
    case 'lb':
      return quantity * LB_G
    case 'count':
      return entry.unitWeightG != null ? quantity * entry.unitWeightG : null
    case 'cup':
      return entry.cupWeightG != null ? quantity * entry.cupWeightG : null
    case 'tbsp':
      return entry.cupWeightG != null ? quantity * (entry.cupWeightG / 16) : null
    case 'tsp':
      return entry.cupWeightG != null ? quantity * (entry.cupWeightG / 48) : null
    case 'ml':
      if (entry.trackBy === 'volume' && entry.densityGPerMl != null) return quantity * entry.densityGPerMl
      if (entry.cupWeightG != null) return quantity * (entry.cupWeightG / CUP_ML)
      return null
    case 'l':
      if (entry.trackBy === 'volume' && entry.densityGPerMl != null) return quantity * 1000 * entry.densityGPerMl
      if (entry.cupWeightG != null) return quantity * 1000 * (entry.cupWeightG / CUP_ML)
      return null
    case 'floz': {
      const ml = quantity * FLOZ_ML
      if (entry.trackBy === 'volume' && entry.densityGPerMl != null) return ml * entry.densityGPerMl
      if (entry.cupWeightG != null) return ml * (entry.cupWeightG / CUP_ML)
      return null
    }
    default:
      return null
  }
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
      if (recomputed === null) return // can't independently verify this unit/entry combo — not a failure
      const tolerance = Math.max(1, recomputed * 0.02) // 2% relative, 1g floor for rounding
      expect(
        Math.abs(recomputed - ing.quantityG),
        `${label}: stored quantityG=${ing.quantityG}, recomputed=${recomputed.toFixed(2)} ` +
          `from ${ing.quantity} ${ing.unit}`,
      ).toBeLessThanOrEqual(tolerance)
    },
  )
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
