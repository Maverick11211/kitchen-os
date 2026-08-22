/**
 * Kitchen OS — Logging something eaten
 *
 * One sheet, two steps: what was it, and how much. It opens over whatever pane
 * you were looking at, the same as the add flow, because logging lunch is not a
 * reason to lose your place.
 *
 * Phase 7 gave it a second kind of answer. A stew cooked on Sunday is eaten on
 * Monday and on Tuesday, and something had to make that batch findable days
 * later — so batches with anything left sit at the TOP of the picker, above the
 * kitchen (Jack, 2026-08-22). Not a screen of their own: the question "what did
 * I eat" has one place to be answered, and a portion of Sunday's stew is an
 * answer to it. What differs is only the second step — a fraction of a batch
 * rather than a weight of an ingredient.
 *
 * The defaults are the whole design (Jack, 2026-08-20). Search, tap the thing,
 * type a number, done: the packet you are eating out of is already chosen —
 * first-expiring first — its label supplies the calories, and the food comes
 * out of your kitchen unless you say otherwise. Everything else on the screen
 * is there for the cases where that is not what happened.
 *
 * No arithmetic here. `log-forms.ts` validates and converts, and it calls the
 * engine to do it (CLAUDE.md).
 */
import { useMemo, useState } from 'react'
import type { CanonicalIngredient, CookEvent, DateOnly, Product } from '../types/schema'
import type { InventoryIndex } from '../engine'
import { convertibleUnits } from '../engine'
import { db } from '../db/db'
import { deleteCookEvent } from '../db/repo/cooks'
import { logIngredient } from '../db/repo/consumption'
import { formatDate, localDayOf, nowIso } from '../lib/clock'
import { IngredientStep } from './AddFlow'
import { BatchPortion } from './BatchPortion'
import { batchAgeWarning, batchLeftLabel } from './cook-view'
import { rankSearch, type FieldIssue } from './entry-forms'
import { formatGrams, lotAmountText, type InventoryItem } from './inventory-view'
import {
  emptyLogDraft,
  logOptionsFor,
  productForChoice,
  validateLogDraft,
  type LogChoice,
  type LogDraft,
  type LogOptions,
} from './log-forms'
import { MEAL_LABELS, MEAL_SLOTS, relativeDayName } from './nutrition-view'

type Step =
  | { readonly name: 'pick' }
  | { readonly name: 'ingredient'; readonly initialName: string }
  | { readonly name: 'amount'; readonly ingredient: CanonicalIngredient }
  | { readonly name: 'portion'; readonly cook: CookEvent }

function issueFor(issues: readonly FieldIssue[], field: string): string | undefined {
  return issues.find((issue) => issue.field === field)?.message
}

// ---------------------------------------------------------------------------
// Step 1 — what was it
// ---------------------------------------------------------------------------

/** "Cooked yesterday · 60% left" — enough to recognise a batch by. */
function batchHint(cook: CookEvent, today: DateOnly): string {
  const day = localDayOf(cook.cookedAt)
  const when = relativeDayName(day, today)?.toLowerCase() ?? `on ${formatDate(day)}`
  return `Cooked ${when} · ${batchLeftLabel(cook)}`
}

/**
 * Whether a batch is old enough to say so, and the words for it.
 *
 * Nothing ages a batch out of this list — it stays offered until it is finished
 * — so this marker is the only thing between a three-week-old stew and a
 * portion logged without a second thought. The app says what it knows and lets
 * Jack decide (Jack, 2026-08-22): hiding it would be the app inventing a shelf
 * life for food it has never seen, and it cannot know what went in the freezer.
 */
function batchAge(cook: CookEvent, today: DateOnly): string | null {
  return batchAgeWarning(localDayOf(cook.cookedAt), today)
}

/**
 * Batches you have not finished come first, then what is in the kitchen, then
 * everything else once you type.
 *
 * Same reasoning as the add sheet's Recent products (DECISIONS.md,
 * 2026-08-20): a list is worth showing unprompted only when it is short and
 * yours. Both of these are. The full 310-entry ontology is not, so it waits for
 * a search.
 */
