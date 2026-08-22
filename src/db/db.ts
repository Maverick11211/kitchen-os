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

  /**
   * Version 2 — `MacroSet.cholesterolMg` (2026-08-20).
   *
   * No table or index changes, so `stores({})` inherits version 1's layout
   * untouched. What this does is backfill the new field on rows already
   * written, because a `MacroSet` missing a field would break every sum it
   * takes part in.
   *
   * All three places a MacroSet is stored are patched. Products carry
   * `macrosPer100g`; cook and consumption events carry SNAPSHOTS, which
   * DECISIONS.md requires never be recomputed from products — so they have to
   * be edited in place rather than regenerated, or last month's totals would
   * silently change.
   *
   * Zero is the honest backfill. The figure was never asked for when those
   * rows were written, and any other value would be invented.
   */
  db.version(2)
    .stores({})
    .upgrade(async (tx) => {
      await tx.table<StoredRow>('products').toCollection().modify((row) => {
        backfillCholesterol(row, 'macrosPer100g')
      })
      await tx.table<StoredRow>('cookEvents').toCollection().modify((row) => {
        backfillCholesterol(row, 'batchMacros')
      })
      await tx.table<StoredRow>('consumptionEvents').toCollection().modify((row) => {
        backfillCholesterol(row, 'macros')
      })
      await tx.table<StoredRow>('meta').toCollection().modify((row) => {
        row.schemaVersion = 2
      })
    })

  /**
   * Version 3 — `ConsumptionEvent.meal` and `Product.unitsPerPackage`
   * (2026-08-21).
   *
   * Both new fields are OPTIONAL, so unlike version 2 there is nothing to
   * backfill: an entry logged before meals existed has no meal, and a product
   * entered before pack counts existed has no count. Absent is the honest
   * answer in both cases, and every reader already treats it that way.
   *
   * The block exists anyway, doing the one thing it must — stamping the new
   * version on the metadata row. DECISIONS.md requires a migration per schema
   * bump, and "this one needs no data changes" is a conclusion worth writing
   * down explicitly rather than an absence someone later has to re-derive.
   */
  db.version(3)
    .stores({})
    .upgrade(async (tx) => {
      await tx.table<StoredRow>('meta').toCollection().modify((row) => {
        row.schemaVersion = 3
      })
    })

  /**
   * Version 4 — `Appliance.size` and `AppMeta.kitSetUpAt` (2026-08-21).
   *
   * The appliance question grew into the kit list: cookware and tools as well
   * as appliances, and a size on the kinds where size decides whether a recipe
   * will fit.
   *
   * Optional again, and nothing is backfilled — but here the absences are read
   * by the app rather than merely tolerated. A row with no `size` means he has
   * not said how big his pot is, so no size warning can fire; `kitSetUpAt`
   * absent means he has never been asked, which is what puts the questions on
   * screen. Stamping either would silence something he never chose to silence.
   *
   * The four appliance rows a version 3 database may already hold stay exactly
   * as they are: still valid, still owned or not, simply without a size.
   */
  db.version(4)
    .stores({})
    .upgrade(async (tx) => {
      await tx.table<StoredRow>('meta').toCollection().modify((row) => {
        row.schemaVersion = 4
      })
    })

  return db
}

/**
 * A stored row seen loosely, for migrations.
 *
 * A migration edits data written by an OLDER version of the app, so typing it
 * as today's `Product` or `CookEvent` would be a lie — the whole reason it is
 * being touched is that it does not match today's shape yet.
 */
type StoredRow = Record<string, unknown>

/** Give a stored MacroSet the cholesterol field it predates. */
function backfillCholesterol(row: StoredRow, field: string): void {
  const macros = row[field]
  if (macros === null || typeof macros !== 'object') return
  const set = macros as Record<string, unknown>
  if (typeof set.cholesterolMg !== 'number') set.cholesterolMg = 0
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
