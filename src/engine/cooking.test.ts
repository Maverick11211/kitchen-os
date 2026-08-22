/**
 * What is left of a cooked batch.
 *
 * Small module, but the cases below are the ones that decide whether a batch
 * hangs around in the log sheet forever offering a portion of nothing, and
 * whether a stale screen can push a batch past fully eaten.
 */
import { describe, expect, it } from 'vitest'
import {
  FRACTION_EPSILON,
  addPortion,
  clampPortion,
  isBatchOpen,
  remainingFraction,
  removePortion,
} from './cooking'

describe('remainingFraction', () => {
  it('is the whole batch when nothing has been eaten', () => {
    expect(remainingFraction({ fractionConsumed: 0 })).toBe(1)
  })

  it('is what is left after a portion', () => {
    expect(remainingFraction({ fractionConsumed: 0.25 })).toBeCloseTo(0.75)
  })

  it('is zero for a finished batch', () => {
    expect(remainingFraction({ fractionConsumed: 1 })).toBe(0)
  })

  /*
   * The reason FRACTION_EPSILON exists. Three portions of a third leave
   * 1.1e-16 behind; without a floor the batch stays "open" forever and appears
   * in the log sheet offering a portion of nothing.
   */
  it('treats floating-point crumbs as nothing', () => {
    const third = 1 / 3
    const eaten = third + third + third
    expect(remainingFraction({ fractionConsumed: eaten })).toBe(0)
  })

  it('never goes negative, even if a batch was somehow over-eaten', () => {
    expect(remainingFraction({ fractionConsumed: 1.4 })).toBe(0)
  })
})

describe('isBatchOpen', () => {
  it('is true while there is something left', () => {
    expect(isBatchOpen({ fractionConsumed: 0.99 })).toBe(true)
  })

  it('is false once it is finished', () => {
    expect(isBatchOpen({ fractionConsumed: 1 })).toBe(false)
  })

  it('is false for a crumb, not true', () => {
    expect(isBatchOpen({ fractionConsumed: 1 - FRACTION_EPSILON / 2 })).toBe(false)
  })
})

describe('clampPortion', () => {
  it('gives back what was asked for when there is enough', () => {
    expect(clampPortion(0.25, 0.75)).toBe(0.25)
  })

  /*
   * The stale-screen case: a sheet opened when the batch was whole, tapped
   * after someone already had half. This clamps rather than refusing, and the
   * caller reports the difference — the same shape as `shortfallG`.
   */
  it('takes only what is left when asked for more', () => {
    expect(clampPortion(0.75, 0.4)).toBeCloseTo(0.4)
  })

  it('is zero when there is nothing left', () => {
    expect(clampPortion(0.5, 0)).toBe(0)
  })

  it('is zero for a request that is not a real portion', () => {
    expect(clampPortion(0, 1)).toBe(0)
    expect(clampPortion(-0.5, 1)).toBe(0)
    expect(clampPortion(Number.NaN, 1)).toBe(0)
    // Infinity is not a portion either. Sanitised here so that every caller can
    // simply check the result before writing anything.
    expect(clampPortion(Number.POSITIVE_INFINITY, 1)).toBe(0)
  })
})

describe('addPortion', () => {
  it('adds a portion on', () => {
    expect(addPortion(0.25, 0.25)).toBeCloseTo(0.5)
  })

  /*
   * A batch cannot come to hold more than it was cooked as — the same ceiling
   * `revertDeductions` puts on a lot. Two Undos from a stale screen must not
   * leave a batch 150% eaten.
   */
  it('caps at a whole batch', () => {
    expect(addPortion(0.9, 0.5)).toBe(1)
  })
})

describe('removePortion', () => {
  it('takes a portion off', () => {
    expect(removePortion(0.75, 0.25)).toBeCloseTo(0.5)
  })

  it('never goes negative', () => {
    expect(removePortion(0.25, 0.5)).toBe(0)
  })

  it('lands exactly on zero rather than on a crumb', () => {
    const third = 1 / 3
    expect(removePortion(third, third)).toBe(0)
  })
})
