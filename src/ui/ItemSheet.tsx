/**
 * Kitchen OS — One ingredient's packets, and correcting them
 *
 * This is the Reconcile screen DECISIONS.md has been promising since Phase 0.
 * Three separate decisions lean on it: quantity drift is accepted rather than
 * prevented, `defaultShelfLifeDays` knowingly under-warns once a jar is opened,
 * and `applyDeductions` clamps rather than going negative. All three are
 * survivable only because correcting a number is meant to be cheap.
 *
 * So it is one tap. A fraction is applied immediately and an Undo appears
 * (Jack, 2026-08-20) — asking "are you sure?" on every correction would double
 * the cost of the thing that is supposed to be free.
 *
 * All arithmetic is the engine's: `gramsForFraction` works out the amount and
 * `setLotRemaining` decides what the resulting lot looks like.
 */
import { useState } from 'react'
import type { CanonicalIngredient, DateOnly, Lot, Product } from '../types/schema'
import { gramsForFraction } from '../engine'
import { db } from '../db/db'
import { adjustLotRemaining, deleteLot, saveLot } from '../db/repo/lots'
import { formatDate, nowIso } from '../lib/clock'
import { EditProduct } from './EditProduct'
import {
  RECONCILE_STEPS,
  countOnHand,
  expiryBand,
  formatCount,
  formatGrams,
  lotAmountText,
  totalRemaining,
} from './inventory-view'

const BAND_NOTE: Record<ReturnType<typeof expiryBand>, string> = {
  expired: 'past its date',
  urgent: 'use now',
  soon: 'use soon',
  fine: '',
  none: '',
}

interface UndoState {
  readonly lot: Lot
  readonly description: string
}

function LotRow({
  lot,
  ingredient,
  product,
  today,
  busy,
  onFraction,
  onExact,
  onThrowOut,
  onEditProduct,
}: {
  lot: Lot
  ingredient: CanonicalIngredient
  product: Product | undefined
  today: DateOnly
  busy: boolean
  onFraction: (lot: Lot, fraction: number) => void
  onExact: (lot: Lot, grams: number) => void
  onThrowOut: (lot: Lot) => void
  onEditProduct: (product: Product) => void
}) {
  const [typed, setTyped] = useState('')
  const [confirming, setConfirming] = useState(false)
  const amount = lotAmountText(lot, ingredient, product)
  const band = expiryBand(lot, today)
  const note = BAND_NOTE[band]

  function submitTyped() {
    const value = Number(typed.trim())
    if (typed.trim() === '' || !Number.isFinite(value) || value < 0) return
    onExact(lot, value)
    setTyped('')
  }

  return (
    <li className={lot.depleted ? 'lot lot-empty' : 'lot'}>
      <div className="lot-head">
        <div>
          <span className="lot-name">{product?.name ?? 'Unknown product'}</span>
          {lot.frozen === true && <span className="chip">frozen</span>}
          {note !== '' && <span className={`chip chip-${band}`}>{note}</span>}
          {/*
            The product's own details, reachable from the packet in front of you
            (Jack, 2026-08-21). A figure is nearly always found to be wrong while
            looking at the thing it describes, which is here rather than back in
            the add flow.
          */}
          {product !== undefined && (
            <button
              type="button"
              className="link-button lot-edit"
              disabled={busy}
              onClick={() => onEditProduct(product)}
            >
              Edit
            </button>
          )}
        </div>
        <span className="lot-amount">
          {lot.depleted ? 'empty' : amount.remaining}
          <span className="lot-of"> of {amount.initial}</span>
        </span>
      </div>

      <div className="lot-meta">
        {lot.expiresOn === null ? 'No date' : `Use by ${formatDate(lot.expiresOn)}`}
        {` · bought ${formatDate(lot.acquiredOn)}`}
        {lot.note !== undefined && lot.note !== '' && ` · ${lot.note}`}
      </div>

      {/*
        Throwing it out is not the same as finishing it (Jack, 2026-08-20).
        Empty means the food went into a person and is worth keeping a record
        of; binned means the packet should not be in the list at all. It cannot
        be undone, so it asks first — inline rather than as a dialog, which on
        an iPad is both easier to hit and easier to back out of.
      */}
      {confirming ? (
        <div className="lot-actions lot-confirm">
          <span className="lot-confirm-text">Throw this packet out? It will not come back.</span>
          <button
            type="button"
            className="step step-bad"
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              onThrowOut(lot)
            }}
          >
            Yes, it is gone
          </button>
          <button type="button" className="step" disabled={busy} onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </div>
      ) : (
        <div className="lot-actions">
          {RECONCILE_STEPS.map((step) => (
          <button
            key={step.label}
            type="button"
            className="step"
            disabled={busy}
            onClick={() => onFraction(lot, step.fraction)}
          >
            {step.label}
          </button>
        ))}

          <input
            type="text"
            inputMode="decimal"
            className="lot-exact"
            placeholder="grams"
            value={typed}
            disabled={busy}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitTyped()
              }
            }}
            onBlur={submitTyped}
          />

          <button
            type="button"
            className="link-button lot-bin"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Throw out
          </button>
        </div>
      )}
    </li>
  )
}

