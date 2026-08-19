/**
 * Kitchen OS — Unit conversion
 *
 * The single source of truth for turning any `Unit` into grams and back.
 * Everything else in the app (and `qa/seed-data.validate.test.ts`) goes
 * through here — there is deliberately no second copy of this math.
 *
 * Rules, from CLAUDE.md and DECISIONS.md:
 *  - Grams are the only internal unit. Units are an input/display concern.
 *  - Volume-to-mass for SOLIDS uses `cupWeightG`, never density. A cup of
 *    shredded cheese and a cup of cubed cheese weigh different amounts and
 *    density math gets neither.
 *  - `densityGPerMl` is consulted ONLY when `trackBy === 'volume'`.
 *
 * Nothing here throws. A conversion that cannot be performed (because the
 * ingredient lacks the field it would need) returns a typed failure, so the
 * caller can say so out loud instead of silently producing NaN.
 */
import type { CanonicalIngredient, Unit } from '../types/schema'

// ---------------------------------------------------------------------------
// Constants — must match the values the Phase 2 build scripts used, or every
// precomputed `RecipeIngredient.quantityG` in the seed data drifts.
// ---------------------------------------------------------------------------

/** Millilitres in one US cup. */
export const CUP_ML = 236.588
export const TBSP_PER_CUP = 16
export const TSP_PER_CUP = 48
export const OZ_G = 28.3495
export const LB_G = 453.592
export const FLOZ_ML = 29.5735

/** Grams in one of each mass unit. */
const MASS_UNIT_G: Readonly<Record<'g' | 'kg' | 'oz' | 'lb', number>> = {
  g: 1,
  kg: 1000,
  oz: OZ_G,
  lb: LB_G,
}

