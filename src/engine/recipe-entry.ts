/**
 * Kitchen OS — Typing a recipe in
 *
 * Everything between "I want to add my nan's stew" and a `Recipe` that ranks
 * beside the 150 bundled ones: reading a pasted ingredient list, holding what
 * the form has collected, checking it, and building the row.
 *
 * Pure, like the rest of `src/engine/`. `now` is a parameter, ids are generated
 * from a set of ids the caller supplies, and nothing here touches Dexie.
 *
 * ## Why the paste path exists
 *
 * Every recipe line needs a canonical ingredient, a quantity and a unit, and
 * `quantityG` is precomputed. Typing ten lines against a 310-entry ontology
 * with three fields each is thirty interactions — the entry friction
 * DECISIONS.md names as the most common cause of abandonment, in its purest
 * form. Pasting the list and correcting what the parser got wrong is one
 * interaction plus however many it missed.
 *
 * The parser is deliberately unclever. It reads the shapes recipes are actually
 * written in and gives up honestly on anything else, because a line it guessed
 * wrong is worse than a line it left for the User to fix: a wrong guess is
 * silently wrong in the ownership figures, and a blank is visibly blank.
 */
import type {
  CanonicalId,
  CanonicalIngredient,
  Recipe,
  RecipeId,
  RecipeIngredient,
  RecipeStep,
  Timestamp,
  Unit,
} from '../types/schema'
import { slugifyIngredientId } from './ingredients'
import { toGrams } from './units'

// ---------------------------------------------------------------------------
// Reading a pasted list
// ---------------------------------------------------------------------------

/** Vulgar fractions, since a pasted recipe is as likely to hold ½ as 1/2. */
const GLYPH_FRACTIONS: Readonly<Record<string, number>> = {
  '¼': 0.25,
  '½': 0.5,
  '¾': 0.75,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅕': 0.2,
  '⅖': 0.4,
  '⅗': 0.6,
  '⅘': 0.8,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅛': 0.125,
  '⅜': 0.375,
  '⅝': 0.625,
  '⅞': 0.875,
}

/**
 * Every way a recipe writes a unit, mapped to the one this app stores.
 *
 * Both spellings of litre, because the seed set came from an American source
 * and Jack writes British.
 */
const UNIT_WORDS: Readonly<Record<string, Unit>> = {
  g: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  floz: 'floz',
}

/** Words that describe the ingredient rather than name it. */
const NOISE_WORDS: readonly string[] = [
  'fresh', 'freshly', 'large', 'small', 'medium', 'ripe', 'raw', 'whole',
  'finely', 'roughly', 'coarsely', 'thinly', 'chopped', 'diced', 'sliced',
  'minced', 'grated', 'crushed', 'peeled', 'trimmed', 'boneless', 'skinless',
  'of', 'a', 'an', 'the',
]

export interface ParsedLine {
  /** The line exactly as pasted, so a row that failed can show what it was. */
  readonly raw: string
  /** Null when the line names no amount — "salt and pepper to taste". */
  readonly quantity: number | null
  /** Null when no unit word was found AND no quantity implies a count. */
  readonly unit: Unit | null
  /** What is left after the amount is taken off: the ingredient, as written. */
  readonly name: string
  /** After a comma, or inside brackets. Kept verbatim for display. */
  readonly preparation: string
  /** The ontology entry this looks like, or null for the User to choose. */
  readonly canonicalId: CanonicalId | null
}

/** "1 1/2", "1½", "½", "2-3", "2.5" — the leading amount, and what is left. */
function takeQuantity(text: string): { quantity: number | null; rest: string } {
  // A range takes the TOP of it. "2-3 cloves" means you need three to be sure,
  // and a recipe you thought you could cook is the failure worth avoiding.
  const range = /^(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*/.exec(text)
  if (range) return { quantity: Number(range[2]), rest: text.slice(range[0].length) }

  const mixed = /^(\d+)\s+(\d+)\s*\/\s*(\d+)\s*/.exec(text)
  if (mixed) {
    return { quantity: Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]), rest: text.slice(mixed[0].length) }
  }

  const glyphMixed = /^(\d+)\s*([¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])\s*/.exec(text)
  if (glyphMixed) {
    return { quantity: Number(glyphMixed[1]) + GLYPH_FRACTIONS[glyphMixed[2]], rest: text.slice(glyphMixed[0].length) }
  }

  const fraction = /^(\d+)\s*\/\s*(\d+)\s*/.exec(text)
  if (fraction) return { quantity: Number(fraction[1]) / Number(fraction[2]), rest: text.slice(fraction[0].length) }

  const glyph = /^([¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])\s*/.exec(text)
  if (glyph) return { quantity: GLYPH_FRACTIONS[glyph[1]], rest: text.slice(glyph[0].length) }

  const plain = /^(\d+(?:\.\d+)?)\s*/.exec(text)
  if (plain) return { quantity: Number(plain[1]), rest: text.slice(plain[0].length) }

  return { quantity: null, rest: text }
}

