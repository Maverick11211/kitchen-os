/**
 * Kitchen OS — Turning a cook into what the screen shows
 *
 * View logic, not domain logic: which batch sizes to offer, what each row of
 * the deduction preview reads as, which portion buttons are still available,
 * and how to read a typed percentage. The arithmetic is the engine's —
 * `planRecipeDeduction` decides what would be debited, `remainingFraction`
 * decides what is left of a batch — and this module never does any of its own
 * (CLAUDE.md).
 *
 * Pure and clock-free, same as `recipe-view.ts` and `nutrition-view.ts`. Every
 * function here is tested without a browser.
 */
import type {
  CanonicalId,
  CookEvent,
  DateOnly,
  Deduction,
  MacroSet,
  Recipe,
  RecipeIngredient,
} from '../types/schema'
import type {
  InventoryIndex,
  OntologyIndex,
  RecipeDeductionPlan,
  RecipeOwnership,
} from '../engine'
import { daysUntil, remainingFraction } from '../engine'
import { formatGrams } from './inventory-view'

// ---------------------------------------------------------------------------
// How big a batch
// ---------------------------------------------------------------------------

/**
 * The batch sizes offered, as steps rather than a typed number (Jack,
 * 2026-08-22).
 *
 * The same shape as Reconcile's five steps, and for the same reason: these are
 * the sizes a person actually cooks. Anything else — one and a half batches
 * because that is what fits the tray — is beyond what a button can usefully
 * offer, and the ±15% tolerance in CLAUDE.md says chasing it would be wasted
 * effort. Half is first because cooking less than the recipe is the common
 * reason to think about size at all.
 */
export const SCALE_STEPS: readonly number[] = [0.5, 1, 2, 3]

export const DEFAULT_SCALE = 1

export interface ScaleOption {
  readonly scale: number
  /** "½ batch", "Full batch", "2 batches". */
  readonly label: string
  /** Enough on hand for this size. False does NOT disable it — see below. */
  readonly possible: boolean
}

function scaleLabel(scale: number): string {
  if (scale === 0.5) return '½ batch'
  if (scale === 1) return 'Full batch'
  return `${scale} batches`
}

/**
 * The batch sizes, each marked with whether the kitchen can cover it.
 *
 * `possible` is a MARKER, not a lock. Cooking while short is allowed (Jack,
 * 2026-08-22) — the preview says the gap out loud and the cook records what
 * actually left. Greying these out would be the "block it" answer, which was
 * considered and rejected: inventory drifts, and refusing a meal he actually
 * cooked is worse than recording it with a warning.
 *
 * `maxBatchScale` is computed at 1x by `evaluateOwnership`, and it is Infinity
 * when a recipe needs nothing countable — so every size is possible, which is
 * the right answer for a recipe made of staples.
 */
export function scaleOptions(ownership: RecipeOwnership): ScaleOption[] {
  return SCALE_STEPS.map((scale) => ({
    scale,
    label: scaleLabel(scale),
    possible: ownership.maxBatchScale >= scale,
  }))
}

/**
 * What to say about the chosen size, or null when there is nothing to add.
 *
 * Silent when the kitchen covers it. A line that appears only when something is
 * wrong is a line worth reading.
 */
export function scaleNote(ownership: RecipeOwnership, scale: number): string | null {
  if (ownership.maxBatchScale >= scale) return null
  if (ownership.maxBatchScale <= 0) return 'There is none of this in the kitchen.'
  if (ownership.maxBatchScale < 0.5) return 'There is not enough here for even a half batch.'
  const largest = scaleOptions(ownership).filter((option) => option.possible).at(-1)
  if (largest === undefined) return 'There is not enough here for a half batch.'
  // "a ½ batch" but "2 batches" — the article only belongs on the singular
  // ones. Caught by the browser pass, which is the only place anyone reads
  // these strings as English rather than as a value in an assertion.
  const size = largest.label.toLowerCase()
  return `There is only enough for ${largest.scale > 1 ? '' : 'a '}${size}.`
}

