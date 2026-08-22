/**
 * Kitchen OS — "What do you cook with?"
 *
 * One list, used twice: as the one-off pass when the app has never been told
 * (`KitSetup` below), and as the editable list on Settings. Sharing the
 * component is the point — an answer given in one place has to look and behave
 * the same in the other, and two copies of a question drift.
 *
 * Every tap SAVES IMMEDIATELY. There is no submit button, so a pass abandoned
 * halfway keeps whatever was answered, and coming back later is the same screen
 * with more of it filled in.
 */
import { useState } from 'react'
import type { Appliance, ApplianceId } from '../types/schema'
import type { KitQuestion } from '../engine'
import { sizeUnitLabel } from '../engine'

export interface KitAnswer {
  readonly owned: boolean
  /** Undefined leaves the recorded size alone. */
  readonly size?: number
}

export interface KitListProps {
  readonly questions: readonly KitQuestion[]
  readonly kit: ReadonlyMap<ApplianceId, Appliance>
  readonly onAnswer: (question: KitQuestion, answer: KitAnswer) => void
}

/**
 * The size box, shown only once he has said he owns the thing.
 *
 * Asking how big a pot he does not own is a question with no answer, and asking
 * it of every row at once is how a list of 33 becomes a list of 66.
 */
function SizeField({
  question,
  answer,
  onAnswer,
}: {
  question: KitQuestion
  answer: Appliance
  onAnswer: (question: KitQuestion, next: KitAnswer) => void
}) {
  const unit = question.item.sizeUnit
  const [draft, setDraft] = useState(answer.size === undefined ? '' : String(answer.size))

  if (unit === undefined || !answer.owned) return null

  function commit(text: string) {
    setDraft(text)
    const trimmed = text.trim()
    if (trimmed === '') return
    const value = Number(trimmed)
    // Saved on every keystroke that parses. A size is one number, and a blur
    // handler that swallows the last digit is worse than a save that happens
    // twice.
    if (!Number.isNaN(value) && value > 0) onAnswer(question, { owned: true, size: value })
  }

  return (
    <label className="kit-size">
      <span className="kit-size-label">Biggest</span>
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="0.5"
        value={draft}
        placeholder="—"
        onChange={(event) => commit(event.target.value)}
      />
      <span className="kit-size-unit">{sizeUnitLabel(unit)}</span>
    </label>
  )
}

function KitRow({
  question,
  answer,
  onAnswer,
}: {
  question: KitQuestion
  answer: Appliance | undefined
  onAnswer: (question: KitQuestion, next: KitAnswer) => void
}) {
  return (
    <li className="kit-row">
      <span className="kit-main">
        <span className="kit-name">{question.item.name}</span>
        <span className="kit-count">
          {question.recipeCount === 1 ? '1 recipe' : `${question.recipeCount} recipes`}
        </span>
      </span>

      <span className="kit-answer">
        <SizeField
          question={question}
          answer={answer ?? { id: question.item.id, name: question.item.name, owned: false }}
          onAnswer={onAnswer}
        />
        {/*
          Neither button pressed until he answers. There is no default, because
          a default is a guess wearing his clothes — the rule this app has
          followed since Phase 5.
        */}
        <button
          type="button"
          className={answer?.owned === true ? 'kit-choice is-chosen' : 'kit-choice'}
          aria-pressed={answer?.owned === true}
          onClick={() => onAnswer(question, { owned: true })}
        >
          Yes
        </button>
        <button
          type="button"
          className={answer?.owned === false ? 'kit-choice is-chosen' : 'kit-choice'}
          aria-pressed={answer?.owned === false}
          onClick={() => onAnswer(question, { owned: false })}
        >
          No
        </button>
      </span>
    </li>
  )
}

export function KitList({ questions, kit, onAnswer }: KitListProps) {
  return (
    <ul className="kit-list">
      {questions.map((question) => (
        <KitRow
          key={question.item.id}
          question={question}
          answer={kit.get(question.item.id)}
          onAnswer={onAnswer}
        />
      ))}
    </ul>
  )
}

export interface KitSetupProps extends KitListProps {
  /** Finish for good: stamps the date so this never opens by itself again. */
  readonly onDone: () => void
  /** Not now: closes for this sitting, stamps nothing, asks again next time. */
  readonly onLater: () => void
}

/**
 * The one-off pass, shown when the app has never been told what he cooks with.
 *
 * "Not now" deliberately stamps nothing. The alternative — treating a dismissal
 * as an answer — would leave the app permanently unable to warn him about
 * equipment while looking as though it had been set up.
 */
export function KitSetup({ questions, kit, onAnswer, onDone, onLater }: KitSetupProps) {
  const answered = questions.filter((question) => kit.has(question.item.id)).length

  return (
    <div className="sheet-backdrop">
      <div className="sheet">
        <header className="sheet-head">
          <h2>What do you cook with?</h2>
          <button type="button" onClick={onLater}>
            Not now
          </button>
        </header>

        <div className="sheet-body">
          <p className="sheet-context">
            Answered once, and recipes needing something you have not got will say so. Anything
            you skip stays quiet rather than guessing. Sizes are the biggest you own — a recipe
            asking for a 6 quart pot can then tell you it will not fit in a 3.
          </p>

          <KitList questions={questions} kit={kit} onAnswer={onAnswer} />
        </div>

        {/*
          A footer OUTSIDE the scrolling body, so "Done" is reachable without
          scrolling to the end of thirty-five questions.
        */}
        <div className="sheet-foot actions">
          <button type="button" className="primary" onClick={onDone}>
            Done{answered > 0 && ` — ${answered} of ${questions.length} answered`}
          </button>
        </div>
      </div>
    </div>
  )
}
