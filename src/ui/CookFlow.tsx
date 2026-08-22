/**
 * Kitchen OS — Cooking a recipe
 *
 * One sheet, two moments: what are you making, and how much of it did you eat.
 *
 * They are two moments rather than one screen because they are two events in
 * the data and DECISIONS.md is firm about that — cooking removes ingredients,
 * eating adds to the day, and a batch cooked to fill the fridge is eaten over
 * days. They are two moments in ONE SITTING because cooking lunch and eating
 * lunch is the common case (Jack, 2026-08-22), and "None yet — it's for later"
 * is a first-class answer rather than a way out.
 *
 * The preview is the point of the first moment: exactly which packets are about
 * to be debited, and what the recipe asks for that the kitchen cannot cover,
 * BEFORE anything happens.
 *
 * No arithmetic here. `cook-view.ts` shapes it and the engine decides it
 * (CLAUDE.md).
 */
import { useMemo, useState } from 'react'
import type { CookEvent, DateOnly, Recipe } from '../types/schema'
import type { InventoryIndex, OntologyIndex, RecipeDeductionPlan } from '../engine'
import { evaluateOwnership, planRecipeDeduction } from '../engine'
import { db } from '../db/db'
import { commitCook, deleteCookEvent } from '../db/repo/cooks'
import { nowIso } from '../lib/clock'
import { BatchPortion } from './BatchPortion'
import {
  DEFAULT_SCALE,
  batchSummary,
  buildCookLines,
  commitLabel,
  cookPreviewNotes,
  planChanged,
  scaleNote,
  scaleOptions,
  type CookLineView,
} from './cook-view'

/**
 * The quiet word at the end of a row. Same rule as the recipe detail's list:
 * the normal case is unmarked, so the list reads as a list of problems.
 */
const STATUS_LABEL: Record<CookLineView['status'], string> = {
  full: '',
  short: 'Not enough',
  none: 'None here',
  staple: 'Assumed in the cupboard',
  optional: 'Skipping the garnish',
}

/**
 * Which of the recipe list's row styles each status borrows.
 *
 * A staple gets its own quiet one, NOT the red "missing" one. It is not a
 * problem — it is a thing the app has decided not to count — and colouring it
 * like a shortfall makes a preview of a perfectly stocked recipe look like it
 * has something wrong with it. (The browser pass found this; the tag was red.)
 */
const STATUS_STYLE: Record<CookLineView['status'], string> = {
  full: 'have',
  short: 'missing',
  none: 'missing',
  staple: 'staple',
  // A garnish you own none of borrows the same quiet style as a staple. It is
  // not a problem, and the recipe card had already said you have everything.
  optional: 'optional',
}

