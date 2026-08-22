/**
 * Kitchen OS — Cook events
 *
 * Everything cooked. Until Phase 7 nothing in the app had ever written one of
 * these, and three other places refused to deal with the consequences; this file
 * is the half that creates them, and `consumption.ts` is the half that eats
 * them.
 *
 * Three rules from DECISIONS.md shape it:
 *
 * **Cooking and eating are separate.** A `CookEvent` takes ingredients OUT of
 * inventory and adds nothing to the day's totals. Eating a portion of it is a
 * `ConsumptionEvent` and touches no inventory, because the food left the packets
 * when it went in the pan. Collapsing the two would be changing a locked
 * decision, not simplifying a screen.
 *
 * **History is immutable.** `batchMacros` is snapshotted here, from the products
 * actually debited, and nothing recomputes it afterwards.
 *
 * **Deduction takes what is available and reports a shortfall.** Cooking is
 * never refused for want of an ingredient (Jack, 2026-08-22): the preview says
 * the gap out loud, and what is recorded is what actually left the kitchen.
 */
import type {
  CookEvent,
  CookEventId,
  Deduction,
  Lot,
  Recipe,
  Timestamp,
} from '../../types/schema'
import type { OntologyIndex, RecipeDeductionPlan } from '../../engine'
import {
  applyDeductions,
  batchMacrosForDeductions,
  buildInventoryIndex,
  isBatchOpen,
  planRecipeDeduction,
  revertDeductions,
} from '../../engine'
import type { KitchenOsDb } from '../db'
import { newId } from '../ids'

export interface CommitCookInput {
  readonly recipe: Recipe
  /** Needed to tell a tracked ingredient from a staple. Built by the caller. */
  readonly ontology: OntologyIndex
  /** 1 = as written, 0.5 = half a batch. */
  readonly scaleFactor: number
}

export interface CommittedCook {
  readonly cook: CookEvent
  /**
   * What the commit actually found in the kitchen, which is not necessarily
   * what the preview showed. Carries the shortfalls, so the confirmation can
   * say "there was less oil than the preview thought" rather than quietly
   * recording something the User did not see.
   */
  readonly plan: RecipeDeductionPlan
}

/**
 * Record that a recipe was cooked, and debit the packets it came out of.
 *
 * The plan is built INSIDE the transaction rather than passed in from the
 * screen. The preview the User approved was computed from a snapshot, and
 * between looking and tapping they may have logged lunch out of the same packet
 * — so committing the old plan would write a `CookEvent.deductions` that does
 * not match what happened. The schema calls that field "the source of truth for
 * reversal", and it can only be that if it is measured at the moment of the
 * write. `CommittedCook.plan` comes back so the screen can report any
 * difference; the same re-read-inside-the-transaction reasoning as
 * `logIngredient`.
 *
 * Only lots that actually changed are written back. `applyDeductions` returns
 * the original object for a lot it did not touch, so identity is an exact test
 * for "did this one move" — no comparing floats, and no rewriting the whole
 * inventory to debit two packets.
 */
export async function commitCook(
  db: KitchenOsDb,
  input: CommitCookInput,
  now: Timestamp,
): Promise<CommittedCook> {
  const { recipe, ontology, scaleFactor } = input

  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new RangeError(
      `commitCook: scaleFactor must be a positive number, got ${scaleFactor}.`,
    )
  }

  return db.transaction('rw', db.cookEvents, db.lots, db.products, async () => {
    const [products, lots] = await Promise.all([db.products.toArray(), db.lots.toArray()])
    const index = buildInventoryIndex(products, lots)

    const plan = planRecipeDeduction(index, ontology, recipe, scaleFactor)
    const deductions = [...plan.deductions]
    const batchMacros = batchMacrosForDeductions(index, deductions)

    const next = applyDeductions(lots, deductions, now)
    const changed = next.filter((lot, position) => lot !== lots[position])
    if (changed.length > 0) await db.lots.bulkPut(changed)

    const cook: CookEvent = {
      id: newId('cook'),
      recipeId: recipe.id,
      // Snapshotted, not looked up later. A seed recipe is not in any table and
      // a User recipe can be deleted; either way the batch keeps its name.
      label: recipe.name,
      scaleFactor,
      cookedAt: now,
      deductions,
      batchMacros,
      fractionConsumed: 0,
    }
    await db.cookEvents.add(cook)

    return { cook, plan }
  })
}

