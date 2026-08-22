/**
 * Kitchen OS — Typing a recipe in
 *
 * A sheet, like the add flow, so it opens over whatever you were looking at and
 * puts you back there. Used for both adding and editing (Jack, 2026-08-21) —
 * the same form loaded from a saved recipe is how editing works, and a second
 * form for it would drift from this one within a month.
 *
 * ## The paste path comes first
 *
 * Ten ingredient lines, each needing a canonical ingredient, a quantity and a
 * unit, is thirty interactions — the entry friction DECISIONS.md names as the
 * commonest cause of abandonment. So the first thing this sheet offers is a box
 * to paste the list into. `parseIngredientLines` fills in what it can and
 * leaves what it cannot, and fixing three rows beats typing ten.
 *
 * Typing it by hand is one tap away for a recipe that only exists in your head.
 *
 * No arithmetic here, and no validation rules: `engine/recipe-entry.ts` decides
 * what a valid recipe is and computes every `quantityG`. This file renders what
 * it says.
 */
import { useMemo, useState } from 'react'
import type { CanonicalIngredient, Recipe, Unit } from '../types/schema'
import type { RecipeDraft, RecipeIssue, RecipeLineDraft } from '../engine'
import {
  OTHER_CUISINE,
  convertibleUnits,
  createUserRecipe,
  draftLinesFromParse,
  emptyRecipeDraft,
  emptyRecipeLine,
  parseIngredientLines,
  recipeDraftFrom,
  validateRecipeDraft,
} from '../engine'
import { db } from '../db/db'
import { saveUserRecipe } from '../db/repo/recipes'
import { nowIso } from '../lib/clock'
import { Field, NumberInput } from './FormControls'
import { IngredientStep } from './AddFlow'
import { rankSearch } from './entry-forms'
import { cuisineOptions } from './recipe-view'

/** Units offered when no ingredient has been chosen yet. */
const ALL_UNITS: readonly Unit[] = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'floz', 'count']

const UNIT_LABEL: Record<Unit, string> = {
  g: 'g', kg: 'kg', oz: 'oz', lb: 'lb',
  ml: 'ml', l: 'l', tsp: 'tsp', tbsp: 'tbsp', cup: 'cup', floz: 'fl oz',
  count: 'each',
}

function issuesForLine(issues: readonly RecipeIssue[], index: number): RecipeIssue | undefined {
  return issues.find((issue) => issue.line === index)
}

function issueForField(issues: readonly RecipeIssue[], field: RecipeIssue['field']): string | undefined {
  return issues.find((issue) => issue.field === field && issue.line === undefined)?.message
}

// ---------------------------------------------------------------------------
// Picking the ingredient for one line
// ---------------------------------------------------------------------------

/**
 * The same search as the add flow, and the same escape hatch.
 *
 * "Can't find it? Add a new ingredient" runs `IngredientStep` from `AddFlow` —
 * the actual component, not a copy of it. That path was built for the moment
 * someone hits an ingredient the app has never heard of, and hitting it while
 * typing a recipe is the same moment.
 */