function PreviewRow({ line }: { line: CookLineView }) {
  const style = STATUS_STYLE[line.status]
  return (
    <li className={`ing ing-${style}`}>
      <span className="ing-amount">{line.amount}</span>
      <span className="ing-main">
        <span className="ing-name">{line.name}</span>
        {line.packets.length > 0 && (
          <span className="ing-prep">
            {line.packets.map((packet) => `${packet.amount} from ${packet.name}`).join(' · ')}
          </span>
        )}
      </span>
      <span className="ing-state">
        {STATUS_LABEL[line.status] !== '' && (
          <span className={`ing-tag ing-tag-${style}`}>{STATUS_LABEL[line.status]}</span>
        )}
        {line.shortLabel !== null && <span className="ing-stock">{line.shortLabel}</span>}
      </span>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Moment 1 — what are you making
// ---------------------------------------------------------------------------

function PlanStep({
  recipe,
  inventory,
  ontology,
  today,
  onCooked,
}: {
  recipe: Recipe
  inventory: InventoryIndex
  ontology: OntologyIndex
  today: DateOnly
  onCooked: (cook: CookEvent, committed: RecipeDeductionPlan, previewed: RecipeDeductionPlan) => void
}) {
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const ownership = useMemo(
    () => evaluateOwnership(recipe, inventory, ontology, { today }),
    [recipe, inventory, ontology, today],
  )
  const plan = useMemo(
    () => planRecipeDeduction(inventory, ontology, recipe, scale),
    [inventory, ontology, recipe, scale],
  )

  const sizes = scaleOptions(ownership)
  const note = scaleNote(ownership, scale)
  const lines = buildCookLines(recipe, plan, inventory, ontology)
  const notes = cookPreviewNotes(plan, ontology)

  async function cook() {
    setBusy(true)
    setFailure(null)
    try {
      const result = await commitCook(db, { recipe, ontology, scaleFactor: scale }, nowIso())
      onCooked(result.cook, result.plan, plan)
    } catch (error: unknown) {
      // Shown, never swallowed. A cook that did not happen must not look like
      // one that did — the packets on the shelf would disagree.
      setFailure(error instanceof Error ? error.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <div className="sheet-body">
      <p className="sheet-context">
        Making <strong>{recipe.name}</strong>
      </p>

      <div className="list-heading">How much are you making?</div>
      <div className="meal-picker">
        {sizes.map((size) => (
          <button
            key={size.scale}
            type="button"
            className={size.scale === scale ? 'step step-chosen' : 'step'}
            aria-pressed={size.scale === scale}
            onClick={() => setScale(size.scale)}
          >
            {size.label}
          </button>
        ))}
      </div>

      {/*
        Sizes bigger than the kitchen can cover are marked, not disabled (Jack,
        2026-08-22). Cooking while short is allowed; what is not allowed is
        being surprised by it afterwards.
      */}
      {note !== null && <p className="field-hint">{note}</p>}

      <div className="list-heading">What comes out of your kitchen</div>
      <ul className="ings">
        {lines.map((line, position) => (
          <PreviewRow key={`${line.canonicalId}-${position}`} line={line} />
        ))}
      </ul>

      <ul className="warnings">
        {notes.map((sentence) => (
          <li key={sentence}>{sentence}</li>
        ))}
      </ul>

      {failure !== null && (
        <ul className="errors">
          <li>{failure}</li>
        </ul>
      )}

      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void cook()}>
          {commitLabel(plan)}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Moment 2 — how much did you eat
// ---------------------------------------------------------------------------

function PortionStep({
  cook,
  committed,
  previewed,
  onDone,
  onUndone,
}: {
  cook: CookEvent
  committed: RecipeDeductionPlan
  previewed: RecipeDeductionPlan
  onDone: () => void
  onUndone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function undo() {
    setBusy(true)
    setFailure(null)
    try {
      await deleteCookEvent(db, cook.id)
      onUndone()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <div className="sheet-body">
      <div className="stand stand-ready">
        <p className="stand-headline">Cooked {cook.label}.</p>
        <p className="stand-notes">{batchSummary(cook.batchMacros)}</p>
      </div>

      {/*
        `commitCook` re-plans inside its transaction, so what was recorded is
        not necessarily what the preview showed. Almost never true on one iPad
        — but silence here would mean recording something he did not agree to.
      */}
      {planChanged(previewed, committed) && (
        <ul className="warnings">
          <li>
            The kitchen had changed since the preview, so what came out is not quite what was
            shown. What is recorded is what actually left.
          </li>
        </ul>
      )}

      {committed.shortfalls.some((shortfall) => !shortfall.optional) && (
        <ul className="warnings">
          <li>
            Cooked with less than the recipe asked for, so the batch figures are for what actually
            went in.
          </li>
        </ul>
      )}

      <BatchPortion
        cook={cook}
        onLogged={onDone}
        secondary={
          /*
            Not a "skip". Cooking to fill the fridge is a real thing to have
            done, and the batch waits in the log sheet until it gets eaten.
          */
          <button type="button" disabled={busy} onClick={onDone}>
            None yet — it’s for later
          </button>
        }
        footer={
          <>
            {failure !== null && (
              <ul className="errors">
                <li>{failure}</li>
              </ul>
            )}
            {/*
              The undo window (Jack, 2026-08-22). Here, while nothing has been
              eaten and the ingredients can go back exactly where they came
              from. Once a portion is logged, `deleteCookEvent` refuses and says
              what is in the way.
            */}
            <div className="undo">
              <span>Wrong recipe, or wrong size?</span>
              <button type="button" disabled={busy} onClick={() => void undo()}>
                Undo this cook
              </button>
            </div>
          </>
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

interface Cooked {
  readonly cook: CookEvent
  readonly committed: RecipeDeductionPlan
  readonly previewed: RecipeDeductionPlan
}

export function CookFlow({
  recipe,
  inventory,
  ontology,
  today,
  onClose,
}: {
  recipe: Recipe
  inventory: InventoryIndex
  ontology: OntologyIndex
  today: DateOnly
  onClose: () => void
}) {
  const [cooked, setCooked] = useState<Cooked | null>(null)

  return (
    <div className="sheet-backdrop">
      <section className="sheet" role="dialog" aria-label="Cook this recipe">
        <header className="sheet-head">
          {/*
            "Made it" is the phrase on the recipe detail's button, so it names
            the sheet it opened. The button INSIDE says `commitLabel` — one
            phrase must not mean both "start this" and "yes, commit".
          */}
          <h2>{cooked === null ? 'Made it' : 'Cooked'}</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        {cooked === null ? (
          <PlanStep
            recipe={recipe}
            inventory={inventory}
            ontology={ontology}
            today={today}
            onCooked={(cook, committed, previewed) => setCooked({ cook, committed, previewed })}
          />
        ) : (
          <PortionStep
            cook={cooked.cook}
            committed={cooked.committed}
            previewed={cooked.previewed}
            onDone={onClose}
            onUndone={onClose}
          />
        )}
      </section>
    </div>
  )
}
