/**
 * Kitchen OS — The log form
 *
 * "I ate 50g of cheddar." Turning that into a storable event means answering
 * three questions, and this module answers them without a browser:
 *
 *  1. How many grams? Typed in any unit, converted by the engine.
 *  2. Whose macros? The packet you are eating out of, by default.
 *  3. Does it come out of stock? Yes, unless you say otherwise.
 *
 * Strings in, because that is what inputs give back. The rules about
 * conversion and macro arithmetic are the engine's and are not repeated here
 * (CLAUDE.md), and nothing in this file reads the clock.
 *
 * Jack settled the defaults on 2026-08-20. The one worth restating: the packet
 * whose macros are counted is the packet the food comes out of. Two cheddars in
 * the fridge is a real situation and something has to choose; tying the figure
 * to the food that actually moved means the answer is never arbitrary.
 */
import type {
  CanonicalIngredient,
  Lot,
  LotId,
  MacroSet,
  MealSlot,
  Product,
  ProductId,
  Unit,
} from '../types/schema'
import type { InventoryIndex } from '../engine'
import { ZERO_MACROS, availableLotsFor, gramsPerCount, scaleMacros, toGrams } from '../engine'
import type { LogIngredientInput } from '../db/repo/consumption'
import { parseAmount, type FieldIssue } from './entry-forms'
import { formatGrams } from './inventory-view'

// ---------------------------------------------------------------------------
// What there is to choose between
// ---------------------------------------------------------------------------

/** A packet on hand, with the label its macros come from. */
export interface LogPacket {
  readonly lot: Lot
  readonly product: Product
}

export interface LogOptions {
  /** Packets with something left, first-expiring first. The first is the default. */
  readonly packets: readonly LogPacket[]
  /** Products with nothing on hand, most recently added first. */
  readonly otherProducts: readonly Product[]
  /** True when there is no product at all, so the figures have to be typed. */
  readonly quickOnly: boolean
}

/**
 * What can be logged for one ingredient, given what is in the kitchen.
 *
 * The three cases the form has to cover, in order of how good the answer is:
 * a packet on hand (macros known, stock moves), a product you have run out of
 * (macros known, nothing to deduct), and nothing at all (figures typed for this
 * entry only). The last one is what stops the app being useless for a sandwich
 * eaten at work, which DECISIONS.md names as the reason direct logging is in v1
 * rather than deferred.
 *
 * A packet whose product has gone missing is dropped rather than shown: it
 * cannot say what it is made of, so it cannot be logged from.
 */