function LinePicker({
  initialQuery,
  ingredients,
  onPick,
  onClose,
}: {
  initialQuery: string
  ingredients: readonly CanonicalIngredient[]
  onPick: (ingredient: CanonicalIngredient) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [adding, setAdding] = useState(false)

  const matches = useMemo(
    () => (query.trim() === '' ? [] : rankSearch(ingredients, query, 30)),
    [ingredients, query],
  )

  return (
    <div className="sheet-backdrop">
      <div className="sheet">
        <header className="sheet-head">
          <h2>{adding ? 'New ingredient' : 'Which ingredient?'}</h2>
          <button type="button" onClick={adding ? () => setAdding(false) : onClose}>
            {adding ? 'Back' : 'Cancel'}
          </button>
        </header>

        {adding ? (
          <IngredientStep
            initialName={query.trim()}
            ingredients={ingredients}
            onSaved={(ingredient) => onPick(ingredient)}
            onBack={() => setAdding(false)}
          />
        ) : (
          <div className="sheet-body">
            <input
              className="search"
              type="search"
              placeholder="Search the ingredient list"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />

            {matches.length > 0 && (
              <ul className="pick-list">
                {matches.map((ingredient) => (
                  <li key={ingredient.id}>
                    <button type="button" className="pick" onClick={() => onPick(ingredient)}>
                      <span className="pick-name">{ingredient.name}</span>
                      <span className="pick-hint">{ingredient.category}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {query.trim() !== '' && matches.length === 0 && (
              <p className="empty">Nothing matches “{query.trim()}”.</p>
            )}

            <button type="button" className="add-ingredient" onClick={() => setAdding(true)}>
              Can’t find it? Add a new ingredient
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One ingredient row
// ---------------------------------------------------------------------------

function LineRow({
  line,
  index,
  ingredient,
  issue,
  onChange,
  onPick,
  onRemove,
}: {
  line: RecipeLineDraft
  index: number
  ingredient: CanonicalIngredient | undefined
  issue: RecipeIssue | undefined
  onChange: (next: RecipeLineDraft) => void
  onPick: () => void
  onRemove: () => void
}) {
  // Only the units this ingredient can actually be converted in. Offering cups
  // of an ingredient with no cup weight is offering an error.
  const units = ingredient === undefined ? ALL_UNITS : convertibleUnits(ingredient)

  return (
    <li className={issue === undefined ? 'line' : 'line line-bad'}>
      <button type="button" className="line-pick" onClick={onPick}>
        {ingredient !== undefined ? (
          <span className="line-name">{ingredient.name}</span>
        ) : (
          <span className="line-unmatched">{line.raw === '' ? 'Choose an ingredient' : line.raw}</span>
        )}
      </button>

      <span className="line-amount">
        <NumberInput
          value={line.quantity}
          placeholder="0"
          onChange={(quantity) => onChange({ ...line, quantity })}
        />
        <select
          value={line.unit}
          onChange={(event) => onChange({ ...line, unit: event.target.value as Unit })}
        >
          {units.map((unit) => (
            <option key={unit} value={unit}>
              {UNIT_LABEL[unit]}
            </option>
          ))}
        </select>
      </span>

      <input
        className="line-prep"
        type="text"
        placeholder="finely diced"
        value={line.preparation}
        onChange={(event) => onChange({ ...line, preparation: event.target.value })}
      />

      {/*
        Optional means "excluded from the ownership percentage" — a garnish you
        can skip. It is the same flag the seed recipes carry.
      */}
      <label className="line-optional">
        <input
          type="checkbox"
          checked={line.optional}
          onChange={(event) => onChange({ ...line, optional: event.target.checked })}
        />
        <span>Optional</span>
      </label>

      <button type="button" className="line-remove" onClick={onRemove} aria-label={`Remove line ${index + 1}`}>
        ×
      </button>

      {issue !== undefined && <span className="line-error">{issue.message}</span>}
    </li>
  )
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export interface RecipeFormProps {
  readonly ingredients: readonly CanonicalIngredient[]
  readonly recipes: readonly Recipe[]
  /** Present when editing. Absent when adding. */
  readonly editing?: Recipe
  readonly onClose: () => void
  readonly onSaved: (recipe: Recipe) => void
}

export function RecipeForm({ ingredients, recipes, editing, onClose, onSaved }: RecipeFormProps) {
  const [draft, setDraft] = useState<RecipeDraft>(() =>
    editing === undefined ? emptyRecipeDraft() : recipeDraftFrom(editing),
  )
  // The paste box is the opening move when adding, and skipped when editing —
  // there is nothing to paste into a recipe that already exists.
  const [pasting, setPasting] = useState(editing === undefined)
  const [pasted, setPasted] = useState('')
  const [picking, setPicking] = useState<number | null>(null)
  const [errors, setErrors] = useState<readonly RecipeIssue[]>([])
  const [busy, setBusy] = useState(false)

  const byId = useMemo(() => new Map(ingredients.map((item) => [item.id, item])), [ingredients])
  const cuisines = useMemo(() => {
    const known = cuisineOptions(recipes)
    return known.includes(OTHER_CUISINE) ? known : [...known, OTHER_CUISINE]
  }, [recipes])

  // Warnings live; errors only once you try to save. Same rule as the add
  // flow: a half-typed form should not be shouted at.
  const warnings = useMemo(() => validateRecipeDraft(draft, ingredients).warnings, [draft, ingredients])

  function setLine(index: number, next: RecipeLineDraft) {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line, position) => (position === index ? next : line)),
    }))
  }

  function readPaste() {
    const parsed = parseIngredientLines(pasted, ingredients)
    if (parsed.length === 0) return
    setDraft((current) => ({ ...current, lines: draftLinesFromParse(parsed) }))
    setPasting(false)
  }

  async function save() {
    setBusy(true)
    try {
      const taken = new Set(recipes.map((recipe) => recipe.id))
      const result = createUserRecipe(draft, ingredients, taken, nowIso(), editing?.id)

      if (!result.ok) {
        setErrors(result.errors)
        return
      }

      await saveUserRecipe(db, result.recipe)
      onSaved(result.recipe)
    } finally {
      setBusy(false)
    }
  }

  if (picking !== null) {
    const line = draft.lines[picking]
    return (
      <LinePicker
        initialQuery={line?.raw ?? ''}
        ingredients={ingredients}
        onPick={(ingredient) => {
          const units = convertibleUnits(ingredient)
          setLine(picking, {
            ...line,
            canonicalId: ingredient.id,
            // Keep the unit if this ingredient can be measured in it, so
            // picking the right ingredient for a parsed line does not undo the
            // unit the parser already read correctly.
            unit: units.includes(line.unit) ? line.unit : (units[0] ?? 'g'),
          })
          setPicking(null)
        }}
        onClose={() => setPicking(null)}
      />
    )
  }

  if (pasting) {
    return (
      <div className="sheet-backdrop">
        <div className="sheet">
          <header className="sheet-head">
            <h2>Add a recipe</h2>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </header>

          <div className="sheet-body">
            <p className="sheet-context">
              Paste the ingredient list and it will be read into rows — amounts, units and all.
              Whatever it cannot match, it will ask you about rather than guess.
            </p>
            <textarea
              className="paste-box"
              rows={12}
              autoFocus
              placeholder={'2 lb chicken thighs, cut into chunks\n1½ cups jasmine rice\n3 large eggs\n2 tbsp soy sauce'}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
            />
          </div>

          <div className="sheet-foot actions">
            <button type="button" className="primary" disabled={pasted.trim() === ''} onClick={readPaste}>
              Read the list
            </button>
            <button type="button" onClick={() => setPasting(false)}>
              Type it out instead
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet sheet-wide">
        <header className="sheet-head">
          <h2>{editing === undefined ? 'Add a recipe' : `Edit ${editing.name}`}</h2>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </header>

        <div className="sheet-body">
          <div className="row">
            <Field label="Name" error={issueForField(errors, 'name')}>
              <input
                type="text"
                value={draft.name}
                placeholder="Nan’s beef stew"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>

            <Field label="Cuisine" error={issueForField(errors, 'cuisine')}>
              <select
                value={draft.cuisine}
                onChange={(event) => setDraft({ ...draft, cuisine: event.target.value })}
              >
                <option value="">Choose…</option>
                {cuisines.map((cuisine) => (
                  <option key={cuisine} value={cuisine}>
                    {cuisine}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="list-heading">Ingredients</div>
          {issueForField(errors, 'lines') !== undefined && (
            <p className="field-error">{issueForField(errors, 'lines')}</p>
          )}

          <ul className="lines">
            {draft.lines.map((line, index) => (
              <LineRow
                key={index}
                line={line}
                index={index}
                ingredient={line.canonicalId === '' ? undefined : byId.get(line.canonicalId)}
                issue={issuesForLine(errors, index)}
                onChange={(next) => setLine(index, next)}
                onPick={() => setPicking(index)}
                onRemove={() =>
                  setDraft((current) => ({
                    ...current,
                    lines: current.lines.filter((_, position) => position !== index),
                  }))
                }
              />
            ))}
          </ul>

          <button
            type="button"
            className="add-ingredient"
            onClick={() => setDraft({ ...draft, lines: [...draft.lines, emptyRecipeLine()] })}
          >
            + Another ingredient
          </button>

          <div className="list-heading">Method</div>
          <p className="field-hint">One step per line. Leave it empty if you know it by heart.</p>
          <textarea
            className="paste-box"
            rows={6}
            value={draft.steps}
            placeholder={'Brown the beef.\nAdd everything else and simmer for two hours.'}
            onChange={(event) => setDraft({ ...draft, steps: event.target.value })}
          />

          <div className="row">
            <Field label="Tools">
              <input
                type="text"
                value={draft.tools}
                placeholder="large pot, wooden spoon"
                onChange={(event) => setDraft({ ...draft, tools: event.target.value })}
              />
            </Field>

            <Field label="Finished weight (optional)" error={issueForField(errors, 'yieldG')}>
              <NumberInput
                value={draft.yieldG}
                placeholder="grams"
                onChange={(yieldG) => setDraft({ ...draft, yieldG })}
              />
            </Field>
          </div>

          <Field label="Note">
            <input
              type="text"
              value={draft.note}
              placeholder="Where it came from, or what to watch for"
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
          </Field>

          {warnings.length > 0 && (
            <ul className="warnings">
              {warnings.map((warning) => (
                <li key={warning.message}>{warning.message}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="sheet-foot actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
            {editing === undefined ? 'Save recipe' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
