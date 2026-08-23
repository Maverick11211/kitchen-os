/**
 * Kitchen OS — Data Schema (Phase 0, LOCKED)
 *
 * This file defines the shape of every piece of data in the app.
 * It contains NO logic — only type definitions.
 *
 * Core principles:
 *  1. All quantities normalize to GRAMS internally. Units are a display concern.
 *  2. Three tiers: CanonicalIngredient -> Product -> Lot.
 *  3. History is immutable. Macros are snapshotted at log time so past days
 *     never change when you correct a product's nutrition data.
 *
 * Changes to this file require updating DECISIONS.md.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO 8601 date, no time component. Example: "2026-09-14" */
export type DateOnly = string;

/** ISO 8601 timestamp with time. Example: "2026-09-14T18:30:00.000Z" */
export type Timestamp = string;

export type CanonicalId = string;
export type ProductId = string;
export type LotId = string;
export type RecipeId = string;
export type ApplianceId = string;
export type CookEventId = string;
export type ConsumptionEventId = string;
export type LeftoverId = string;

/**
 * Units a user can type or a recipe can specify.
 * Everything converts to grams before storage or comparison.
 */
export type Unit =
  // mass
  | 'g'
  | 'kg'
  | 'oz'
  | 'lb'
  // volume
  | 'ml'
  | 'l'
  | 'tsp'
  | 'tbsp'
  | 'cup'
  | 'floz'
  // count (uses unitWeightG)
  | 'count';

/** How an ingredient is naturally measured. Determines conversion path. */
export type TrackBy = 'mass' | 'volume' | 'count';

export type IngredientCategory =
  | 'produce'
  | 'protein'
  | 'dairy'
  | 'grain'
  | 'legume'
  | 'fat-oil'
  | 'condiment'
  | 'spice'
  | 'baking'
  | 'beverage'
  | 'other';

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

/**
 * Nutrition figures. Stored per 100g on products; computed as absolute
 * totals on events.
 *
 * The daily view surfaces calories/protein/carbsG/fatG. The rest are captured
 * because they appear on every label and cost nothing to store.
 */
export interface MacroSet {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  sugarG: number;
  sodiumMg: number;
  saturatedFatG: number;

  /**
   * Added 2026-08-20 (see DECISIONS.md). It appears on every US nutrition
   * label, between saturated fat and sodium, and leaving it out meant typing a
   * label involved skipping a line.
   *
   * Required, not optional, so it behaves like every other macro in the
   * arithmetic — an optional field would have to be defended against in every
   * sum. Existing rows are backfilled with 0 by the version 2 migration in
   * `src/db/db.ts`, and older backup files are upgraded on import.
   */
  cholesterolMg: number;
}

// ---------------------------------------------------------------------------
// TIER 1 — CanonicalIngredient
// The vocabulary recipes speak. "Gouda, shredded" — not a brand.
// ---------------------------------------------------------------------------

export interface CanonicalIngredient {
  id: CanonicalId;

  /** Display name. Example: "Cheddar, shredded" */
  name: string;

  category: IngredientCategory;

  /** Natural measurement mode. Drives which conversion fields are required. */
  trackBy: TrackBy;

  /**
   * Do we count quantity and macros for this ingredient?
   * false = assumed always on hand, excluded from ownership %, macros ignored.
   * Example: salt (false), flour (true).
   */
  tracked: boolean;

  /**
   * Does this get an expiration date and appear in expiry warnings?
   * Example: fresh basil (true), flour (false).
   */
  perishable: boolean;

  /**
   * Weight of one US cup, in grams. REQUIRED when a recipe may express this
   * ingredient in cup/tbsp/tsp. tbsp and tsp are derived from this value.
   *
   * Do NOT compute this from density for solids — a cup of shredded cheese
   * and a cup of cubed cheese weigh different amounts.
   */
  cupWeightG?: number;

  /**
   * Average weight of one unit, in grams. REQUIRED when trackBy === 'count'.
   * Example: garlic clove ~5g, large egg ~50g.
   */
  unitWeightG?: number;

  /**
   * Grams per millilitre. ONLY for true liquids (milk, oil, water, stock).
   * Never populate for solids.
   */
  densityGPerMl?: number;

  /** Alternate names used by recipe sources. Lowercase, for matching. */
  aliases: string[];

  /**
   * Canonicals that may substitute for this one when checking ownership.
   * Symmetric by convention but stored on both sides for lookup speed.
   * Example: "mozzarella-shredded" <-> "mozzarella-block".
   */
  interchangeableWith?: CanonicalId[];

