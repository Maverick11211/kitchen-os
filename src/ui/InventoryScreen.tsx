/**
 * Kitchen OS — The inventory list (right-hand pane)
 *
 * Displays only. Every number on screen was worked out by `src/engine/` or by
 * `inventory-view.ts` — this file does no arithmetic of its own (CLAUDE.md).
 */
import { useParams } from 'react-router'
import type { IngredientCategory } from '../types/schema'
import { formatDate } from '../lib/clock'
import {
  CATEGORY_LABELS,
  formatAmount,
  formatGrams,
  itemsInCategory,
  type ExpiryBand,
  type InventoryItem,
} from './inventory-view'

const BAND_LABEL: Record<ExpiryBand, string> = {
  expired: 'Past date',
  urgent: 'Use now',
  soon: 'Use soon',
  fine: '',
  none: '',
}

function ExpiryTag({ item }: { item: InventoryItem }) {
  const label = BAND_LABEL[item.band]
  if (label === '') return null
  return <span className={`tag tag-${item.band}`}>{label}</span>
}

function ItemRow({ item, onSelect }: { item: InventoryItem; onSelect: (item: InventoryItem) => void }) {
  return (
    <li>
      {/*
        The whole row is the target, not a separate edit affordance. Correcting
        a quantity is the most frequent thing anyone does to a stocked
        ingredient, and DECISIONS.md's answer to drift is that correction has to
        be cheap — starting with finding the button.
      */}
      <button type="button" className={`item item-${item.band}`} onClick={() => onSelect(item)}>
        <span className="item-main">
          <span className="item-name">{item.ingredient.name}</span>
          <ExpiryTag item={item} />
        </span>
        <span className="item-meta">
          {/*
            Counted things read as counts (Jack, 2026-08-21). The weight is not
            thrown away — it moves to the quiet line underneath, where it is
            available without being the thing you have to interpret first.
          */}
          <span className="item-amount">{formatAmount(item)}</span>
          <span className="item-detail">
            {item.totalCount !== null && `${formatGrams(item.totalG)} · `}
            {item.lotCount === 1 ? '1 packet' : `${item.lotCount} packets`}
            {item.soonestExpiry !== null && ` · ${formatDate(item.soonestExpiry)}`}
          </span>
        </span>
      </button>
    </li>
  )
}

export interface InventoryScreenProps {
  readonly title: string
  readonly items: readonly InventoryItem[]
  readonly emptyNote?: string
  readonly onSelect: (item: InventoryItem) => void
}

export function InventoryScreen({ title, items, emptyNote, onSelect }: InventoryScreenProps) {
  return (
    <section className="screen">
      <header className="screen-head">
        <h1>{title}</h1>
        <p className="screen-count">
          {items.length === 1 ? '1 ingredient' : `${items.length} ingredients`}
        </p>
      </header>

      {items.length === 0 ? (
        <p className="empty">{emptyNote ?? 'Nothing here yet.'}</p>
      ) : (
        <ul className="items">
          {items.map((item) => (
            <ItemRow key={item.ingredient.id} item={item} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** The category route, which has to read its category out of the address. */
export function CategoryScreen({
  items,
  onSelect,
}: {
  items: readonly InventoryItem[]
  onSelect: (item: InventoryItem) => void
}) {
  const { category } = useParams<{ category: string }>()
  const known = category !== undefined && category in CATEGORY_LABELS

  if (!known) {
    return (
      <InventoryScreen
        title="Unknown category"
        items={[]}
        emptyNote="No such category."
        onSelect={onSelect}
      />
    )
  }

  const typed = category as IngredientCategory
  return (
    <InventoryScreen
      title={CATEGORY_LABELS[typed]}
      items={itemsInCategory(items, typed)}
      emptyNote={`No ${CATEGORY_LABELS[typed].toLowerCase()} in the kitchen right now.`}
      onSelect={onSelect}
    />
  )
}
