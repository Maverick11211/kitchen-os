/**
 * Kitchen OS — Canonical ingredients
 *
 * v1 is ADD-ONLY (DECISIONS.md, 2026-08-19). There is deliberately no update or
 * delete function here: the seed merge is only safe to write because a bundled
 * entry can never carry the User's edits. Adding an edit path means re-reading
 * that decision first — it is not a small change.
 *
 * The rules about what makes a valid ingredient live in
 * `src/engine/ingredients.ts`. This file only reads and writes.
 */
import type { CanonicalId, CanonicalIngredient } from '../../types/schema'
import type { CanonicalIngredientDraft, CreateIngredientResult } from '../../engine'
import { createUserIngredient } from '../../engine'
import type { KitchenOsDb } from '../db'

export async function listIngredients(db: KitchenOsDb): Promise<CanonicalIngredient[]> {
  return db.canonicalIngredients.orderBy('name').toArray()
}

export async function getIngredient(
  db: KitchenOsDb,
  id: CanonicalId,
): Promise<CanonicalIngredient | undefined> {
  return db.canonicalIngredients.get(id)
}

/**
 * Create an ingredient the User typed in, backing the inline "can't find it?
 * add it" form.
 *
 * The read, the validation and the write are one transaction. Uniqueness of the
 * name, the aliases and the generated id is all checked against the list read at
 * the start, so doing this outside a transaction would let two entries with the
 * same name slip through — and the id is a foreign key for every Product, so a
 * collision quietly repoints real inventory.
 *
 * Returns the engine's result untouched: on failure the caller gets `errors`
 * and `warnings` already tagged with the form field to highlight, and on success
 * it gets `warnings` that must be shown WITHOUT blocking the save.
 */
export async function addUserIngredient(
  db: KitchenOsDb,
  draft: CanonicalIngredientDraft,
): Promise<CreateIngredientResult> {
  return db.transaction('rw', db.canonicalIngredients, async () => {
    const existing = await db.canonicalIngredients.toArray()
    const result = createUserIngredient(draft, existing)
    if (!result.ok) return result
    await db.canonicalIngredients.add(result.ingredient)
    return result
  })
}