  /**
   * Typical shelf life once acquired, in days. Used to pre-fill the expiration
   * field when adding a lot. Only meaningful when perishable === true.
   */
  defaultShelfLifeDays?: number;

  /**
   * Nutrition per 100 grams for this ingredient bought WITHOUT a label.
   *
   * Added 2026-08-23 (see DECISIONS.md), and it narrows the three-tier rule
   * that said only a Product carries macros. That rule was right about branded
   * groceries and wrong about the produce aisle: a loose sweet potato has no
   * packaging, so there is no label to read and no honest Product to build one
   * from, and the User was left searching the internet to log a vegetable.
   *
   * Three things keep this from undoing what the original rule protected:
   *
   *   1. It is a FALLBACK, never an override. A `Product` wins wherever one
   *      exists — the bag of baby carrots has a label, and the label beats any
   *      generic figure.
   *   2. It is OPTIONAL, and absent on 188 of the 310 entries. Absent means "no
   *      honest generic figure exists", which is the truth for anything whose
   *      whole point is that brands differ: sauces, cereals, yogurts.
   *   3. Anything derived from it is MARKED as an estimate wherever it appears,
   *      through `Product.macrosSource`. An estimate labelled as an estimate is
   *      honest; one that looks like a label reading is not.
   *
   * Figures are USDA SR28, AS PURCHASED and uncooked — raw for produce and
   * meat, dry for grains and pulses, because that is what gets weighed into the
   * kitchen. Every one is traceable to a USDA NDB number through
   * `tools/reference-macros/mapping.json`, which is where they are maintained.
   * Do not edit them here; run `node tools/reference-macros/apply.cjs`.
   */
  referenceMacrosPer100g?: MacroSet;

  /**
   * true for entries that came from the bundled ontology.json, false for ones
   * the User added in the app. Same meaning as Recipe.isSeed.
   *
   * Added 2026-08-19 (see DECISIONS.md) when in-app ingredient creation was
   * scoped in. The seed merge needs it: a redeployed ontology.json may safely
   * replace a seed entry, but must never overwrite one the User created.
   * Without this field the merge can only choose between clobbering the User's
   * data and never updating anything.
   */
  isSeed: boolean;
}

/**
 * Where a product's nutrition figures came from.
 *
 * `'label'` — read off the packaging. What the app was built around.
 * `'reference'` — the generic USDA figure for the ingredient, used because the
 *   thing arrived without packaging. Always shown marked as an estimate.
 */
export type MacroSource = 'label' | 'reference';

// ---------------------------------------------------------------------------
// TIER 2 — Product
// A specific purchasable item. Carries the nutrition data.
// Entered once, reused on every future purchase.
// ---------------------------------------------------------------------------

export interface Product {
  id: ProductId;
  canonicalId: CanonicalId;

  /** Display name. Example: "Kroger Shredded Sharp Cheddar" */
  name: string;

  brand?: string;

  /**
   * Nutrition per 100 grams. Labels give per-serving figures; the entry form
   * converts using servingSizeG before storing.
   */
  macrosPer100g: MacroSet;

  /**
   * Serving size from the label, in grams. Retained so the entry form can
   * show the user what they typed and recompute if corrected.
   */
  labelServingSizeG?: number;

  /** Net weight of a full package, in grams. Pre-fills lot quantity. */
  packageSizeG?: number;

  /**
   * How many individual items are in a full package. "6" for a pack of six
   * tortillas.
   *
   * Added 2026-08-21 (see DECISIONS.md). Only meaningful when the canonical
   * ingredient is tracked by count, and only useful alongside `packageSizeG` —
   * together they give what ONE of them actually weighs, which is the number
   * the app was previously guessing.
   *
   * The guess it replaces was `CanonicalIngredient.unitWeightG`, an average
   * across every brand of the thing. That is the right fallback when nothing
   * better is known, but the package in the kitchen knows better, and logging
   * "1 tortilla" against a generic average is a silent error on every count
   * ingredient in the app.
   */
  unitsPerPackage?: number;

