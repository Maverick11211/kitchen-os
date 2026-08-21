/**
 * Kitchen OS — Shared form controls
 *
 * The two pieces every entry form in the app is built out of. Moved here from
 * `AddFlow.tsx` on 2026-08-21 when the product form was split out for editing —
 * controls used by three sheets should not live inside one of them.
 *
 * Nothing here validates or converts anything. It renders what it is handed;
 * the Enter-key behaviour these forms share is in `form-behaviour.ts`.
 */
import type { ReactNode } from 'react'

/**
 * A number field without the stepper arrows.
 *
 * `type="number"` draws little up/down wheels that are useless on a tablet and
 * easy to nudge by accident while scrolling. `inputMode="decimal"` still brings
 * up the numeric keypad on iPad, which is the part that actually matters.
 */
export function NumberInput({
  value,
  onChange,
  placeholder,
  autoFocus = false,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className={error ? 'field field-bad' : 'field'}>
      <span className="field-label">{label}</span>
      {children}
      {error !== undefined && <span className="field-error">{error}</span>}
    </label>
  )
}
