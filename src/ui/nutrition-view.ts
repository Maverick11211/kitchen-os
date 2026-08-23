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
import type {
  ConsumptionEvent,
  DateOnly,
  MacroSet,
  MealSlot,
  Product,
  ProductId,
} from '../types/schema'
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
   * Everything except a leftover, which is a v2 feature nothing writes.
   *
   * Until Phase 7 this was ingredient entries only: removing a portion of a
   * cooked batch has to adjust the batch it came out of, and `deleteConsumption`
   * refused rather than guess. It no longer refuses — the portion goes back onto
   * `CookEvent.fractionConsumed` and the batch becomes eatable again — so the
   * button belongs on those rows too. A meal you logged by mistake was exactly
   * as much of a mistake as an ingredient you logged by mistake.
   */
  readonly canDelete: boolean

  /**
   * Whether these figures came from the app's generic reference rather than off
   * a label.
   *
   * Shown as a small marker on the row. The reference-macro change of
   * 2026-08-23 is only defensible while an estimate is visibly an estimate: a
   * generic figure presented with the same confidence as a label reading is the
   * app lying quietly, and quiet is the part that matters. See
   * `CanonicalIngredient.referenceMacrosPer100g`.
   *
   * False whenever nothing is known — a cooked meal, a manual entry, a product
   * stored before the app recorded provenance. It means "not marked", never
   * "checked".
   */
  readonly estimated: boolean
}

/** How much of a batch, as a percentage a person would say out loud. */
function fractionDetail(fraction: number): string {
  return `${Math.round(fraction * 100)}% of the batch`
}

/**
 * Turn a day's events into rows.
 *
 * `products` is optional so callers with no reason to care — anything counting
 * rather than displaying — need not thread an index through. Without it nothing
 * is marked, which is the honest reading of "the caller did not say".
 *
 * The lookup goes through the event's `productId` rather than through its
 * stored macros, because those are a snapshot and carry no provenance of their
 * own. So correcting a product's figures later does change whether an old row
 * is MARKED, while leaving the row's numbers exactly as they were. That is the
 * right way round: the marker describes where figures came from, and typing
 * them off a label is precisely the event that stops them being an estimate.
 */
export function dayEntries(
  events: readonly ConsumptionEvent[],
  products?: ReadonlyMap<ProductId, Product>,
): DayEntry[] {
  return events.map((event) => ({
    event,
    label: event.label,
    detail:
      event.source.type === 'ingredient'
        ? formatGrams(event.source.grams)
        : fractionDetail(event.source.fraction),
    calories: Math.round(event.macros.calories),
    canDelete: event.source.type !== 'leftover',
    estimated: isEstimated(event, products),
  }))
}

function isEstimated(
  event: ConsumptionEvent,
  products: ReadonlyMap<ProductId, Product> | undefined,
): boolean {
  if (products === undefined) return false
  if (event.source.type !== 'ingredient') return false
  const productId = event.source.productId
  if (productId === undefined) return false
  return products.get(productId)?.macrosSource === 'reference'
}

// ---------------------------------------------------------------------------
// Meals
// ---------------------------------------------------------------------------

/**
 * The meals a day is divided into, in the order they are eaten.
 *
 * Snack last rather than in clock order: it is the one that happens at any hour,
 * so there is no time of day that would put it anywhere in particular.
 */
export const MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack']

export const MEAL_LABELS: Record<MealSlot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snacks',
}

/** One section of the day. `meal` is null for entries with no meal on them. */
export interface MealGroup {
  readonly meal: MealSlot | null
  readonly heading: string
  readonly entries: readonly DayEntry[]
  /** Rounded subtotal for the section. */
  readonly calories: number
  /** The section's full totals, for anything that wants more than calories. */
  readonly macros: MacroSet
}

/**
 * The day, split into meals.
 *
 * Empty sections are left out entirely: a day with no breakfast should not show
 * a Breakfast heading with nothing under it, which reads as a thing you failed
 * to do rather than a thing you did not do.
 *
 * Entries with no meal come LAST, under their own heading, rather than being
 * hidden or filed under a guess. Every entry logged before meals existed is one
 * of these (`ConsumptionEvent.meal` is optional precisely so they can stay
 * honest about it), and they still count towards the day's totals — the four
 * figures at the top are computed from the whole day, not from the sections.
 */
export function mealGroups(
  events: readonly ConsumptionEvent[],
  products?: ReadonlyMap<ProductId, Product>,
): MealGroup[] {
  const groups: MealGroup[] = []

  const build = (meal: MealSlot | null, heading: string, matching: ConsumptionEvent[]) => {
    if (matching.length === 0) return
    const macros = totalMacros(matching)
    groups.push({
      meal,
      heading,
      entries: dayEntries(matching, products),
      calories: Math.round(macros.calories),
      macros,
    })
  }

  for (const meal of MEAL_SLOTS) {
    build(meal, MEAL_LABELS[meal], events.filter((event) => event.meal === meal))
  }
  build(null, 'Other', events.filter((event) => event.meal === undefined))

  return groups
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
