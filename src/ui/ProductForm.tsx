/**
 * Kitchen OS — The product form's fields
 *
 * Just the fields: name, brand, what the label's figures are measured against,
 * and the nutrition panel. The frame around them — the heading, the buttons,
 * and what saving does — belongs to whoever is asking, because adding a product
 * and correcting one are different acts with the same questions.
 *
 * Extracted from `AddFlow.tsx` on 2026-08-21, when editing a product was added
 * (Jack's request). Two copies of a nine-field nutrition panel would have
 * drifted apart the first time either changed.
 *
 * No arithmetic here, and no saving. `entry-forms.ts` validates and converts;
 * this file only renders what it is given.
 */
import type { CanonicalIngredient } from '../types/schema'
import { Field, NumberInput } from './FormControls'
import { issueFor } from './form-behaviour'
import { MACRO_FIELDS, type FieldIssue, type MacroBasis, type MacroKey, type ProductDraft } from './entry-forms'

export function ProductFields({
  ingredient,
  draft,
  setDraft,
  errors,
  warnings,
}: {
  ingredient: CanonicalIngredient
  draft: ProductDraft
  setDraft: (update: (current: ProductDraft) => ProductDraft) => void
  errors: readonly FieldIssue[]
  warnings: readonly FieldIssue[]
}) {
  function setMacro(key: MacroKey, value: string) {
    setDraft((current) => ({ ...current, macros: { ...current.macros, [key]: value } }))
  }

  return (
    <>
      <Field label="Product name" error={issueFor(errors, 'name')}>
        <input
          type="text"
          value={draft.name}
          autoFocus
          placeholder="Kroger Boneless Chicken Breast"
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </Field>

      <Field label="Brand (optional)">
        <input
          type="text"
          value={draft.brand}
          onChange={(event) => setDraft((current) => ({ ...current, brand: event.target.value }))}
        />
      </Field>

      <div className="row">
        <Field label="Label figures are per">
          <select
            value={draft.basis}
            onChange={(event) => setDraft((current) => ({ ...current, basis: event.target.value as MacroBasis }))}
          >
            <option value="package">the package</option>
            <option value="serving">a serving</option>
            <option value="per100g">100 g</option>
          </select>
        </Field>

        {/* Each basis asks only for the measurement it cannot work out itself. */}
        {draft.basis === 'package' && (
          <Field label="Package size (g)" error={issueFor(errors, 'packageSizeG')}>
            <NumberInput
              value={draft.packageSizeG}
              onChange={(value: string) => setDraft((current) => ({ ...current, packageSizeG: value }))}
            />
          </Field>
        )}

        {draft.basis === 'serving' && (
          <>
            <Field label="Serving size (g)" error={issueFor(errors, 'servingSizeG')}>
              <NumberInput
                value={draft.servingSizeG}
                onChange={(value: string) => setDraft((current) => ({ ...current, servingSizeG: value }))}
              />
            </Field>
            <Field label="Servings per package" error={issueFor(errors, 'servingsPerPackage')}>
              <NumberInput
                value={draft.servingsPerPackage}
                placeholder="about 4"
                onChange={(value: string) => setDraft((current) => ({ ...current, servingsPerPackage: value }))}
              />
            </Field>
          </>
        )}

        {draft.basis === 'per100g' && (
          <Field label="Package size (g)" error={issueFor(errors, 'packageSizeG')}>
            <NumberInput
              value={draft.packageSizeG}
              placeholder="pre-fills the amount"
              onChange={(value: string) => setDraft((current) => ({ ...current, packageSizeG: value }))}
            />
          </Field>
        )}

        {/*
          Only for things counted rather than weighed, and it is the one number
          that makes "1 tortilla" mean one of THESE (Jack, 2026-08-21). Without
          it the app falls back to the ontology's average across every brand,
          which was quietly a third light on his tortillas.
        */}
        {ingredient.trackBy === 'count' && (
          <Field label="How many in a pack?" error={issueFor(errors, 'unitsPerPackage')}>
            <NumberInput
              value={draft.unitsPerPackage}
              placeholder="6"
              onChange={(value: string) => setDraft((current) => ({ ...current, unitsPerPackage: value }))}
            />
          </Field>
        )}
      </div>

      <div className="list-heading">Nutrition</div>
      <div className="macro-grid">
        {MACRO_FIELDS.map((field) => (
          <Field key={field.key} label={field.label} error={issueFor(errors, field.key)}>
            <NumberInput
              value={draft.macros[field.key]}
              onChange={(value: string) => setMacro(field.key, value)}
            />
          </Field>
        ))}
      </div>

      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((warning) => (
            <li key={warning.field}>{warning.message}</li>
          ))}
        </ul>
      )}
    </>
  )
}
