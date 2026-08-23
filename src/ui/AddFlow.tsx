/**
 * Kitchen OS — Putting food into the app
 *
 * One sheet, three steps: find it, describe it if it is new, say how much you
 * got. It opens over whatever pane you were looking at and returns you there,
 * rather than navigating away — standing in the kitchen with a bag in one hand
 * is not the moment to lose your place.
 *
 * The fast path is the one that matters. DECISIONS.md sets a target of under
 * twenty seconds to add a repeat product, and that is the entire reason the
 * Product tier exists: search, tap the product you already have, accept the
 * pre-filled package size, save. Three taps, no typing after the search.
 *
 * No arithmetic here. Every number is validated and converted by
 * `entry-forms.ts`, which in turn calls the engine.
 */
import { useMemo, useState } from 'react'
import type {
  CanonicalIngredient,
  DateOnly,
  IngredientCategory,
  Product,
  TrackBy,
} from '../types/schema'
import {
  INGREDIENT_CATEGORIES,
  TRACK_BY_MODES,
  convertibleUnits,
  validateIngredientDraft,
} from '../engine'
import { db } from '../db/db'
import { addProduct } from '../db/repo/products'
import { addLot } from '../db/repo/lots'
import { addUserIngredient } from '../db/repo/ingredients'
import { nowIso } from '../lib/clock'
import { CATEGORY_LABELS, formatGrams } from './inventory-view'
import { Field, NumberInput } from './FormControls'
import { advanceOnEnter, issueFor } from './form-behaviour'
import { ProductFields } from './ProductForm'
import {
  TRACK_BY_LABELS,
  defaultExpiry,
  emptyIngredientDraft,
  emptyLotDraft,
  emptyProductDraft,
  referenceProductDraft,
  rankSearch,
  toIngredientDraft,
  validateLotDraft,
  validateProductDraft,
  type FieldIssue,
  type IngredientDraft,
  type LotDraft,
  type ProductDraft,
} from './entry-forms'

type Step =
  | { readonly name: 'pick' }
  | { readonly name: 'ingredient'; readonly initialName: string }
  | {
      readonly name: 'product'
      readonly ingredient: CanonicalIngredient
      readonly notice?: readonly string[]
    }
  | { readonly name: 'lot'; readonly ingredient: CanonicalIngredient; readonly product: Product }

// ---------------------------------------------------------------------------
// Step 1 — find it
// ---------------------------------------------------------------------------

