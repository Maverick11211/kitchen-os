/**
 * Kitchen OS — Turning the database into what the inventory screen shows
 *
 * View logic, not domain logic: grouping, sorting and which warning colour a lot
 * earns. All the actual arithmetic — how many grams are on hand, how many days
 * until a date — comes from `src/engine/`, which this module calls rather than
 * reimplements (CLAUDE.md).
 *
 * Pure and clock-free, same as the engine, so it can be tested without a
 * browser. `today` is passed in.
 */
import type {
  CanonicalIngredient,
  DateOnly,
  IngredientCategory,
  Lot,
} from '../types/schema'
import type { InventoryIndex, OntologyIndex } from '../engine'
import { availableLotsFor, daysUntil, findIngredient, isLotAvailable } from '../engine'

/**
 * The inventory screen's two warning bands (Jack, 2026-08-19).
 *
 * These are NOT the same number as `DEFAULT_EXPIRING_SOON_DAYS` in the engine,
 * which is 5 and governs the recipe-ranking tie-break. DECISIONS.md is explicit
 * that the inventory threshold is a separate decision; it happens that "soon"
 * landed on the same 5, but they are free to move apart.
 */
export const EXPIRY_URGENT_DAYS = 2
export const EXPIRY_SOON_DAYS = 5

/**
 * How close to the edge a lot is.
 *
 * `none` means it never expires — either no date was given or it is frozen with
 * no date. That is different from `fine`, which means there IS a date and it is
 * comfortably far off, and the screen shows them differently.
 */
export type ExpiryBand = 'expired' | 'urgent' | 'soon' | 'fine' | 'none'

/** Worst first. Used to pick one band for an ingredient held across many lots. */
const BAND_SEVERITY: Record<ExpiryBand, number> = {
  expired: 4,
  urgent: 3,
  soon: 2,
  fine: 1,
  none: 0,
}

export function expiryBand(lot: Lot, today: DateOnly): ExpiryBand {
  if (lot.expiresOn === null) return 'none'
  const days = daysUntil(lot.expiresOn, today)
  if (days === null) return 'none'
  if (days < 0) return 'expired'
  if (days <= EXPIRY_URGENT_DAYS) return 'urgent'
  if (days <= EXPIRY_SOON_DAYS) return 'soon'
  return 'fine'
}

/**
 * True for every band that carries a warning. Drives the "Use up" list.
 *
 * All three warning bands count, not just the urgent ones. The bands exist to
 * say how loudly to warn — colour and wording — not to decide what is worth
 * warning about at all. Including only the urgent ones meant an item could be
 * tagged "Use soon" in the list while the filter built to collect exactly those
 * items reported nothing, which is the kind of disagreement that teaches you to
 * stop trusting the count.
 */
export function needsUsingUp(band: ExpiryBand): boolean {
  return band === 'expired' || band === 'urgent' || band === 'soon'
}

export interface InventoryItem {
  readonly ingredient: CanonicalIngredient
  /** Total grams on hand across every product and lot. */
  readonly totalG: number
  readonly lotCount: number
  /** The worst band of any lot held, so one about-to-turn carton is visible. */
  readonly band: ExpiryBand
  /** Soonest expiry date held, or null when nothing held expires. */
  readonly soonestExpiry: DateOnly | null
}

/**
 * Every ingredient currently on hand, as the screen wants it.
 *
 * Depleted lots are excluded — they are kept in the database for history, but an
 * empty packet is not inventory. An ingredient with no available lots does not
 * appear at all: this is "what is in the kitchen", not a catalogue of everything
 * the app knows about.
 */