// ---------------------------------------------------------------------------
// The deduction preview
// ---------------------------------------------------------------------------

export type CookLineStatus = 'full' | 'short' | 'none' | 'staple' | 'optional'

/** One packet about to be debited. */
export interface CookPacketView {
  readonly lotId: string
  /** The product name, so it reads as the thing in the fridge. */
  readonly name: string
  readonly amount: string
}

export interface CookLineView {
  readonly canonicalId: CanonicalId
  readonly name: string
  /** What this line of the recipe asks for at the chosen scale. */
  readonly amount: string
  readonly packets: readonly CookPacketView[]
  readonly status: CookLineStatus
  /** "40 g short" — null when the kitchen covers it. */
  readonly shortLabel: string | null
}

function ingredientName(ontology: OntologyIndex, id: CanonicalId): string {
  return ontology.get(id)?.name ?? id
}

function productNameFor(index: InventoryIndex, deduction: Deduction): string {
  const lot = index.lotsById.get(deduction.lotId)
  if (lot === undefined) return 'A packet'
  return index.productsById.get(lot.productId)?.name ?? 'A packet'
}

/**
 * Every recipe line, in recipe order, with the packets it would come out of.
 *
 * Built from `RecipeDeductionPlan`, which already did the deciding — this adds
 * names and words and nothing else. Untracked staples are absent from the plan
 * (there is nothing to debit) but present in the recipe, so they are put back on
 * the list here: leaving salt off the page would mean the preview was not the
 * recipe. They carry no packets and can never be short.
 */
export function buildCookLines(
  recipe: Recipe,
  plan: RecipeDeductionPlan,
  index: InventoryIndex,
  ontology: OntologyIndex,
): CookLineView[] {
  // The plan holds one entry per TRACKED line, in recipe order. Walking the
  // recipe and taking the next plan entry for each tracked line keeps the two
  // in step without matching on canonical id — which would go wrong on the six
  // seed recipes that name the same ingredient twice.
  const queue = [...plan.lines]

  return recipe.ingredients.map((ingredient: RecipeIngredient): CookLineView => {
    const name = ingredientName(ontology, ingredient.canonicalId)
    const wanted = ingredient.quantityG * plan.scaleFactor
    const line = queue[0]?.canonicalId === ingredient.canonicalId ? queue.shift() : undefined

    if (line === undefined) {
      return {
        canonicalId: ingredient.canonicalId,
        name,
        amount: formatGrams(wanted),
        packets: [],
        status: 'staple',
        shortLabel: null,
      }
    }

    const packets = line.deductions.map((deduction) => ({
      lotId: deduction.lotId,
      name: productNameFor(index, deduction),
      amount: formatGrams(deduction.grams),
    }))

    /*
     * A garnish that could not be covered sits back rather than going red
     * (Jack, 2026-08-22). It is not a problem: the recipe card had already said
     * you have everything, because optional lines are excluded from the
     * percentage, and a red row here would be the cook sheet arguing with it.
     */
    const status: CookLineStatus = line.complete
      ? 'full'
      : ingredient.optional
        ? 'optional'
        : line.deductedG > 0
          ? 'short'
          : 'none'

    return {
      canonicalId: ingredient.canonicalId,
      name,
      amount: formatGrams(line.requestedG),
      packets,
      status,
      // No "40 g short" on a garnish. The tag says it was skipped; a gram
      // figure would make it read as something to go and buy.
      shortLabel: line.complete || ingredient.optional
        ? null
        : `${formatGrams(line.shortfallG)} short`,
    }
  })
}

/**
 * The sentences above the preview: what will happen, and what is missing.
 *
 * Deliberately says the gap out loud rather than hiding it behind a colour on a
 * row (Jack, 2026-08-22). The whole point of a preview is that nothing is a
 * surprise after the tap.
 */
/** How many distinct packets a plan would touch. One packet, debited twice, is one. */
export function packetCount(plan: RecipeDeductionPlan): number {
  return new Set(plan.deductions.map((deduction) => deduction.lotId)).size
}