function takeUnit(text: string): { unit: Unit | null; rest: string } {
  const flOz = /^fl\.?\s*(?:oz|ounces?)\b\.?\s*/i.exec(text)
  if (flOz) return { unit: 'floz', rest: text.slice(flOz[0].length) }

  const word = /^([a-zA-Z]+)\b\.?\s*/.exec(text)
  if (!word) return { unit: null, rest: text }

  const unit = UNIT_WORDS[word[1].toLowerCase()]
  return unit === undefined ? { unit: null, rest: text } : { unit, rest: text.slice(word[0].length) }
}

/** Strip the describing words, so "finely chopped fresh parsley" looks up parsley. */
function searchableName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !NOISE_WORDS.includes(word))
    .join(' ')
    .trim()
}

function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (word.endsWith('es') && word.length > 3) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1)
  return word
}

/**
 * The ontology entry a written ingredient most likely means.
 *
 * Four passes, most certain first: the exact name, an exact alias, the same
 * with plurals removed, and finally the longest ontology name or alias that
 * appears inside what was written — which is what catches "boneless skinless
 * chicken thighs" landing on "chicken thighs".
 *
 * Returns null rather than a weak guess. An unmatched line is one the form
 * asks about; a wrongly matched one is silently wrong in the ownership figures
 * for as long as the recipe exists.
 */
export function matchIngredient(
  written: string,
  ontology: readonly CanonicalIngredient[],
): CanonicalId | null {
  const cleaned = searchableName(written)
  if (cleaned === '') return null
  const singularised = cleaned.split(' ').map(singular).join(' ')

  for (const candidate of [cleaned, singularised]) {
    for (const entry of ontology) {
      if (entry.name.toLowerCase() === candidate) return entry.id
      if (entry.aliases.some((alias) => alias.toLowerCase() === candidate)) return entry.id
    }
  }

  let best: { id: CanonicalId; length: number } | null = null
  for (const entry of ontology) {
    for (const label of [entry.name, ...entry.aliases]) {
      const needle = label.toLowerCase()
      // Two characters or fewer would match half the ontology by accident.
      if (needle.length <= 2) continue
      if (!cleaned.includes(needle) && !singularised.includes(needle)) continue
      if (best === null || needle.length > best.length) best = { id: entry.id, length: needle.length }
    }
  }

  return best?.id ?? null
}

/**
 * Read a pasted ingredient list, one line at a time.
 *
 * Blank lines and section headings ("For the sauce:") are dropped — a heading
 * is a line ending in a colon with no amount on it, which is how every recipe
 * on the internet writes one.
 *
 * A line with no unit word but a number is a COUNT: "3 eggs", "2 onions". That
 * is the single most common shape in a recipe and getting it wrong would make
 * the parser useless.
 */
export function parseIngredientLines(
  text: string,
  ontology: readonly CanonicalIngredient[],
): ParsedLine[] {
  const lines: ParsedLine[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const raw = rawLine.trim().replace(/^[-•*•]\s*/, '')
    if (raw === '') continue
    if (raw.endsWith(':') && !/\d/.test(raw)) continue

    const { quantity, rest: afterQuantity } = takeQuantity(raw)
    const { unit, rest: afterUnit } = quantity === null
      ? { unit: null, rest: afterQuantity }
      : takeUnit(afterQuantity)

    const remainder = afterUnit.trim()
    const [namePart, ...preparationParts] = remainder.split(',')
    const bracketed = /\(([^)]*)\)/.exec(namePart)

    const name = namePart.replace(/\([^)]*\)/g, '').trim()
    const preparation = [bracketed?.[1], ...preparationParts]
      .filter((part): part is string => part !== undefined && part.trim() !== '')
      .map((part) => part.trim())
      .join(', ')

    lines.push({
      raw,
      quantity,
      // A bare number with no unit word is a count of something.
      unit: unit ?? (quantity === null ? null : 'count'),
      name,
      preparation,
      canonicalId: matchIngredient(name, ontology),
    })
  }

  return lines
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/**
 * Cuisine for a recipe that does not belong to one.
 *
 * Offered alongside the cuisines already in the library (Jack, 2026-08-21) so
 * that "Tuesday dinner" has somewhere to go without inventing a tag that then
 * sits alone in the filter menu forever.
 */
export const OTHER_CUISINE = 'Other'