export function ItemSheet({
  ingredient,
  lots,
  products,
  today,
  onClose,
}: {
  /*
   * The ingredient, not the inventory row. Emptying the last packet removes an
   * item from the inventory list, and if this sheet were keyed to that row it
   * would vanish at the exact moment the Undo button became worth having.
   */
  ingredient: CanonicalIngredient
  /** Every lot of this ingredient, in FEFO order, including emptied ones. */
  lots: readonly Lot[]
  products: ReadonlyMap<string, Product>
  today: DateOnly
  onClose: () => void
}) {
  const [undo, setUndo] = useState<UndoState | null>(null)
  const [editing, setEditing] = useState<Product | null>(null)
  const [showEmptied, setShowEmptied] = useState(false)
  const [busy, setBusy] = useState(false)

  const onHandCount = countOnHand(lots, ingredient, products)
  const live = lots.filter((lot) => !lot.depleted)
  const emptied = lots.filter((lot) => lot.depleted)
  const shown = showEmptied ? [...live, ...emptied] : live

  async function apply(lot: Lot, grams: number, description: string) {
    setBusy(true)
    try {
      // The whole previous record is kept, not just its amount: `depleted` and
      // `depletedAt` cannot be worked back out from a number alone.
      setUndo({ lot, description })
      await adjustLotRemaining(db, lot.id, grams, nowIso())
    } finally {
      setBusy(false)
    }
  }

  /**
   * Bin a packet. No Undo, deliberately — you have thrown the food away, and an
   * app offering to un-throw-away food would be pretending.
   *
   * Any pending Undo for THIS packet is dropped first. It restores a whole lot
   * record with `put`, so leaving it on screen would let one tap resurrect a row
   * that was just deleted.
   */
  async function throwOut(lot: Lot) {
    setBusy(true)
    try {
      if (undo?.lot.id === lot.id) setUndo(null)
      await deleteLot(db, lot.id)
    } finally {
      setBusy(false)
    }
  }

  async function undoLast() {
    if (!undo) return
    setBusy(true)
    try {
      await saveLot(db, undo.lot)
      setUndo(null)
    } finally {
      setBusy(false)
    }
  }

  /*
   * Editing takes over the sheet rather than opening a second one on top. The
   * product being corrected is the one whose packet you were just looking at,
   * and stacking a dialog over a dialog on an iPad leaves neither with room.
   */
  if (editing !== null) {
    return (
      <div className="sheet-backdrop">
        <section className="sheet" role="dialog" aria-label={`Edit ${editing.name}`}>
          <header className="sheet-head">
            <h2>{editing.name}</h2>
            <button type="button" onClick={() => setEditing(null)}>
              Close
            </button>
          </header>

          <EditProduct
            ingredient={ingredient}
            product={editing}
            onSaved={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        </section>
      </div>
    )
  }

  return (
    <div className="sheet-backdrop">
      <section className="sheet" role="dialog" aria-label={ingredient.name}>
        <header className="sheet-head">
          <h2>{ingredient.name}</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="sheet-body">
          <p className="sheet-context">
            {onHandCount === null
              ? formatGrams(totalRemaining(lots))
              : formatCount(onHandCount, ingredient)}{' '}
            on hand across {live.length === 1 ? '1 packet' : `${live.length} packets`}. Tap how
            full each one actually is.
          </p>

          {undo !== null && (
            <div className="undo">
              <span>{undo.description}</span>
              <button type="button" disabled={busy} onClick={() => void undoLast()}>
                Undo
              </button>
            </div>
          )}

          <ul className="lots">
            {shown.map((lot) => (
              <LotRow
                key={lot.id}
                lot={lot}
                ingredient={ingredient}
                product={products.get(lot.productId)}
                today={today}
                busy={busy}
                onFraction={(target, fraction) =>
                  void apply(
                    target,
                    gramsForFraction(target, fraction),
                    fraction === 0
                      ? `Marked a packet empty.`
                      : `Set a packet to ${formatGrams(gramsForFraction(target, fraction))}.`,
                  )
                }
                onExact={(target, grams) =>
                  void apply(target, grams, `Set a packet to ${formatGrams(grams)}.`)
                }
                onThrowOut={(target) => void throwOut(target)}
                onEditProduct={setEditing}
              />
            ))}
          </ul>

          {/*
            Emptied packets are kept, never deleted, so history survives — but a
            year of them would bury the two you can actually see in the fridge.
            Hidden by default, one tap away, because the reason to want one back
            is having just marked the wrong packet empty.
          */}
          {emptied.length > 0 && (
            <button
              type="button"
              className="link-button"
              onClick={() => setShowEmptied((current) => !current)}
            >
              {showEmptied
                ? 'Hide emptied packets'
                : `Show ${emptied.length} emptied ${emptied.length === 1 ? 'packet' : 'packets'}`}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