/**
 * What the commit button says.
 *
 * Verb plus consequence, the same shape as the log sheet's "Log it · 201 cal".
 * It must NOT read "Made it" — that is what the button on the recipe detail
 * says, and having one phrase mean both "start recording this" and "yes,
 * commit" is the same mistake as the two "Something else" buttons Phase 5
 * shipped and had to fix.
 */
export function commitLabel(plan: RecipeDeductionPlan): string {
  const packets = packetCount(plan)
  if (packets === 0) return 'Cook it'
  return `Cook it · ${packets} ${packets === 1 ? 'packet' : 'packets'}`
}

export function cookPreviewNotes(
  plan: RecipeDeductionPlan,
  ontology: OntologyIndex,
): string[] {
  const notes: string[] = []
  const packets = packetCount(plan)

  if (packets === 0) {
    notes.push('Nothing will come out of your kitchen — there is none of this here.')
  } else {
    notes.push(
      `${packets} ${packets === 1 ? 'packet' : 'packets'} will be used, soonest-expiring first.`,
    )
  }

  for (const shortfall of plan.shortfalls) {
    const name = ingredientName(ontology, shortfall.canonicalId)
    if (shortfall.optional) {
      /*
       * Mentioned, not warned about (Jack, 2026-08-22). Worth knowing — the
       * batch really will have fewer calories in it than the recipe suggests —
       * but it is a garnish you are skipping, not a thing going wrong.
       */
      notes.push(`No ${name.toLowerCase()} for the garnish, so it will be cooked without it.`)
      continue
    }
    notes.push(
      `${formatGrams(shortfall.shortfallG)} short of ${name} — ` +
        'it will be recorded as cooked with what you have.',
    )
  }

  return notes
}

/**
 * Whether the kitchen changed between the preview and the commit.
 *
 * `commitCook` re-plans inside its transaction, so what it recorded is not
 * necessarily what was on screen. Almost always false on one iPad — but when it
 * is true the confirmation has to say so, because the alternative is silently
 * recording something the User did not agree to.
 */
export function planChanged(
  previewed: RecipeDeductionPlan,
  committed: RecipeDeductionPlan,
): boolean {
  if (previewed.deductions.length !== committed.deductions.length) return true
  return previewed.deductions.some((deduction, position) => {
    const other = committed.deductions[position]
    if (other === undefined) return true
    return (
      other.lotId !== deduction.lotId ||
      other.canonicalId !== deduction.canonicalId ||
      Math.abs(other.grams - deduction.grams) > 0.5
    )
  })
}

/** "1,240 calories in the whole batch" — what was actually made. */
export function batchSummary(batchMacros: MacroSet): string {
  return `${Math.round(batchMacros.calories)} calories in the whole batch`
}

// ---------------------------------------------------------------------------
// How much did you eat
// ---------------------------------------------------------------------------

/**
 * Portions offered as buttons, as fractions of the WHOLE batch.
 *
 * Of the whole batch, never of what is left. The schema is explicit about it
 * and it is what makes two helpings add up — but it also matters on screen:
 * "half" has to mean the same thing on Sunday and on Tuesday, or the number
 * recorded depends on when you happened to ask.
 */
export const PORTION_STEPS: readonly { readonly fraction: number; readonly label: string }[] = [
  { fraction: 0.25, label: '¼' },
  { fraction: 0.5, label: '½' },
  { fraction: 0.75, label: '¾' },
]

export interface PortionOption {
  /** The portion of the whole batch this records. */
  readonly fraction: number
  readonly label: string
  /** False when there is not that much left. The screen greys these out. */
  readonly possible: boolean
}

/**
 * The portion buttons for a batch, given how much of it is left.
 *
 * The last option is "the rest", whatever that is. It is the honest answer to
 * "I finished it", and it is the one that closes a batch exactly rather than
 * leaving a crumb behind that keeps it on the list forever.
 *
 * Options that are too big are marked, not removed. A row of four buttons that
 * becomes two is harder to use than four with two dimmed — the positions stop
 * meaning the same thing.
 */
