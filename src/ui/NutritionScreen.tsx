/**
 * Kitchen OS — The day (right-hand pane)
 *
 * Four numbers and a list. DECISIONS.md is explicit that v1 has no goals, no
 * targets and no comparison statistics, so there is deliberately nothing here
 * to compare today against — just what you ate and what it came to.
 *
 * Every figure shown was worked out by `nutrition-view.ts`, which in turn calls
 * the engine. This file does no arithmetic (CLAUDE.md), and it never looks a
 * product up: the macros come off the stored event, which is what makes a past
 * day stay exactly as it was when a product is corrected later.
 */
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import type { ConsumptionEvent, DateOnly } from '../types/schema'
import { db } from '../db/db'
import { deleteConsumption, restoreConsumption } from '../db/repo/consumption'
import { formatDate, formatTime } from '../lib/clock'
import { useDay, useFirstLoggedDay } from './useKitchenData'
import {
  canPageBack,
  canPageForward,
  emptyDayNote,
  headlineFigures,
  mealGroups,
  nextDay,
  previousDay,
  relativeDayName,
  type DayEntry,
} from './nutrition-view'

function EntryRow({
  entry,
  busy,
  onDelete,
}: {
  entry: DayEntry
  busy: boolean
  onDelete: (event: ConsumptionEvent) => void
}) {
  return (
    <li className="entry">
      <span className="entry-time">{formatTime(entry.event.consumedAt)}</span>

      <span className="entry-main">
        <span className="entry-name">{entry.label}</span>
        <span className="entry-detail">{entry.detail}</span>
      </span>

      <span className="entry-calories">
        {entry.calories} <span className="entry-unit">cal</span>
      </span>

      {/*
        Delete rather than edit. "History is immutable" is about never rewriting
        a stored snapshot; withdrawing an entry and logging a new one keeps that
        literally true while still letting a mis-tap be fixed (Jack, 2026-08-20).
        Absent on anything that came from cooking — that has to adjust the cook
        event it belongs to, which is Phase 7.
      */}
      {entry.canDelete ? (
        <button
          type="button"
          className="entry-remove"
          disabled={busy}
          aria-label={`Remove ${entry.label}`}
          onClick={() => onDelete(entry.event)}
        >
          Remove
        </button>
      ) : (
        <span className="entry-remove-spacer" />
      )}
    </li>
  )
}

export function NutritionScreen({ today, onLog }: { today: DateOnly; onLog: () => void }) {
  const { day: routeDay } = useParams<{ day: string }>()
  const day = routeDay ?? today
  const navigate = useNavigate()

  const events = useDay(day)
  const earliestDay = useFirstLoggedDay()

  const [undo, setUndo] = useState<ConsumptionEvent | null>(null)
  const [busy, setBusy] = useState(false)

  const figures = headlineFigures(events ?? [])
  const groups = mealGroups(events ?? [])
  const heading = relativeDayName(day, today) ?? formatDate(day)

  function goTo(target: DateOnly) {
    // Today keeps its own stable address so the rail link stays lit on it.
    navigate(target === today ? '/today' : `/day/${target}`)
    setUndo(null)
  }

  async function remove(event: ConsumptionEvent) {
    setBusy(true)
    try {
      const removed = await deleteConsumption(db, event.id)
      // The whole record is kept for Undo, not just its id: putting it back has
      // to restore the original timestamp and macro snapshot.
      if (removed !== undefined) setUndo(removed.event)
    } finally {
      setBusy(false)
    }
  }

  async function undoRemove() {
    if (undo === null) return
    setBusy(true)
    try {
      await restoreConsumption(db, undo)
      setUndo(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="screen">
      <header className="screen-head">
        <div className="day-nav">
          <button
            type="button"
            className="day-step"
            aria-label="Previous day"
            disabled={!canPageBack(day, earliestDay)}
            onClick={() => goTo(previousDay(day))}
          >
            ‹
          </button>
          <h1>{heading}</h1>
          <button
            type="button"
            className="day-step"
            aria-label="Next day"
            disabled={!canPageForward(day, today)}
            onClick={() => goTo(nextDay(day))}
          >
            ›
          </button>
        </div>

        <button type="button" className="log-button" onClick={onLog}>
          + Log something eaten
        </button>
      </header>

      <ul className="totals">
        {figures.map((figure) => (
          <li key={figure.key} className="total">
            <span className="total-value">
              {figure.value}
              {figure.unit}
            </span>
            <span className="total-label">{figure.label}</span>
          </li>
        ))}
      </ul>

      {undo !== null && (
        <div className="undo">
          <span>Removed {undo.label}.</span>
          <button type="button" disabled={busy} onClick={() => void undoRemove()}>
            Undo
          </button>
        </div>
      )}

      {/*
        Grouped by meal, with a subtotal on each heading (Jack, 2026-08-21).
        Sections nothing was eaten in are absent rather than empty: a Breakfast
        heading with nothing under it reads as a thing you failed to do.
        Entries logged before meals existed, or logged without saying, gather
        under "Other" at the end — they still count towards the four figures
        above, which are computed from the whole day.
      */}
      {events === undefined ? (
        <p className="empty">Reading the day…</p>
      ) : groups.length === 0 ? (
        <p className="empty">{emptyDayNote(day, today)}</p>
      ) : (
        groups.map((group) => (
          <section key={group.meal ?? 'other'} className="meal">
            <div className="meal-head">
              <h2>{group.heading}</h2>
              <span className="meal-total">
                {group.calories} <span className="entry-unit">cal</span>
              </span>
            </div>
            <ul className="entries">
              {group.entries.map((entry) => (
                <EntryRow
                  key={entry.event.id}
                  entry={entry}
                  busy={busy}
                  onDelete={(event) => void remove(event)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  )
}