export function buildInventoryItems(
  ontology: OntologyIndex,
  inventory: InventoryIndex,
  today: DateOnly,
): InventoryItem[] {
  const items: InventoryItem[] = []

  for (const canonicalId of inventory.lotsByCanonical.keys()) {
    const lots = availableLotsFor(inventory, canonicalId)
    if (lots.length === 0) continue

    const ingredient = findIngredient(ontology, canonicalId)
    // An id with no ingredient behind it cannot be displayed or converted. The
    // seed merge never deletes, so this should not happen — skipping beats
    // crashing the whole screen if it somehow does.
    if (!ingredient) continue

    let totalG = 0
    let band: ExpiryBand = 'none'
    let soonestExpiry: DateOnly | null = null

    for (const lot of lots) {
      totalG += lot.remainingG
      const lotBand = expiryBand(lot, today)
      if (BAND_SEVERITY[lotBand] > BAND_SEVERITY[band]) band = lotBand
      if (lot.expiresOn !== null && (soonestExpiry === null || lot.expiresOn < soonestExpiry)) {
        soonestExpiry = lot.expiresOn
      }
    }

    items.push({ ingredient, totalG, lotCount: lots.length, band, soonestExpiry })
  }

  items.sort((a, b) => a.ingredient.name.localeCompare(b.ingredient.name))
  return items
}

/**
 * Grams left across a set of lots.
 *
 * Emptied packets contribute nothing, and "empty" is the engine's judgement
 * (`isLotAvailable`) rather than a `> 0` test here — floating-point crumbs are
 * exactly the sort of thing that would otherwise show as "0 g" on a packet the
 * app still thought had something in it.
 */
export function totalRemaining(lots: readonly Lot[]): number {
  return lots.filter(isLotAvailable).reduce((total, lot) => total + lot.remainingG, 0)
}

export function itemsInCategory(
  items: readonly InventoryItem[],
  category: IngredientCategory,
): InventoryItem[] {
  return items.filter((item) => item.ingredient.category === category)
}

/** Everything that needs using up, worst first. */
export function itemsNeedingUse(items: readonly InventoryItem[]): InventoryItem[] {
  return items
    .filter((item) => needsUsingUp(item.band))
    .sort((a, b) => {
      const severity = BAND_SEVERITY[b.band] - BAND_SEVERITY[a.band]
      if (severity !== 0) return severity
      return (a.soonestExpiry ?? '').localeCompare(b.soonestExpiry ?? '')
    })
}

export function countByCategory(
  items: readonly InventoryItem[],
): ReadonlyMap<IngredientCategory, number> {
  const counts = new Map<IngredientCategory, number>()
  for (const item of items) {
    counts.set(item.ingredient.category, (counts.get(item.ingredient.category) ?? 0) + 1)
  }
  return counts
}

/**
 * Category names as a person would read them.
 *
 * The stored values are lowercase machine ids; these are what goes on screen.
 * Keyed by the union type, so adding a category to the schema without giving it
 * a label is a compile error rather than a blank menu entry.
 */
export const CATEGORY_LABELS: Record<IngredientCategory, string> = {
  produce: 'Produce',
  protein: 'Protein',
  dairy: 'Dairy',
  grain: 'Grains',
  legume: 'Legumes',
  'fat-oil': 'Fats & oils',
  condiment: 'Condiments',
  spice: 'Spices',
  baking: 'Baking',
  beverage: 'Drinks',
  other: 'Other',
}

/**
 * The one-tap fractions on the Reconcile sheet (Jack, 2026-08-20).
 *
 * Measured against what the packet held when it was added, not against what is
 * left — "about half a bag" means half a bag, whatever the app currently thinks
 * is in it. That is the whole point: the app's number is the thing being
 * corrected, so it cannot also be the thing being measured against.
 *
 * Five steps rather than three. A nearly-full tub and a half-empty one are
 * genuinely different, and both are things a person can judge at a glance;
 * anything finer than a quarter is beyond what anyone can eyeball, which is
 * what the typed amount is for.
 */
export const RECONCILE_STEPS: readonly { readonly label: string; readonly fraction: number }[] = [
  { label: 'Full', fraction: 1 },
  { label: '¾', fraction: 0.75 },
  { label: '½', fraction: 0.5 },
  { label: '¼', fraction: 0.25 },
  { label: 'Empty', fraction: 0 },
]

/** Grams, rounded the way a person would say them. Never more precision than is real. */
export function formatGrams(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(grams >= 10_000 ? 0 : 1)} kg`
  if (grams >= 10) return `${Math.round(grams)} g`
  return `${grams.toFixed(1)} g`
}
