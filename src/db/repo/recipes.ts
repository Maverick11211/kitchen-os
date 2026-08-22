/**
 * Kitchen OS — The User's own recipes
 *
 * This table holds ONLY recipes typed into the app. The 150 seed recipes are
 * read from the bundle and are never written here — `src/engine/recipe-source.ts`
 * explains why, and joins the two into the list the screens use.
 *
 * That makes the table small, and makes a backup file carry exactly the recipes
 * a redeploy could not reproduce.
 */
import type { Recipe, RecipeId } from '../../types/schema'
import type { KitchenOsDb } from '../db'

/**
 * Every recipe the User has entered.
 *
 * A thin wrapper on purpose: screens do not touch Dexie (DECISIONS.md,
 * 2026-08-19, item 2), and one reviewable list of everything that can read or
 * write the only copy of this data is worth the line it costs.
 */
export async function listUserRecipes(db: KitchenOsDb): Promise<Recipe[]> {
  return db.recipes.toArray()
}

/**
 * Save a recipe he typed. Used for both adding and editing (Jack, 2026-08-21).
 *
 * `put` rather than `add`, because editing keeps the recipe's id — its address,
 * and later its cook events, point at it — so a save is a replace as often as
 * it is an insert.
 *
 * Recipes are editable where canonical ingredients are not. The add-only rule
 * of 2026-08-19 exists to keep the seed MERGE safe, and there is no recipe
 * merge: seed recipes are read from the bundle and never written here.
 */
export async function saveUserRecipe(db: KitchenOsDb, recipe: Recipe): Promise<Recipe> {
  await db.recipes.put(recipe)
  return recipe
}

/**
 * Delete one of his recipes.
 *
 * Only ever reaches rows in this table, so a bundled recipe cannot be deleted
 * by this path — the worst a bad id can do is delete nothing. Phase 7 will need
 * to decide what a deleted recipe means for a `CookEvent` that points at it;
 * today nothing does.
 */
export async function deleteUserRecipe(db: KitchenOsDb, id: RecipeId): Promise<void> {
  await db.recipes.delete(id)
}
