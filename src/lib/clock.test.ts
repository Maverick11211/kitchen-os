/**
 * Kitchen OS — Local days
 *
 * The one piece of the nutrition phase that has to know the device's timezone.
 * A day is local midnight to local midnight (Jack, 2026-08-20) while
 * `consumedAt` is a UTC instant, so these tests pin `TZ` and check the
 * conversion in both directions — including the two days a year that are not 24
 * hours long.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatTime, localDayOf, localDayRange, msUntilNextLocalDay, todayIso } from './clock'

/** Where the iPad lives. Pinned so these tests mean the same thing anywhere. */
const DEVICE_TZ = 'America/New_York'

beforeEach(() => {
  vi.stubEnv('TZ', DEVICE_TZ)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * Run a block with the device somewhere else.
 *
 * Node re-reads `TZ` when it is assigned, so this genuinely moves the clock
 * rather than only changing a label.
 */
function inTimezone(tz: string, run: () => void): void {
  vi.stubEnv('TZ', tz)
  try {
    run()
  } finally {
    vi.stubEnv('TZ', DEVICE_TZ)
  }
}

describe('localDayRange', () => {
  it('starts and ends at local midnight, expressed in UTC', () => {
    // New York in August is UTC-4, so local midnight is 04:00 UTC.
    expect(localDayRange('2026-08-20')).toEqual({
      startAt: '2026-08-20T04:00:00.000Z',
      endAt: '2026-08-21T04:00:00.000Z',
    })
  })

  it('is exactly 24 hours on an ordinary day', () => {
    const { startAt, endAt } = localDayRange('2026-08-20')
    expect(Date.parse(endAt) - Date.parse(startAt)).toBe(24 * 3600 * 1000)
  })

  it('is 23 hours on the day the clocks go forward', () => {
    // 2026-03-08, New York: 2am becomes 3am.
    const { startAt, endAt } = localDayRange('2026-03-08')
    expect(Date.parse(endAt) - Date.parse(startAt)).toBe(23 * 3600 * 1000)
  })

  it('is 25 hours on the day the clocks go back', () => {
    // 2026-11-01, New York: 2am becomes 1am.
    const { startAt, endAt } = localDayRange('2026-11-01')
    expect(Date.parse(endAt) - Date.parse(startAt)).toBe(25 * 3600 * 1000)
  })

  it('abuts the next day with no gap and no overlap', () => {
    expect(localDayRange('2026-08-20').endAt).toBe(localDayRange('2026-08-21').startAt)
  })

  it('follows the device timezone rather than assuming one', () => {
    inTimezone('UTC', () => {
      expect(localDayRange('2026-08-20').startAt).toBe('2026-08-20T00:00:00.000Z')
    })
    inTimezone('Asia/Tokyo', () => {
      // UTC+9: the local day starts the previous afternoon in UTC.
      expect(localDayRange('2026-08-20').startAt).toBe('2026-08-19T15:00:00.000Z')
    })
  })

  it('rejects something that is not a date', () => {
    expect(() => localDayRange('the 20th')).toThrow(RangeError)
  })
})

describe('localDayOf', () => {
  it('reads a timestamp as a local calendar day', () => {
    // 03:30 UTC is 23:30 the previous evening in New York.
    expect(localDayOf('2026-08-20T03:30:00.000Z')).toBe('2026-08-19')
    expect(localDayOf('2026-08-20T04:30:00.000Z')).toBe('2026-08-20')
  })

  it('agrees with localDayRange for every hour of a day', () => {
    const day = '2026-08-20'
    const { startAt, endAt } = localDayRange(day)
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(Date.parse(startAt) + hour * 3600 * 1000).toISOString()
      expect(localDayOf(at)).toBe(day)
    }
    // The exclusive end belongs to the next day, not this one.
    expect(localDayOf(endAt)).toBe('2026-08-21')
  })

  it('agrees with todayIso, which is what "today" means everywhere else', () => {
    const now = new Date('2026-08-20T18:00:00.000Z')
    expect(localDayOf(now.toISOString())).toBe(todayIso(now))
  })

  it('rejects something that is not a timestamp', () => {
    expect(() => localDayOf('lunchtime')).toThrow(RangeError)
  })
})

describe('formatTime', () => {
  it('renders a time of day', () => {
    // Locale formatting varies, so this checks it produced a time, not a shape.
    expect(formatTime('2026-08-20T22:45:00.000Z')).toMatch(/6.*45/)
  })

  it('does not print "Invalid Date"', () => {
    expect(formatTime('not a time')).toBe('—')
  })
})

describe('msUntilNextLocalDay', () => {
  it('counts to the next local midnight, not the next UTC one', () => {
    // 23:00 in New York is 03:00 UTC tomorrow. A UTC-based answer would say 21
    // hours; the right answer is one.
    const at = new Date('2026-08-20T23:00:00-04:00')
    expect(msUntilNextLocalDay(at)).toBe(60 * 60 * 1000)
  })

  it('returns a whole day at exactly midnight rather than zero', () => {
    // Zero here would make a caller that reschedules itself spin.
    const at = new Date('2026-08-20T00:00:00-04:00')
    expect(msUntilNextLocalDay(at)).toBe(24 * 60 * 60 * 1000)
  })

  it('is always strictly positive, at every minute of a day', () => {
    for (let minute = 0; minute < 24 * 60; minute++) {
      const at = new Date(Date.parse('2026-08-20T04:00:00.000Z') + minute * 60 * 1000)
      expect(msUntilNextLocalDay(at)).toBeGreaterThan(0)
    }
  })

  it('lands exactly on the boundary todayIso changes at', () => {
    const at = new Date('2026-08-20T14:37:11.250-04:00')
    const then = new Date(at.getTime() + msUntilNextLocalDay(at))
    expect(todayIso(at)).toBe('2026-08-20')
    expect(todayIso(then)).toBe('2026-08-21')
    // One millisecond earlier is still today, so the boundary is not off by one.
    expect(todayIso(new Date(then.getTime() - 1))).toBe('2026-08-20')
  })

  it('is 25 hours on the night the clocks go back', () => {
    // 2026-11-01 in New York is 25 hours long. Adding 24 hours would land at
    // 23:00 on the 1st and call it the 2nd.
    inTimezone('America/New_York', () => {
      const at = new Date('2026-11-01T00:00:00-04:00')
      expect(msUntilNextLocalDay(at)).toBe(25 * 60 * 60 * 1000)
    })
  })

  it('is 23 hours on the night the clocks go forward', () => {
    inTimezone('America/New_York', () => {
      const at = new Date('2026-03-08T00:00:00-05:00')
      expect(msUntilNextLocalDay(at)).toBe(23 * 60 * 60 * 1000)
    })
  })
})
