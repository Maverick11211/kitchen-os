/**
 * Kitchen OS — The database
 *
 * IndexedDB via Dexie, on the device, no backend (CLAUDE.md). This file does
 * one thing: declare the tables and their indexes. All reading and writing goes
 * through `src/db/repo/`, so that every write to the User's only copy of their
 * data lives in one place that can be reviewed.
 *
 * Nothing here imports React, and nothing here does unit or macro arithmetic —
 * that is `src/engine/`'s job.
 *
 * ## Adding a table or an index later
 *
 * Dexie versions the STORE LAYOUT (which tables exist and which fields are
 * indexed), which is a different thing from `SCHEMA_VERSION` in
 * `src/types/schema.ts` (the shape of the objects). Adding an index means
 * adding a `db.version(2).stores({ ... })` block below and leaving version 1
 * where it is — Dexie replays them in order to upgrade an existing database.
 * Deleting the version(1) block would break every device that already has one.
 *
 * ## Why some obvious fields are not indexed
 *
 * IndexedDB cannot use a boolean as a key, so `isSeed`, `depleted` and `frozen`
 * are stored but not indexed. Filtering on those happens in memory, which is
 * free at this scale — the whole ontology is 310 rows.
 */
import Dexie, { type Table } from 'dexie'
import type {
  Appliance,
  AppMeta,
  CanonicalIngredient,
  ConsumptionEvent,
  CookEvent,
  Leftover,
  Lot,
  Product,
  Recipe,
} from '../types/schema'

/**
 * `AppMeta` is a single row, and it needs a key.
 *
 * The key is stored OUTSIDE the object (`meta: ''` below, and an explicit key
 * argument on get/put) rather than as a field on it. That keeps the stored row
 * exactly an `AppMeta` — no bookkeeping property to remember to strip before
 * handing it to anything else, and no way for it to leak into a backup file.
 */
export const META_KEY = 'app'

export interface KitchenOsTables {
  canonicalIngredients: Table<CanonicalIngredient, string>
  products: Table<Product, string>
  lots: Table<Lot, string>
  recipes: Table<Recipe, string>
  appliances: Table<Appliance, string>
  cookEvents: Table<CookEvent, string>
  consumptionEvents: Table<ConsumptionEvent, string>
  leftovers: Table<Leftover, string>
  meta: Table<AppMeta, string>
}

export type KitchenOsDb = Dexie & KitchenOsTables

export const DB_NAME = 'kitchen-os'

/**
 * Build a database handle.
 *
 * `name` is a parameter so tests can each open their own database and stay
 * independent of one another. Application code uses the default.
 */
export function createDb(name: string = DB_NAME): KitchenOsDb {
  const db = new Dexie(name) as KitchenOsDb

  db.version(1).stores({
    canonicalIngredients: 'id, name, category',
    products: 'id, canonicalId, name',
    // `expiresOn` is indexed for expiry queries. Lots with a null expiry are
    // absent from that index, which is correct — they never expire — but it
    // means "every lot" must be read from the table itself, not the index.
    lots: 'id, productId, expiresOn, acquiredOn',
    // `*cuisines` is a multi-entry index: one recipe with three cuisines is
    // findable under all three. Phase 6 filters on it.
    recipes: 'id, name, *cuisines',
    appliances: 'id',
    cookEvents: 'id, recipeId, cookedAt',
    consumptionEvents: 'id, consumedAt',
    leftovers: 'id, cookEventId',
    // Empty spec: the key lives outside the stored object. See META_KEY.
    meta: '',
  })

  return db
}

/** The application's database. Tests build their own with `createDb`. */
export const db: KitchenOsDb = createDb()

/**
 * Every table, in the order a backup file lists them. Used by export/import so
 * a newly added table cannot be quietly left out of a backup.
 */
export const ALL_TABLE_NAMES = [
  'canonicalIngredients',
  'products',
  'lots',
  'recipes',
  'appliances',
  'cookEvents',
  'consumptionEvents',
  'leftovers',
  'meta',
] as const satisfies readonly (keyof KitchenOsTables)[]
