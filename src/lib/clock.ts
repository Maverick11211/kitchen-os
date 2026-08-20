/**
 * Kitchen OS — Reading the clock
 *
 * The engine never reads the clock: every time-dependent function there takes
 * `now` or `today` as a parameter, which is what makes it reproducible in tests.
 * The clock has to be read SOMEWHERE though, and this is that somewhere — one
 * module, at the edge, so there is a single place to look when a date behaves
 * oddly.
 */
import type { DateOnly, Timestamp } from '../types/schema'

/** Right now, as an ISO timestamp. For anything stored on a record. */
export function nowIso(): Timestamp {
  return new Date().toISOString()
}

/**
 * Today's date in the DEVICE's timezone, as YYYY-MM-DD.
 *
 * Deliberately local rather than UTC. Expiry is a human question — "is this
 * still good today?" — and using UTC would flip the answer over in the evening
 * for anyone west of Greenwich, which is where this iPad lives.
 */
export function todayIso(date: Date = new Date()): DateOnly {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The half-open span of real time covered by one LOCAL calendar day.
 *
 * `startAt` is inclusive, `endAt` exclusive — an event stamped at exactly
 * midnight belongs to the day starting, not the day ending, and no instant
 * belongs to two days.
 */
export interface LocalDayRange {
  readonly startAt: Timestamp
  readonly endAt: Timestamp
}

/**
 * When a local day begins and ends, as UTC timestamps.
 *
 * `ConsumptionEvent.consumedAt` is a UTC instant, but a day is a local-calendar
 * question — Jack decided on 2026-08-20 that a day runs local midnight to local
 * midnight, the same convention expiry already uses. So a day's events cannot
 * be found by matching the first ten characters of the stored string: at
 * UTC-4, local Thursday runs from "…T04:00:00Z" to the next day's "…T04:00:00Z",
 * and a 9pm dinner is stored under tomorrow's UTC date. This converts, and the
 * query is a range over the `consumedAt` index.
 *
 * Written here rather than in the engine because it needs the device's
 * timezone, and this module is the one place ambient time is read.
 *
 * Throws on an unparseable date: the caller built it, so a bad value is a bug
 * in the app, and a silently wrong day range would quietly hide meals.
 */
export function localDayRange(day: DateOnly): LocalDayRange {
  return { startAt: startOfLocalDay(day), endAt: startOfLocalDay(day, 1) }
}

/**
 * Midnight local time at the start of `day`, plus optional whole days, as a UTC
 * timestamp.
 *
 * The offset is applied with `setDate` on a local Date rather than by adding 24
 * hours, so a day containing a daylight-saving change is still exactly one day
 * — 2026-11-01 in New York is 25 hours long and this returns the right instant
 * for the start of the 2nd regardless.
 */
function startOfLocalDay(day: DateOnly, plusDays = 0): Timestamp {
  const date = new Date(`${day}T00:00:00`)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`startOfLocalDay: "${day}" is not a YYYY-MM-DD date.`)
  }
  if (plusDays !== 0) date.setDate(date.getDate() + plusDays)
  return date.toISOString()
}

/**
 * Which local day a stored timestamp falls on.
 *
 * The inverse of `localDayRange`, and what turns a `ConsumptionEvent` into a
 * row under a heading.
 */
export function localDayOf(timestamp: Timestamp): DateOnly {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`localDayOf: "${timestamp}" is not a timestamp.`)
  }
  return todayIso(date)
}

/** "6:45 pm" — the time of day an entry was logged, for the daily list. */
export function formatTime(timestamp: Timestamp): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "19 Aug 2026". Undated values render as an em dash rather than "Invalid Date". */
export function formatDate(date: DateOnly | null | undefined): string {
  if (!date) return '—'
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
