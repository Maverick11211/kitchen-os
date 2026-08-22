/**
 * Kitchen OS — One recipe, in full
 *
 * What it needs, how much of it you have, and how to cook it. Reached from a
 * card; its own address (`#/recipes/chicken-fried-rice`) so a reload keeps you
 * where you were and the back gesture works.
 *
 * Phase 6 SHOWS. There is no "made it" button here on purpose — cooking,
 * scaling and deduction are Phase 7, and a button that half-worked would be
 * worse than no button.
 */
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { Appliance, ApplianceId, DateOnly, Recipe } from '../types/schema'
import type { InventoryIndex, OntologyIndex } from '../engine'
import { evaluateOwnership } from '../engine'
import { db } from '../db/db'
import { deleteUserRecipe } from '../db/repo/recipes'
import {
  batchLabel,
  buildRecipeLines,
  expiringLabel,
  kitWarnings,
  missingLabel,
  ownershipPercent,
  type RecipeLineStatus,
  type RecipeLineView,
} from './recipe-view'

/**
 * The quiet word at the end of a row.
 *
 * "Have" gets no marker at all. A list where the normal case is unmarked reads
 * as a list of problems, which is what you are scanning for.
 */
const STATUS_LABEL: Record<RecipeLineStatus, string> = {
  have: '',
  low: 'Not quite enough',
  missing: 'Missing',
  staple: 'Assumed in the cupboard',
  optional: 'Optional',
}

function IngredientRow({ line }: { line: RecipeLineView }) {
  return (
    <li className={`ing ing-${line.status}`}>
      <span className="ing-amount">{line.amount}</span>
      <span className="ing-main">
        <span className="ing-name">{line.name}</span>
        {line.preparation !== null && <span className="ing-prep">{line.preparation}</span>}
      </span>
      <span className="ing-state">
        {STATUS_LABEL[line.status] !== '' && (
          <span className={`ing-tag ing-tag-${line.status}`}>{STATUS_LABEL[line.status]}</span>
        )}
        {line.stockLabel !== null && <span className="ing-stock">{line.stockLabel}</span>}
      </span>
    </li>
  )
}

export interface RecipeDetailProps {
  readonly recipes: readonly Recipe[]
  readonly inventory: InventoryIndex
  readonly ontology: OntologyIndex
  readonly appliances: ReadonlyMap<ApplianceId, Appliance>
  readonly today: DateOnly
  readonly onEdit: (recipe: Recipe) => void
}

export function RecipeDetail({
  recipes,
  inventory,
  ontology,
  appliances,
  today,
  onEdit,
}: RecipeDetailProps) {
  const { recipeId } = useParams<{ recipeId: string }>()
  const navigate = useNavigate()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const recipe = recipes.find((candidate) => candidate.id === recipeId)

  const evaluated = useMemo(() => {
    if (recipe === undefined) return null
    const ownership = evaluateOwnership(recipe, inventory, ontology, { today })
    return { ownership, lines: buildRecipeLines(recipe, ownership, ontology) }
  }, [recipe, inventory, ontology, today])

  if (recipe === undefined || evaluated === null) {
    return (
      <section className="screen">
        <header className="screen-head">
          <h1>Recipe not found</h1>
        </header>
        <p className="empty">
          That recipe is not in the book. <Link to="/recipes">Back to the recipes</Link>
        </p>
      </section>
    )
  }

  const { ownership, lines } = evaluated
  const percent = ownershipPercent(ownership.ownershipFraction)
  const missing = missingLabel(ownership, ontology)
  const batch = batchLabel(ownership)
  const expiring = expiringLabel(ownership)
  // All of them here, where there is room. The card shows one and counts the
  // rest, because a card listing three equipment problems is not a card.
  const warnings = kitWarnings(recipe, appliances)

  return (
    <section className="screen">
      <p className="crumb">
        <Link to="/recipes">‹ Recipes</Link>
      </p>

      <header className="screen-head">
        <h1>{recipe.name}</h1>
        <p className="screen-count">{recipe.cuisines.join(' · ')}</p>
      </header>

      {/*
        Yours can be changed; the bundled 150 cannot. Not a rule about
        permission — a seed recipe lives in the app bundle rather than the
        database, so there is nothing here to edit (2026-08-21).
      */}
      {!recipe.isSeed && (
        <div className="own-recipe">
          <span className="own-recipe-label">Your recipe</span>
          <span className="actions">
            <button type="button" onClick={() => onEdit(recipe)}>
              Edit
            </button>
            <button type="button" onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
          </span>
        </div>
      )}

      {confirmingDelete && (
        <div className="panel panel-warn">
          <h2>Delete {recipe.name}?</h2>
          <p>It is only in this app, so this cannot be undone from here.</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                void deleteUserRecipe(db, recipe.id).then(() => navigate('/recipes'))
              }}
            >
              Yes, delete it
            </button>
            <button type="button" onClick={() => setConfirmingDelete(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}

      {/*
        The same figures as the card, in a sentence rather than a ring. The ring
        is for scanning a grid; here there is room to say what it means.
      */}
      <div className={ownership.ownershipFraction === 1 ? 'stand stand-ready' : 'stand'}>
        <p className="stand-headline">
          {ownership.ownershipFraction === 1
            ? 'You have everything for this.'
            : `You have ${ownership.ownedCount} of the ${ownership.countedCount} ingredients this needs (${percent}%).`}
        </p>
        <p className="stand-notes">
          {[missing, batch, expiring, ...warnings].filter((note) => note !== null).join(' · ')}
        </p>
      </div>

      <h2 className="section-head">Ingredients</h2>
      <ul className="ings">
        {lines.map((line, position) => (
          <IngredientRow key={`${line.canonicalId}-${position}`} line={line} />
        ))}
      </ul>

      {recipe.tools.length > 0 && (
        <p className="tools">
          <span className="tools-label">Tools</span> {recipe.tools.join(', ')}
        </p>
      )}

      <h2 className="section-head">Method</h2>
      <ol className="steps">
        {recipe.steps.map((step) => (
          <li key={step.order}>
            <span className="step-number">{step.order}</span>
            <span className="step-text">{step.text}</span>
          </li>
        ))}
      </ol>

      {recipe.note !== undefined && <p className="recipe-note">{recipe.note}</p>}
    </section>
  )
}