function PickStep({
  ingredients,
  products,
  onPickProduct,
  onPickIngredient,
  onAddIngredient,
}: {
  ingredients: readonly CanonicalIngredient[]
  products: readonly Product[]
  onPickProduct: (product: Product) => void
  onPickIngredient: (ingredient: CanonicalIngredient) => void
  onAddIngredient: (name: string) => void
}) {
  const [query, setQuery] = useState('')

  const byId = useMemo(
    () => new Map(ingredients.map((item) => [item.id, item])),
    [ingredients],
  )

  // Products you already have come first: that is the repeat purchase, which is
  // the case worth optimising for.
  const matchingProducts = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return products.slice(0, 8)
    return products
      .filter((product) => {
        const ingredient = byId.get(product.canonicalId)
        return (
          product.name.toLowerCase().includes(needle) ||
          (product.brand ?? '').toLowerCase().includes(needle) ||
          (ingredient?.name.toLowerCase().includes(needle) ?? false)
        )
      })
      .slice(0, 8)
  }, [products, byId, query])

  const searching = query.trim() !== ''

  /**
   * Ingredients appear only once something has been typed.
   *
   * Listing all 310 by default was worse than useless: it filled the sheet with
   * an alphabetical run that never got past B, so it looked like the whole
   * catalogue while showing almost none of it. Nobody scrolls a list to find
   * food they can name. Search is the way in; the list is the answer to a
   * question, not the starting position.
   */
  const matchingIngredients = useMemo(
    () => (searching ? rankSearch(ingredients, query, 30) : []),
    [ingredients, query, searching],
  )

  return (
    <div className="sheet-body">
      <input
        className="search"
        type="search"
        placeholder="What did you get?"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
      />

      {matchingProducts.length > 0 && (
        <>
          <div className="list-heading">{query.trim() === '' ? 'Recent' : 'Yours'}</div>
          <ul className="pick-list">
            {matchingProducts.map((product) => (
              <li key={product.id}>
                <button type="button" className="pick" onClick={() => onPickProduct(product)}>
                  <span className="pick-name">{product.name}</span>
                  <span className="pick-hint">
                    {byId.get(product.canonicalId)?.name ?? product.canonicalId}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {searching && (
        <>
          <div className="list-heading">Ingredients</div>
          {matchingIngredients.length === 0 ? (
            <p className="empty">Nothing matches “{query.trim()}”.</p>
          ) : (
            <ul className="pick-list">
              {matchingIngredients.map((ingredient) => (
                <li key={ingredient.id}>
                  <button
                    type="button"
                    className="pick"
                    onClick={() => onPickIngredient(ingredient)}
                  >
                    <span className="pick-name">{ingredient.name}</span>
                    <span className="pick-hint">new product</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {!searching && products.length === 0 && (
        <p className="empty">
          Type what you bought — there are {ingredients.length} ingredients to match against.
        </p>
      )}

      {/*
        Always offered, not only when the search comes up empty. Something can
        be present under a name you would not have guessed, and being told "no
        matches" first, THEN having to search again to be sure, is worse than a
        button that is simply always there. It carries the search text across so
        nothing is retyped.
      */}
      <button
        type="button"
        className="add-ingredient"
        onClick={() => onAddIngredient(query.trim())}
      >
        Can’t find it? Add a new ingredient
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 1b — an ingredient the app has never heard of
// ---------------------------------------------------------------------------

/**
 * The inline "can't find it? add it" form (DECISIONS.md, 2026-08-19).
 *
 * Deliberately part of this sheet rather than a screen you navigate to. Hitting
 * a missing ingredient happens standing in the kitchen holding the thing, and
 * being sent somewhere else to fix it — then having to find your way back and
 * start again — is exactly the friction that gets an app abandoned. Save, and
 * you land on the product form for what you just created.
 *
 * Every rule about what makes a valid ingredient comes from
 * `engine/ingredients.ts`. The messages below are its messages, shown as
 * written; nothing here decides what is allowed.
 */
export function IngredientStep({
  initialName,
  ingredients,
  onSaved,
  onBack,
}: {
  initialName: string
  ingredients: readonly CanonicalIngredient[]
  onSaved: (ingredient: CanonicalIngredient, notes: readonly string[]) => void
  onBack: () => void
}) {
  const [draft, setDraft] = useState<IngredientDraft>(() => emptyIngredientDraft(initialName))
  const [errors, setErrors] = useState<readonly FieldIssue[]>([])
  const [busy, setBusy] = useState(false)

  /**
   * Warnings are computed live; errors only appear once you try to save.
   *
   * They are different kinds of thing. A warning says what this entry will not
   * be able to do — useful while you are still deciding what to type, and it
   * must never block the save (DECISIONS.md). An error says the entry is
   * unusable, and shouting that at a half-typed form is just noise.
   */
  const warnings = useMemo(
    () => validateIngredientDraft(toIngredientDraft(draft), ingredients).warnings,
    [draft, ingredients],
  )

  async function save() {
    setBusy(true)
    try {
      const result = await addUserIngredient(db, toIngredientDraft(draft))
      if (!result.ok) {
        setErrors(result.errors)
        return
      }
      setErrors([])
      onSaved(
        result.ingredient,
        result.warnings.map((warning) => warning.message),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="sheet-body"
      onSubmit={(event) => event.preventDefault()}
      onKeyDown={advanceOnEnter}
    >
      <p className="sheet-context">
        This gets added to your ingredient list for good, and app updates will leave it alone.
      </p>

      <Field label="Name" error={issueFor(errors, 'name')}>
        <input
          type="text"
          value={draft.name}
          autoFocus
          placeholder="Gochujang"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </Field>

      <div className="row">
        <Field label="Category" error={issueFor(errors, 'category')}>
          <select
            value={draft.category}
            onChange={(event) =>
              setDraft({ ...draft, category: event.target.value as IngredientCategory })
            }
          >
            {INGREDIENT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Measured" error={issueFor(errors, 'trackBy')}>
          <select
            value={draft.trackBy}
            onChange={(event) => setDraft({ ...draft, trackBy: event.target.value as TrackBy })}
          >
            {TRACK_BY_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {TRACK_BY_LABELS[mode]}
              </option>
            ))}
          </select>
        </Field>

        {/* Only the conversion the chosen mode actually needs is asked for. */}
        {draft.trackBy === 'count' && (
          <Field label="Weight of one (g)" error={issueFor(errors, 'unitWeightG')}>
            <NumberInput
              value={draft.unitWeightG}
              placeholder="a clove is about 5"
              onChange={(value) => setDraft({ ...draft, unitWeightG: value })}
            />
          </Field>
        )}

        {draft.trackBy === 'volume' && (
          <Field label="Grams per millilitre" error={issueFor(errors, 'densityGPerMl')}>
            <NumberInput
              value={draft.densityGPerMl}
              placeholder="water 1.0, oil 0.92"
              onChange={(value) => setDraft({ ...draft, densityGPerMl: value })}
            />
          </Field>
        )}

        {draft.trackBy !== 'volume' && (
          <Field label="Weight of one cup (g)" error={issueFor(errors, 'cupWeightG')}>
            <NumberInput
              value={draft.cupWeightG}
              placeholder="optional"
              onChange={(value) => setDraft({ ...draft, cupWeightG: value })}
            />
          </Field>
        )}
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={draft.tracked}
          onChange={(event) => setDraft({ ...draft, tracked: event.target.checked })}
        />
        <span>Count it — quantities and calories. Off for things like salt and pepper.</span>
      </label>

      <label className="toggle">
        <input
          type="checkbox"
          checked={draft.perishable}
          onChange={(event) => setDraft({ ...draft, perishable: event.target.checked })}
        />
        <span>It goes off — give it an expiry date and warnings.</span>
      </label>

      {draft.perishable && (
        <Field label="Usually lasts (days)" error={issueFor(errors, 'defaultShelfLifeDays')}>
          <NumberInput
            value={draft.defaultShelfLifeDays}
            placeholder="fills in the expiry date for you"
            onChange={(value) => setDraft({ ...draft, defaultShelfLifeDays: value })}
          />
        </Field>
      )}

      <Field label="Also known as (optional, comma separated)" error={issueFor(errors, 'aliases')}>
        <input
          type="text"
          value={draft.aliases}
          placeholder="red pepper paste, gochoojang"
          onChange={(event) => setDraft({ ...draft, aliases: event.target.value })}
        />
      </Field>

      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((warning) => (
            <li key={warning.field}>{warning.message}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          Add ingredient
        </button>
        <button type="button" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — describe it
// ---------------------------------------------------------------------------

function ProductStep({
  ingredient,
  notice,
  onSaved,
  onBack,
}: {
  ingredient: CanonicalIngredient
  /** Anything worth saying about how you got here — carried from a new ingredient. */
  notice?: readonly string[]
  onSaved: (product: Product) => void
  onBack: () => void
}) {
  /*
   * Opens already filled in when the app has generic figures for this
   * ingredient — produce, counter meat and fish, bulk bins.
   *
   * That is the point of the whole change. Adding a loose sweet potato used to
   * mean finding nine numbers on the internet first, because there is no
   * packaging to read them off. Now the form opens with USDA's figures in it,
   * says at the top that they are not a label, and can be saved as it stands or
   * corrected.
   *
   * For the 188 ingredients with no reference — anything whose brand is the
   * whole point — this is null and the ordinary blank form appears, unchanged.
   */
  const [draft, setDraft] = useState<ProductDraft>(
    () => referenceProductDraft(ingredient) ?? emptyProductDraft(),
  )
  const [errors, setErrors] = useState<readonly FieldIssue[]>([])
  const [warnings, setWarnings] = useState<readonly FieldIssue[]>([])
  const [busy, setBusy] = useState(false)

  async function save() {
    const result = validateProductDraft(draft, ingredient.id)
    setWarnings(result.warnings)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors([])
    setBusy(true)
    try {
      onSaved(await addProduct(db, result.product, nowIso()))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="sheet-body"
      onSubmit={(event) => event.preventDefault()}
      onKeyDown={advanceOnEnter}
    >
      <p className="sheet-context">
        New product for <strong>{ingredient.name}</strong>
      </p>

      {/*
        Warnings from creating the ingredient land here rather than stopping the
        flow at the previous step. They never blocked the save, so interrupting
        for them would be dishonest about how much they matter — but losing them
        entirely would leave you wondering later why cups are not offered.
      */}
      {notice !== undefined && notice.length > 0 && (
        <ul className="warnings">
          {notice.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      <ProductFields
        ingredient={ingredient}
        draft={draft}
        setDraft={setDraft}
        errors={errors}
        warnings={warnings}
      />

      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          Save product
        </button>
        <button type="button" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Step 3 — how much
// ---------------------------------------------------------------------------

function LotStep({
  ingredient,
  product,
  today,
  onSaved,
  onBack,
}: {
  ingredient: CanonicalIngredient
  product: Product
  today: DateOnly
  onSaved: () => void
  onBack: () => void
}) {
  const [draft, setDraft] = useState<LotDraft>(() =>
    emptyLotDraft(ingredient, today, product.packageSizeG),
  )
  const [errors, setErrors] = useState<readonly FieldIssue[]>([])
  const [busy, setBusy] = useState(false)

  const units = useMemo(() => convertibleUnits(ingredient, product), [ingredient, product])

  /**
   * Turning the freezer switch on clears the pre-filled date and turning it off
   * puts it back. A date typed by hand is left alone — the flag governs the
   * default, not the User's own answer.
   */
  function setFrozen(frozen: boolean) {
    setDraft((current) => {
      const wasDefault =
        current.expiresOn === (defaultExpiry(ingredient, current.acquiredOn, false) ?? '')
      if (!wasDefault) return { ...current, frozen }
      return {
        ...current,
        frozen,
        expiresOn: defaultExpiry(ingredient, current.acquiredOn, frozen) ?? '',
      }
    })
  }

  async function save() {
    const result = validateLotDraft(draft, ingredient, product.id, product)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors([])
    setBusy(true)
    try {
      await addLot(db, result.lot)
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  const preview = validateLotDraft(draft, ingredient, product.id, product)

  return (
    <form
      className="sheet-body"
      onSubmit={(event) => event.preventDefault()}
      onKeyDown={advanceOnEnter}
    >
      <p className="sheet-context">
        How much <strong>{product.name}</strong>?
      </p>

      <div className="row">
        <Field label="Amount" error={issueFor(errors, 'quantity')}>
          <NumberInput
            value={draft.quantity}
            autoFocus
            onChange={(value) => setDraft({ ...draft, quantity: value })}
          />
        </Field>

        <Field label="Unit" error={issueFor(errors, 'unit')}>
          <select
            value={draft.unit}
            onChange={(event) => setDraft({ ...draft, unit: event.target.value as LotDraft['unit'] })}
          >
            {units.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {preview.ok && draft.unit !== 'g' && (
        <p className="field-hint">Stored as {formatGrams(preview.grams)}.</p>
      )}

      <div className="row">
        <Field label="Bought on" error={issueFor(errors, 'acquiredOn')}>
          <input
            type="date"
            value={draft.acquiredOn}
            onChange={(event) => setDraft({ ...draft, acquiredOn: event.target.value })}
          />
        </Field>

        <Field label="Use by (blank = does not expire)">
          <input
            type="date"
            value={draft.expiresOn}
            onChange={(event) => setDraft({ ...draft, expiresOn: event.target.value })}
          />
        </Field>
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={draft.frozen}
          onChange={(event) => setFrozen(event.target.checked)}
        />
        <span>In the freezer</span>
      </label>

      <Field label="Note (optional)">
        <input
          type="text"
          value={draft.note}
          placeholder="back of the freezer"
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        />
      </Field>

      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          Add to the kitchen
        </button>
        <button type="button" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export function AddFlow({
  ingredients,
  products,
  today,
  onClose,
}: {
  ingredients: readonly CanonicalIngredient[]
  products: readonly Product[]
  today: DateOnly
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>({ name: 'pick' })

  const byId = useMemo(() => new Map(ingredients.map((item) => [item.id, item])), [ingredients])

  function pickProduct(product: Product) {
    const ingredient = byId.get(product.canonicalId)
    // A product whose ingredient has vanished cannot have its units worked out,
    // so there is nothing sensible to show. Should not happen: merges never delete.
    if (!ingredient) return
    setStep({ name: 'lot', ingredient, product })
  }

  const TITLES: Record<Step['name'], string> = {
    pick: 'Add to the kitchen',
    ingredient: 'New ingredient',
    product: 'New product',
    lot: 'Amount',
  }

  return (
    <div className="sheet-backdrop">
      <section className="sheet" role="dialog" aria-label="Add to the kitchen">
        <header className="sheet-head">
          <h2>{TITLES[step.name]}</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        {step.name === 'pick' && (
          <PickStep
            ingredients={ingredients}
            products={products}
            onPickProduct={pickProduct}
            onPickIngredient={(ingredient) => setStep({ name: 'product', ingredient })}
            onAddIngredient={(initialName) => setStep({ name: 'ingredient', initialName })}
          />
        )}

        {step.name === 'ingredient' && (
          <IngredientStep
            initialName={step.initialName}
            ingredients={ingredients}
            onBack={() => setStep({ name: 'pick' })}
            // Straight on to the product form for what was just created. This
            // is the "returns you to where you were" half of the decision —
            // creating the ingredient was never the goal, adding the food was.
            onSaved={(ingredient, notice) => setStep({ name: 'product', ingredient, notice })}
          />
        )}

        {step.name === 'product' && (
          <ProductStep
            ingredient={step.ingredient}
            notice={step.notice}
            onBack={() => setStep({ name: 'pick' })}
            onSaved={(product) => setStep({ name: 'lot', ingredient: step.ingredient, product })}
          />
        )}

        {step.name === 'lot' && (
          <LotStep
            ingredient={step.ingredient}
            product={step.product}
            today={today}
            onBack={() => setStep({ name: 'pick' })}
            onSaved={onClose}
          />
        )}
      </section>
    </div>
  )
}
