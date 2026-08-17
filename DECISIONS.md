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
| Salt, pepper | ✗ | ✗ |
| Flour, oil, rice, canned goods, most dried spices | ✓ | ✗ |
| Fresh basil, lemon, cilantro | ✓ | ✓ |
| Chicken, milk, cheese | ✓ | ✓ |

**Superseded 2026-08-14:** this row originally read "Salt, dried spices."
See the dated entry near the bottom of this file — most dried spices are
now tracked, only salt and pepper remain assumed-on-hand.

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
  family or maintained by hand. Related: produce format variants (e.g.
  whole carrots vs. baby carrots, whole onion vs. diced/frozen) would need
  a second canonical entry each, linked via `interchangeableWith`, since
  `trackBy` can't represent two measurement modes on one entry. Deferred —
  ontology currently has one whole/count-or-bagged/mass entry per produce
  item. Revisit once `interchangeableWith` is actually wired up.
- Reconcile screen interaction detail
- `defaultShelfLifeDays` has no frozen/fresh distinction. Ontology entries
  (Phase 1) use fridge/fresh shelf life as the default — e.g. raw chicken
  breast is 2 days. Anything frozen will trip expiry warnings sooner than
  actually necessary. Revisit if this becomes annoying in practice; possible
  fixes are a per-lot "frozen" flag or a second shelf-life field.

---

## 2026-08-14 — Fallback unitWeightG on high-variance mass ingredients

`trackBy` says how an ingredient is tracked in inventory (grams remaining in
a lot). It does not by itself say how a recipe is allowed to specify
quantity — a recipe could still reasonably say "2 chicken breasts" even
though breasts are tracked by mass, not count.

Most `trackBy: 'mass'` ingredients (ground beef, steaks, chops, deli meat,
bacon) do NOT get a `unitWeightG`, because piece size varies too much for
one number to mean anything — a deli turkey slice can be 3-4x thicker
depending on how the counter cut it.

Exception: chicken breast and chicken thighs got a `unitWeightG` anyway
(170g and 130g respectively) as a fallback, so recipes written as "2
chicken breasts" don't fail to import in Phase 2. This is a rough average,
not a measurement — it inherits its own error on top of the ±15% macro
tolerance already accepted project-wide. Apply this fallback selectively to
future ingredients that are both high-variance in size AND commonly
referenced by count in recipes — not automatically to every mass-tracked
ingredient.

---

## 2026-08-14 — defaultShelfLifeDays represents sealed/best-by, not opened

Same root cause as the frozen/fresh open item above: `Lot` only has one
`acquiredOn` timestamp and one derived expiry. There's no `openedOn` field,
so a single `defaultShelfLifeDays` per canonical ingredient can't represent
something whose spoilage clock resets once you break the seal — mayonnaise
and ranch dressing are good for months sealed, weeks once opened.

Decision: `defaultShelfLifeDays` represents the sealed/best-by shelf life
(matches the printed date, verifiable, and is what you'd check when adding
a fresh lot), not the shorter opened/in-use life. Consequence: the app will
under-warn about something that's been open in the fridge for a while — the
Reconcile screen is the accepted mitigation for that drift, same as
everywhere else quantity/freshness gets fuzzy.

Fixed under this convention: `mayonnaise` (60→180 days), `ranch-dressing`
(30→150 days). Also flipped `salsa` from perishable:true (14 days) to
perishable:false, on the theory that jarred shelf-stable salsa is the same
"long sealed best-by, low tracking value" bucket as ketchup/mustard — not
explicitly confirmed with the User, worth a second look if the User means
fresh refrigerated salsa instead.

If this becomes a real problem in practice, the fix is adding `openedOn` to
`Lot` in a later phase — not something to solve by picking cleverer
defaults now.

---

## 2026-08-14 — Most dried spices are tracked, not assumed-on-hand

Supersedes the "Salt, dried spices" row in the tracked/perishable table
above. The original assumption — every spice is a universal pantry item,
not worth checking ownership for — doesn't hold in practice. The User
doesn't own every spice in the ontology (turmeric, curry powder, etc.),
and `tracked: false` was silently making the app assume otherwise, which
would have shown recipes as fully makeable when a real ingredient was
missing.

