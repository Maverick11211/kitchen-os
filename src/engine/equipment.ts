/**
 * Kitchen OS — Kit: what you cook with, and whether it fits
 *
 * Recipes name their equipment in free text — `Recipe.tools` holds 134 distinct
 * strings across the 150 seed recipes, from "wok" to "large heavy-based pan
 * with lid" — plus four structured ids in `requiredAppliances`. This module
 * turns both into a small vocabulary of KIT ITEMS, so the app can ask what he
 * owns once and check every recipe against the answer.
 *
 * Pure, like the rest of `src/engine/`.
 *
 * ## What is asked, and what is warned about
 *
 * The catalogue below is the vocabulary, not the questionnaire. What he is
 * actually asked comes from the recipes in front of him (`kitQuestions`), most
 * needed first — the same rule the four appliances already followed. A recipe
 * typed in later that calls for a mandoline adds its own question.
 *
 * Two warnings, both of them warnings and never filters. DECISIONS.md is
 * explicit that a recipe is shown whatever equipment it needs:
 *
 *   MISSING   he has said he does not own it
 *   TOO SMALL the recipe states a size, he has recorded his, and his is smaller
 *
 * Silence covers both "he owns it" and "he has never been asked", on purpose.
 * An absent row is unknown, not absent kit.
 *
 * ## Why sizes are only checked when the recipe states one
 *
 * Decided with Jack on 2026-08-21, against the alternative of estimating the
 * volume a recipe needs from `estimatedYieldG` and comparing it with his
 * biggest pot. That would have fired on all 150 recipes — and been wrong on
 * plenty of them, since finished weight is not volume, water boils off, and a
 * roasting tin is not judged by what it holds. Seven seed recipes state a size
 * outright. Those seven, plus every recipe he types himself, are checked
 * honestly; the rest say nothing, which is the ±15% spirit of this project
 * applied to equipment.
 */
import type { Appliance, ApplianceId, Recipe } from '../types/schema'

/**
 * The dimension a kind of kit is measured in.
 *
 *   qt — capacity, for things you fill: pots, saucepans, casseroles
 *   in — the longest side or the diameter, for things you lay food on or in
 *
 * `null` is for kit where size is not a question anybody asks. Nobody owns a
 * blender that is too small for a recipe in a way this app could check.
 */
export type SizeUnit = 'qt' | 'in'

export interface KitItem {
  readonly id: ApplianceId
  readonly name: string
  /** Powered things are grouped separately when he is asked. */
  readonly powered: boolean
  /** Absent when size is not a sensible question for this kind. */
  readonly sizeUnit?: SizeUnit
  /**
   * Lower-case fragments that identify this item in a recipe's tool text.
   *
   * Matched longest-first across the whole catalogue, so "non-stick frying pan"
   * lands on the non-stick pan rather than the plain frying pan, and "dutch
   * oven" does not land on "oven".
   */
  readonly terms: readonly string[]
}

/**
 * The kit vocabulary.
 *
 * Built from what the 150 seed recipes actually name, not from an idea of a
 * complete kitchen: every entry here is something at least one recipe asks for,
 * and the four ids that already exist in `requiredAppliances` (stovetop, oven,
 * grill-bbq, grill-broiler) keep their names so rows already in the database
 * stay valid.
 */
