/**
 * Kitchen OS — Macro arithmetic
 *
 * Deliberately small. Products carry `macrosPer100g`; everything the app
 * displays is that number scaled by grams and added up.
 *
 * The immutability rule from DECISIONS.md is enforced structurally rather than
 * by convention: these functions take numbers in and hand a fresh `MacroSet`
 * back for the caller to STORE on a `CookEvent` or `ConsumptionEvent`. Nothing
 * here ever reaches back into a product to recompute a past event, so
 * correcting a product's nutrition tomorrow cannot rewrite last month's totals.
 *
 * `CanonicalIngredient` carries no macros by design — only `Product` does — so
 * untracked staples (salt, water) contribute nothing here automatically: they
 * never get a product, so they never produce a line.
 */
import type { MacroSet } from '../types/schema'

/** Every field of a MacroSet, for iteration and exhaustiveness. */
export const MACRO_KEYS = [
  'calories',
  'proteinG',
  'carbsG',
  'fatG',
  'fiberG',
  'sugarG',
  'sodiumMg',
  'saturatedFatG',
] as const satisfies readonly (keyof MacroSet)[]

/** An empty macro set. Frozen — treat it as a value, never mutate it. */
export const ZERO_MACROS: Readonly<MacroSet> = Object.freeze({
  calories: 0,
  proteinG: 0,
  carbsG: 0,
  fatG: 0,
  fiberG: 0,
  sugarG: 0,
  sodiumMg: 0,
  saturatedFatG: 0,
})

/**
 * Build a MacroSet by computing each field. Written out longhand rather than
 * looped so TypeScript can prove every field is present without an `any` or a
 * partial cast.
 */
function buildMacros(valueFor: (key: keyof MacroSet) => number): MacroSet {
  return {
    calories: valueFor('calories'),
    proteinG: valueFor('proteinG'),
    carbsG: valueFor('carbsG'),
    fatG: valueFor('fatG'),
    fiberG: valueFor('fiberG'),
    sugarG: valueFor('sugarG'),
    sodiumMg: valueFor('sodiumMg'),
    saturatedFatG: valueFor('saturatedFatG'),
  }
}

/** Multiply every field by `factor`. */
export function multiplyMacros(macros: MacroSet, factor: number): MacroSet {
  return buildMacros((key) => macros[key] * factor)
}

/**
 * How much of each macro is in `grams` of something whose label reads
 * `per100g`. The workhorse — every calorie the app shows comes through here.
 */
export function scaleMacros(per100g: MacroSet, grams: number): MacroSet {
  return multiplyMacros(per100g, grams / 100)
}

/**
 * The portion of a batch actually eaten. Consumption is logged as a fraction
 * of what was cooked (DECISIONS.md: "no serving counts"), so this is what
 * turns a `CookEvent.batchMacros` into a `ConsumptionEvent.macros`.
 */
export function fractionOfMacros(batch: MacroSet, fraction: number): MacroSet {
  return multiplyMacros(batch, fraction)
}

export function addMacros(a: MacroSet, b: MacroSet): MacroSet {
  return buildMacros((key) => a[key] + b[key])
}

export function subtractMacros(a: MacroSet, b: MacroSet): MacroSet {
  return buildMacros((key) => a[key] - b[key])
}

/** Total of any number of macro sets. Empty list gives a zero set. */
export function sumMacros(sets: readonly MacroSet[]): MacroSet {
  return buildMacros((key) => sets.reduce((total, set) => total + set[key], 0))
}

/**
 * One contributing item: some number of grams of something with known
 * per-100g nutrition. Keeping this shape free of Product/Lot means the macro
 * math has no opinion about where the numbers came from.
 */
export interface MacroLine {
  readonly grams: number
  readonly macrosPer100g: MacroSet
}

/** Total macros across several ingredients. Used for a whole cooked batch. */
export function macrosForLines(lines: readonly MacroLine[]): MacroSet {
  return buildMacros((key) =>
    lines.reduce((total, line) => total + line.macrosPer100g[key] * (line.grams / 100), 0),
  )
}

/** Sum the day's consumption. Same as `sumMacros`, named for how it reads. */
export function totalMacros(events: readonly { readonly macros: MacroSet }[]): MacroSet {
  return sumMacros(events.map((event) => event.macros))
}

/**
 * Round for display only. Never round before storing — the ±15% tolerance in
 * DECISIONS.md is about accepting real-world variance, not about throwing away
 * precision that costs nothing to keep.
 */
export function roundMacros(macros: MacroSet): MacroSet {
  return {
    calories: Math.round(macros.calories),
    proteinG: Math.round(macros.proteinG * 10) / 10,
    carbsG: Math.round(macros.carbsG * 10) / 10,
    fatG: Math.round(macros.fatG * 10) / 10,
    fiberG: Math.round(macros.fiberG * 10) / 10,
    sugarG: Math.round(macros.sugarG * 10) / 10,
    sodiumMg: Math.round(macros.sodiumMg),
    saturatedFatG: Math.round(macros.saturatedFatG * 10) / 10,
  }
}

/** True when every field is zero. */
export function isZeroMacros(macros: MacroSet): boolean {
  return MACRO_KEYS.every((key) => macros[key] === 0)
}
