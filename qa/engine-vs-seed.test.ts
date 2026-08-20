/**
 * Runs the Phase 3 engine against the real seed data — all 310 ontology entries
 * and all 150 recipes — rather than hand-built fixtures.
 *
 * The unit tests in `src/engine/*.test.ts` prove each function behaves as
 * specified. This file proves the specification survives contact with the
 * actual data: that every seed line converts, that cooking the whole library
 * conserves mass exactly, and that ranking produces a sane spread rather than
 * everything landing at 0% or 100%.
 *
 * Lives in qa/ for the same reason the seed validator does — it reads the JSON
 * off disk with `node:fs`, which the app's own tsconfig has no types for.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { CanonicalIngredient, Lot, MacroSet, Product, Recipe } from '../src/types/schema'
import { buildOntologyIndex } from '../src/engine/ontology'
import {
  applyDeductions,
  buildInventoryIndex,
  planRecipeDeduction,
} from '../src/engine/inventory'
import { evaluateOwnership, missingOneTier, rankRecipes } from '../src/engine/ownership'
import { toGrams } from '../src/engine/units'

const here = dirname(fileURLToPath(import.meta.url))

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(here, relativePath), 'utf-8')) as T
}

const ontology = loadJson<CanonicalIngredient[]>('../src/data/ontology.json')
const recipes = loadJson<Recipe[]>('../src/data/recipes.json')
const ontologyIndex = buildOntologyIndex(ontology)

const TODAY = '2026-08-19'
const NOW = '2026-08-19T12:00:00.000Z'

/** Placeholder nutrition: exactly 200 kcal/100g, so totals are checkable by hand. */
const FLAT_MACROS: MacroSet = {
  calories: 200, proteinG: 10, carbsG: 20, fatG: 5,
  fiberG: 1, sugarG: 2, sodiumMg: 100, saturatedFatG: 1, cholesterolMg: 0,
}

/** A pantry holding `gramsEach` of every ontology entry. Half expire soon. */
function fullPantry(gramsEach: number): { products: Product[]; lots: Lot[] } {
  const products = ontology.map((entry) => ({
    id: `p-${entry.id}`,
    canonicalId: entry.id,
    name: entry.name,
    macrosPer100g: FLAT_MACROS,
    createdAt: NOW,
  }))
  const lots = ontology.map((entry, n) => ({
    id: `l-${entry.id}`,
    productId: `p-${entry.id}`,
    initialG: gramsEach,
    remainingG: gramsEach,
    expiresOn: n % 2 === 0 ? '2026-08-21' : null,
    acquiredOn: '2026-08-01',
    depleted: false,
  }))
  return { products, lots }
}

