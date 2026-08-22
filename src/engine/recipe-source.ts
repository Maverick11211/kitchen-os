/**
 * Kitchen OS — Where recipes come from
 *
 * The 150 seed recipes are NOT copied into IndexedDB. They are read straight
 * from the bundled `recipes.json`, and `db.recipes` holds only the recipes the
 * User typed in. This module joins the two into the single list the recipe
 * screen ranks.
 *
 * Decided with Jack on 2026-08-21, closing the question Phase 4 deliberately
 * left open (DECISIONS.md, 2026-08-19, item 5: "copying 150 recipes in now
 * would require writing a recipe merge before Phase 6 has decided what it
 * needs"). Phase 6 decided it does not need one:
 *
 *  - **There is a failure mode to avoid, not guard.** A restore replaces `meta`
 *    wholesale, `seedVersion` included (`src/db/repo/backup.ts`, on purpose).
 *    Had the seed recipes been merged into the table and then left out of
 *    backup files to keep them small, a restore would clear the recipes table
 *    AND write back a seed version the running app already matches — so the
 *    startup merge would conclude it was up to date and the 150 recipes would
 *    silently never come back. Reading them from the bundle removes that
 *    entirely rather than defending against it.
 *  - **Nothing to stamp.** No recipe merge, no second seed version, no schema
 *    version 4. `BUNDLED_SEED_VERSION` goes on meaning the ontology alone.
 *  - **Backups stay honest and small.** They carry the User's own recipes,
 *    which are the only ones a redeploy cannot reproduce.
 *
 * The cost, written down so it is not a surprise later: a seed recipe is a
 * frozen object in the bundle and a User recipe is a row, so EDITING a seed
 * recipe is not possible in place. The escape hatch already exists in the join
 * below — save the edit as a User recipe carrying the seed's id and it shadows
 * the seed, which is copy-on-write in one line. v1 has no seed-recipe editing,
 * so that day may never come.
 *
 * Pure, like everything else in `src/engine/`: both bundles are arguments.
 */
import type { Recipe, RecipeId } from '../types/schema'

/**
 * Force the flag rather than trust it.
 *
 * `isSeed` decides how a recipe is described on screen and, later, whether it
 * can be deleted. Rows in `db.recipes` are the User's by construction, but a
 * restored backup is a file that could say anything, so the invariant is made
 * true here instead of assumed. Same reasoning as `mergeSeedOntology` forcing
 * `isSeed: true` on bundled entries.
 */
function asUserRecipe(recipe: Recipe): Recipe {
  return recipe.isSeed ? { ...recipe, isSeed: false } : recipe
}

function asSeedRecipe(recipe: Recipe): Recipe {
  return recipe.isSeed ? recipe : { ...recipe, isSeed: true }
}

/**
 * Every recipe the app knows about, seed set first.
 *
 * A User recipe sharing a seed recipe's id SHADOWS it — it takes the seed's
 * place in the list rather than appearing alongside it, so the same id can
 * never render twice. This mirrors `mergeSeedOntology`'s rule that the User
 * always wins a conflict: their device holds the only copy of their data, and
 * an app update must never be able to overrule something they typed.
 *
 * Order is bundled order, then User-only recipes in the order the table
 * returned them. It only has to be deterministic — `rankRecipes` sorts.
 *
 * Pure: neither input is modified, and an entry is returned as the original
 * object wherever nothing needed changing.
 */
export function combineRecipes(
  bundled: readonly Recipe[],
  user: readonly Recipe[],
): Recipe[] {
  // Insertion order is preserved and a repeated id keeps its first position
  // while taking the last value, so a table holding two rows with one id
  // yields one recipe rather than a duplicate further down the list.
  const userById = new Map<RecipeId, Recipe>()
  for (const recipe of user) {
    userById.set(recipe.id, asUserRecipe(recipe))
  }

  const combined: Recipe[] = []
  const bundledIds = new Set<RecipeId>()

  for (const seed of bundled) {
    bundledIds.add(seed.id)
    const shadow = userById.get(seed.id)
    combined.push(shadow ?? asSeedRecipe(seed))
  }

  for (const [id, recipe] of userById) {
    if (!bundledIds.has(id)) combined.push(recipe)
  }

  return combined
}
