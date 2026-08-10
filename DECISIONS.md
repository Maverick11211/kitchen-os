# Kitchen OS — Decision Log

Locked as of Phase 0. Everything here is settled unless explicitly revisited.
Add new entries at the bottom with a date. Do not silently change an entry —
supersede it.

**Priority order:** inventory management first, nutrition tracking second,
recipes third.

**Definition of done for v1:** a working ingredient database, a browsable
recipe library, and a macro tracker accurate enough to stop using a paid
calorie app.

---

## Platform

| Decision | Choice |
|---|---|
| App type | Client-side PWA, no backend |
| Stack | React + TypeScript + Vite |
| Storage | IndexedDB via Dexie, on-device only |
| Hosting | GitHub Pages, public repo |
| Target | iPad Safari, landscape-first |

**Why no backend:** removes hosting cost, removes an entire class of failure,
and keeps pantry data on the device. Trade-off is that the iPad holds the only
copy, which is why export is treated as a v1 requirement rather than a nicety.

---

## Data model

### Three tiers

`CanonicalIngredient` → `Product` → `Lot`

- **Canonical** is the vocabulary recipes speak. "Cheddar, shredded."
- **Product** is a specific purchasable item and carries the nutrition data.
  "Kroger Shredded Sharp Cheddar."
- **Lot** is one physical package, with its own expiration and remaining
  quantity.

Each tier answers a different question. Recipes match at canonical. Macros come
from product. Expiry and quantity live on lots. Collapsing any two breaks
something: one tier means recipes can't match, two means either losing
per-package expiration or re-entering macros on every shopping trip.

Practical payoff: the second bag of the same cheese takes about eight seconds
to add, because the product already exists.

### Grams are the only internal unit

Every quantity converts to grams before storage or comparison. Units are a
display and input concern only.

### Volume conversion uses cup weight, never density

For solids, `cupWeightG` is stored explicitly per canonical and tbsp/tsp are
derived from it. Density × volume is wrong for solids — a cup of shredded
cheese (~113g) and a cup of cubed cheese (~132g) differ, and density math gets
neither. `densityGPerMl` is populated for true liquids only.

### Two independent flags, not one "staple" flag

| Flag | Question it answers |
|---|---|
| `tracked` | Do we count quantity and macros? |
| `perishable` | Does it get an expiration date and expiry warnings? |

| Example | tracked | perishable |
|---|---|---|
| Salt, dried spices | ✗ | ✗ |
| Flour, oil, rice, canned goods | ✓ | ✗ |
| Fresh basil, lemon, cilantro | ✓ | ✓ |
| Chicken, milk, cheese | ✓ | ✓ |

A single flag conflated two different things. Flour never expires but is a
major calorie contributor you genuinely run out of — it must be tracked while
staying out of expiry warnings.

Ownership percentage ignores untracked ingredients. Expiry warnings only
consider perishables.

### Deduction is first-expiring-first-out

Across lots of the same product, the earliest expiration is consumed first.
Makes waste reduction structural rather than a feature you have to remember to
use.

### Depleted lots are retained

Empty lots are marked `depleted: true` and kept. Costs almost nothing and
preserves history you cannot recover once deleted.

### History is immutable

`ConsumptionEvent.macros` and `CookEvent.batchMacros` are snapshots taken at
the time of the event. Correcting a product's nutrition data later must never
silently rewrite past days' totals.

---

## Recipes

### No serving counts

Recipes describe a batch. Consumption is logged as a fraction of that batch —
"I ate about 40% of what I made."

Serving counts are arbitrary, inconsistent between sources, and the single
largest source of macro-tracking error. Fractions are something a person can
actually estimate. This also makes leftovers trivial later: a leftover is just
the unlogged fraction.

`estimatedYieldG` is optional and exists only so leftovers can be used as an
ingredient in v2.

### Ownership is binary, checked against the recipe as written

You either have enough of a tracked, non-optional ingredient or you don't.
Ownership is evaluated at 1× scale; scaling happens after selection.

Two refinements:

- **Low quantity flag** when holdings are within 10% of the requirement
  (≥90% but <100%). Shown as a warning, still counts as not-owned.
- **Max batch size** is displayed when the limiting ingredient allows less than
  a full batch. Example: *"You have everything, but only enough for a ½ batch."*
  Removes the surprise of a 100% recipe you can't actually make.

### Ranking

1. Primary sort: percentage of required ingredients owned
2. Tie-break: percentage of that recipe's ingredients expiring soon, descending
3. A **"Missing One"** tier surfaces above the main list, naming the specific
   missing ingredient

Filters: cuisine, expiring-soon. Alternate sort: alphabetical.

### Optional ingredients

Garnishes are excluded from ownership math, same treatment as untracked
staples. Still deducted from inventory if present when cooking.

### Appliances

A recipe requiring an appliance you don't own is **shown with a warning**,
never hidden.

### Seed set

100–150 recipes, bundled with the app, sourced from TheMealDB and normalized
against the ontology. No cuisine limit. In-app recipe addition in v1 is a typed
form.

---

## Nutrition

### Stored vs. displayed

Stored: calories, protein, carbs, fat, fiber, sugar, sodium, saturated fat.
Displayed on the daily view: calories, carbs, fat, protein.

The rest appear on every label and cost nothing to capture.

### Accuracy tolerance is ±15%

Accepted up front. Variance in produce size, absorption, and measurement makes
better than this unachievable at home. No precision machinery beyond this
point — it is wasted effort.

### Cooking and eating are separate events

`CookEvent` removes ingredients from inventory. `ConsumptionEvent` adds to the
day's totals. Cooking a batch and eating a quarter of it are two actions.

### Direct ingredient logging is in v1

Log grams of any ingredient without a recipe. Required — a tracker that only
counts cooked meals will not replace a calorie app, and retrofitting it later
is expensive.

Saved snack combinations need no separate concept: a two-ingredient recipe
already covers it.

### Daily view

Today's four headline macros, with the ability to browse previous days. No
goals, targets, or comparison statistics in v1.

---

## Deferred to v2

- Barcode scanning and nutrition-label OCR
- Leftovers as a usable entity (schema is already present, so no migration)
- Macro goals and targets
- Trend and comparison statistics
- Recipe import by URL or photo

---

## Known risks

**Data loss.** One copy, in browser storage, on one device. Mitigation: JSON
export to the Files app, plus a reminder banner after 7 days without an export.
Not optional.

**Entry friction.** The most common cause of abandonment. Design target is
under 20 seconds to add a repeat product. This is why the Product tier exists.

**Quantity drift.** Milk poured without logging, handfuls of nuts. Not
preventable. Mitigation: a Reconcile screen that snaps a lot to ½ / ¼ / empty
in one tap. Accept drift, make correction cheap.

**Ontology quality.** Ranking and deduction are only as good as the canonical
ingredient table. This is the highest-leverage artifact in the project and
worth over-investing in.

---

## Open items

Not blocking, revisit when relevant:

- Expiry warning threshold in days — currently unset, likely 3 and 7 day tiers
- Whether `interchangeableWith` should be auto-derived within a canonical
  family or maintained by hand
- Reconcile screen interaction detail
