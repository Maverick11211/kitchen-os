/**
 * Kitchen OS — Products
 *
 * Tier 2 of the three-tier model: a specific purchasable item, carrying the
 * nutrition data. Entered once and reused on every future purchase — that reuse
 * is the whole reason this tier exists, and it is what makes the second bag of
 * the same cheese an eight-second job (DECISIONS.md).
 */
import type { CanonicalId, Product, ProductId, Timestamp } from '../../types/schema'
import type { KitchenOsDb } from '../db'
import { newId } from '../ids'

/** Everything the add-product form collects. The app supplies id and createdAt. */
export type NewProduct = Omit<Product, 'id' | 'createdAt'>

export async function listProducts(db: KitchenOsDb): Promise<Product[]> {
  return db.products.orderBy('name').toArray()
}

export async function getProduct(
  db: KitchenOsDb,
  id: ProductId,
): Promise<Product | undefined> {
  return db.products.get(id)
}

/** Every product recorded for one canonical ingredient. */
export async function productsForCanonical(
  db: KitchenOsDb,
  canonicalId: CanonicalId,
): Promise<Product[]> {
  return db.products.where('canonicalId').equals(canonicalId).toArray()
}

/**
 * Store a new product.
 *
 * `now` is passed in rather than read from the clock here, matching the engine's
 * convention, so a test or an import replay produces the same row every time.
 */
export async function addProduct(
  db: KitchenOsDb,
  input: NewProduct,
  now: Timestamp,
): Promise<Product> {
  const product: Product = { ...input, id: newId('prod'), createdAt: now }
  await db.products.add(product)
  return product
}

/**
 * Replace a product's details with corrected ones.
 *
 * Added 2026-08-21 (Jack: be able to fix a product from the ingredient sheet).
 * The whole row is rewritten from the form rather than patched field by field,
 * so clearing the brand or removing a pack count actually clears it — a form
 * that shows every field is a complete statement of what the product is.
 *
 * `id` and `createdAt` are carried over: this is the same product with better
 * information, not a new one, and every lot in the kitchen points at that id.
 *
 * **Past days do not move.** `ConsumptionEvent.macros` is a snapshot taken when
 * the entry was logged, and nothing here touches those rows — which is the
 * whole reason DECISIONS.md made history immutable, and why editing a product
 * is safe where editing a canonical ingredient still is not (the seed merge can
 * silently overwrite that one). Meals eaten from the old figures keep them;
 * anything logged from here on uses the corrected ones.
 */
export async function updateProduct(
  db: KitchenOsDb,
  id: ProductId,
  changes: NewProduct,
): Promise<Product> {
  const existing = await db.products.get(id)
  if (!existing) throw new Error(`updateProduct: unknown product "${id}".`)

  const updated: Product = { ...changes, id: existing.id, createdAt: existing.createdAt }
  await db.products.put(updated)
  return updated
}
