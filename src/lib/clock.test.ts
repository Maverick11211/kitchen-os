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
import { formatTime, localDayOf, localDayRange, todayIso } from './clock'

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