  /**
   * Where `macrosPer100g` came from.
   *
   * Added 2026-08-23 (see DECISIONS.md) alongside
   * `CanonicalIngredient.referenceMacrosPer100g`. Without it there is no way to
   * tell a figure copied off a label from a generic one the app supplied, and
   * the app would be presenting an estimate with the same confidence as a
   * reading. Macros are snapshotted onto events from the product, so recording
   * it HERE means every past entry keeps its own answer even if the product is
   * corrected later.
   *
   * Optional because it is unknowable for every product created before it
   * existed. Absent means "not recorded" and is shown unmarked — the User typed
   * those in off a label, which is exactly what `'label'` means, but the app
   * should not put words in the mouth of data it did not capture.
   */
  macrosSource?: MacroSource;

  /** UPC barcode. Unused in v1; reserved for barcode scanning in v2. */
  upc?: string;

  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// TIER 3 — Lot
// One physical package you own. Carries expiration and remaining quantity.
// ---------------------------------------------------------------------------

export interface Lot {
  id: LotId;
  productId: ProductId;

  /** Grams present when this lot was added. Never changes. */
  initialG: number;

  /** Grams left. Decremented by cooking and direct logging. */
  remainingG: number;

  /** Null when the product does not meaningfully expire. */
  expiresOn: DateOnly | null;

  acquiredOn: DateOnly;

  /**
   * True for a lot kept in the freezer.
   *
   * Added 2026-08-19 (see DECISIONS.md). `defaultShelfLifeDays` on the
   * canonical is a fridge/fresh figure — raw chicken breast is 2 days — so
   * without this flag every frozen lot trips the expiry warning the moment it
   * is added. When set, the add-lot form skips the shelf-life prefill and the
   * lot is left out of expiry warnings unless an explicit `expiresOn` was
   * entered.
   *
   * Optional rather than required: absent means "not frozen", which is the
   * right reading for every lot written before this field existed.
   */
  frozen?: boolean;

  /**
   * True once remainingG reaches zero. Depleted lots are RETAINED, not
   * deleted, so consumption history stays intact and usage rates are
   * derivable later.
   */
  depleted: boolean;

  depletedAt?: Timestamp;

  /** Free-text. Example: "back of the freezer" */
  note?: string;
}

// ---------------------------------------------------------------------------
// Kit — appliances, cookware, tools
// ---------------------------------------------------------------------------

/**
 * One piece of kit: an appliance, a pot, a baking tray, a sieve.
 *
 * The type name is historical. This table was created in Phase 0 for appliances
 * and grew to cover cookware and tools on 2026-08-21; it was not renamed
 * because a rename is a data migration bought for a nicer word, and `Recipe`
 * already points at these ids through `requiredAppliances`.
 *
 * A row exists ONLY once the User has answered about that item. An absent row
 * means "never asked", which is not the same as `owned: false`, and the two are
 * treated differently: unknown says nothing, not-owned warns.
 */
export interface Appliance {
  id: ApplianceId;
  name: string;

  /**
   * Whether the user owns it. Recipes requiring an unowned appliance are
   * still shown, with a warning — never hidden.
   */
  owned: boolean;

  /**
   * The size of the biggest one they own. Absent means they have not said.
   *
   * The UNIT is fixed by the item and not stored here: pots and casseroles in
   * quarts, pans, tins and dishes in inches — the longest side, or the
   * diameter. `src/engine/equipment.ts` holds the catalogue that says which.
   *
   * "The biggest one" is the whole idea. One number per kind answers the only
   * question a recipe ever asks — will this fit — and someone who owns a 6 qt
   * pot does not also need to record the 2 qt one.
   */
  size?: number;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface RecipeIngredient {
  canonicalId: CanonicalId;

  /** Quantity as written in the recipe, in the stated unit. */
  quantity: number;

  unit: Unit;

  /**
   * Grams equivalent, precomputed at import time so ranking does not have to
   * convert on every render. Recomputed if the canonical's conversion data
   * changes.
   */
  quantityG: number;

  /**
   * Garnishes and "nice to have" items. Excluded from ownership percentage,
   * same as untracked staples. Still deducted if present when cooking.
   */
  optional: boolean;

  /** Display-only preparation note. Example: "finely diced" */
  preparation?: string;
}

export interface RecipeStep {
  order: number;
  text: string;
}

export interface Recipe {
  id: RecipeId;
  name: string;

  /** One or more cuisine tags. Example: ["Mexican", "Tex-Mex"] */
  cuisines: string[];

  ingredients: RecipeIngredient[];

  /** Appliances required. Missing ones produce a warning, not a filter. */
  requiredAppliances: ApplianceId[];

  /** Non-appliance tools worth listing. Example: "mixing bowl", "whisk" */
  tools: string[];

  steps: RecipeStep[];

