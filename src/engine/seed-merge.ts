/**
 * Kitchen OS — Merging a redeployed ontology into existing data
 *
 * The bundled `ontology.json` is copied into IndexedDB on first run. After
 * that, IndexedDB is the source of truth — the app does not re-read the bundled
 * file on every launch. So when a new version of the app ships with extra
 * ingredients, something has to fold them in without disturbing what is already
 * there. That is what `AppMeta.seedVersion` was reserved for in Phase 0, and
 * this is the logic it was reserved for.
 *
 * The rules (Jack, 2026-08-19):
 *
 *   bundled entry, not present locally    -> ADD it
 *   bundled entry, local copy is a seed   -> UPDATE it (the User never edits
 *                                            seed entries, so nothing is lost)
 *   bundled entry, local copy is the
 *     User's own                          -> SKIP, leave theirs untouched
 *   local seed entry no longer bundled    -> RETAIN, never delete
 *   local user entry                      -> RETAIN, never touched
 *
 * Two of those deserve saying out loud:
 *
 * Nothing is ever DELETED. A `Product` points at a `canonicalId`, and a `Lot`
 * points at a `Product`. Removing an ingredient because it vanished from the
 * bundle would orphan real inventory the User still physically owns. Retaining
 * a stale entry costs a row.
 *
 * The User always wins a conflict. Their device holds the only copy of their
 * data, so an app update must never be able to silently change conversion
 * numbers that existing lots and cook events depend on.
 *
 * This module only computes the new ingredient list. Writing it to IndexedDB
 * and updating `AppMeta.seedVersion` is the caller's job (Phase 4).
 */
import type { AppMeta, CanonicalId, CanonicalIngredient } from '../types/schema'

export interface SeedMergeResult {
  /** The full ingredient list to store. Bundled order first, then local-only. */
  readonly ingredients: readonly CanonicalIngredient[]
  /** Bundled entries that did not exist locally. */
  readonly added: readonly CanonicalId[]
  /** Existing seed entries replaced with a newer bundled version. */
  readonly updated: readonly CanonicalId[]
  /** Bundled entries skipped because the User owns that id. */
  readonly skippedUserOwned: readonly CanonicalId[]
  /** Seed entries kept even though the bundle no longer contains them. */
  readonly retainedMissing: readonly CanonicalId[]
  /** Entries the User created. Always carried through untouched. */
  readonly retainedUserAdded: readonly CanonicalId[]
  /** True when the merge would change nothing. */
  readonly unchanged: boolean
}

/**
 * Whether the bundled seed data is newer than what has been merged in.
 *
 * Undefined `seedVersion` means nothing has ever been merged — a fresh install,
 * where the merge doubles as first-run seeding. Comparison is by inequality,
 * not ordering, so re-running an older build also re-merges rather than
 * silently doing nothing.
 */
export function needsSeedMerge(meta: Pick<AppMeta, 'seedVersion'>, bundledSeedVersion: string): boolean {
  return meta.seedVersion !== bundledSeedVersion
}

function sameIngredient(a: CanonicalIngredient, b: CanonicalIngredient): boolean {
  // Field-by-field rather than JSON.stringify, which is sensitive to key order.
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.category === b.category &&
    a.trackBy === b.trackBy &&
    a.tracked === b.tracked &&
    a.perishable === b.perishable &&
    a.isSeed === b.isSeed &&
    a.cupWeightG === b.cupWeightG &&
    a.unitWeightG === b.unitWeightG &&
    a.densityGPerMl === b.densityGPerMl &&
    a.defaultShelfLifeDays === b.defaultShelfLifeDays &&
    a.aliases.length === b.aliases.length &&
    a.aliases.every((alias, i) => alias === b.aliases[i]) &&
    (a.interchangeableWith?.length ?? 0) === (b.interchangeableWith?.length ?? 0) &&
    (a.interchangeableWith ?? []).every((id, i) => id === b.interchangeableWith?.[i])
  )
}

/**
 * Fold a newly bundled ontology into what is already stored.
 *
 * Pure: neither input array is modified, and the entries in the result are the
 * original objects wherever nothing changed.
 */
export function mergeSeedOntology(
  local: readonly CanonicalIngredient[],
  bundled: readonly CanonicalIngredient[],
): SeedMergeResult {
  const localById = new Map<CanonicalId, CanonicalIngredient>(
    local.map((entry) => [entry.id, entry]),
  )

  const ingredients: CanonicalIngredient[] = []
  const added: CanonicalId[] = []
  const updated: CanonicalId[] = []
  const skippedUserOwned: CanonicalId[] = []
  const consumed = new Set<CanonicalId>()

  for (const incoming of bundled) {
    const existing = localById.get(incoming.id)

    if (!existing) {
      // Force isSeed regardless of what the file says, so a hand-edited
      // ontology.json cannot inject an entry that the next merge then refuses
      // to update.
      ingredients.push(incoming.isSeed ? incoming : { ...incoming, isSeed: true })
      added.push(incoming.id)
      continue
    }

    consumed.add(incoming.id)

    if (!existing.isSeed) {
      skippedUserOwned.push(incoming.id)
      ingredients.push(existing)
      continue
    }

    if (sameIngredient(existing, incoming)) {
      ingredients.push(existing)
      continue
    }

    ingredients.push(incoming.isSeed ? incoming : { ...incoming, isSeed: true })
    updated.push(incoming.id)
  }

  // Anything local the bundle did not mention, in its original order.
  const retainedMissing: CanonicalId[] = []
  const retainedUserAdded: CanonicalId[] = []
  for (const entry of local) {
    if (consumed.has(entry.id)) continue
    ingredients.push(entry)
    if (entry.isSeed) retainedMissing.push(entry.id)
    else retainedUserAdded.push(entry.id)
  }

  return {
    ingredients,
    added,
    updated,
    skippedUserOwned,
    retainedMissing,
    retainedUserAdded,
    unchanged: added.length === 0 && updated.length === 0,
  }
}

/** One-line summary of a merge, for a log line or a post-update notice. */
export function describeSeedMerge(result: SeedMergeResult): string {
  if (result.unchanged && result.skippedUserOwned.length === 0) {
    return 'Ingredient list already up to date.'
  }
  const parts: string[] = []
  if (result.added.length > 0) parts.push(`${result.added.length} added`)
  if (result.updated.length > 0) parts.push(`${result.updated.length} updated`)
  if (result.skippedUserOwned.length > 0) {
    parts.push(`${result.skippedUserOwned.length} kept as yours`)
  }
  if (result.retainedUserAdded.length > 0) {
    parts.push(`${result.retainedUserAdded.length} of your own untouched`)
  }
  return `Ingredients: ${parts.join(', ')}.`
}
