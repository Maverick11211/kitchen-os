/**
 * Kitchen OS — What is left of a cooked batch
 *
 * Cooking and eating are separate events (DECISIONS.md). A `CookEvent` records
 * what left the kitchen; `fractionConsumed` records how much of the result has
 * since been eaten, and the arithmetic connecting the two lives here rather than
 * being written out again in the repository and in the screens.
 *
 * It is a small module on purpose. Everything a batch needs to know is one
 * subtraction — but that subtraction decides which portion buttons a screen
 * offers, whether a batch appears in the log sheet at all, and how much is
 * actually recorded when a stale screen asks for more than there is. Three
 * copies of one subtraction is how those three answers drift apart.
 *
 * Pure and clock-free, like the rest of `src/engine/`.
 */
import type { CookEvent } from '../types/schema'

/**
 * Below this, a fraction is treated as zero.
 *
 * The same reasoning as `GRAM_EPSILON` in `inventory.ts`: eating a batch in
 * thirds leaves 2.2e-16 behind, and without a floor that batch is "open"
 * forever and shows up in the log sheet offering a portion of nothing.
 */
export const FRACTION_EPSILON = 1e-6

/** How much of a batch has not been eaten yet, 0..1. */
export function remainingFraction(cook: Pick<CookEvent, 'fractionConsumed'>): number {
  const left = 1 - cook.fractionConsumed
  if (left <= FRACTION_EPSILON) return 0
  return Math.min(1, left)
}

/**
 * Whether there is still something of this batch to eat.
 *
 * What decides that a cook appears in the log sheet. A finished batch is not
 * deleted — it is history, and the day it fed is computed from it — it simply
 * stops being something you can serve yourself from.
 */
export function isBatchOpen(cook: Pick<CookEvent, 'fractionConsumed'>): boolean {
  return remainingFraction(cook) > 0
}

/**
 * The portion that can actually be recorded, given what is left.
 *
 * Clamps rather than refuses, for the same reason `planDeduction` does: the
 * screen that asked was built from a snapshot, and by the time the answer
 * arrives another portion may already have been logged. The caller compares the
 * result with what it asked for and says so out loud when they differ — the
 * same shape as `shortfallG` on a logged ingredient.
 *
 * Negative and non-finite requests come back as zero rather than throwing. This
 * is the one place a fraction is sanitised, and every caller checks the result
 * before writing anything.
 */
export function clampPortion(requested: number, remaining: number): number {
  if (!Number.isFinite(requested) || requested <= FRACTION_EPSILON) return 0
  return Math.min(requested, Math.max(0, remaining))
}

/**
 * Add a portion back onto a batch, for an entry being un-deleted.
 *
 * Capped at a whole batch, the same ceiling `revertDeductions` puts on a lot and
 * for the same reason: a batch cannot come to hold more than it was cooked as.
 */
export function addPortion(fractionConsumed: number, portion: number): number {
  const next = fractionConsumed + portion
  if (next >= 1 - FRACTION_EPSILON) return Math.min(1, next)
  return next
}

/** Take a portion off a batch, for an entry being deleted. Never negative. */
export function removePortion(fractionConsumed: number, portion: number): number {
  const next = fractionConsumed - portion
  return next <= FRACTION_EPSILON ? 0 : next
}