export function logOptionsFor(index: InventoryIndex, canonicalId: string): LogOptions {
  const packets: LogPacket[] = []
  for (const lot of availableLotsFor(index, canonicalId)) {
    const product = index.productsById.get(lot.productId)
    if (product !== undefined) packets.push({ lot, product })
  }

  const stocked = new Set(packets.map((packet) => packet.product.id))
  const otherProducts = [...index.productsById.values()]
    .filter((product) => product.canonicalId === canonicalId && !stocked.has(product.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return {
    packets,
    otherProducts,
    quickOnly: packets.length === 0 && otherProducts.length === 0,
  }
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/** Where this entry's figures come from. */
export type LogChoice =
  | { readonly kind: 'packet'; readonly lotId: LotId }
  | { readonly kind: 'product'; readonly productId: ProductId }
  | { readonly kind: 'quick' }

/**
 * The typed figures for something with no product.
 *
 * Four, not nine. The product form asks for the whole label because a product
 * is entered once and reused forever, so the five extra numbers are worth the
 * typing. A quick log is one entry that will never be seen again, and the five
 * are not displayed anywhere in v1 — asking for them would be friction with no
 * payoff. They are stored as zero, the same honest backfill the cholesterol
 * migration used: the figure was never asked for.
 */
export interface QuickMacroDraft {
  readonly calories: string
  readonly carbsG: string
  readonly fatG: string
  readonly proteinG: string
}

export interface LogDraft {
  readonly amount: string
  readonly unit: Unit
  readonly choice: LogChoice
  /** The "don't take it out of my stock" switch. Only means anything for a packet. */
  readonly deduct: boolean
  /** Which meal, or '' for not saying. Never filled in on the User's behalf. */
  readonly meal: MealSlot | ''
  readonly quick: QuickMacroDraft
}

/**
 * The unit the amount box starts in.
 *
 * The ingredient's natural measure, because "1 egg" and "200 ml" are what a
 * person would say, and grams only when the conversion field that unit needs is
 * actually on the ontology entry — offering a unit the engine will refuse is
 * worse than offering a duller one that works.
 */
export function defaultUnit(ingredient: CanonicalIngredient, product?: Product): Unit {
  if (ingredient.trackBy === 'count' && gramsPerCount(ingredient, product) !== null) return 'count'
  if (ingredient.trackBy === 'volume' && ingredient.densityGPerMl !== undefined) return 'ml'
  return 'g'
}

/** The product a choice points at, or undefined for a quick log. */
export function productForChoice(choice: LogChoice, options: LogOptions): Product | undefined {
  if (choice.kind === 'packet') {
    return options.packets.find((option) => option.lot.id === choice.lotId)?.product
  }
  if (choice.kind === 'product') {
    return options.otherProducts.find((option) => option.id === choice.productId)
  }
  return undefined
}

/** The best available source of figures: the first-expiring packet, if there is one. */
export function defaultChoice(options: LogOptions): LogChoice {
  const packet = options.packets[0]
  if (packet !== undefined) return { kind: 'packet', lotId: packet.lot.id }
  const product = options.otherProducts[0]
  if (product !== undefined) return { kind: 'product', productId: product.id }
  return { kind: 'quick' }
}

export function emptyLogDraft(ingredient: CanonicalIngredient, options: LogOptions): LogDraft {
  const choice = defaultChoice(options)
  return {
    amount: '',
    // The unit follows the packet being logged from, because for a count that
    // packet is what decides what "1" weighs.
    unit: defaultUnit(ingredient, productForChoice(choice, options)),
    choice,
    deduct: true,
    // No default and no guess from the clock (Jack, 2026-08-21). A wrong guess
    // has to be corrected every single time, which is worse than no answer.
    meal: '',
    quick: { calories: '', carbsG: '', fatG: '', proteinG: '' },
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type LogValidation =
  | {
      readonly ok: true
      readonly log: LogIngredientInput
      readonly grams: number
      /**
       * What the packet is expected to give up, worked out from what the screen
       * currently believes. `logIngredient` re-reads the packet inside its
       * transaction and returns the real figure — this is for the sentence shown
       * BEFORE the tap, not for anything that gets stored.
       */
      readonly deductedG: number
      readonly shortfallG: number
      readonly warnings: readonly FieldIssue[]
    }
  | { readonly ok: false; readonly errors: readonly FieldIssue[]; readonly warnings: readonly FieldIssue[] }

/** One typed macro figure. Blank is zero; text that is not a number is a typo. */
function readQuickField(
  text: string,
  field: string,
  label: string,
  errors: FieldIssue[],
): number {
  if (text.trim() === '') return 0
  const value = parseAmount(text)
  if (value === null) {
    errors.push({ field, message: `${label} needs to be a number.` })
    return 0
  }
  if (value < 0) {
    errors.push({ field, message: `${label} cannot be less than zero.` })
    return 0
  }
  return value
}

/**
 * The typed figures, as the total for what was eaten.
 *
 * Not per 100g. A quick log is "that bar was about 250 calories", which is a
 * statement about the thing in your hand, and asking someone to convert it to a
 * per-100g basis first would be a strange thing to do to them.
 */
function quickMacros(draft: QuickMacroDraft, errors: FieldIssue[], warnings: FieldIssue[]): MacroSet {
  const calories = parseAmount(draft.calories)
  if (calories === null) {
    errors.push({ field: 'calories', message: 'Roughly how many calories was it?' })
  } else if (calories < 0) {
    errors.push({ field: 'calories', message: 'Calories cannot be less than zero.' })
  }

  const carbsG = readQuickField(draft.carbsG, 'carbsG', 'Carbs', errors)
  const fatG = readQuickField(draft.fatG, 'fatG', 'Fat', errors)
  const proteinG = readQuickField(draft.proteinG, 'proteinG', 'Protein', errors)

  const blank = [draft.carbsG, draft.fatG, draft.proteinG].filter((text) => text.trim() === '')
  if (blank.length > 0 && calories !== null) {
    warnings.push({
      field: 'quick',
      message:
        blank.length === 3
          ? 'Only calories recorded. Carbs, fat and protein will count as zero for this entry.'
          : 'Anything left blank counts as zero for this entry.',
    })
  }

  return { ...ZERO_MACROS, calories: calories ?? 0, carbsG, fatG, proteinG }
}

/**
 * Turn what was typed into something `logIngredient` can store.
 *
 * The amount goes through the engine's `toGrams`, so the "never density for
 * solids" rule stays enforced in the one place it lives, and a failed conversion
 * shows the engine's own message — it is already written for a person.
 *
 * The macros are computed HERE and stored as a value. That is what makes
 * DECISIONS.md's immutability rule structural: the figure is worked out once,
 * at log time, and the stored event never refers back to the product again.
 */
export function validateLogDraft(
  draft: LogDraft,
  ingredient: CanonicalIngredient,
  options: LogOptions,
): LogValidation {
  const errors: FieldIssue[] = []
  const warnings: FieldIssue[] = []

  const amount = parseAmount(draft.amount)
  if (amount === null) {
    errors.push({ field: 'amount', message: 'How much did you have?' })
  } else if (amount <= 0) {
    errors.push({ field: 'amount', message: 'That has to be more than zero.' })
  }

  // Where the figures come from, and what moves in the kitchen.
  //
  // This is settled BEFORE the amount is converted, and the order matters: for
  // a count, the chosen product is what decides what "1" weighs. Converting
  // first meant one tortilla was always the ontology's average tortilla rather
  // than one out of the bag in the kitchen (Jack, 2026-08-21).
  let macrosPer100g: MacroSet | null = null
  let macros: MacroSet | null = null
  let label = ingredient.name
  let productId: ProductId | undefined
  let lotId: LotId | undefined
  let packet: LogPacket | undefined

  if (draft.choice.kind === 'packet') {
    const chosen = draft.choice
    packet = options.packets.find((option) => option.lot.id === chosen.lotId)
    if (packet === undefined) {
      errors.push({ field: 'choice', message: 'That packet is not there any more.' })
    } else {
      macrosPer100g = packet.product.macrosPer100g
      label = packet.product.name
      productId = packet.product.id
      if (draft.deduct) lotId = packet.lot.id
    }
  } else if (draft.choice.kind === 'product') {
    const chosen = draft.choice
    const product = options.otherProducts.find((option) => option.id === chosen.productId)
    if (product === undefined) {
      errors.push({ field: 'choice', message: 'That product is not there any more.' })
    } else {
      macrosPer100g = product.macrosPer100g
      label = product.name
      productId = product.id
    }
  } else {
    macros = quickMacros(draft.quick, errors, warnings)
  }

  let grams = 0
  if (amount !== null && amount > 0) {
    const converted = toGrams(ingredient, amount, draft.unit, productForChoice(draft.choice, options))
    if (!converted.ok) errors.push({ field: 'unit', message: converted.message })
    else grams = converted.grams
  }

  // How much the packet can actually give up. The remainder is quantity drift:
  // you ate what you ate, and the packet is simply empty (Jack, 2026-08-20).
  let deductedG = 0
  let shortfallG = 0
  if (lotId !== undefined && packet !== undefined && grams > 0) {
    deductedG = Math.min(packet.lot.remainingG, grams)
    shortfallG = grams - deductedG
    if (shortfallG > 0) {
      warnings.push({
        field: 'deduct',
        message: `Only ${formatGrams(packet.lot.remainingG)} left in that packet, so ${formatGrams(
          grams,
        )} is logged and the packet is emptied.`,
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings }

  const log: LogIngredientInput = {
    canonicalId: ingredient.id,
    grams,
    label,
    macros: macros ?? scaleMacros(macrosPer100g ?? ZERO_MACROS, grams),
    ...(productId === undefined ? {} : { productId }),
    ...(lotId === undefined ? {} : { lotId }),
    ...(draft.meal === '' ? {} : { meal: draft.meal }),
  }

  return { ok: true, log, grams, deductedG, shortfallG, warnings }
}
