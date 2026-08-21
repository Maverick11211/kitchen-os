/**
 * Kitchen OS — Getting data into the screens
 *
 * Two hooks. `useStartup` runs the seed merge once when the app opens;
 * `useKitchen` keeps the current inventory in sync with the database.
 *
 * Screens use these rather than touching Dexie themselves — the repository layer
 * stays the only thing that reads and writes.
 */
import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type {
  AppMeta,
  CanonicalIngredient,
  ConsumptionEvent,
  DateOnly,
  Lot,
  Product,
} from '../types/schema'
import { db } from '../db/db'
import { readMeta } from '../db/repo/meta'
import { firstConsumptionAt, listConsumptionBetween } from '../db/repo/consumption'
import { runStartupSeedMerge } from '../db/seed'
import { localDayOf, localDayRange } from '../lib/clock'

export type StartupState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly summary: string }
  | { readonly status: 'failed'; readonly message: string }

/**
 * Prepare the database, once, before anything else renders.
 *
 * Safe to run twice — React's development mode deliberately double-invokes
 * effects, and the merge is idempotent and transactional, so the second run is a
 * no-op rather than a duplicate.
 */
export function useStartup(): StartupState {
  const [state, setState] = useState<StartupState>({ status: 'loading' })

  useEffect(() => {
    let abandoned = false

    runStartupSeedMerge(db)
      .then((outcome) => {
        if (!abandoned) setState({ status: 'ready', summary: outcome.summary })
      })
      .catch((error: unknown) => {
        if (abandoned) return
        // Shown to the User. If this fails the app has no ingredient list at
        // all, so it must say so loudly rather than render an empty kitchen.
        const message = error instanceof Error ? error.message : 'Unknown problem.'
        setState({ status: 'failed', message })
      })

    return () => {
      abandoned = true
    }
  }, [])

  return state
}

export interface KitchenData {
  readonly ingredients: CanonicalIngredient[]
  readonly products: Product[]
  readonly lots: Lot[]
}

/**
 * The whole kitchen, re-read whenever any of it changes.
 *
 * Reading everything at once is fine at this size — a few hundred ingredients
 * and however many packets one person owns — and it means a screen never has to
 * think about which query to invalidate after a save.
 *
 * Returns undefined on the very first render, before the read finishes.
 */
export function useKitchen(): KitchenData | undefined {
  return useLiveQuery(async () => {
    const [ingredients, products, lots] = await Promise.all([
      db.canonicalIngredients.toArray(),
      db.products.toArray(),
      db.lots.toArray(),
    ])
    return { ingredients, products, lots }
  }, [])
}

/**
 * Everything eaten on one local day, oldest first.
 *
 * The day is a local-calendar question and `consumedAt` is a UTC instant, so
 * this converts through `localDayRange` rather than matching on the stored
 * string — an evening meal is filed under tomorrow's UTC date and a naive query
 * would lose it.
 *
 * Undefined on the first render, before the read finishes.
 */
export function useDay(day: DateOnly): ConsumptionEvent[] | undefined {
  return useLiveQuery(async () => {
    const { startAt, endAt } = localDayRange(day)
    return listConsumptionBetween(db, startAt, endAt)
  }, [day])
}

/**
 * The day of the oldest entry on record, which is as far back as paging goes.
 *
 * Undefined covers both "still loading" and "nothing has ever been logged". The
 * daily view treats them the same — the ‹ arrow is dead — and the difference
 * lasts one render.
 */
export function useFirstLoggedDay(): DateOnly | undefined {
  return useLiveQuery(async () => {
    const earliest = await firstConsumptionAt(db)
    return earliest === undefined ? undefined : localDayOf(earliest)
  }, [])
}

/** App metadata, kept live so the backup screen updates the moment you export. */
export function useMeta(): AppMeta | undefined {
  return useLiveQuery(() => readMeta(db), [])
}
