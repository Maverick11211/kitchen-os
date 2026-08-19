/**
 * Kitchen OS — Ontology lookup
 *
 * The canonical ingredient table is a flat array on disk (`ontology.json`) but
 * every other engine module wants it keyed by id. This is that key, and the
 * shared type for "something you can look an ingredient up in".
 */
import type { CanonicalId, CanonicalIngredient } from '../types/schema'

/** Canonical ingredients keyed by id. Read-only: the ontology is seed data. */
export type OntologyIndex = ReadonlyMap<CanonicalId, CanonicalIngredient>

export function buildOntologyIndex(ingredients: readonly CanonicalIngredient[]): OntologyIndex {
  return new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]))
}

/**
 * Look up an ingredient, or undefined if the id is unknown.
 *
 * An unknown id is a real possibility once the user can add their own recipes
 * (Phase 6) or once a seed update removes an entry, so callers are expected to
 * handle undefined rather than assume the ontology is complete.
 */
export function findIngredient(
  index: OntologyIndex,
  canonicalId: CanonicalId,
): CanonicalIngredient | undefined {
  return index.get(canonicalId)
}

/**
 * Whether this ingredient counts toward ownership percentage and macro totals.
 *
 * `tracked: false` means "assumed always on hand" — salt, pepper, water. An
 * ingredient the ontology doesn't know is treated as tracked, so an unknown id
 * shows up as missing rather than silently vanishing from a recipe.
 */
export function isTracked(index: OntologyIndex, canonicalId: CanonicalId): boolean {
  return index.get(canonicalId)?.tracked ?? true
}