export const KIT_CATALOGUE: readonly KitItem[] = [
  // --- powered ---
  { id: 'stovetop', name: 'Stovetop', powered: true, terms: ['stovetop', 'hob'] },
  { id: 'oven', name: 'Oven', powered: true, terms: ['oven'] },
  { id: 'microwave', name: 'Microwave', powered: true, terms: ['microwave'] },
  { id: 'grill-bbq', name: 'Barbecue', powered: true, terms: ['barbecue', 'bbq', 'outdoor grill', 'charcoal grill'] },
  { id: 'grill-broiler', name: 'Overhead grill (broiler)', powered: true, terms: ['broiler', 'overhead grill'] },
  { id: 'air-fryer', name: 'Air fryer', powered: true, terms: ['air fryer', 'air-fryer'] },
  { id: 'rice-cooker', name: 'Rice cooker', powered: true, terms: ['rice cooker'] },
  { id: 'slow-cooker', name: 'Slow cooker', powered: true, terms: ['slow cooker', 'crock pot', 'crockpot'] },
  { id: 'pressure-cooker', name: 'Pressure cooker', powered: true, terms: ['pressure cooker', 'instant pot'] },
  { id: 'deep-fryer', name: 'Deep fryer', powered: true, terms: ['deep fryer', 'deep-fryer'] },
  { id: 'blender', name: 'Blender', powered: true, terms: ['blender'] },
  { id: 'stick-blender', name: 'Stick blender', powered: true, terms: ['stick blender', 'immersion blender', 'hand blender'] },
  { id: 'food-processor', name: 'Food processor', powered: true, terms: ['food processor'] },
  { id: 'mixer', name: 'Mixer', powered: true, terms: ['stand mixer', 'hand mixer', 'electric mixer', 'electric whisk'] },
  { id: 'kettle', name: 'Kettle', powered: true, terms: ['kettle'] },
  { id: 'toaster', name: 'Toaster', powered: true, terms: ['toaster'] },
  { id: 'waffle-iron', name: 'Waffle iron', powered: true, terms: ['waffle iron', 'waffle maker'] },
  { id: 'smoker', name: 'Smoker', powered: true, terms: ['smoker'] },

  // --- pots and pans, measured ---
  { id: 'pot', name: 'Pot', powered: false, sizeUnit: 'qt', terms: ['stockpot', 'stock pot', 'pot'] },
  { id: 'saucepan', name: 'Saucepan', powered: false, sizeUnit: 'qt', terms: ['saucepan', 'sauce pan'] },
  // "casserole" alone lands here rather than on the baking dish, because the
  // longer "casserole dish" is matched first and takes the oven-dish sense.
  { id: 'dutch-oven', name: 'Dutch oven / casserole', powered: false, sizeUnit: 'qt', terms: ['dutch oven', 'dutch pot', 'casserole pot', 'cast iron casserole', 'casserole'] },
  { id: 'frying-pan', name: 'Frying pan / skillet', powered: false, sizeUnit: 'in', terms: ['frying pan', 'skillet', 'saute pan', 'sauté pan', 'heavy-based pan', 'heavy based pan', 'pan'] },
  { id: 'non-stick-pan', name: 'Non-stick frying pan', powered: false, sizeUnit: 'in', terms: ['non-stick pan', 'nonstick pan', 'non-stick frying pan', 'nonstick frying pan', 'non-stick skillet'] },
  { id: 'wok', name: 'Wok', powered: false, sizeUnit: 'in', terms: ['wok'] },
  { id: 'griddle', name: 'Griddle / grill pan', powered: false, sizeUnit: 'in', terms: ['griddle', 'grill pan'] },

  // --- oven kit, measured ---
  { id: 'baking-tray', name: 'Baking tray', powered: false, sizeUnit: 'in', terms: ['baking tray', 'baking sheet', 'sheet pan', 'baking pan'] },
  { id: 'roasting-tin', name: 'Roasting tin', powered: false, sizeUnit: 'in', terms: ['roasting tin', 'roasting tray', 'roasting pan'] },
  { id: 'baking-dish', name: 'Baking dish', powered: false, sizeUnit: 'in', terms: ['baking dish', 'gratin dish', 'ovenproof dish', 'oven-proof dish', 'casserole dish'] },
  { id: 'pie-dish', name: 'Pie dish', powered: false, sizeUnit: 'in', terms: ['pie dish', 'pie plate', 'tart tin', 'flan tin'] },
  { id: 'cake-tin', name: 'Cake tin', powered: false, sizeUnit: 'in', terms: ['cake tin', 'cake pan', 'springform'] },
  { id: 'loaf-tin', name: 'Loaf tin', powered: false, sizeUnit: 'in', terms: ['loaf tin', 'loaf pan'] },
  { id: 'muffin-tin', name: 'Muffin tin', powered: false, sizeUnit: 'in', terms: ['muffin tin', 'muffin tray', 'cupcake tin'] },

  // --- unmeasured hand kit ---
  { id: 'mixing-bowl', name: 'Mixing bowl', powered: false, terms: ['mixing bowl', 'large bowl', 'salad bowl', 'bowl'] },
  { id: 'colander', name: 'Colander', powered: false, terms: ['colander'] },
  { id: 'wire-rack', name: 'Wire rack', powered: false, terms: ['wire rack', 'cooling rack'] },
  { id: 'sieve', name: 'Sieve', powered: false, terms: ['sieve', 'strainer'] },
  { id: 'skewers', name: 'Skewers', powered: false, terms: ['skewer', 'skewers'] },
  { id: 'thermometer', name: 'Kitchen thermometer', powered: false, terms: ['thermometer'] },
  { id: 'scales', name: 'Kitchen scales', powered: false, terms: ['scales', 'kitchen scale'] },
  { id: 'rolling-pin', name: 'Rolling pin', powered: false, terms: ['rolling pin'] },
  { id: 'grater', name: 'Grater', powered: false, terms: ['grater', 'box grater', 'microplane'] },
  { id: 'mortar-pestle', name: 'Mortar and pestle', powered: false, terms: ['mortar', 'pestle'] },
  { id: 'masher', name: 'Potato masher', powered: false, terms: ['masher', 'potato ricer', 'ricer'] },
  { id: 'mandoline', name: 'Mandoline', powered: false, terms: ['mandoline'] },
  { id: 'piping-bag', name: 'Piping bag', powered: false, terms: ['piping bag', 'pastry bag'] },
  { id: 'spatula', name: 'Spatula', powered: false, terms: ['spatula', 'fish slice'] },
  { id: 'whisk', name: 'Whisk', powered: false, terms: ['whisk'] },
  { id: 'tongs', name: 'Tongs', powered: false, terms: ['tongs'] },
  { id: 'peeler', name: 'Peeler', powered: false, terms: ['peeler'] },
  { id: 'pastry-brush', name: 'Pastry brush', powered: false, terms: ['pastry brush'] },
  { id: 'slotted-spoon', name: 'Slotted spoon', powered: false, terms: ['slotted spoon'] },
]

