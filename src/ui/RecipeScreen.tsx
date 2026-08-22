/**
 * Kitchen OS — The recipe library (right-hand pane)
 *
 * A card grid of every recipe, most-makeable first, with a "one thing away"
 * tier lifted out above it.
 *
 * Displays only. The ranking is `rankRecipes`, the wording is `recipe-view.ts`,
 * and nothing here computes a fraction of its own (CLAUDE.md). The one piece of
 * arithmetic below is turning an already-computed fraction into an SVG arc
 * length, which is drawing, not domain logic.
 *
 * Phase 6 SHOWS recipes. It never writes a `CookEvent` and never touches a lot
 * — cooking, scaling and deduction are Phase 7.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Appliance, ApplianceId, DateOnly, Recipe } from '../types/schema'
import type { InventoryIndex, OntologyIndex, RecipeSort } from '../engine'
import { rankRecipes } from '../engine'
import {
  buildRecipeCards,
  cuisineOptions,
  onlyMakeable,
  splitTiers,
  summariseLibrary,
  type RecipeCardView,
} from './recipe-view'

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

const RING_SIZE = 56
const RING_STROKE = 6
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * One mark, one meaning: this arc is ownership and nothing else (Jack,
 * 2026-08-21). Batch size and expiring stock are words on the card, not a
 * second variable tinted into the same circle.
 *
 * `aria-hidden` because the same figures are already in the text beside it —
 * the ring is a second reading of the card, not the only one.
 */
function OwnershipRing({ card }: { card: RecipeCardView }) {
  const filled = RING_CIRCUMFERENCE * Math.min(1, Math.max(0, card.fraction))

  return (
    <span className={card.ready ? 'ring ring-ready' : 'ring'}>
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
        <circle
          className="ring-track"
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          strokeWidth={RING_STROKE}
          fill="none"
        />
        <circle
          className="ring-arc"
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          strokeWidth={RING_STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${RING_CIRCUMFERENCE - filled}`}
          /* Start at twelve o'clock rather than three. */
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      </svg>
      <span className="ring-label">{card.percent}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function RecipeCard({ card, onOpen }: { card: RecipeCardView; onOpen: (id: string) => void }) {
  return (
    <li>
      {/* The whole card is the target. No hover state: there is no pointer. */}
      <button
        type="button"
        className={card.ready ? 'recipe-card recipe-card-ready' : 'recipe-card'}
        onClick={() => onOpen(card.recipeId)}
      >
        <OwnershipRing card={card} />

        <span className="recipe-main">
          <span className="recipe-name">{card.name}</span>
          <span className="recipe-sub">
            {card.cuisine}
            {' · '}
            {card.ownedCount} of {card.countedCount} ingredients
            {!card.isSeed && ' · yours'}
          </span>

          <span className="recipe-notes">
            {card.missingLabel !== null && <span className="note note-missing">{card.missingLabel}</span>}
            {card.batchLabel !== null && <span className="note">{card.batchLabel}</span>}
            {card.expiringLabel !== null && <span className="note note-soon">{card.expiringLabel}</span>}
            {card.kitWarning !== null && <span className="note note-warn">{card.kitWarning}</span>}
          </span>
        </span>
      </button>
    </li>
  )
}

function CardGrid({ cards, onOpen }: { cards: readonly RecipeCardView[]; onOpen: (id: string) => void }) {
  return (
    <ul className="recipe-grid">
      {cards.map((card) => (
        <RecipeCard key={card.recipeId} card={card} onOpen={onOpen} />
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export interface RecipeScreenProps {
  readonly recipes: readonly Recipe[]
  readonly inventory: InventoryIndex
  readonly ontology: OntologyIndex
  readonly appliances: ReadonlyMap<ApplianceId, Appliance>
  readonly today: DateOnly
  readonly onAdd: () => void
}

export function RecipeScreen({
  recipes,
  inventory,
  ontology,
  appliances,
  today,
  onAdd,
}: RecipeScreenProps) {
  const navigate = useNavigate()

  // Filters are component state, not part of the address. A filter is how you
  // are looking at the list right now; the list itself is the place you are.
  const [cuisine, setCuisine] = useState('')
  const [expiringOnly, setExpiringOnly] = useState(false)
  const [makeableOnly, setMakeableOnly] = useState(false)
  const [sort, setSort] = useState<RecipeSort>('ownership')

  const cuisines = useMemo(() => cuisineOptions(recipes), [recipes])

  const cards = useMemo(() => {
    const ranked = rankRecipes(recipes, inventory, ontology, {
      today,
      cuisine: cuisine === '' ? undefined : cuisine,
      expiringSoonOnly: expiringOnly,
      sort,
    })
    const built = buildRecipeCards(ranked, recipes, ontology, appliances)
    return makeableOnly ? onlyMakeable(built) : built
  }, [recipes, inventory, ontology, appliances, today, cuisine, expiringOnly, sort, makeableOnly])

  const summary = summariseLibrary(cards)
  // Alphabetical is a flat list on purpose. Lifting a tier out of an A-Z list
  // breaks the one thing an A-Z list promises.
  const tiers = sort === 'ownership' ? splitTiers(cards) : { missingOne: [], rest: cards }

  const open = (id: string) => navigate(`/recipes/${id}`)

  return (
    <section className="screen screen-wide">
      <header className="screen-head">
        <h1>Recipes</h1>
        <p className="screen-count">
          {summary.ready === 0
            ? 'Nothing you can make right now'
            : `${summary.ready} you can make now`}
          {` · ${summary.total} ${summary.total === 1 ? 'recipe' : 'recipes'}`}
        </p>
      </header>

      <div className="filters">
        <label className="filter">
          <span className="filter-label">Cuisine</span>
          <select value={cuisine} onChange={(event) => setCuisine(event.target.value)}>
            <option value="">All</option>
            {cuisines.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="filter">
          <span className="filter-label">Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as RecipeSort)}>
            <option value="ownership">What I can make</option>
            <option value="alphabetical">A–Z</option>
          </select>
        </label>

        <button
          type="button"
          className={expiringOnly ? 'filter-toggle is-on' : 'filter-toggle'}
          aria-pressed={expiringOnly}
          onClick={() => setExpiringOnly((on) => !on)}
        >
          Uses something going off
        </button>

        {/*
          Opt-in, which is not the same as hiding. DECISIONS.md forbids hiding a
          recipe you lack the kit for; this is the User asking for a shorter
          list (Jack, 2026-08-21).
        */}
        <button
          type="button"
          className={makeableOnly ? 'filter-toggle is-on' : 'filter-toggle'}
          aria-pressed={makeableOnly}
          onClick={() => setMakeableOnly((on) => !on)}
        >
          Only what I can make now
        </button>

        <button type="button" className="filter-add" onClick={onAdd}>
          + Add a recipe
        </button>
      </div>

      {cards.length === 0 ? (
        <p className="empty">
          {makeableOnly
            ? 'Nothing you can make with everything on hand right now.'
            : expiringOnly
              ? 'Nothing needs using up right now.'
              : 'No recipes match that filter.'}
        </p>
      ) : (
        <>
          {tiers.missingOne.length > 0 && (
            <section className="tier">
              <h2 className="tier-head">One thing away</h2>
              <CardGrid cards={tiers.missingOne} onOpen={open} />
            </section>
          )}

          {tiers.rest.length > 0 && (
            <section className="tier">
              {tiers.missingOne.length > 0 && <h2 className="tier-head">Everything else</h2>}
              <CardGrid cards={tiers.rest} onOpen={open} />
            </section>
          )}
        </>
      )}
    </section>
  )
}