  /**
   * Approximate total finished weight in grams, if known.
   *
   * NOTE: recipes have NO serving count by design. Consumption is logged as a
   * fraction of the batch. This field exists only to make leftovers usable as
   * an ingredient later (v2) and may be omitted.
   */
  estimatedYieldG?: number;

  /** true for the bundled seed set, false for user-entered recipes. */
  isSeed: boolean;

  createdAt: Timestamp;
  note?: string;
}

// ---------------------------------------------------------------------------
// Events — cooking and eating are SEPARATE
// ---------------------------------------------------------------------------

/** One lot debited by one event. */
export interface Deduction {
  lotId: LotId;
  canonicalId: CanonicalId;
  grams: number;
}

/**
 * Recorded when a recipe is cooked. Removes ingredients from inventory.
 * Does NOT by itself add anything to the day's macro totals — eating does.
 */
export interface CookEvent {
  id: CookEventId;
  recipeId: RecipeId;

  /**
   * What the recipe was called when it was cooked.
   *
   * Added 2026-08-22 (see DECISIONS.md). `recipeId` alone cannot be relied on to
   * produce a name: seed recipes live in the bundle rather than in `db.recipes`,
   * and a User recipe can be DELETED — which would leave a cooked batch in the
   * log sheet with nothing to call it. Snapshotting the name is the same rule
   * `ConsumptionEvent.label` already follows, for the same reason.
   *
   * `recipeId` is kept alongside it, because it is still the right way to get
   * back to the recipe when it does still exist.
   */
  label: string;

  /** 1.0 = as written, 1.5 = one and a half batches. */
  scaleFactor: number;

  cookedAt: Timestamp;

  /** Exactly what left inventory. Source of truth for reversal. */
  deductions: Deduction[];

  /**
   * Total macros of the entire batch produced, snapshotted at cook time from
   * the products actually consumed. Consumption logs a fraction of this.
   */
  batchMacros: MacroSet;

  /** Sum of fractions consumed so far, 0..1. Drives leftover tracking (v2). */
  fractionConsumed: number;
}

/**
 * What a consumption event was. Discriminated union.
 */
export type ConsumptionSource =
  | {
      type: 'cook';
      cookEventId: CookEventId;
      /** Portion of the batch eaten. 0.25 = a quarter of what was made. */
      fraction: number;
    }
  | {
      type: 'ingredient';
      canonicalId: CanonicalId;
      /** Which product was eaten, when known. Drives macro accuracy. */
      productId?: ProductId;
      /** Which lot to debit. Omit to skip inventory deduction. */
      lotId?: LotId;
      grams: number;
      /**
       * What actually came out of the packet, when anything did.
       *
       * Added 2026-08-22 (see DECISIONS.md), closing the inaccuracy recorded on
       * 2026-08-20. `grams` is what was EATEN; when the packet held less than
       * that, the amount REMOVED was smaller, and with no record of the
       * difference deleting the entry handed back more than it took.
       *
       * Optional because it is unknowable for every entry written before it
       * existed. Absent means "fall back to `grams`", which is exactly the old
       * behaviour and is correct whenever the packet covered the amount — which
       * it did in all but the narrow clamped case.
       */
      deductions?: Deduction[];
    }
  | {
      type: 'leftover';
      leftoverId: LeftoverId;
      fraction: number;
    };

/**
 * Which meal an entry belongs to.
 *
 * Added 2026-08-21 (see DECISIONS.md). A flat day answers "how much did I eat"
 * but not "where did it go", and the answer to the second question is what
 * changes what you do tomorrow.
 */
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/**
 * Anything eaten. This is what the daily totals sum over.
 *
 * Macros are SNAPSHOTTED here, not recomputed on read. Correcting a product's
 * nutrition later must not silently rewrite last month's totals.
 */
export interface ConsumptionEvent {
  id: ConsumptionEventId;
  consumedAt: Timestamp;
  source: ConsumptionSource;
  macros: MacroSet;

  /** Display label. Example: "Chicken Tikka Masala" or "Carrots" */
  label: string;