describe('engine vs. seed data — conversion', () => {
  it('converts every one of the seed set\'s ingredient lines', () => {
    const failures: string[] = []
    for (const recipe of recipes) {
      for (const [index, ing] of recipe.ingredients.entries()) {
        const entry = ontologyIndex.get(ing.canonicalId)
        if (!entry) {
          failures.push(`${recipe.id}[${index}]: unknown canonical ${ing.canonicalId}`)
          continue
        }
        const result = toGrams(entry, ing.quantity, ing.unit)
        if (!result.ok) failures.push(`${recipe.id}[${index}]: ${result.message}`)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})

describe('engine vs. seed data — cooking the whole library', () => {
  it('conserves mass exactly across all 150 recipes', () => {
    const { products } = fullPantry(50_000)
    let lots = fullPantry(50_000).lots
    let totalPlanned = 0
    const startingGrams = lots.reduce((sum, lot) => sum + lot.remainingG, 0)

    for (const recipe of recipes) {
      const index = buildInventoryIndex(products, lots)
      const plan = planRecipeDeduction(index, ontologyIndex, recipe, 1)
      // A 50kg-of-everything pantry covers every seed recipe at 1x.
      expect(plan.complete, `${recipe.id}: ${JSON.stringify(plan.shortfalls)}`).toBe(true)
      totalPlanned += plan.deductions.reduce((sum, d) => sum + d.grams, 0)
      lots = applyDeductions(lots, plan.deductions, NOW)
    }

    const removed = startingGrams - lots.reduce((sum, lot) => sum + lot.remainingG, 0)
    expect(removed).toBeCloseTo(totalPlanned, 6)
    expect(totalPlanned).toBeGreaterThan(0)
  })

  it('never drives a lot negative, even cooking everything twice over', () => {
    const { products } = fullPantry(1_000)
    let lots = fullPantry(1_000).lots
    for (const recipe of [...recipes, ...recipes]) {
      const index = buildInventoryIndex(products, lots)
      const plan = planRecipeDeduction(index, ontologyIndex, recipe, 1)
      lots = applyDeductions(lots, plan.deductions, NOW)
    }
    expect(lots.every((lot) => lot.remainingG >= 0)).toBe(true)
    expect(lots.every((lot) => !lot.depleted || lot.remainingG === 0)).toBe(true)
    expect(lots.every((lot) => !lot.depleted || lot.depletedAt !== undefined)).toBe(true)
    // Depleted lots are retained, never dropped.
    expect(lots).toHaveLength(ontology.length)
  })

  it('reports shortfalls rather than failing when the pantry is thin', () => {
    const { products, lots } = fullPantry(5)
    const index = buildInventoryIndex(products, lots)
    const plans = recipes.map((r) => planRecipeDeduction(index, ontologyIndex, r, 1))
    expect(plans.some((p) => !p.complete)).toBe(true)
    for (const plan of plans) {
      for (const shortfall of plan.shortfalls) {
        expect(shortfall.shortfallG).toBeGreaterThan(0)
        expect(shortfall.shortfallG).toBeLessThanOrEqual(shortfall.requestedG)
      }
    }
  })

  it('never plans a deduction for an untracked staple', () => {
    const { products, lots } = fullPantry(50_000)
    const index = buildInventoryIndex(products, lots)
    const untracked = new Set(ontology.filter((e) => !e.tracked).map((e) => e.id))
    expect(untracked.size).toBeGreaterThan(0)

    for (const recipe of recipes) {
      const plan = planRecipeDeduction(index, ontologyIndex, recipe, 1)
      for (const deduction of plan.deductions) {
        expect(untracked.has(deduction.canonicalId), `${recipe.id} deducted a staple`).toBe(false)
      }
    }
  })
})

describe('engine vs. seed data — ownership ranking', () => {
  it('ranks every recipe at 100% from a full pantry', () => {
    const { products, lots } = fullPantry(50_000)
    const ranked = rankRecipes(recipes, buildInventoryIndex(products, lots), ontologyIndex, {
      today: TODAY,
    })
    expect(ranked).toHaveLength(recipes.length)
    expect(ranked.every((r) => r.ownershipFraction === 1)).toBe(true)
    expect(ranked.every((r) => r.maxBatchScale >= 1)).toBe(true)
    expect(missingOneTier(ranked)).toEqual([])
  })

  it('ranks every recipe at 0% from an empty pantry, without NaN', () => {
    const empty = buildInventoryIndex([], [])
    const ranked = rankRecipes(recipes, empty, ontologyIndex, { today: TODAY })
    expect(ranked.every((r) => r.ownershipFraction === 0)).toBe(true)
    expect(ranked.every((r) => Number.isFinite(r.ownershipFraction))).toBe(true)
    expect(ranked.every((r) => r.maxBatchScale === 0)).toBe(true)
  })

  it('produces a real spread from a partial pantry, sorted descending', () => {
    const { products, lots } = fullPantry(50_000)
    const index = buildInventoryIndex(
      products.filter((_, i) => i % 3 === 0),
      lots.filter((_, i) => i % 3 === 0),
    )
    const ranked = rankRecipes(recipes, index, ontologyIndex, { today: TODAY })

    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.ownershipFraction).toBeGreaterThanOrEqual(ranked[i]!.ownershipFraction)
    }
    const fractions = new Set(ranked.map((r) => r.ownershipFraction))
    expect(fractions.size).toBeGreaterThan(5)
    expect(ranked[0]!.ownershipFraction).toBeGreaterThan(0)
    expect(ranked[0]!.ownershipFraction).toBeLessThan(1)
  })

  it('every counted line is a tracked, non-optional ingredient', () => {
    const { products, lots } = fullPantry(50_000)
    const index = buildInventoryIndex(products, lots)
    for (const recipe of recipes) {
      const result = evaluateOwnership(recipe, index, ontologyIndex, { today: TODAY })
      expect(result.lines).toHaveLength(recipe.ingredients.length)
      for (const line of result.lines) {
        const entry = ontologyIndex.get(line.canonicalId)
        expect(line.counted).toBe((entry?.tracked ?? true) && !line.optional)
      }
      expect(result.countedCount).toBeGreaterThan(0)
    }
  })

  it('is stable — ranking the same library twice gives the same order', () => {
    const { products, lots } = fullPantry(50_000)
    const index = buildInventoryIndex(
      products.filter((_, i) => i % 4 === 0),
      lots.filter((_, i) => i % 4 === 0),
    )
    const first = rankRecipes(recipes, index, ontologyIndex, { today: TODAY }).map((r) => r.recipeId)
    const shuffled = [...recipes].reverse()
    const second = rankRecipes(shuffled, index, ontologyIndex, { today: TODAY }).map((r) => r.recipeId)
    expect(second).toEqual(first)
  })
})
