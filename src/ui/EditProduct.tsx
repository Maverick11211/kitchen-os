/**
 * Kitchen OS — Correcting a product
 *
 * Jack, 2026-08-21: "when reviewing an ingredient in the kitchen, I would like
 * the opportunity to edit all the functions I once had access to when first
 * adding". Same questions as the add form, asked again with the answers already
 * in them.
 *
 * This does NOT conflict with the add-only rule of 2026-08-19. That rule is
 * about CANONICAL ingredients, and its reasoning is seed-merge safety: a
 * redeployed ontology replaces a differing seed entry, so an edit there is
 * destroyed silently. Products are a different tier — the merge never touches
 * them — and a past day cannot move when one changes, because its macros were
 * snapshotted at log time.
 */
import { useState } from 'react'
import type { CanonicalIngredient, Product } from '../types/schema'
import { db } from '../db/db'
import { updateProduct } from '../db/repo/products'
import { ProductFields } from './ProductForm'
import { advanceOnEnter } from './form-behaviour'
import { productDraftFrom, validateProductDraft, type FieldIssue, type ProductDraft } from './entry-forms'

export function EditProduct({
  ingredient,
  product,
  onSaved,
  onCancel,
}: {
  ingredient: CanonicalIngredient
  product: Product
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<ProductDraft>(() => productDraftFrom(product))
  const [errors, setErrors] = useState<readonly FieldIssue[]>([])
  const [warnings, setWarnings] = useState<readonly FieldIssue[]>([])
  const [busy, setBusy] = useState(false)

  async function save() {
    const result = validateProductDraft(draft, product.canonicalId)
    setWarnings(result.warnings)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors([])
    setBusy(true)
    try {
      await updateProduct(db, product.id, result.product)
      onSaved()
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
        Correcting <strong>{product.name}</strong>
      </p>

      {/*
        Two things worth saying out loud, both about what editing does NOT do.
        The first is the basis: what is stored is per 100 g, and the figures
        below are shown that way whatever was originally typed off the label.
        The second is the one that matters — a correction is not a rewrite of
        the past.
      */}
      <p className="field-hint">
        The figures below are per 100 g. If you change what they are measured
        against, retype them to match the label.
      </p>
      <p className="field-hint">
        Days you have already logged keep the figures they were logged with —
        this only changes what gets counted from now on.
      </p>

      <ProductFields
        ingredient={ingredient}
        draft={draft}
        setDraft={setDraft}
        errors={errors}
        warnings={warnings}
      />

      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          Save changes
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