`tracked` is a canonical-level default, not a per-user pantry flag — the
actual "do I own this" answer already comes from whether a `Lot` exists for
it, exactly as it does for every other tracked ingredient. So the fix isn't
a new mechanism, it's just applying the existing one: 20 of the 22 spice
entries moved from `tracked: false` into the same bucket as flour/oil/rice
(tracked, not perishable). Only salt and black pepper stay assumed-on-hand,
as the two genuine universals.

Consequence: those 20 entries also needed `cupWeightG` added, since recipes
reference spices by tsp/tbsp and that conversion didn't exist while they
were untracked. Values are rough (ground-spice density estimates, not
measured), same tolerance as every other cupWeightG in this file.

`bay-leaves` also switched from `mass`/`cupWeightG` to `count`/`unitWeightG`
in the same pass — "1 cup of bay leaves" isn't a real recipe measurement;
recipes count leaves.

---

## 2026-08-14 — Phase 1 closed at 193 entries; no way to grow the ontology post-launch

`ontology.json` shipped with 193 canonical ingredients across all 10
categories. Before closing Phase 1, did a gap-check against common home
ingredients and added 15 more (water, feta, Swiss, ground chicken, cod,
green onion, red onion, kale, green beans, hamburger buns, refried beans,
apple cider vinegar, white vinegar, marinara sauce, canned corn).

Open item: there is currently no way for the User to add a new canonical
ingredient once the app is built and deployed. Neither Phase 4 (Inventory
UI) nor Phase 6 (Recipe UI) currently scopes a screen for it — both
assume the canonical ingredient a product or recipe line needs already
exists. Two paths, not mutually exclusive:

1. `AppMeta.seedVersion` already exists in the schema for exactly this —
   tracking which version of the bundled seed data (ontology + recipes)
   has been merged into local IndexedDB, so a future `ontology.json`
   update can add entries without duplicating what's there or touching
   existing products/lots. The merge logic itself isn't built (Phase 3+
   engine work) — the field is just a hook.
2. An in-app "add ingredient" form, writing straight to IndexedDB at
   runtime, no redeploy needed. Not currently scoped anywhere — would
   most naturally sit in Phase 4 next to add-product/add-lot.

Flagged in ROADMAP.md under Phase 4. Needs a decision before Phase 4
starts, not before Phase 2 or 3 — recipe import and the engine don't
depend on this.

---

## 2026-08-17 — Ontology reopened for Phase 2 seed data; grew 193 → 271 across 5 rounds

**Supersedes the "no way to grow the ontology" framing above** for the
specific case of preparing the bundled seed data. That entry was about
end users adding ingredients post-launch (still unsolved, still an open
item); it was never meant to block the ontology from growing *before*
launch, while assembling Phase 2's seed content. Recording that
distinction explicitly since it wasn't obvious from the original wording.

**Growth by round:**

| Round | Trigger | New entries | Field-only fixes | Total after |
|---|---|---|---|---|
| 1 | Full-catalog name check: TheMealDB's ~480-string ingredient vocabulary vs. the 193-entry ontology. 183 strings (38%) had no match. | 65 | 21 aliases | 258 |
| 2 | `quantityG` conversion failures while normalizing recipes 1-5 — matching a *name* isn't the same as being able to convert its quantity. | 5 | 5 (salt, black-pepper, baking-powder, baking-soda, vanilla-extract) | 263 |
| 3 | Recipes 6-19 (seafood, pork, vegetarian, pasta, beef) | 3 | 7 (6 aliases + green-onion cupWeightG) | 266 |
| 4 | User decision on count-only proteins (below) | 1 (`chicken-legs`) | 2 (pork-chop-boneless, bacon `unitWeightG`) | 267 |
| 5 | Recipes 20-28 (lamb, sides, Mediterranean) | 4 | 1 (butternut-squash `unitWeightG`) | 271 |

