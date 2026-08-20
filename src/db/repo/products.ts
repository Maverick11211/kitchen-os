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