export function portionOptions(remaining: number): PortionOption[] {
  const options: PortionOption[] = PORTION_STEPS.map((step) => ({
    fraction: step.fraction,
    label: step.label,
    // A hair of tolerance: 1 - 0.25 - 0.5 is 0.24999999999999997, and a ¼
    // button that refuses the last quarter of a batch is nonsense.
    possible: step.fraction <= remaining + 0.001,
  }))

  options.push({
    fraction: remaining,
    label: remaining >= 1 ? 'All of it' : 'The rest',
    possible: remaining > 0,
  })

  return options
}

/** "Three quarters of this batch is left." Null for an untouched batch. */
export function remainingNote(cook: Pick<CookEvent, 'fractionConsumed'>): string | null {
  const left = remainingFraction(cook)
  if (left >= 1) return null
  if (left <= 0) return 'All of this batch has been eaten.'
  return `${Math.round(left * 100)}% of this batch is left.`
}

/** "40% of the batch" — how a portion reads in a list. */
export function portionLabel(fraction: number): string {
  return `${Math.round(fraction * 100)}% of the batch`
}

/**
 * How much of a batch is left, for the row in the log sheet.
 *
 * "all of it left" rather than "100% left": a batch nobody has touched is the
 * common case, and a percentage there reads as arithmetic about something that
 * has not happened yet.
 */
export function batchLeftLabel(cook: Pick<CookEvent, 'fractionConsumed'>): string {
  const left = remainingFraction(cook)
  if (left >= 1) return 'all of it left'
  return `${Math.round(left * 100)}% left`
}

/**
 * Past this many days, a batch is old enough that the app says so.
 *
 * Four days is the common fridge rule of thumb for cooked food, and it is close
 * to `EXPIRY_SOON_DAYS` for a packet. It is a NUMBER OF DAYS, not a claim about
 * this particular stew — which is exactly why the app marks the age rather than
 * hiding the batch (Jack, 2026-08-22). Nothing knows whether it went in the
 * freezer.
 */
export const BATCH_OLD_DAYS = 4

/**
 * How old a batch is, when that is worth saying, otherwise null.
 *
 * Silent for the first few days, because "cooked today" is not news. Nothing
 * ages a batch out of the log sheet — a batch stays offered until it is
 * finished — so this is the only thing standing between a three-week-old stew
 * and a portion logged without a second thought.
 */
export function batchAgeWarning(cookedOn: DateOnly, today: DateOnly): string | null {
  const days = daysUntil(today, cookedOn)
  if (days === null || days <= BATCH_OLD_DAYS) return null
  return `${days} days ago — still good?`
}

export type PercentReading =
  | { readonly ok: true; readonly fraction: number; readonly warning: string | null }
  | { readonly ok: false; readonly message: string }

/**
 * Read a typed percentage — "40", "40%", "40 %".
 *
 * The escape hatch beside the buttons, because you cannot tap your way to two
 * fifths. Over-asking is a WARNING rather than an error: the answer is clamped
 * to what is left, which is the same treatment a logged ingredient gets when the
 * packet cannot cover it, and refusing outright would mean retyping a number
 * that was nearly right.
 */
export function readPercent(text: string, remaining: number): PercentReading {
  const trimmed = text.trim().replace(/%$/, '').trim()
  if (trimmed === '') return { ok: false, message: 'Type how much of the batch you ate.' }

  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { ok: false, message: 'That is not a number.' }
  if (value <= 0) return { ok: false, message: 'That has to be more than zero.' }
  if (value > 100) return { ok: false, message: 'A batch is 100% — you cannot eat more than it.' }

  const fraction = value / 100
  if (fraction > remaining + 0.001) {
    return {
      ok: true,
      fraction: remaining,
      warning: `Only ${Math.round(remaining * 100)}% of this batch is left, so that is what will be logged.`,
    }
  }

  return { ok: true, fraction, warning: null }
}