**Round 1 additions covered:** proteins (lamb, duck, mussels, clams,
squid, oysters, mackerel, chorizo, prosciutto), produce (asparagus, leek,
shallot, celeriac, fennel, brussels sprouts, eggplant, pumpkin, stone
fruit), herbs/spices (dill, mint, sage, cardamom, saffron, garam masala,
curry pastes), cheeses (gouda, brie, ricotta, mascarpone, Monterey Jack,
gruyère, goat cheese), and pantry items (pine nuts, capers, tahini,
olives, puff pastry). Aliases absorbed British spelling/terms ("chilli
powder", "courgettes" → zucchini, "swede" → turnip, "rapeseed oil" →
vegetable oil) and near-identical products (crème fraîche → sour cream,
single cream → half-and-half).

**Judgment calls** — each trades precision for not adding a near-duplicate
entry, within the project's existing ±15% macro tolerance, but worth
remembering if accuracy on these specific recipes ever feels off:

- `curry-paste` collapses Massaman, Thai green, Thai red, and Madras
  curry pastes into one entry — different flavors, similar enough macro
  profile (oil + spice + aromatics).
- `pasta-other-dry` collapses macaroni, farfalle, rigatoni, tagliatelle,
  fettuccine, lasagne sheets, and similar shapes — dry wheat pasta has
  near-identical macros regardless of shape. `pasta-spaghetti` and
  `pasta-penne` stayed separate since recipes already referenced them
  individually.
- `bouillon-cube` (round 5) is one generic entry for both vegetable and
  chicken stock cubes — product and macros are nearly identical either way.
- `ham-deli-sliced` stood in for a whole gammon/ham joint in Split Pea
  Soup (same base protein, different cut/prep — flagged rather than
  adding a single-use whole-ham entry).
- `allspice-ground` stood in for an "Old Bay"-style blend in Breakfast
  Potatoes (Old Bay is itself allspice-forward, so a reasonable
  single-spice stand-in, not an exact match).

**Deliberately not added** — recipes needing these are skipped rather
than forced: alcohol as an ingredient (brandy, sake, stout, dry white
wine), UK-baking one-offs with no US-pantry equivalent (golden syrup,
digestive biscuits, custard powder, suet, glacé cherries), food
colorings, and narrow proteins (veal, monkfish, pilchards, doner meat).
Recipes skipped for these or other reasons: Teriyaki Chicken Casserole,
Honey Teriyaki Salmon, Chicken Karaage, Honey Balsamic Chicken, Spinach &
Ricotta Cannelloni, Vegetarian Chilli, Dal Fry, Egg Foo Young, French
Onion Soup.