/** One ingredient row in the form. Everything is a string: this is what was typed. */
export interface RecipeLineDraft {
  /** Empty until an ingredient is chosen — which a pasted line may not have. */
  readonly canonicalId: CanonicalId | ''
  readonly quantity: string
  readonly unit: Unit
  readonly optional: boolean
  readonly preparation: string
  /** The pasted text this row came from, so an unmatched row can show it. */
  readonly raw: string
}

export interface RecipeDraft {
  readonly name: string
  readonly cuisine: string
  readonly lines: readonly RecipeLineDraft[]
  /** One step per line. Optional entirely (Jack, 2026-08-21). */
  readonly steps: string
  /** Comma separated, free text (Jack, 2026-08-21) — the kit parser reads it. */
  readonly tools: string
  /** Optional. Nothing uses it until leftovers land in v2. */
  readonly yieldG: string
  readonly note: string
}

export function emptyRecipeLine(): RecipeLineDraft {
  return { canonicalId: '', quantity: '', unit: 'g', optional: false, preparation: '', raw: '' }
}

export function emptyRecipeDraft(): RecipeDraft {
  return {
    name: '',
    cuisine: '',
    lines: [emptyRecipeLine()],
    steps: '',
    tools: '',
    yieldG: '',
    note: '',
  }
}

/** Turn parsed lines into form rows, keeping what the parser could not resolve. */
export function draftLinesFromParse(parsed: readonly ParsedLine[]): RecipeLineDraft[] {
  return parsed.map((line) => ({
    canonicalId: line.canonicalId ?? '',
    quantity: line.quantity === null ? '' : String(Math.round(line.quantity * 1000) / 1000),
    unit: line.unit ?? 'g',
    optional: false,
    preparation: line.preparation,
    raw: line.raw,
  }))
}

/** Load an existing recipe back into the form, for editing (Jack, 2026-08-21). */
export function recipeDraftFrom(recipe: Recipe): RecipeDraft {
  return {
    name: recipe.name,
    cuisine: recipe.cuisines[0] ?? '',
    lines: recipe.ingredients.map((ingredient) => ({
      canonicalId: ingredient.canonicalId,
      quantity: String(ingredient.quantity),
      unit: ingredient.unit,
      optional: ingredient.optional,
      preparation: ingredient.preparation ?? '',
      raw: '',
    })),
    steps: recipe.steps.map((step) => step.text).join('\n'),
    tools: recipe.tools.join(', '),
    yieldG: recipe.estimatedYieldG === undefined ? '' : String(recipe.estimatedYieldG),
    note: recipe.note ?? '',
  }
}

// ---------------------------------------------------------------------------
// Checking it
// ---------------------------------------------------------------------------

export type RecipeIssueField = 'name' | 'cuisine' | 'lines' | 'steps' | 'yieldG'

export interface RecipeIssue {
  readonly field: RecipeIssueField
  /** Which row, when the issue belongs to one. Zero-based. */
  readonly line?: number
  readonly severity: 'error' | 'warning'
  /** Written to be shown as-is. */
  readonly message: string
}

