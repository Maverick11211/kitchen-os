/**
 * Kitchen OS — Turning logged events into what the daily view shows
 *
 * View logic, not domain logic: which four numbers go at the top, what each row
 * reads as, and which day the arrows lead to. The arithmetic is the engine's
 * (`totalMacros`, `roundMacros`) — this module never adds a macro up itself
 * (CLAUDE.md).
 *
 * Pure and clock-free, same as `inventory-view.ts`. `today` is passed in, and no
 * locale formatting happens here so the tests mean the same thing on any
 * machine: the components call `formatTime`/`formatDate` from `src/lib/clock.ts`
 * for that.
 *
 * The rule this module exists to protect is DECISIONS.md's "history is
 * immutable": every figure below is read off `ConsumptionEvent.macros`, which was
 * snapshotted when the entry was written. Nothing here reaches back into a
 * product, so correcting a product's nutrition tomorrow cannot move a past day.
 */
import type { ConsumptionEvent, DateOnly, MacroSet } from '../types/schema'
import { roundMacros, totalMacros } from '../engine'
import { addDays } from './entry-forms'
import { formatGrams } from './inventory-view'

// ---------------------------------------------------------------------------
// The four numbers
// ---------------------------------------------------------------------------

/** The macros the daily view shows. Nine are stored; these four are displayed. */
export type HeadlineKey = 'calories' | 'carbsG' | 'fatG' | 'proteinG'

export interface HeadlineFigure {
  readonly key: HeadlineKey
  readonly label: string
  readonly value: number
  /** Empty for calories, which are not measured in anything. */
  readonly unit: string
}

/**
 * In DECISIONS.md's order: calories, carbs, fat, protein.
 *
 * The other five stored figures are deliberately absent. They are captured
 * because they are on every label and cost nothing, not because this screen has
 * anything to say about them, and v1 has no goals or targets to compare any of
 * them against.
 */
const HEADLINES: readonly { readonly key: HeadlineKey; readonly label: string; readonly unit: string }[] =
  [
    { key: 'calories', label: 'Calories', unit: '' },
    { key: 'carbsG', label: 'Carbs', unit: 'g' },
    { key: 'fatG', label: 'Fat', unit: 'g' },
    { key: 'proteinG', label: 'Protein', unit: 'g' },
  ]

/** The day's totals, rounded for display. An empty day is four zeroes, not blank. */
export function headlineFigures(events: readonly ConsumptionEvent[]): HeadlineFigure[] {
  const total = roundMacros(totalMacros(events))
  return HEADLINES.map((headline) => ({ ...headline, value: total[headline.key] }))
}

/** The day's totals in full, for anything that wants all nine. */
export function dayTotal(events: readonly ConsumptionEvent[]): MacroSet {
  return totalMacros(events)
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface DayEntry {
  readonly event: ConsumptionEvent
  /** What was eaten. Product name for a logged ingredient, recipe name for a meal. */
  readonly label: string
  /** How much of it: "50 g", or "40% of the batch". */
  readonly detail: string
  /** Rounded, because a row showing 201.3 calories claims precision nobody has. */
  readonly calories: number
  /**
   * Whether this row offers a Delete.
   *
   * Only entries logged directly. Removing a portion of a cooked batch has to
   * adjust the cook event it belongs to, which is Phase 7's problem —
   * `deleteConsumption` refuses those outright, so the button must not appear.
   */
  readonly canDelete: boolean
}

/** How much of a batch, as a percentage a person would say out loud. */
function fractionDetail(fraction: number): string {
  return `${Math.round(fraction * 100)}% of the batch`
}

export function dayEntries(events: readonly ConsumptionEvent[]): DayEntry[] {
  return events.map((event) => ({
    event,
    label: event.label,
    detail:
      event.source.type === 'ingredient'
        ? formatGrams(event.source.grams)
        : fractionDetail(event.source.fraction),
    calories: Math.round(event.macros.calories),
    canDelete: event.source.type === 'ingredient',
  }))
}

// ---------------------------------------------------------------------------
// Moving between days
// ---------------------------------------------------------------------------

export function previousDay(day: DateOnly): DateOnly {
  return addDays(day, -1)
}

export function nextDay(day: DateOnly): DateOnly {
  return addDays(day, 1)
}

/**
 * Whether the ‹ arrow is live.
 *
 * Bounded by the oldest entry on record rather than left open. Walking back
 * through empty days you were not using the app for is a way of making the
 * screen look broken; stopping where the history stops is honest about what
 * there is. `earliestDay` is undefined when nothing has ever been logged, and
 * then there is nowhere to go.
 */
export function canPageBack(day: DateOnly, earliestDay: DateOnly | undefined): boolean {
  if (earliestDay === undefined) return false
  return day > earliestDay
}

/** Whether the › arrow is live. There is no paging into the future. */
export function canPageForward(day: DateOnly, today: DateOnly): boolean {
  return day < today
}

/**
 * "Today" or "Yesterday" when that is what the day is, otherwise null and the
 * component falls back to `formatDate`.
 *
 * Returning null rather than a formatted date keeps this module free of locale
 * formatting, which is the thing that would make its tests depend on where the
 * machine thinks it is.
 */
export function relativeDayName(day: DateOnly, today: DateOnly): string | null {
  if (day === today) return 'Today'
  if (day === addDays(today, -1)) return 'Yesterday'
  return null
}

/** What an empty day says. Today has not happened yet; a past day is just empty. */
export function emptyDayNote(day: DateOnly, today: DateOnly): string {
  return day === today ? 'Nothing logged yet today.' : 'Nothing was logged this day.'
}