**Decision (round 4): count-only proteins get a `unitWeightG` fallback.**
Several recipes reference a high-variance mass-tracked protein by count
instead of weight — "2 pork chops," "2 strips of bacon," "4 chicken
legs." These had deliberately been left without `unitWeightG` per the
2026-08-14 decision ("piece size varies too much for one number to mean
anything"), with chicken breast/thighs as the sole named exception. Since
this kept recurring (3 recipes blocked on it), asked the User rather than
overriding that decision silently. **User decided:** extend the same
exception. Added `unitWeightG: 170` to `pork-chop-boneless` (same as
chicken breast — a boneless center-cut chop is a similar size),
`unitWeightG: 8` to `bacon` (one raw strip), and a new `chicken-legs`
entry at `unitWeightG: 340` (bone-in leg quarter — thigh + drumstick —
distinct from the existing drumstick-only entry). All three carry the
same caveat as the original chicken exception: rough averages, not
measurements, with their own error on top of the ±15% tolerance already
accepted project-wide. This unblocked Breakfast Potatoes, Skillet Apple
Pork Chops, and Chicken Marengo.

The post-launch "how does the User add an ingredient" open item from the
2026-08-14 entry is unchanged and still unresolved — this entry only
covers what shipped in the bundled seed data.

Running total at end of day: 28 recipes seeded (out of the 100-150
target), 271 ontology entries (was 193 that morning).

## 2026-08-17, later — validation pass added; caught 3 real bugs in the existing 28

Built `qa/seed-data.validate.test.ts`, a Vitest file that runs automatically
with `npm test` (no new command to remember). It checks ontology structure
(no duplicate ids/aliases, valid enums, `densityGPerMl` never set on
anything that isn't `trackBy: 'volume'` — the CLAUDE.md "never density x
volume for solids" rule, enforced instead of just stated), recipe structure
(every `canonicalId` resolves, valid units, positive quantities), recomputes
every `quantityG` and `estimatedYieldG` from scratch to catch arithmetic
mistakes, and does a rough calories-per-100g plausibility check. Full
breakdown in `qa/README.md`.

**The calorie check needed data the schema doesn't have.** `CanonicalIngredient`
carries no macros by design (`Product.macrosPer100g` does, Phase 3+), and no
`products.json` exists yet. Rather than touch the locked schema, added
`qa/calorie-reference.json` — a rough kcal/100g estimate per ingredient,
covering only what the 28 recipes currently use, explicitly QA-only and
outside `src/` (never imported by the app, never bundled). It's a sanity
band, not real macro data — good enough to catch a 5-10x units mistake, not
precise enough for anything else.

Running it against the existing 28 recipes and 271-entry ontology surfaced
3 real, pre-existing problems, all fixed the same day:

- `cooking-spray` is `trackBy: 'volume'` but never had a `densityGPerMl` —
  slipped through because no recipe has used it yet. Added `0.92`.
- `coconut-milk-canned` had a leftover `densityGPerMl: 0.95` from before it
  was reclassified to `trackBy: 'count'` (uses `unitWeightG: 400`, one can).
  The field was orphaned and violated the density-only-for-liquids rule.
  Removed it.
- Lamb Tagine's saffron (0.25 tsp of a 2g/cup ingredient, so ~0.01g) rounded
  to `quantityG: 0.0` under the 1-decimal rounding used everywhere else —
  a real trace amount getting erased, not a wrong ingredient. Fixed to
  `0.01`.

One check needed loosening, not the data: Egg Drop Soup came back at 25
kcal/100g against an initial 30-600 plausible band. It's a legitimately
broth-heavy soup (3 cups chicken broth at ~4 kcal/100g dominates the total)
computed from raw ingredient weights, which can't account for the
concentration that happens as a soup simmers down — a real dish can
legitimately land in the low 20s. Lowered the floor to 15, with a comment
explaining why, rather than force a broth soup's numbers to look like a
casserole's.

## 2026-08-17, later still — full cuisine survey; pivoted to area-based sourcing

Ran the "full upfront pass" the User asked for instead of continuing the
reactive per-batch approach. Queried TheMealDB's `filter.php?a=<cuisine>`
for every area rather than pulling by category (Chicken, Beef, Vegetarian,
Dessert) — categories were the actual source of British skew risk, since
BBC Good Food content clusters there disproportionately, not because
British is the majority of TheMealDB overall.

**Found and worked around a data-consistency bug in TheMealDB itself:**
`filter.php?a=American`, `?a=French`, and `?a=Indian` all returned zero
results, even though this session had already sourced confirmed recipes
tagged to those cuisines. Turned out TheMealDB's `strArea` field is
inconsistent — most cuisines use the adjectival name ("British",
"Chinese", "Turkish"), but a few use the plain country name instead
("United States", "France", "India"). Re-queried with the country-name
form to get accurate counts.

**Full picture (~516 recipes across ~29 cuisines, the free-tier dataset's
practical ceiling):** British is the single largest cuisine at 59 (11.4%),
followed by Spanish (47), American (35), Turkish (30), French (28), then
Chinese/Jamaican/Thai/Vietnamese/Polish (27 each), Canadian (22), Italian
(21), Indian (14), Australian (13), Uruguayan/Japanese (9 each), and
roughly a dozen cuisines at 5-8 each (Egyptian, Greek, Croatian, Filipino,
Irish, Malaysian, Portuguese, Tunisian, Russian, Syrian, Mexican,
Moroccan, Kenyan).

Checked this against the 28 recipes already built: British was actually
*under*-represented (2/28, 7%) relative to its 11.4% share of the source
data — the reactive approach hadn't produced a British-heavy set so far,
but nothing had been actively preventing one from developing as remaining
categories got mined out.

**User decisions:** target the full 150-recipe end of the original range
(122 more needed), and cap British at ~10% of the final total (~15
recipes) — in line with its natural share of the source data, not
artificially excluded, just not allowed to dominate. 13 more British slots
remain, to be filled only by recipes that clear both the ingredient-
familiarity bar and the ontology budget below.

**Sourcing rule going forward:** pull by cuisine/area instead of category,
skip any recipe (British or otherwise) that would need meaningfully more
than the ~2.8-entries/recipe historical average, and for British
specifically also require familiar, already-common ingredients — no new
UK-baking one-offs, no exotic proteins.

**First batch under the new approach (11 recipes, 6 new ontology
entries — 0.55/recipe, well under budget):** Thai Green Curry, Vietnamese
Chicken Salad, Rosol (Polish Chicken Soup), Lamb and Lemon Souvlaki
(Greek), Bistek (Filipino), Grilled Portuguese Sardines, Chakchouka
(Tunisian), Chivito Uruguayo, Sukuma Wiki (Kenyan), Spanish Tortilla, and
Quick Gazpacho — one recipe each from 9 previously-unrepresented cuisines,
proving the area-based approach is both cheaper on the ontology and much
better for variety than the old category-based one. Added `fish-sauce`,
`pita-bread`, and `sardines` (genuinely new); caught and avoided adding
*duplicate* entries for lettuce, rosemary, and peanuts, which already
existed as `romaine-lettuce`, `rosemary-dried`, and `peanuts-raw` — the
validation pass's alias-collision check caught this immediately rather
than it becoming a silent ambiguous-match bug.

Skipped this batch: Japanese Katsudon (needs mirin — treated as alcohol,
consistent with the sake/wine/brandy exclusions), Beef Rendang (needs
star anise and tamarind paste, and the source's ingredient list was
missing lemongrass entirely even though the instructions call for it —
too many stacked judgment calls for one recipe), Traditional Croatian
Goulash (200ml red wine, not a trace amount).

Running total: 39 recipes seeded (out of the 150 target), 274 ontology
entries (was 271 before this batch).

## 2026-08-17, later still — alcohol un-excluded; reversing an undocumented Phase 2 decision

The 2026-08-17 entry above lists "alcohol used as an ingredient" as
deliberately not added, alongside UK-baking one-offs and food colorings —
but never actually says why, for any of the three. The User asked. Under
examination this wasn't a real decision, just an unexamined default I
carried through the whole ontology-building pass without checking it.
Reversing it here, with the reasoning actually written down this time.

**Why it seemed reasonable at the time:** most of the alcohol in a cooked
dish evaporates during cooking, so estimating its calorie contribution
from the raw ingredient's macros overstates the finished dish — a bigger
error than most ingredients carry.

**Why that's not a good reason to exclude it:** every other cooking
transformation in this app already goes unmodeled the same way — browning
meat loses fat and moisture, sauces reduce and concentrate, water
evaporates out of soups (see the Egg Drop Soup note above). The project's
own stated tolerance (±15%, "don't build precision machinery beyond
this," per `CLAUDE.md`) already exists to absorb exactly this kind of
approximation. Singling out alcohol for exclusion while accepting the
same error everywhere else wasn't consistent.

**User's actual request, and the distinction worth recording:** alcohol
needs to be trackable two ways eventually — as a cooking ingredient
(partial calorie loss to evaporation, not modeled, same as every other
cooking transformation) and as a drinking beverage logged at full
calories (a can of one beer vs. another can have very different calorie
counts). The second case needs no schema change at all — it's exactly
what the CanonicalIngredient → Product split already exists for: one
canonical "beer, lager" can have many Products (different brands) with
their own `macrosPer100g`, same as any other ingredient. Modeling
*cooking* loss precisely (a retention-factor system) would be a real
schema addition and is explicitly out of scope for now — noted as a
possible v2 idea, not something to build today.

**What changed:** added `wine-white-dry` and `sake` to the ontology.
`wine-red` and `mirin` turned out to already exist (evidently the original
exclusion was never fully applied in the first place — another sign it
was never a deliberate, enforced rule). Un-skipped and built 5 recipes
that had been blocked on this: French Onion Soup, Honey Teriyaki Salmon,
Chicken Karaage, Traditional Croatian Goulash, and Japanese Katsudon.

Egg Foo Young stays skipped — with the alcohol issue gone it still needs
4 new entries (oyster sauce, bean sprouts, shrimp, Shaoxing wine) for one
recipe, over budget on its own merits now.

New judgment-call pattern from Chicken Karaage worth flagging: the source
recipe calls for 1/3 cup of oil to fill a pot for frying, but almost none
of that is actually eaten — only what the coating absorbs. Recorded the
full amount as 2 tbsp (a rough absorption estimate) rather than the full
frying volume, which would have overstated calories by roughly 5x. Expect
this to come up again with other fried recipes.

Running total: 44 recipes seeded (out of the 150 target), 276 ontology
entries (was 274 before this batch).

## 2026-08-17, later still — 4 more recipes; British catch-up batch

Picked up 4 more recipes, filtered for familiar ingredients per the User's
"eliminate excess British by familiarity" rule: Beef Sunday Roast, Corned
Beef Hash, and Creamy Tomato Soup (British — all everyday ingredients, 1
new entry between the three), and Roti John (Malaysian — zero new
entries). Skipped Turkey Meatloaf: needs 4 new entries (turkey mince,
breadcrumbs, barbecue sauce, cannellini beans) for one recipe, over
budget.

Added one new entry, `corned-beef` — and found it collided with an
existing alias: `beef-brisket` already carried "corned beef" as an alias
from the earlier Corned Beef and Cabbage recipe (a whole brined brisket
joint you boil). The new entry is for the canned/hash-style product used
in Corned Beef Hash — a meaningfully different product nutritionally
(cured and canned vs. raw joint), worth keeping separate rather than
collapsing. Resolved by renaming `beef-brisket`'s alias to "corned beef
brisket" / "corned beef joint" so the bare "corned beef" string
unambiguously means the canned product. The validation pass's
alias-collision check caught this immediately, same as the
lettuce/rosemary/peanuts collision in an earlier batch — this check has
now paid for itself twice in one session.

British count is now 5 of the ~15-recipe cap (2 original + 3 this batch).

Running total: 48 recipes seeded (out of the 150 target), 277 ontology
entries (was 276 before this batch).

## 2026-08-17, later still — 7 more recipes; Turkish/Jamaican/Chinese

Continuing the area-based sourcing. Added 7 recipes across Turkish (Cacik,
Corba, Chicken Wings with Cumin Lemon & Garlic), Jamaican (Steamed
Cabbage), and Chinese (Tomato Egg Stir Fry, Beef and Broccoli Stir-Fry,
Sesame Cucumber Salad) for only 3 new ontology entries total
(`chicken-wings`, `oyster-sauce`, `sherry` — the last also covers
Shaoxing wine and Chinese rice wine as aliases, since they're
close-enough substitutes for this project's purposes).

Skipped Red Peas Soup (Jamaican): the ingredient list lists "Beef, 2 lbs"
but the instructions are entirely about preparing salted pigtail, which
isn't in the ingredient list at all — the same kind of internally
inconsistent source data that's been a skip reason all session (Dal Fry,
Beef Rendang).

Adding `oyster-sauce` and a wine/rice-wine entry means Egg Foo Young (see
earlier entry) is down to 2 blocking new entries instead of 4 — still
skipping it for now, but it's cheaper to pick up later if wanted.

Running total: 55 recipes seeded (out of the 150 target), 280 ontology
entries (was 277 before this batch).

## 2026-08-17, later still — 6 more recipes; Thai/Vietnamese/Polish/Jamaican/Spanish

Added Stir-fried Chicken with Chillies & Basil and Thai Pumpkin Soup
(Thai), Tangy Carrot Cabbage & Onion Salad (Vietnamese), Cucumber &
Fennel Salad (Polish), Jamaican Rice and Peas (Jamaican), and Padron
Peppers (Spanish) for 1 new ontology entry (`lemongrass`). Also added
"red cabbage" as an alias on the existing `cabbage` entry rather than a
new one, and used `bell-pepper` as a documented stand-in for Padron
peppers (small green pepper, similar macros, not worth a single-use
entry for one recipe).

Running total: 61 recipes seeded (out of the 150 target), 281 ontology
entries (was 280 before this batch).

## 2026-08-17, later still — 4 more recipes; French/Canadian

Added French Lentils With Garlic and Thyme and Chicken Basquaise
(French), and Hodge Podge and Pate Chinois (Canadian) for 2 new ontology
entries (`sun-dried-tomatoes`, `creamed-corn`). Also added "french
lentils" as an alias on the existing `lentils-red` entry, and added a
missing `cupWeightG` (150) to the pre-existing `chorizo` entry, which had
no conversion field before and would have blocked using it by volume.

Chicken Basquaise uses white wine (`wine-white-dry`) — this is the first
recipe built since the alcohol-inclusion decision that would previously
have been skipped outright for that reason alone. It carries a `note`
field pointing at this file for context.

Pate Chinois measures its potato layer as "4 cups mashed potato," which
doesn't map to `potato-russet`'s count-based `unitWeightG` (a whole raw
potato weight, not a mashed-yield weight). Estimated mashed potato at
~210g/cup (a standard reference figure) and recorded it as a `cup`-unit
line with a preparation note, rather than trying to force it through the
whole-potato conversion path.

Caught and fixed one quantityG bug before it shipped: Hodge Podge's
green beans were entered as `quantityG: 110` for "1 cup," but
`green-beans`'s actual `cupWeightG` is 100 — off by 10g, over the 2%
tolerance. The validation pass's recomputation check caught it
immediately; corrected to 100.

Running total: 65 recipes seeded (out of the 150 target), 283 ontology
entries (was 281 before this batch).

## 2026-08-17, later still — 6 more recipes; Spanish/Indian/Australian

Added Paella, Chicken & Chorizo Rice Pot, and Patatas Bravas (Spanish),
Tandoori Chicken and Matar Paneer (Indian), and Aussie Burgers
(Australian) for 3 new ontology entries (`broad-beans`, `beetroot`,
`arugula`). Paella's rice is recorded against the existing `rice-white`
entry with a preparation note — short-grain paella rice doesn't have its
own entry and isn't worth one for a single recipe, similar to the Padron
pepper / bell-pepper substitution in an earlier batch.

Caught and fixed several quantityG bugs before/during validation, all
from guessing at unitWeightG/cupWeightG values instead of reading the
actual ontology entries first: onion-yellow, onion-red, and garlic-clove
all have fixed per-count weights (110g, 150g, 5g respectively) that
don't flex for "small" or "large" as a preparation note implies — where
a recipe genuinely wanted a smaller onion, switched that line to a plain
gram measurement instead of `count`. Paprika and thyme-dried cupWeightG
values were also guessed rather than looked up and had to be corrected.
The validator's recomputation check caught all of these; going forward,
look up the real ontology conversion field before writing quantityG
rather than estimating it.

Running total: 71 recipes seeded (out of the 150 target), 286 ontology
entries (was 283 before this batch).

## 2026-08-17, later still — 4 more recipes; Turkish/Jamaican/Vietnamese/Polish

Added Adana Kebab (Turkish), Escovitch Fish (Jamaican), Tofu, Greens &
Cashew Stir-Fry (Vietnamese), and Golabki/Cabbage Rolls (Polish) for 6
new ontology entries (`red-pepper-paste`, `red-snapper`, `scotch-bonnet`,
`pak-choi`, `hoisin-sauce`, `ground-pork`).

Two documented substitutions rather than new one-off entries: Adana
Kebab's Romano peppers use the existing `bell-pepper` entry, and its pul
biber (Turkish red pepper flakes) uses the existing `red-pepper-flakes`
entry — both close enough in macros for this project's tolerance.
Escovitch Fish's malt vinegar uses the existing `vinegar-apple-cider`
entry the same way. Skipped Ezme (Turkish) — needs 5 new entries
(pepper paste, pul biber/handled but sumac, pomegranate molasses, dried
mint all new) for one relish, over budget.

This batch had zero quantityG bugs on the first `npm test` run — first
clean pass since batch 8, credited to looking up every ontology
conversion field before writing quantityG instead of estimating it, per
the lesson from batch 10.

Running total: 75 recipes seeded (out of the 150 target), 292 ontology
entries (was 286 before this batch).
