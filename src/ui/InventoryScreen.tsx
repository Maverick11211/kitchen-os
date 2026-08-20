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

function ItemRow({ item }: { item: InventoryItem }) {
  return (
    <li className={`item item-${item.band}`}>
      <div className="item-main">
        <span className="item-name">{item.ingredient.name}</span>
        <ExpiryTag item={item} />
      </div>
      <div className="item-meta">
        <span className="item-amount">{formatGrams(item.totalG)}</span>
        <span className="item-detail">
          {item.lotCount === 1 ? '1 packet' : `${item.lotCount} packets`}
          {item.soonestExpiry !== null && ` · ${formatDate(item.soonestExpiry)}`}
        </span>
      </div>
    </li>
  )
}

export interface InventoryScreenProps {
  readonly title: string
  readonly items: readonly InventoryItem[]
  readonly emptyNote?: string
}

export function InventoryScreen({ title, items, emptyNote }: InventoryScreenProps) {
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
            <ItemRow key={item.ingredient.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** The category route, which has to read its category out of the address. */
export function CategoryScreen({ items }: { items: readonly InventoryItem[] }) {
  const { category } = useParams<{ category: string }>()
  const known = category !== undefined && category in CATEGORY_LABELS

  if (!known) {
    return <InventoryScreen title="Unknown category" items={[]} emptyNote="No such category." />
  }

  const typed = category as IngredientCategory
  return (
    <InventoryScreen
      title={CATEGORY_LABELS[typed]}
      items={itemsInCategory(items, typed)}
      emptyNote={`No ${CATEGORY_LABELS[typed].toLowerCase()} in the kitchen right now.`}
    />
  )
}
