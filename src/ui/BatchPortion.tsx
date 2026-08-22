/**
 * Kitchen OS — "How much of it did you eat?"
 *
 * One question, asked in two places: straight after cooking something, and days
 * later from the log sheet when the rest of it gets eaten. It is one component
 * because it is one question — two copies would drift, and the thing they would
 * drift on is what a portion MEANS, which is the part that has to stay fixed.
 *
 * A portion is a fraction of the WHOLE batch, never of what is left
 * (DECISIONS.md, and the schema says so out loud). That is what makes two
 * helpings add up, and what makes "half" mean the same thing on Sunday and on
 * Tuesday.
 *
 * No arithmetic here — `cook-view.ts` decides which portions are available and
 * reads the typed percentage, and the engine clamps whatever arrives.
 */
import { useState, type ReactNode } from 'react'
import type { CookEvent, MealSlot } from '../types/schema'
import { remainingFraction } from '../engine'
import { db } from '../db/db'
import { logCookPortion } from '../db/repo/consumption'
import { nowIso } from '../lib/clock'
import { portionOptions, readPercent, remainingNote } from './cook-view'
import { MEAL_LABELS, MEAL_SLOTS } from './nutrition-view'

export function BatchPortion({
  cook,
  onLogged,
  secondary,
  footer,
}: {
  cook: CookEvent
  onLogged: () => void
  /** An answer that is not a portion — "None yet", "Back". Optional. */
  secondary?: ReactNode
  /** Anything below the actions: an undo, a way to remove the batch. */
  footer?: ReactNode
}) {
  const [chosen, setChosen] = useState<number | null>(null)
  const [typed, setTyped] = useState('')
  const [meal, setMeal] = useState<MealSlot | ''>('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const left = remainingFraction(cook)
  const options = portionOptions(left)
  const note = remainingNote(cook)

  /*
   * Typed wins when there is anything in the box, because typing is the more
   * deliberate act — and tapping a button clears the box, so the two controls
   * can never both look chosen.
   */
  const reading =
    typed.trim() !== ''
      ? readPercent(typed, left)
      : chosen === null
        ? null
        : ({ ok: true, fraction: chosen, warning: null } as const)

  async function logIt() {
    if (reading === null || !reading.ok) return
    setBusy(true)
    setFailure(null)
    try {
      await logCookPortion(
        db,
        { cookEventId: cook.id, fraction: reading.fraction, ...(meal === '' ? {} : { meal }) },
        nowIso(),
      )
      onLogged()
    } catch (error: unknown) {
      // Shown, never swallowed. `logCookPortion` refuses a batch with nothing
      // left rather than logging a zero, and that refusal has to be readable.
      setFailure(error instanceof Error ? error.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <>
      <div className="list-heading">How much did you eat?</div>
      {note !== null && <p className="field-hint">{note}</p>}

      <div className="meal-picker">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={chosen === option.fraction && typed === '' ? 'step step-chosen' : 'step'}
            aria-pressed={chosen === option.fraction && typed === ''}
            disabled={busy || !option.possible}
            onClick={() => {
              setChosen(option.fraction)
              setTyped('')
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* You cannot tap your way to two fifths. */}
      <label className={reading !== null && !reading.ok ? 'field field-bad' : 'field'}>
        <span className="field-label">Or a percentage of the batch</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="40"
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value)
            setChosen(null)
          }}
        />
        {reading !== null && !reading.ok && <span className="field-error">{reading.message}</span>}
      </label>

      {reading !== null && reading.ok && reading.warning !== null && (
        <ul className="warnings">
          <li>{reading.warning}</li>
        </ul>
      )}

      {/*
        Which meal. Nothing selected to begin with and the clock is never
        consulted (Jack, 2026-08-21) — the same rule the log sheet follows, and
        tapping the chosen one again clears it.
      */}
      <div className="list-heading">Which meal? (optional)</div>
      <div className="meal-picker">
        {MEAL_SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            className={meal === slot ? 'step step-chosen' : 'step'}
            aria-pressed={meal === slot}
            disabled={busy}
            onClick={() => setMeal(meal === slot ? '' : slot)}
          >
            {MEAL_LABELS[slot]}
          </button>
        ))}
      </div>

      {failure !== null && (
        <ul className="errors">
          <li>{failure}</li>
        </ul>
      )}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || reading === null || !reading.ok}
          onClick={() => void logIt()}
        >
          Log it
        </button>
        {secondary}
      </div>

      {footer}
    </>
  )
}