  /**
   * Which meal this was, when it was said.
   *
   * Optional on purpose (added 2026-08-21). Entries logged before meals existed
   * genuinely have no answer, and inventing one — filing every old entry as a
   * snack, or guessing from the clock retroactively — would put made-up
   * information in the one table the app promises never to rewrite. Absent
   * means unlabelled, and the daily view groups those together under their own
   * heading rather than hiding them.
   *
   * The app does NOT guess from the time of day when logging either (Jack,
   * 2026-08-21): a 3pm meal is as likely to be a late lunch as an early dinner,
   * and a wrong default that has to be corrected every time is worse than no
   * default at all.
   */
  meal?: MealSlot;
}

// ---------------------------------------------------------------------------
// Leftovers — v2 feature, schema present so it needs no migration
// ---------------------------------------------------------------------------

export interface Leftover {
  id: LeftoverId;
  cookEventId: CookEventId;
  name: string;

  /** Portion of the original batch still uneaten, 0..1. */
  remainingFraction: number;

  createdAt: Timestamp;
  expiresOn: DateOnly | null;

  /**
   * Approximate weight remaining, when the recipe declared estimatedYieldG.
   * Enables using a leftover as an ingredient in another recipe.
   */
  remainingG?: number;
}

// ---------------------------------------------------------------------------
// App metadata
// ---------------------------------------------------------------------------

export interface AppMeta {
  /** Schema version. Increment on any breaking change to this file. */
  schemaVersion: number;

  /** Last successful export. Drives the backup reminder. */
  lastExportAt?: Timestamp;

  seedVersion?: string;

  /**
   * When the User finished the one-off "what do you cook with" pass.
   *
   * Absent means it has never been finished, which is what makes the kit
   * questions appear on opening the app. It is a timestamp rather than a
   * boolean so that a future change to the kit catalogue can decide, on the
   * date, whether it is worth asking again.
   */
  kitSetUpAt?: Timestamp;
}

/** Shape of the JSON produced by Export and accepted by Import. */
export interface BackupFile {
  schemaVersion: number;
  exportedAt: Timestamp;
  canonicalIngredients: CanonicalIngredient[];
  products: Product[];
  lots: Lot[];
  recipes: Recipe[];
  appliances: Appliance[];
  cookEvents: CookEvent[];
  consumptionEvents: ConsumptionEvent[];
  leftovers: Leftover[];
  meta: AppMeta;
}

/**
 * Version of the stored data shape.
 *
 * 1 — Phases 0-4a. Never deployed; `Lot.frozen` was added under this number
 *     while no database existed anywhere, so nothing needed converting.
 * 2 — 2026-08-20. `MacroSet.cholesterolMg` added. The first version bump with
 *     real data behind it: see the `version(2)` upgrade in `src/db/db.ts` for
 *     stored rows, and `validateBackupFile` for files.
 * 3 — 2026-08-21. `ConsumptionEvent.meal` and `Product.unitsPerPackage` added,
 *     both optional. Two fields decided on the same day, shipped as ONE version
 *     with one migration — two bumps for two same-day decisions would be a
 *     self-inflicted wound. Nothing is backfilled: both fields are absent on
 *     older rows, which is the truth about them.
 * 4 — 2026-08-21. `Appliance.size` and `AppMeta.kitSetUpAt` added, both
 *     optional, when the appliance question grew into the kit list. Nothing is
 *     backfilled again, and this time the absences carry meaning the app reads:
 *     no `size` means he has not said how big his is, and no `kitSetUpAt` means
 *     he has never been asked. Inventing either would silence a warning he
 *     never chose to silence.
 * 5 — 2026-08-22. `CookEvent.label` and `ConsumptionSource`'s
 *     `deductions` on the ingredient arm, added at the start of Phase 7 — the
 *     phase that first writes a `CookEvent` at all.
 *
 *     `label` is REQUIRED, the first required field any bump has added since
 *     version 2. It can be, because no row needing a backfill can exist:
 *     nothing in versions 1-4 ever wrote a cook event. The migration backfills
 *     from `recipeId` anyway — a hand-edited file or a test fixture can hold
 *     one, and an id reads badly but is the only truth available.
 *
 *     `deductions` is optional and nothing is backfilled, because the
 *     difference it records was never measured on older rows.
 *
 *   6 — `CanonicalIngredient.referenceMacrosPer100g` and
 *     `Product.macrosSource` (2026-08-23). Both optional and both additive, so
 *     no stored row has to change: an old canonical simply has no reference,
 *     and an old product simply does not say where its figures came from. The
 *     new reference data reaches an existing database through the SEED MERGE
 *     rather than through the migration — `BUNDLED_SEED_VERSION` is what
 *     triggers it, and bumping that is not optional when the ontology changes.
 *
 * Any future change to this file needs the same two things — a migration for
 * the database and a step in the backup upgrade path.
 */
export const SCHEMA_VERSION = 6;