export interface DeletedCook {
  readonly cook: CookEvent
  /** Grams put back into packets. Zero when every packet has since been binned. */
  readonly restoredG: number
}

/**
 * Undo a cook: put the ingredients back and remove the record.
 *
 * **Refuses once anything has been eaten from the batch** (Jack, 2026-08-22).
 * Reverting the deductions would hand back raw ingredients that are already
 * counted, as a cooked meal, on some day's totals — so the ingredients and the
 * calories would both exist, and no arithmetic afterwards could tell that they
 * are the same food. The message names the entries in the way, because the fix
 * is to remove those first and the User cannot be expected to guess that.
 *
 * This is the same shape as `deleteConsumption`: an id that is already gone
 * returns `undefined` rather than throwing, because the only way to ask twice is
 * a stale screen and both taps mean the same thing.
 *
 * A lot that has since been deleted — thrown out, which DECISIONS.md says is not
 * undoable — simply gets nothing back. There is nowhere to put it.
 */
export async function deleteCookEvent(
  db: KitchenOsDb,
  id: CookEventId,
): Promise<DeletedCook | undefined> {
  return db.transaction('rw', db.cookEvents, db.lots, db.consumptionEvents, async () => {
    const cook = await db.cookEvents.get(id)
    if (!cook) return undefined

    const portions = await db.consumptionEvents
      .filter((event) => event.source.type === 'cook' && event.source.cookEventId === id)
      .toArray()

    if (portions.length > 0) {
      const names = portions.map((portion) => portion.label).join(', ')
      const one = portions.length === 1
      throw new Error(
        `deleteCookEvent: "${cook.label}" has already been eaten from ` +
          `(${portions.length} ${one ? 'entry' : 'entries'}: ${names}). Remove ` +
          `${one ? 'that entry' : 'those entries'} from the food log first, ` +
          'then this batch can be undone.',
      )
    }

    const restoredG = await restoreLots(db, cook.deductions)
    await db.cookEvents.delete(id)

    return { cook, restoredG }
  })
}

/** Put a set of deductions back on the lots they came from. Returns the total. */
async function restoreLots(db: KitchenOsDb, deductions: readonly Deduction[]): Promise<number> {
  const ids = [...new Set(deductions.map((deduction) => deduction.lotId))]
  const found = (await db.lots.bulkGet(ids)).filter((lot): lot is Lot => lot !== undefined)
  if (found.length === 0) return 0

  const next = revertDeductions(found, deductions)
  const changed = next.filter((lot, position) => lot !== found[position])
  if (changed.length > 0) await db.lots.bulkPut(changed)

  return changed.reduce((total, lot) => {
    const before = found.find((candidate) => candidate.id === lot.id)
    return total + (before === undefined ? 0 : lot.remainingG - before.remainingG)
  }, 0)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every cook on record, most recent first. */
export async function listCookEvents(db: KitchenOsDb): Promise<CookEvent[]> {
  return db.cookEvents.orderBy('cookedAt').reverse().toArray()
}

/**
 * Batches with something still to eat, most recent first.
 *
 * This is what makes Sunday's stew findable on Tuesday (Jack, 2026-08-22) — the
 * question the whole phase was shaped around. A finished batch drops off the
 * list but is never deleted: it is the evidence for the days it fed.
 */
export async function listOpenCooks(db: KitchenOsDb): Promise<CookEvent[]> {
  const all = await listCookEvents(db)
  return all.filter(isBatchOpen)
}

export async function getCookEvent(
  db: KitchenOsDb,
  id: CookEventId,
): Promise<CookEvent | undefined> {
  return db.cookEvents.get(id)
}
