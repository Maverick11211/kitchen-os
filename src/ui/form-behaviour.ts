/**
 * Kitchen OS — Form behaviour
 *
 * The two form helpers that are logic rather than markup: finding the message
 * for a field, and what the Enter key does. They live apart from
 * `FormControls.tsx` so that file can stay components-only.
 */
import type { KeyboardEvent } from 'react'
import type { FieldIssue } from './entry-forms'

export function issueFor(issues: readonly FieldIssue[], field: string): string | undefined {
  return issues.find((issue) => issue.field === field)?.message
}

/**
 * Enter moves to the next field rather than submitting the form.
 *
 * Typing a nutrition label is eight numbers in a row. Reaching for the screen
 * between each one is the difference between this taking fifteen seconds and
 * taking a minute, and a minute is where entry friction starts costing you the
 * habit. Past the last field, focus lands on the save button, so Enter all the
 * way through works.
 *
 * Only text fields are walked. Dropdowns are deliberately skipped: landing on
 * one mid-run stops the typing dead, because the next thing typed goes nowhere
 * and the next Enter does something unexpected. A choice gets tapped; a value
 * gets typed.
 */
export function advanceOnEnter(event: KeyboardEvent<HTMLFormElement>): void {
  if (event.key !== 'Enter') return
  const target = event.target
  if (!(target instanceof HTMLInputElement) || target.type === 'checkbox') return

  event.preventDefault()
  const form = event.currentTarget
  const fields = Array.from(form.querySelectorAll<HTMLInputElement>('input')).filter(
    (field) => field.type !== 'checkbox',
  )
  const next = fields[fields.indexOf(target) + 1]
  if (next) next.focus()
  else form.querySelector<HTMLButtonElement>('button.primary')?.focus()
}