function PickStep({
  ingredients,
  onHand,
  cooks,
  today,
  onPick,
  onPickBatch,
  onAddIngredient,
}: {
  ingredients: readonly CanonicalIngredient[]
  onHand: readonly InventoryItem[]
  cooks: readonly CookEvent[]
  today: DateOnly
  onPick: (ingredient: CanonicalIngredient) => void
  onPickBatch: (cook: CookEvent) => void
  onAddIngredient: (name: string) => void
}) {
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''

  const matches = useMemo(
    () => (searching ? rankSearch(ingredients, query, 30) : []),
    [ingredients, query, searching],
  )

  return (
    <div className="sheet-body">
      <input
        className="search"
        type="search"
        placeholder="What did you eat?"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
      />

      {/*
        Above the kitchen, because a batch you cooked is the most likely answer
        to "what did you eat" and the hardest one to reconstruct any other way
        (Jack, 2026-08-22). Unprompted for the same reason "In your kitchen" is:
        the list is short and it is yours. A finished batch is not here — it is
        kept, but there is none of it to serve.
      */}
      {!searching && cooks.length > 0 && (
        <>
          <div className="list-heading">Cooked and not finished</div>
          <ul className="pick-list">
            {cooks.map((cook) => (
              <li key={cook.id}>
                <button type="button" className="pick" onClick={() => onPickBatch(cook)}>
                  <span className="pick-name">{cook.label}</span>
                  <span className="pick-hint">{batchHint(cook, today)}</span>
                  {batchAge(cook, today) !== null && (
                    <span className="pick-hint pick-hint-old">{batchAge(cook, today)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {!searching && onHand.length > 0 && (
        <>
          <div className="list-heading">In your kitchen</div>
          <ul className="pick-list">
            {onHand.slice(0, 12).map((item) => (
              <li key={item.ingredient.id}>
                <button type="button" className="pick" onClick={() => onPick(item.ingredient)}>
                  <span className="pick-name">{item.ingredient.name}</span>
                  <span className="pick-hint">{formatGrams(item.totalG)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {searching && (
        <>
          <div className="list-heading">Ingredients</div>
          {matches.length === 0 ? (
            <p className="empty">Nothing matches “{query.trim()}”.</p>
          ) : (
            <ul className="pick-list">
              {matches.map((ingredient) => (
                <li key={ingredient.id}>
                  <button type="button" className="pick" onClick={() => onPick(ingredient)}>
                    <span className="pick-name">{ingredient.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {!searching && onHand.length === 0 && cooks.length === 0 && (
        <p className="empty">Type what you ate — it does not have to be something you own.</p>
      )}

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
// Step 2 — how much
// ---------------------------------------------------------------------------

/** One thing the figures could come from: a packet, a product, or your own guess. */
function sourceLabel(
  choice: LogChoice,
  options: LogOptions,
  ingredient: CanonicalIngredient,
): { readonly name: string; readonly hint: string } {
  if (choice.kind === 'packet') {
    const packet = options.packets.find((option) => option.lot.id === choice.lotId)
    if (packet === undefined) return { name: 'That packet', hint: 'no longer here' }
    // Counted things say how many are left, not what they weigh — the same rule
    // the shelf follows (Jack, 2026-08-21).
    const left = `${lotAmountText(packet.lot, ingredient, packet.product).remaining} left`
    return {
      name: packet.product.name,
      hint:
        packet.lot.expiresOn === null
          ? left
          : `${left} · use by ${formatDate(packet.lot.expiresOn)}`,
    }
  }
  if (choice.kind === 'product') {
    const product = options.otherProducts.find((option) => option.id === choice.productId)
    return { name: product?.name ?? 'That product', hint: 'none left — figures only' }
  }
  return { name: 'Something else', hint: 'type the figures yourself' }
}

function AmountStep({
  ingredient,
  options,
  onLogged,
  onBack,
}: {
  ingredient: CanonicalIngredient
  options: LogOptions
  onLogged: () => void
  onBack: () => void
}) {
  const [draft, setDraft] = useState<LogDraft>(() => emptyLogDraft(ingredient, options))
  const [errors, setErrors] = useState<readonly FieldIssue[]>([])
  const [busy, setBusy] = useState(false)

  /*
   * The units offered follow the CHOSEN product, not just the ingredient. For a
   * count that product is what decides what "1" weighs, and a product with a
   * pack count can offer "count" even when the ontology entry could not.
   */
  const chosenProduct = productForChoice(draft.choice, options)
  const units = useMemo(
    () => convertibleUnits(ingredient, chosenProduct),
    [ingredient, chosenProduct],
  )

  /**
   * Switch source, keeping the unit if it still converts.
   *
   * Moving from a packet that knows its pack count to one that does not would
   * otherwise leave "count" selected and unconvertible, and the form would
   * report an error about a choice the User never made.
   */
  function chooseSource(choice: LogChoice) {
    const nextUnits = convertibleUnits(ingredient, productForChoice(choice, options))
    setDraft((current) => ({
      ...current,
      choice,
      unit: nextUnits.includes(current.unit) ? current.unit : 'g',
    }))
  }

  // Every source, in the order they are worth having: what you have open, what
  // you have run out of, and failing both, your own estimate.
  const choices: LogChoice[] = [
    ...options.packets.map((packet): LogChoice => ({ kind: 'packet', lotId: packet.lot.id })),
    ...options.otherProducts.map((product: Product): LogChoice => ({
      kind: 'product',
      productId: product.id,
    })),
    { kind: 'quick' },
  ]

  const preview = validateLogDraft(draft, ingredient, options)
  const typing = draft.choice.kind === 'quick'
  const chosenPacket = draft.choice.kind === 'packet'

  async function save() {
    const result = validateLogDraft(draft, ingredient, options)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors([])
    setBusy(true)
    try {
      await logIngredient(db, result.log, nowIso())
      onLogged()
    } finally {
      setBusy(false)
    }
  }

  function setQuick(field: keyof LogDraft['quick'], value: string) {
    setDraft((current) => ({ ...current, quick: { ...current.quick, [field]: value } }))
  }

  return (
    <form
      className="sheet-body"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <p className="sheet-context">
        How much <strong>{ingredient.name}</strong>?
      </p>

      <div className="row">
        <label className={issueFor(errors, 'amount') ? 'field field-bad' : 'field'}>
          <span className="field-label">Amount</span>
          <input
            type="text"
            inputMode="decimal"
            value={draft.amount}
            autoFocus
            onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
          />
          {issueFor(errors, 'amount') !== undefined && (
            <span className="field-error">{issueFor(errors, 'amount')}</span>
          )}
        </label>

        <label className={issueFor(errors, 'unit') ? 'field field-bad' : 'field'}>
          <span className="field-label">Unit</span>
          <select
            value={draft.unit}
            onChange={(event) =>
              setDraft({ ...draft, unit: event.target.value as LogDraft['unit'] })
            }
          >
            {units.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
          {issueFor(errors, 'unit') !== undefined && (
            <span className="field-error">{issueFor(errors, 'unit')}</span>
          )}
        </label>
      </div>

      {preview.ok && draft.unit !== 'g' && (
        <p className="field-hint">That is {formatGrams(preview.grams)}.</p>
      )}

      {/* Only worth asking when there is more than one answer. */}
      {choices.length > 1 && (
        <>
          <div className="list-heading">Which one?</div>
          <ul className="pick-list">
            {choices.map((choice) => {
              const key =
                choice.kind === 'packet'
                  ? choice.lotId
                  : choice.kind === 'product'
                    ? choice.productId
                    : 'quick'
              const chosen = key === (draft.choice.kind === 'packet'
                ? draft.choice.lotId
                : draft.choice.kind === 'product'
                  ? draft.choice.productId
                  : 'quick')
              const { name, hint } = sourceLabel(choice, options, ingredient)
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={chosen ? 'pick pick-chosen' : 'pick'}
                    onClick={() => chooseSource(choice)}
                  >
                    <span className="pick-name">{name}</span>
                    <span className="pick-hint">{hint}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {typing && (
        <>
          <div className="list-heading">Roughly, for what you ate</div>
          <div className="row">
            {(
              [
                ['calories', 'Calories'],
                ['carbsG', 'Carbs (g)'],
                ['fatG', 'Fat (g)'],
                ['proteinG', 'Protein (g)'],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className={issueFor(errors, field) ? 'field field-bad' : 'field'}>
                <span className="field-label">{label}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={draft.quick[field]}
                  onChange={(event) => setQuick(field, event.target.value)}
                />
                {issueFor(errors, field) !== undefined && (
                  <span className="field-error">{issueFor(errors, field)}</span>
                )}
              </label>
            ))}
          </div>
        </>
      )}

      {/*
        Which meal. Nothing is selected to begin with and the clock is not
        consulted (Jack, 2026-08-21): a 3pm plate is as likely to be a late lunch
        as an early dinner, and a default that has to be corrected every time is
        worse than none. Tapping the chosen one again clears it, so "I would
        rather not say" stays reachable rather than being a trap.
      */}
      <div className="list-heading">Which meal? (optional)</div>
      <div className="meal-picker">
        {MEAL_SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            className={draft.meal === slot ? 'step step-chosen' : 'step'}
            aria-pressed={draft.meal === slot}
            onClick={() => setDraft({ ...draft, meal: draft.meal === slot ? '' : slot })}
          >
            {MEAL_LABELS[slot]}
          </button>
        ))}
      </div>

      {/*
        The off switch. Default on, because eating your cheese should reduce your
        cheese — but not everything logged came out of this kitchen.
      */}
      {chosenPacket && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={draft.deduct}
            onChange={(event) => setDraft({ ...draft, deduct: event.target.checked })}
          />
          <span>Take it out of my kitchen</span>
        </label>
      )}

      {preview.ok && preview.warnings.length > 0 && (
        <ul className="warnings">
          {preview.warnings.map((issue) => (
            <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      )}

      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((issue) => (
            <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {preview.ok ? `Log it · ${Math.round(preview.log.macros.calories)} cal` : 'Log it'}
        </button>
        {/* "Back", not "Something else" — that phrase is taken, by the source
            option two rows up, and having both on screen read as a choice
            between the same thing twice. */}
        <button type="button" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Step 2, the other kind — a portion of something you cooked
// ---------------------------------------------------------------------------

function BatchStep({
  cook,
  today,
  onLogged,
  onBack,
}: {
  cook: CookEvent
  today: DateOnly
  onLogged: () => void
  onBack: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  /**
   * Removing a batch nobody has eaten from — a cook recorded by mistake, found
   * after the undo window on the cook sheet has closed (Jack, 2026-08-22).
   *
   * No confirmation step, because `deleteCookEvent` is the confirmation: it
   * refuses a batch with anything logged against it and names the entries in
   * the way. Nothing here decides whether it is safe; the transaction does.
   */
  async function remove() {
    setBusy(true)
    setFailure(null)
    try {
      await deleteCookEvent(db, cook.id)
      onLogged()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <div className="sheet-body">
      <p className="sheet-context">
        A portion of <strong>{cook.label}</strong>
      </p>
      <p className="field-hint">{batchHint(cook, today)}</p>
      {batchAge(cook, today) !== null && (
        <ul className="warnings">
          <li>You cooked this {batchAge(cook, today)}</li>
        </ul>
      )}

      <BatchPortion
        cook={cook}
        onLogged={onLogged}
        secondary={
          <button type="button" disabled={busy} onClick={onBack}>
            Back
          </button>
        }
        footer={
          <>
            {failure !== null && (
              <ul className="errors">
                <li>{failure}</li>
              </ul>
            )}
            <div className="undo">
              <span>Did not actually cook this?</span>
              <button type="button" disabled={busy} onClick={() => void remove()}>
                Remove this batch
              </button>
            </div>
          </>
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

export function LogFlow({
  ingredients,
  items,
  cooks,
  index,
  today,
  onClose,
}: {
  ingredients: readonly CanonicalIngredient[]
  /** What is in the kitchen, for the unprompted list. */
  items: readonly InventoryItem[]
  /** Batches with something left. Empty until something has been cooked. */
  cooks: readonly CookEvent[]
  index: InventoryIndex
  today: DateOnly
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>({ name: 'pick' })

  const TITLES: Record<Step['name'], string> = {
    pick: 'Log something eaten',
    ingredient: 'New ingredient',
    amount: 'How much',
    portion: 'How much of it',
  }

  return (
    <div className="sheet-backdrop">
      <section className="sheet" role="dialog" aria-label="Log something eaten">
        <header className="sheet-head">
          <h2>{TITLES[step.name]}</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        {step.name === 'pick' && (
          <PickStep
            ingredients={ingredients}
            onHand={items}
            cooks={cooks}
            today={today}
            onPick={(ingredient) => setStep({ name: 'amount', ingredient })}
            onPickBatch={(cook) => setStep({ name: 'portion', cook })}
            onAddIngredient={(initialName) => setStep({ name: 'ingredient', initialName })}
          />
        )}

        {step.name === 'portion' && (
          <BatchStep
            cook={step.cook}
            today={today}
            onLogged={onClose}
            onBack={() => setStep({ name: 'pick' })}
          />
        )}

        {step.name === 'ingredient' && (
          <IngredientStep
            initialName={step.initialName}
            ingredients={ingredients}
            onBack={() => setStep({ name: 'pick' })}
            // Straight on to the amount, the same as the add flow: creating the
            // ingredient was never the goal, recording the meal was.
            onSaved={(ingredient) => setStep({ name: 'amount', ingredient })}
          />
        )}

        {step.name === 'amount' && (
          <AmountStep
            ingredient={step.ingredient}
            options={logOptionsFor(index, step.ingredient.id)}
            onBack={() => setStep({ name: 'pick' })}
            onLogged={onClose}
          />
        )}
      </section>
    </div>
  )
}
