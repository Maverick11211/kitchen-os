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

/** "19 Aug 2026". Undated values render as an em dash rather than "Invalid Date". */
export function formatDate(date: DateOnly | null | undefined): string {
  if (!date) return '—'
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