const BY_ID = new Map<ApplianceId, KitItem>(KIT_CATALOGUE.map((item) => [item.id, item]))

/**
 * Every (term, item) pair, longest term first.
 *
 * Longest-first is what makes "non-stick frying pan" beat "frying pan", "dutch
 * oven" beat "oven", and "large bowl" beat nothing else. Built once.
 */
const TERMS: readonly { readonly term: string; readonly item: KitItem }[] = KIT_CATALOGUE.flatMap(
  (item) => item.terms.map((term) => ({ term, item })),
).sort((a, b) => b.term.length - a.term.length)

export function findKitItem(id: ApplianceId): KitItem | undefined {
  return BY_ID.get(id)
}

/** The label for a size box: "quarts" or "inches". */
export function sizeUnitLabel(unit: SizeUnit): string {
  return unit === 'qt' ? 'quarts' : 'inches'
}

// ---------------------------------------------------------------------------
// Reading a recipe's tool text
// ---------------------------------------------------------------------------

/**
 * A stated size, converted to the unit its kind is measured in.
 *
 * Handles what the seed set actually writes: "6 qt pot", "12-inch skillet",
 * "20cm non-stick frying pan", "8-inch square baking dish", "10x14x2-inch
 * baking pan", "1.5-litre gratin dish".
 *
 * For a multi-dimension size the LONGEST side wins — "10x14x2-inch" is a 14
 * inch pan, because the question being asked is whether the food fits.
 *
 * Returns null when the stated dimension cannot be compared with the kind's
 * unit: a gratin dish is measured in inches here, so "1.5-litre" is dropped
 * rather than converted through an invented depth. One of the seven.
 */