export interface RecipeValidation {
  readonly ok: boolean
  readonly errors: readonly RecipeIssue[]
  readonly warnings: readonly RecipeIssue[]
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/**
 * Check a draft. Warnings never block a save; errors do.
 *
 * The rule that shapes this list: a row the User can see is wrong gets an
 * error, and a row that is merely thin gets a warning. No steps is a warning,
 * because a recipe you know by heart is a real recipe (Jack, 2026-08-21). A
 * line whose unit cannot be converted is an error, because `quantityG` is
 * computed once at save time and a recipe that skipped a line would rank as
 * though it did not need that ingredient.
 */
export function validateRecipeDraft(
  draft: RecipeDraft,
  ontology: readonly CanonicalIngredient[],
): RecipeValidation {
  const errors: RecipeIssue[] = []
  const warnings: RecipeIssue[] = []
  const byId = new Map(ontology.map((entry) => [entry.id, entry]))

  if (draft.name.trim() === '') {
    errors.push({ field: 'name', severity: 'error', message: 'Give the recipe a name.' })
  }

  if (draft.cuisine.trim() === '') {
    errors.push({ field: 'cuisine', severity: 'error', message: 'Pick a cuisine, or Other.' })
  }

  const filled = draft.lines.filter((line) => line.canonicalId !== '' || line.quantity.trim() !== '' || line.raw !== '')
  if (filled.length === 0) {
    errors.push({ field: 'lines', severity: 'error', message: 'A recipe needs at least one ingredient.' })
  }

  draft.lines.forEach((line, index) => {
    const blank = line.canonicalId === '' && line.quantity.trim() === '' && line.raw === ''
    if (blank) return

    if (line.canonicalId === '') {
      errors.push({
        field: 'lines',
        line: index,
        severity: 'error',
        message:
          line.raw === ''
            ? 'Choose an ingredient for this line.'
            : `Nothing in the ingredient list matches "${line.raw}". Choose one, or remove the line.`,
      })
      return
    }

    const ingredient = byId.get(line.canonicalId)
    if (ingredient === undefined) {
      errors.push({
        field: 'lines',
        line: index,
        severity: 'error',
        message: 'That ingredient is no longer in the list.',
      })
      return
    }

    const quantity = parseNumber(line.quantity)
    if (quantity === null || quantity <= 0) {
      errors.push({
        field: 'lines',
        line: index,
        severity: 'error',
        message: `How much ${ingredient.name.toLowerCase()}?`,
      })
      return
    }

    const grams = toGrams(ingredient, quantity, line.unit)
    if (!grams.ok) {
      // The engine already wrote a sentence explaining why, naming the
      // ingredient and the missing conversion field. Repeating it here in
      // worse words would help nobody.
      errors.push({ field: 'lines', line: index, severity: 'error', message: grams.message })
    }
  })

  if (draft.steps.trim() === '') {
    warnings.push({
      field: 'steps',
      severity: 'warning',
      message: 'No method saved. Fine if you know it by heart — the ingredients are what ranking uses.',
    })
  }

  const yieldG = parseNumber(draft.yieldG)
  if (draft.yieldG.trim() !== '' && (yieldG === null || yieldG <= 0)) {
    errors.push({ field: 'yieldG', severity: 'error', message: 'Finished weight must be a number of grams.' })
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// Building the recipe
// ---------------------------------------------------------------------------

export type CreateRecipeResult =
  | { readonly ok: true; readonly recipe: Recipe; readonly warnings: readonly RecipeIssue[] }
  | { readonly ok: false; readonly errors: readonly RecipeIssue[] }

/**
 * A readable id, unique against the ones already taken.
 *
 * Deliberately the same slug rules as a User-added ingredient: an id is
 * something that turns up in a backup file and in the address bar, and two sets
 * of rules for what a readable id looks like would drift.
 */
export function generateRecipeId(name: string, taken: ReadonlySet<RecipeId>): RecipeId {
  const base = slugifyIngredientId(name)
  if (base === '') return ''
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function stepsFrom(text: string): RecipeStep[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => ({ order: index + 1, text: line }))
}

/**
 * Build the `Recipe` a valid draft describes.
 *
 * `quantityG` is computed HERE, once, exactly as the seed importer did it — so
 * a typed recipe and a bundled one are the same kind of object by the time
 * anything ranks them, and no screen ever converts a unit (CLAUDE.md).
 *
 * `existingId` keeps an edited recipe's id, so its address, its cook events and
 * anything else pointing at it survive being edited (Jack, 2026-08-21).
 */
export function createUserRecipe(
  draft: RecipeDraft,
  ontology: readonly CanonicalIngredient[],
  taken: ReadonlySet<RecipeId>,
  now: Timestamp,
  existingId?: RecipeId,
): CreateRecipeResult {
  const validation = validateRecipeDraft(draft, ontology)
  if (!validation.ok) return { ok: false, errors: validation.errors }

  const byId = new Map(ontology.map((entry) => [entry.id, entry]))
  const ingredients: RecipeIngredient[] = []

  for (const line of draft.lines) {
    if (line.canonicalId === '') continue
    const ingredient = byId.get(line.canonicalId)
    if (ingredient === undefined) continue

    const quantity = parseNumber(line.quantity)
    if (quantity === null) continue

    const grams = toGrams(ingredient, quantity, line.unit)
    if (!grams.ok) continue

    ingredients.push({
      canonicalId: line.canonicalId,
      quantity,
      unit: line.unit,
      quantityG: Math.round(grams.grams * 10) / 10,
      optional: line.optional,
      ...(line.preparation.trim() === '' ? {} : { preparation: line.preparation.trim() }),
    })
  }

  const yieldG = parseNumber(draft.yieldG)

  const recipe: Recipe = {
    id: existingId ?? generateRecipeId(draft.name, taken),
    name: draft.name.trim(),
    cuisines: [draft.cuisine.trim()],
    ingredients,
    // Appliances are not asked for. The tool text is what the kit check reads,
    // and asking for both would be asking the same question twice.
    requiredAppliances: [],
    tools: splitList(draft.tools),
    steps: stepsFrom(draft.steps),
    ...(yieldG === null ? {} : { estimatedYieldG: yieldG }),
    isSeed: false,
    createdAt: now,
    ...(draft.note.trim() === '' ? {} : { note: draft.note.trim() }),
  }

  return { ok: true, recipe, warnings: validation.warnings }
}