/** Millilitres in one of each volume unit. */
const VOLUME_UNIT_ML: Readonly<Record<'ml' | 'l' | 'floz' | 'tsp' | 'tbsp' | 'cup', number>> = {
  ml: 1,
  l: 1000,
  floz: FLOZ_ML,
  tsp: CUP_ML / TSP_PER_CUP,
  tbsp: CUP_ML / TBSP_PER_CUP,
  cup: CUP_ML,
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ConversionFailureReason =
  /** Unit is `count` but the ingredient has no `unitWeightG`. */
  | 'missing-unit-weight'
  /** A volume unit was used but the ingredient has neither `cupWeightG` nor
   *  (for liquids) `densityGPerMl`. */
  | 'missing-volume-conversion'
  /** Quantity was negative, NaN, or infinite. */
  | 'invalid-quantity'
  /** Unit string is not a member of `Unit`. Only reachable from untyped input. */
  | 'unknown-unit'

export interface ConversionFailure {
  readonly ok: false
  readonly reason: ConversionFailureReason
  /** Human-readable, safe to surface in the UI. */
  readonly message: string
}

export type ToGramsResult = { readonly ok: true; readonly grams: number } | ConversionFailure

export type FromGramsResult = { readonly ok: true; readonly quantity: number } | ConversionFailure

function fail(reason: ConversionFailureReason, message: string): ConversionFailure {
  return { ok: false, reason, message }
}

// ---------------------------------------------------------------------------
// Unit classification
// ---------------------------------------------------------------------------

export function isMassUnit(unit: Unit): unit is 'g' | 'kg' | 'oz' | 'lb' {
  return unit in MASS_UNIT_G
}

export function isVolumeUnit(unit: Unit): unit is 'ml' | 'l' | 'floz' | 'tsp' | 'tbsp' | 'cup' {
  return unit in VOLUME_UNIT_ML
}

// ---------------------------------------------------------------------------
// The one place volume becomes mass
// ---------------------------------------------------------------------------

/**
 * Grams per millilitre for this ingredient, or null if it cannot be determined.
 *
 * This is the ONLY function that decides how volume becomes mass, which is what
 * makes the "never density x volume for solids" rule enforceable in one place
 * rather than repeated across every unit branch.
 *
 * Order matters:
 *  1. True liquids (`trackBy === 'volume'`) use their measured density.
 *  2. Everything else derives from `cupWeightG` — a cup IS a volume, so
 *     `cupWeightG / CUP_ML` is the ingredient's real packed grams-per-ml in
 *     the form it's normally measured in. This is NOT the same as looking up
 *     the substance's bulk density, which is the thing that gets shredded and
 *     chopped foods wrong.
 */
export function gramsPerMl(ingredient: CanonicalIngredient): number | null {
  if (ingredient.trackBy === 'volume' && ingredient.densityGPerMl != null) {
    return ingredient.densityGPerMl
  }
  if (ingredient.cupWeightG != null) {
    return ingredient.cupWeightG / CUP_ML
  }
  return null
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function checkQuantity(quantity: number): ConversionFailure | null {
  if (!Number.isFinite(quantity)) {
    return fail('invalid-quantity', `Quantity must be a finite number, got ${quantity}.`)
  }
  if (quantity < 0) {
    return fail('invalid-quantity', `Quantity must not be negative, got ${quantity}.`)
  }
  return null
}

/**
 * Convert `quantity` of `unit` into grams for this ingredient.
 *
 * Recipes store the result as `RecipeIngredient.quantityG` so ranking never has
 * to convert on render.
 */
export function toGrams(
  ingredient: CanonicalIngredient,
  quantity: number,
  unit: Unit,
): ToGramsResult {
  const bad = checkQuantity(quantity)
  if (bad) return bad

  if (isMassUnit(unit)) {
    return { ok: true, grams: quantity * MASS_UNIT_G[unit] }
  }

  if (unit === 'count') {
    if (ingredient.unitWeightG == null) {
      return fail(
        'missing-unit-weight',
        `"${ingredient.name}" has no unitWeightG, so a count cannot be converted to grams.`,
      )
    }
    return { ok: true, grams: quantity * ingredient.unitWeightG }
  }

  if (isVolumeUnit(unit)) {
    const density = gramsPerMl(ingredient)
    if (density == null) {
      return fail(
        'missing-volume-conversion',
        `"${ingredient.name}" has neither cupWeightG nor densityGPerMl, ` +
          `so ${unit} cannot be converted to grams.`,
      )
    }
    return { ok: true, grams: quantity * VOLUME_UNIT_ML[unit] * density }
  }

  return fail('unknown-unit', `Unrecognised unit "${String(unit)}".`)
}

/**
 * Convert grams back into `unit` — the display direction. Used wherever the UI
 * shows a stored gram value in the unit the user actually thinks in.
 */
export function fromGrams(
  ingredient: CanonicalIngredient,
  grams: number,
  unit: Unit,
): FromGramsResult {
  const bad = checkQuantity(grams)
  if (bad) return bad

  if (isMassUnit(unit)) {
    return { ok: true, quantity: grams / MASS_UNIT_G[unit] }
  }

  if (unit === 'count') {
    if (ingredient.unitWeightG == null) {
      return fail(
        'missing-unit-weight',
        `"${ingredient.name}" has no unitWeightG, so grams cannot be shown as a count.`,
      )
    }
    return { ok: true, quantity: grams / ingredient.unitWeightG }
  }

  if (isVolumeUnit(unit)) {
    const density = gramsPerMl(ingredient)
    if (density == null) {
      return fail(
        'missing-volume-conversion',
        `"${ingredient.name}" has neither cupWeightG nor densityGPerMl, ` +
          `so grams cannot be shown as ${unit}.`,
      )
    }
    return { ok: true, quantity: grams / (VOLUME_UNIT_ML[unit] * density) }
  }

  return fail('unknown-unit', `Unrecognised unit "${String(unit)}".`)
}

/** True when `toGrams` would succeed for this ingredient/unit pair. */
export function canConvert(ingredient: CanonicalIngredient, unit: Unit): boolean {
  return toGrams(ingredient, 1, unit).ok
}

/**
 * Every unit this ingredient can be expressed in, for populating a unit picker
 * without offering choices that would fail.
 */
export function convertibleUnits(ingredient: CanonicalIngredient): Unit[] {
  const all: Unit[] = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'floz', 'count']
  return all.filter((unit) => canConvert(ingredient, unit))
}