export function parseStatedSize(text: string, unit: SizeUnit): number | null {
  const lower = text.toLowerCase()

  if (unit === 'qt') {
    const quarts = /(\d+(?:\.\d+)?)\s*-?\s*(?:qt\b|quarts?\b)/.exec(lower)
    if (quarts) return Number(quarts[1])
    const litres = /(\d+(?:\.\d+)?)\s*-?\s*(?:l\b|litres?\b|liters?\b)/.exec(lower)
    // A litre is 1.057 quarts. Rounding that to 1 would be precision theatre in
    // the wrong direction — it makes his pot look smaller, not larger.
    if (litres) return Number(litres[1]) * 1.057
    return null
  }

  const inches = /((?:\d+(?:\.\d+)?)(?:\s*(?:x|×)\s*\d+(?:\.\d+)?)*)\s*-?\s*(?:in\b|inch|inches|")/.exec(lower)
  if (inches) return largestDimension(inches[1])

  const centimetres = /((?:\d+(?:\.\d+)?)(?:\s*(?:x|×)\s*\d+(?:\.\d+)?)*)\s*-?\s*cm\b/.exec(lower)
  if (centimetres) return largestDimension(centimetres[1]) / 2.54

  return null
}

function largestDimension(group: string): number {
  return Math.max(...group.split(/\s*(?:x|×)\s*/).map(Number).filter((n) => !Number.isNaN(n)))
}

export interface KitRequirement {
  /**
   * The kit that satisfies this line. More than one when the recipe offers a
   * choice — "wok or large frying pan" is satisfied by EITHER, and warning
   * about a missing wok when he has a frying pan would be wrong.
   */
  readonly anyOf: readonly ApplianceId[]
  /** The size the recipe states, in the kind's unit. Null when it states none. */
  readonly statedSize: number | null
  /** The recipe's own words, for the warning to quote. */
  readonly text: string
}

/**
 * What one recipe needs, from `requiredAppliances` and the tool text together.
 *
 * A tool string the vocabulary does not recognise produces NO requirement. That
 * is deliberate: an unrecognised string is the parser's failure, not the User's
 * missing equipment, and inventing a warning out of it would train him to
 * ignore warnings. It stays visible as text on the recipe either way.
 */
export function equipmentNeeds(recipe: Recipe): KitRequirement[] {
  const requirements: KitRequirement[] = []
  const claimed = new Set<ApplianceId>()

  for (const id of recipe.requiredAppliances) {
    const item = BY_ID.get(id)
    if (item === undefined || claimed.has(id)) continue
    claimed.add(id)
    requirements.push({ anyOf: [id], statedSize: null, text: item.name })
  }

  for (const tool of recipe.tools) {
    const anyOf = matchAlternatives(tool)
    if (anyOf.length === 0) continue

    // A tool line naming something already required as an appliance adds
    // nothing, but it MAY add a size — "6 qt pot" against a bare "pot".
    const unit = BY_ID.get(anyOf[0])?.sizeUnit
    const statedSize = unit === undefined ? null : parseStatedSize(tool, unit)

    const alreadyThere = requirements.find(
      (existing) => existing.anyOf.length === anyOf.length && existing.anyOf.every((id, i) => id === anyOf[i]),
    )
    if (alreadyThere !== undefined && statedSize === null) continue

    requirements.push({ anyOf, statedSize, text: tool })
  }

  return requirements
}

/**
 * Split a tool string on "or" and match each half.
 *
 * "wok or large frying pan" is a choice; "large pan with lid" is not. Splitting
 * only on the word `or` keeps that distinction without a grammar.
 */
function matchAlternatives(tool: string): ApplianceId[] {
  const parts = tool.toLowerCase().split(/\bor\b/)
  const ids: ApplianceId[] = []

  for (const part of parts) {
    const found = TERMS.find((candidate) => part.includes(candidate.term))
    if (found !== undefined && !ids.includes(found.item.id)) ids.push(found.item.id)
  }

  return ids
}

// ---------------------------------------------------------------------------
// Checking it against what he owns
// ---------------------------------------------------------------------------

export type KitProblemKind = 'missing' | 'too-small'

export interface KitProblem {
  readonly kind: KitProblemKind
  readonly itemId: ApplianceId
  /** Ready to show: "You have no wok", "Your biggest pot is 3 qt; this needs 6". */
  readonly message: string
}

/**
 * Everything wrong with the kit for one recipe. Empty is the normal answer.
 *
 * A requirement offering alternatives is satisfied by any of them, and stays
 * silent unless he has said no to ALL of them — with an unanswered alternative
 * counting as "might have", because unknown is not a problem.
 */
export function kitProblems(
  needs: readonly KitRequirement[],
  kit: ReadonlyMap<ApplianceId, Appliance>,
): KitProblem[] {
  const problems: KitProblem[] = []
  const reported = new Set<string>()

  for (const need of needs) {
    const answers = need.anyOf.map((id) => kit.get(id))
    const anyUnanswered = answers.some((answer) => answer === undefined)
    const anyOwned = answers.some((answer) => answer?.owned === true)

    if (!anyOwned && !anyUnanswered) {
      const first = need.anyOf[0]
      const key = `missing:${first}`
      if (!reported.has(key)) {
        reported.add(key)
        problems.push({
          kind: 'missing',
          itemId: first,
          message: `You have no ${nameOf(need.anyOf).toLowerCase()}`,
        })
      }
      continue
    }

    if (need.statedSize === null) continue

    // Size is only judged against kit he owns AND has measured. Anything else
    // is a question he has not answered, and this app does not answer for him.
    for (const id of need.anyOf) {
      const owned = kit.get(id)
      const item = BY_ID.get(id)
      if (owned?.owned !== true || owned.size === undefined || item?.sizeUnit === undefined) continue
      if (owned.size + SIZE_EPSILON >= need.statedSize) continue

      const key = `too-small:${id}`
      if (reported.has(key)) continue
      reported.add(key)
      problems.push({
        kind: 'too-small',
        itemId: id,
        message: `Your biggest ${item.name.toLowerCase()} is ${format(owned.size)} ${item.sizeUnit}; this needs ${format(need.statedSize)}`,
      })
    }
  }

  return problems
}

/**
 * Half an inch of slack, and the same in quarts.
 *
 * A 12 inch pan and a recipe wanting 12 inches must not warn because 20 cm
 * converted to 7.874. Pans are not machined parts.
 */
const SIZE_EPSILON = 0.5

function format(value: number): string {
  return String(Math.round(value * 10) / 10)
}

function nameOf(ids: readonly ApplianceId[]): string {
  return ids.map((id) => BY_ID.get(id)?.name ?? id).join(' or ')
}

// ---------------------------------------------------------------------------
// What to ask him
// ---------------------------------------------------------------------------

export interface KitQuestion {
  readonly item: KitItem
  /** How many recipes in the library want it. The list is ordered on this. */
  readonly recipeCount: number
}

/**
 * The kit worth asking about, most needed first.
 *
 * Derived from the library rather than a fixed questionnaire (Jack,
 * 2026-08-21): asking about forty things a kitchen might have is the kind of
 * chore that gets abandoned half-answered, and a half-answered list is
 * indistinguishable from an unanswered one.
 */
export function kitQuestions(recipes: readonly Recipe[]): KitQuestion[] {
  const counts = new Map<ApplianceId, number>()

  for (const recipe of recipes) {
    const wanted = new Set<ApplianceId>()
    for (const need of equipmentNeeds(recipe)) {
      for (const id of need.anyOf) wanted.add(id)
    }
    for (const id of wanted) counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  return [...counts.entries()]
    .flatMap(([id, recipeCount]) => {
      const item = BY_ID.get(id)
      return item === undefined ? [] : [{ item, recipeCount }]
    })
    .sort((a, b) => b.recipeCount - a.recipeCount || a.item.name.localeCompare(b.item.name))
}
