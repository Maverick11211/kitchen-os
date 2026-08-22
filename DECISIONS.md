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

## 2026-08-18 — 7 more recipes; Chinese/Italian/Thai (TheMealDB lookup.php outage)

Hit a TheMealDB service issue this session: `lookup.php?i=<id>` on the v1
API started returning stale/wrong cached recipe data regardless of the
id requested (confirmed by cross-checking `strMeal` in the response
against the requested id — it kept returning whichever recipe had been
fetched most recently, for any id). `filter.php` continued to work
correctly throughout. Worked around it by switching recipe-detail fetches
to the v2 API with TheMealDB's public test key
(`/api/json/v2/9973533/lookup.php?i=<id>`), which returned correct,
distinct data for every id. Recording this here in case it recurs —
try v2 with the test key first before assuming `lookup.php` itself is
broken.

Added Kung Pao Chicken, Egg Foo Young, and Beef Lo Mein (Chinese),
Lasagne and Squash Linguine (Italian), and Pad Thai and Thai Drumsticks
(Thai) for 3 new ontology entries (`water-chestnut`, `bean-sprouts`,
`sweet-chili-sauce`). Egg Foo Young had been sitting on the skip list
since early in the session waiting on exactly these — `oyster-sauce` and
`sherry` were added in an earlier batch, `shrimp-peeled-deveined`
already existed, and `bean-sprouts` was the last piece; it's now built.

Several documented substitutions instead of one-off entries: creme
fraiche -> `sour-cream`, lasagne sheets and linguine -> `pasta-other-dry`,
lo mein noodles -> `egg-noodles`, muscovado sugar -> `sugar-brown`, fresh
basil/sage -> the existing dried-herb entries at an estimated dried
equivalent. Egg Foo Young's deep-frying oil is recorded at a reduced
volume (2 cups vs. the 3 cups called for) per the fried-oil-absorption
convention established earlier in the session, rather than counting the
full frying volume as consumed.

Every quantityG in this batch was computed from an ontology value looked
up before writing the recipe, per the batch 10/11 lesson — `npm test`
passed cleanly on the first run again.

Running total: 82 recipes seeded (out of the 150 target), 295 ontology
entries (was 292 before this batch).

## 2026-08-18, later still — 12 more recipes; French/Spanish/Turkish

A big batch: Beef Bourguignon, Chicken Parmentier, Tuna Niçoise, and
French Omelette (French); Gambas al Ajillo, Easy Spanish Chicken, Pisto
con Huevos, and Chorizo & Tomato Salad (Spanish); Kofta Burgers, Smoky
Chicken Skewers, Turkish Rice (Vermicelli Rice), and Chilli Ginger Lamb
Chops (Turkish) — for only 3 new ontology entries (`goose-fat`,
`beef-shin`, `fennel-seeds`), thanks to how well-stocked the ontology
already is after 12 prior batches.

Several documented substitutions instead of new one-offs: sherry vinegar
-> `red-wine-vinegar`, smoky aïoli -> `mayonnaise`, vermicelli pasta ->
`egg-noodles`, lamb loin chops -> `lamb-leg`, French Omelette's tarragon
folded into its `parsley` line (no close ontology match, small quantity,
similar use as a chopped fresh herb). Both Beef Bourguignon and Chicken
Parmentier use wine and carry a note pointing at DECISIONS.md.

Caught 3 quantityG bugs before/during validation, all the same root
cause as batch 10 and 11's fixes: a "half" or approximate-can quantity
written as a whole `count` (half a cabbage, half a lemon, one 400g can
of beans where the ontology's canned-bean unit is 425g) without updating
the `quantity` field to match. Fixed by setting `quantity` to the actual
fractional/rounded count so recomputation lines up — same lesson as
before, just a variant of it (partial counts, not wrong reference
values) that's worth calling out separately: whenever a recipe wants
"half of" a count-tracked ingredient, the `quantity` field itself must
carry that fraction, not just the `quantityG`.

Running total: 94 recipes seeded (out of the 150 target), 298 ontology
entries (was 295 before this batch).

## 2026-08-18, later still — 8 more recipes; Canadian/Jamaican/Vietnamese

Added Poutine, Molasses Baked Beans, and Jiggs Dinner (Canadian);
Jamaican Curry Chicken and Jamaican Beef Patties (Jamaican); Bang Bang
Prawn Salad, Salt & Pepper Squid, and Vietnamese Grilled Pork (Bun Thit
Nuong) (Vietnamese) for 5 new ontology entries (`cheese-curds`, `gravy`,
`navy-beans-dry`, `molasses`, `szechuan-peppercorns`). `curry-powder`,
`turnip`, and `split-peas-dry` all turned out to already exist from
earlier batches.

Jiggs Dinner's "salt beef" uses the existing `beef-brisket` entry with a
note — same cut/preparation family as the corned beef joint already
modeled there. Vietnamese Grilled Pork's source recipe listed pre-made
egg rolls as a side accompaniment; omitted with a note rather than
force-mapped, since it's a store-bought item outside this recipe's own
cooking process.

A new variant of the "fraction of a count-tracked item" bug from batch
13 showed up here: Bang Bang Prawn Salad measures 4 tbsp (~60g) from a
400g can of coconut milk. Writing the fraction as `0.1` (rounded to 1
decimal by the usual `r1` helper) produced 40g on recompute instead of
60g — the rounding itself was the bug, not the concept. Fixed by using a
3-decimal fraction (`0.15`) so `0.15 * 400 = 60.0` exactly. Two more
routine half-count fixes (half a green pepper, half a cucumber) followed
the by-now-familiar pattern from batches 10/11/13.

Running total: 102 recipes seeded (out of the 150 target), 303 ontology
entries (was 298 before this batch).

## 2026-08-19 — 11 more recipes; Thai/Polish/Indian

Added Pad See Ew, Thai Chicken Cakes with Sweet Chilli Sauce, Prawn
Stir-Fry, and Thai Beef Stir-Fry (Thai); Pierogi, Polish Patties
(Kotlety), Bigos (Hunters Stew), and Zapiekanki (Polish); Baingan
Bharta, Chicken Handi, and Lamb Biryani (Indian) for 5 new ontology
entries (`sauerkraut`, `kielbasa`, `caraway-seed`, `cumin-seeds`,
`poppy-seeds`). `curry-powder`, `turnip`, `split-peas-dry`, `ghee`, and
several spice entries all turned out to already exist.

Two substitutions instead of one-offs: dark soy sauce -> `soy-sauce`,
and Zapiekanki's Polish kabanos sausage reuses the new `kielbasa` entry
(same category of product) instead of a second new one.

Caught 4 more instances of the exact bug flagged after batch 14 —
`quantity` left at a whole `1` while `quantityG` was computed from a
fractional basis (5/6 of an onion for Pierogi, half an onion for Baingan
Bharta, ~0.44 of a cabbage and ~0.59 of a can for Bigos). This confirms
the fix from batch 14's writeup didn't actually get applied consistently
during batch 15's authoring — worth treating as a mechanical check to
run before `npm test`, not just a lesson to remember: for every line
using a fractional multiplier inside `count_g(...)`, grep for it and
confirm the `quantity` field carries the same fraction.

Running total: 113 recipes seeded (out of the 150 target), 308 ontology
entries (was 303 before this batch).

## 2026-08-19 — 14 more recipes; Spanish/Chinese/French/Canadian

Added Chorizo, Potato & Cheese Omelette, Fried Calamari, Chickpea,
Chorizo & Spinach Stew, and Spanish Beans with Chicken & Chorizo
(Spanish); General Tso's Chicken, Shrimp With Snow Peas, Ramen Noodles
with Boiled Egg, and Chinese Orange Chicken (Chinese); Coq au Vin,
Boulangère Potatoes, and Steak Diane (French); Classic Tourtière,
Montreal Smoked Meat, and Rappie Pie (Canadian). Only 2 new ontology
entries needed for all 14 recipes: `snow-peas` and `brandy` — nearly
everything else (`chickpeas-canned`, `pinto-beans-canned`,
`nutmeg-ground`, `onion-powder`, `puff-pastry`, `sesame-seeds`, etc.)
already existed.

Substitutions used instead of one-off entries: pinto beans ->
`navy-beans-dry` (both dried legumes needing an overnight soak), duck
sauce -> `sweet-chili-sauce`, gochujang -> `chili-powder` (small
amount), celery salt -> `salt`, shortcrust pastry -> `puff-pastry`,
ground clove folded into the `nutmeg-ground` line (Tourtière), and
Jersey Royal potatoes -> `potato-russet`.

Coq au Vin and Steak Diane both use alcohol (red wine, brandy) that's
mostly cooked off — both carry a `note` field pointing back to the
alcohol-inclusion decision, consistent with prior batches.

Before running the build script this time, ran the mechanical grep
check flagged after batch 15's writeup (search for every fractional
`count_g`/`cup`/`tbsp`/`tsp` call and confirm `quantity` matches the
fraction) — it caught 4 instances on review (potato-russet at 0.6 in
both Chorizo Potato Cheese Omelette and Classic Tourtière, chickpeas at
1.88 cans, potato-russet at 1.47) before the script was ever run. `npm
test` passed clean on the first attempt for the first time since batch
12 — the mechanical check, not just documenting the lesson, is what
finally worked.

Running total: 127 recipes seeded (out of the 150 target), 310 ontology
entries (was 308 before this batch).

## 2026-08-19 — 12 more recipes; Turkish/Jamaican/Vietnamese/Polish/Italian/British

Added Kumpir and Lamb & Apricot Meatballs (Turkish); Jerk Chicken with
Rice & Peas and Jamaican Curry Goat (Jamaican); Beef Pho and
Vietnamese-style Caramel Pork (Vietnamese); Polskie Nalesniki (Polish
Pancakes) and Pork & Sauerkraut Goulash (Polish); Salmon Prawn Risotto
and Rigatoni with Fennel Sausage Sauce (Italian); Toad In The Hole and
Fish Pie (British, bringing British to 7 — still well under the ~15
cap). **Zero new ontology entries needed** — the 310-entry ontology
already covered every ingredient across all 12 recipes.

Substitutions used instead of one-offs: goat meat -> `lamb-leg` (very
similar in curries, common real-world swap), red/bird's-eye chilli ->
`jalapeno` (used 3 times across Jerk Chicken, Beef Pho, and Caramel
Pork), pork shoulder/steaks -> `pork-chop-boneless` (used twice, Caramel
Pork and the Goulash), arborio rice -> `rice-white`, pecorino ->
`parmesan-grated`, anchovy fillet -> a small gram amount of `sardines`,
Jerusalem artichokes -> `turnip`, British bangers -> `sausage-italian`,
palm sugar -> `sugar-brown`, cinnamon stick -> `cinnamon-ground`, and
"all-purpose seasoning" folded into the `salt` line for Curry Goat.

Simplified the unit-choice approach this batch: confirmed by reading
`qa/seed-data.validate.test.ts`'s `recomputeQuantityG` directly that
unit `"g"`/`"ml"` always passes `quantityG` through unchanged regardless
of the canonical's `trackBy`/`unitWeightG`/`cupWeightG` — there is no
check anywhere that a RecipeIngredient's unit must match its
canonical's `trackBy`. So for any ingredient given as a plain weight
(pork shoulder, potatoes, cod fillet, etc.) rather than a natural count,
using `"g"` directly instead of forcing a `"count"` conversion is both
simpler and immune to the fractional-quantity bug class entirely, since
`quantity` and `quantityG` are the same number by construction. Kept
`"count"` only for genuinely discrete items (eggs, cloves, onions,
canned goods rounded to the nearest can). Ran the mechanical
fractional-quantity grep check before running the build script again —
zero mismatches found, and `npm test` passed clean on the first attempt
for the second batch running.

Also noticed and backfilled 10 pre-existing ontology ids that had been
used in earlier batches but never got a `qa/calorie-reference.json`
entry (`cheddar-shredded`, `cod-fillet`, `horseradish-prepared`, `lard`,
`nutmeg-ground`, `rice-white`, `sausage-italian`,
`shrimp-peeled-deveined`, `smoked-paprika`, `star-anise`) — the calorie
check silently skips recipes with a missing reference rather than
failing, so this had gone unnoticed until this batch used them all
directly.

Running total: 139 recipes seeded (out of the 150 target), 310 ontology
entries (unchanged this batch).

## 2026-08-19 — Final 11 recipes; 150/150 target reached

Added Spanish-style Slow-Cooked Lamb Shoulder & Beans (Spanish); Szechuan
Beef (Chinese); Pork Cassoulet (French); Massaman Beef Curry (Thai);
Nutty Chicken Curry (Indian); Turkish Lamb Pilau (Turkish); Oxtail with
Broad Beans (Jamaican); Sea Bass with Sizzled Ginger, Chilli & Spring
Onions (Vietnamese); Slow-Roasted Ham with Lemon, Garlic & Sage
(Polish); Lancashire Hotpot (British); and Osso Buco alla Milanese
(Italian). One recipe from each of 11 different cuisines, spreading the
final push evenly rather than piling onto any single one. **Zero new
ontology entries needed** — third batch running with none, confirming
the ontology has converged on covering the vast majority of common
Western/Asian home-cooking ingredients.

Three new one-off substitutions worth noting: oxtail and veal shanks
(Osso Buco) both map to `beef-shin` — all three are collagen-rich,
slow-braising cuts, so the same canonical entry covers all of them; sea
bass maps to `red-snapper` (closest delicate white/pink fish already in
the ontology); and 3 lamb kidneys in the Lancashire Hotpot were folded
directly into the `lamb-leg` quantity with a note, since there's no
separate offal entry and it's a small fraction of the dish's protein.
Kaffir lime leaves (Massaman Curry) were approximated with a tiny
fraction of `lime` (0.1 count) rather than added as a new entry, similar
to how whole spices have been folded into related lines in past batches.

Backfilled 8 more pre-existing ontology ids that had been used in
earlier batches without a `qa/calorie-reference.json` entry
(`baguette`, `coconut-cream`, `egg-white`, `hot-sauce`, `marjoram-dried`,
`orange`, `pine-nuts`, `tamarind-paste`) — same gap-closing pass as
batch 17, and worth doing as a matter of course each batch going
forward since the check silently skips rather than fails.

Ran the mechanical fractional-quantity grep check before running the
build script — zero mismatches, and `npm test` passed clean on the
first attempt for the third batch running. The combination of the grep
pre-check plus defaulting to unit `"g"`/`"ml"` for any plain-weight
ingredient (established in batch 17) has fully closed out the bug class
that recurred in batches 13, 14, and 15.

**Final running total: 150 recipes seeded — target reached.** 310
ontology entries total (was 193 before Phase 2 began, unchanged this
specific batch).

## 2026-08-18 — Pre-Phase-3 review

Full review of `ontology.json`, `recipes.json`, `calorie-reference.json`,
`ROADMAP.md`, and this file before starting Phase 3, at Jack's request.
Verified fresh (not just trusting the last batch's green run): re-ran
`npm test && npm run lint && npm run build` from scratch (6017 tests,
clean), and byte-diffed the working copy against what's actually on
Jack's machine — identical, nothing drifted.

**Ontology (310 entries):** no duplicate ids, no alias collisions, no
duplicate names, no ontology-level invariant violations (every
`trackBy: 'count'` entry has `unitWeightG`, every `trackBy: 'volume'`
entry has `densityGPerMl`, no non-volume entry carries `densityGPerMl`),
no implausible numeric conversion values. 89 of the 310 entries are
never referenced by any of the 150 seed recipes — expected, not a bug:
Phase 1 built a general pantry ontology, not a recipes-only one, so
those entries (oats, quinoa, various canned beans, several cheeses,
etc.) are simply unused by this particular recipe set and ready for
Phase 3+ to reference directly (e.g. logged-but-not-cooked ingredients)
or for future recipe batches.

One real gap found and fixed: 5 ingredients that recipes actually use
(`cashews`, `ketchup`, `onion-powder`, `orange-juice`, `puff-pastry`)
had no `qa/calorie-reference.json` entry despite the batch-17/18
backfill passes — the calorie check silently skips rather than fails,
so this slipped through twice. Added all 5. Recipe calorie-plausibility
is now checked for all 150 recipes with zero skips, and none are
anywhere near the 15-600 kcal/100g band edges (closest low: egg-drop-soup
at 24.9; closest high: fried-calamari at 503.4) — comfortable margin on
both sides.

Noted but not changed: 7 ontology entries beyond the two documented
exceptions (`chicken-breast-boneless-skinless`, `chicken-thighs-boneless-skinless`)
carry both `trackBy: 'mass'` and a `unitWeightG` fallback — `bacon`,
`pork-chop-boneless`, `carrot`, `celery`, `butternut-squash`,
`whole-chicken`, `chicken-legs`. The 2026-08-14 decision said to apply
this "selectively... not automatically to every mass-tracked ingredient."
These look like reasonable applications of the same underlying logic
(high-variance-by-weight but commonly referenced by count in a recipe —
"1 carrot", "2 celery stalks", "1 whole chicken"), not a violation, but
it's worth a conscious acknowledgment that the fallback ended up broader
in practice than the original note implied. No action needed unless it
becomes a real problem.

**Recipes (150 entries):** no duplicate ids or names, every recipe has
non-empty ingredients/steps/cuisines, `isSeed: true` and a valid
`createdAt` on all 150, `requiredAppliances` vocabulary is exactly 4
clean values (`oven`, `stovetop`, `grill-bbq`, `grill-broiler`) with no
casing/naming drift. No protein ingredient over 100g is ever marked
`optional` (spot-checked, zero hits). Yield range spans 194.5g
(Ramen Noodles with Boiled Egg, a single-serving soup) to 9656.4g
(Rappie Pie, an intentionally large multi-serving Canadian casserole) —
both trace back to their source recipe's actual stated quantities, not
errors.

One documented-but-worth-flagging convention drift: recipes from before
this window's batches (roughly the first ~75) put substitution/sourcing
detail in the recipe-level `note` field; recipes from batch 12 onward
(especially 16-18) moved that detail into each ingredient's own
`preparation` field instead — which is arguably more correct per the
schema's own doc comment ("Display-only preparation note") — and
narrowed `note` to mostly just alcohol-inclusion flags. 62 recipes carry
at least one substitution-flavored `preparation` note with no
recipe-level `note` summarizing it. This is intentional, not an
oversight, and per-ingredient is the right place for it — flagging only
so a future session doesn't "fix" it by back-filling 62 `note` fields
that don't need it.

Trivial cosmetic issue, not fixed: every Phase-2 recipe's `createdAt`
reads `2026-08-19T00:00:00.000Z`, one calendar day ahead of the actual
authoring date (2026-08-18) — inherited from a `NOW` constant set once
early on and reused verbatim in every batch script since. Doesn't affect
any logic (`createdAt` is informational only) and touching all 150
records to shave off one day isn't worth the diff noise. Worth using the
real date in future batches, nothing more.

**Cross-file consistency:** the working copy used for every batch this
session (`/tmp/kos/repo` in the cloud sandbox) is byte-identical to what
was committed to Jack's machine — confirmed by diff, not assumption.
`ROADMAP.md` was stale (still said "Phase 2 not started", last updated
2026-08-14) despite Phase 2 having been fully committed batch by batch
all session — it was never touched because the established per-batch
commit routine only ever pushed `ontology.json` / `recipes.json` /
`calorie-reference.json` / `DECISIONS.md`. Fixed as part of this review;
`ROADMAP.md` now reflects Phase 2 as done with real final numbers.
Lesson for future phases: the per-batch commit file list should include
`ROADMAP.md` whenever a phase actually completes, not just at the very
end.

**Instruction-following check:** 150/150 target hit exactly; British
finished at 8/150 (~5%), comfortably under the ~10% cap; alcohol
included per the standing decision, with `note` flags on every recipe
that uses it; git-push instructions were given in full at least once
per extended pause and only repeated in full at the very end (final
wrap-up), matching Jack's "don't repeat unless something changed"
instruction; project memory (`MEMORY.md` /
`phase2-recipe-seed-progress.md`) was kept current after every batch.
No files outside the intended Phase 2 scope
(`ontology.json`/`recipes.json`/`calorie-reference.json`/`DECISIONS.md`,
now also `ROADMAP.md` for this review) were touched — `schema.ts`,
`src/engine/`, and all UI/config files are untouched from Phase 0/1
state, ready for Phase 3.

**Open decisions for Jack before Phase 3** (none blocking — Phase 3 can
start regardless, these are just things worth a conscious yes/no rather
than a silent default):
1. `interchangeableWith` (produce format variants, e.g. whole vs. diced
   onion) is still fully deferred from Phase 0/1, as already documented
   in the Open Items section above — Phase 3's ownership-ranking logic
   needs a decision on whether it reads this field at all in v1, or
   whether ranking works purely off exact `canonicalId` match for now.
2. Whether to backfill `createdAt` on the 150 seed recipes to the
   correct date — recommended: no, not worth it.
3. Whether the substitution-heavy recipes (62 of them, see above) are
   fine as permanent seed data, or whether a few of the more aggressive
   substitutions (goat -> lamb-leg, veal -> beef-shin, sea bass ->
   red-snapper, arborio -> rice-white) should eventually get their own
   canonical entries instead. Recommended: leave as-is until it's
   actually annoying in practice — this is exactly the kind of premature
   precision CLAUDE.md's macro-tolerance gotcha warns against.

---

## 2026-08-19 — Phase 3: core engine built

`src/engine/` now exists: `units.ts`, `ontology.ts`, `inventory.ts`,
`macros.ts`, `ownership.ts`, plus an `index.ts` barrel. Zero React imports,
no clock and no randomness read internally — anything time-dependent
(`now`, `today`) is a parameter, which is what makes the engine
reproducible in tests. 183 engine unit tests plus 10 integration tests
against the real seed data; full suite 6220 passing, lint and build clean.

### Decisions confirmed with Jack before writing code

**1. Ownership matches on exact `canonicalId` only in v1.**
`interchangeableWith` is defined in the schema but populated on zero of
the 310 ontology entries, so reading it would be dead code. Substitution
awareness stays deferred (consistent with the Open Items entry above).
Mitigation against this being expensive later: every ownership lookup
routes through a single function, `availableGramsForLine` in
`ownership.ts`. Summing substitutes belongs in that one function and
nowhere else, so wiring it up later is a localised change rather than a
rewrite of the module.

**2. FEFO consumes null-expiry lots LAST.**
Confirms the presumption in the pre-Phase-3 review. Things that will
actually go bad get used before things that won't, which is the whole
point of FEFO being structural rather than optional. Full ordering is:
`expiresOn` ascending with nulls last, then `acquiredOn` ascending, then
lot `id`. The last key exists purely to make the ordering *total* — two
lots sharing both dates would otherwise deduct in whatever order the
database handed them back, making a passing test fail later for no
visible reason.

**3. Deduction takes what is available and reports the shortfall.**
Rejected: refusing the whole deduction (you could not then record a meal
you really cooked with slightly less butter than the recipe wanted), and
allowing `remainingG` to go negative (corrupts inventory state; the
Reconcile screen is the accepted mitigation for drift everywhere else).
`planDeduction` returns a plan and mutates nothing; `applyDeductions`
produces the new lots. That split is what lets Phase 7 show a deduction
preview before committing. `applyDeductions` clamps at zero, so a plan
built against a stale snapshot can under-deduct but never corrupt.

### Housekeeping done in the same pass

**TypeScript strict mode is now actually on.** CLAUDE.md has always
listed "TypeScript strict mode. No `any`" as a rule, but `strict` was set
in none of the tsconfigs — so it had never been enforced by the compiler.
Turning it on passes clean on all pre-existing code, so this cost
nothing today; it was only going to get more expensive once the engine
existed. Added to `tsconfig.app.json` and `tsconfig.qa.json`.

**`qa/seed-data.validate.test.ts` now imports the engine** instead of
keeping a private copy of the conversion math (`recomputeQuantityG` is
now a three-line wrapper around `toGrams`). Two motivations: two copies
drift, and a validator checking the data against rules the app does not
use passes while the app is wrong — the worst available failure mode.

That refactor also closed a real blind spot. The old copy handled
cup/tbsp/tsp only via `cupWeightG`, and **no liquid in the ontology
carries a `cupWeightG`** — so every tablespoon of oil, soy sauce or
stock returned null and was silently *skipped* rather than verified.
266 of 1562 ingredient lines (17%) had never been checked. The engine
converts those through density, and an unconvertible line is now a test
failure rather than a silent pass. Verified the check has teeth by
deleting a `unitWeightG` and confirming the suite goes red.

**10 ontology entries backfilled** with the one conversion field each
was missing, which is what made zero-skips achievable:
`unitWeightG` on `shrimp-peeled-deveined` (15), `squid` (300),
`steak-sirloin` (170), `basil` (0.5), `mint` (0.3), `cinnamon-ground`
(3), `cardamom-ground` (0.1), `sun-dried-tomatoes` (6.75); `cupWeightG`
on `potato-russet` (210) and `coconut-milk-canned` (225). Every value is
the one the Phase 2 build scripts had already used implicitly — several
recipes' `preparation` notes literally say so ("~0.5g/leaf estimated, no
ontology unitWeightG for basil"). No recipe's stored `quantityG`
changed; the diff is exactly 10 added lines.

### Engine design notes worth knowing later

**One volume path, not eleven.** `gramsPerMl()` in `units.ts` is the only
place volume becomes mass: density when `trackBy === 'volume'`,
otherwise `cupWeightG / CUP_ML`. Every volume unit routes through it, so
CLAUDE.md's "never density × volume for solids" rule is enforced in one
function instead of being repeated (and eventually mis-repeated) across
a per-unit switch. There is a test asserting a malformed solid carrying
a stray `densityGPerMl` still does NOT get the density path.

**Two different error philosophies, deliberately.** `units.ts` never
throws — it handles user and seed input, where an unconvertible value is
a normal thing to report to the UI, so it returns
`{ ok: false, reason, message }`. `inventory.ts` throws `RangeError` on a
negative gram request or an unknown lot id, because those are values the
app itself computed and a silent no-op would hide a real bug.

**`GRAM_EPSILON` (1e-6).** Floating-point subtraction leaves crumbs like
1e-13g behind; without a floor, a plainly-empty lot never gets marked
depleted. A microgram is far below anything this app can represent.

### Still open after Phase 3

- **Expiring-soon threshold.** DECISIONS.md still lists this as unset
  ("likely 3 and 7 day tiers"). `ownership.ts` uses a parameter with a
  default of 7 days rather than silently inventing a value —
  `DEFAULT_EXPIRING_SOON_DAYS`. Phase 6 should pick the real number when
  it designs the warning tiers.
- `interchangeableWith` (see decision 1) — deferred, with a single
  designated place to add it.
- The two `createdAt` / substitution-heavy-recipe items from the
  pre-Phase-3 review are unchanged; recommendation is still to leave both.

---

## 2026-08-19 — Expiring-soon threshold settled at 5 days

Supersedes the "expiry warning threshold in days — currently unset, likely
3 and 7 day tiers" line in the Open Items section above.

`DEFAULT_EXPIRING_SOON_DAYS` in `src/engine/ownership.ts` is now 5 (was a
placeholder 7). Jack's call. It remains a parameter on every function that
uses it, so a Phase 6 UI can still layer a shorter "urgent" band on top
(the original note's two-tier idea) without touching the engine — the
single default is what ranking's expiring-soon tie-break uses.

Note that this window governs the recipe-ranking tie-break. If Phase 4's
inventory expiry warnings want a different number, that is a separate
decision and should be recorded as one rather than assumed to match.

---

## 2026-08-19 — In-app ingredient creation; schema amended (LOCKED file changed)

**Resolves the open item from 2026-08-14** ("Phase 1 closed at 193 entries;
no way to grow the ontology post-launch") and the related Phase 4 note in
ROADMAP.md. Jack considered redeploy-only first and rejected it after
reviewing the trade-offs.

### Why redeploy-only was rejected

Worth recording, because the obvious argument for it turns out to be wrong.
Redeploy-only does NOT avoid the hard engine work: the bundled ontology is
copied into IndexedDB on first run and never re-read, so a redeploy still
needs merge logic to fold new entries in. What it avoids is only the form.
Against that: a missing canonical blocks the whole chain — no canonical
means no Product, which means no Lot — so an unknown ingredient makes it
impossible to record that item at all until a laptop, a push, a Pages
build and an iOS PWA cache refresh have all happened. That collides
directly with the "entry friction is the most common cause of abandonment"
risk recorded above.

Mitigating evidence that it would rarely bite (recorded because it may
matter again): 89 of 310 ontology entries are unused by any seed recipe,
spice coverage is 40/41, and the last three Phase 2 batches — 37 recipes
across six cuisines — needed zero new entries. The ontology has converged.
The decision went the other way on the cost of the bad case, not the
frequency of it.

### Decisions

1. **Add-only in v1.** The User can create a canonical ingredient but not
   edit one, seed or their own. This is what keeps the merge simple: if a
   seed entry can never carry User edits, a bundled update can always
   replace it safely. Editing is a separate feature with real merge
   complexity (a per-entry "modified" marker, or promoting an edited seed
   entry to User-owned) and the ±15% tolerance means correcting a rough
   `cupWeightG` rarely changes an answer. Revisit if it becomes annoying.
2. **The form lives inline in the add-product flow**, not only on a
   separate screen — "can't find it? add it", returning you to where you
   were. That is the moment the wall is hit, standing in the kitchen with
   the item in hand, and it is the only placement that meets the existing
   sub-20-second entry-friction target.
3. **On a merge conflict the User's entry wins** and the bundled one is
   skipped (logged, not silent). Their device holds the only copy of their
   data; an app update must never silently change conversion numbers that
   existing lots and cook events depend on.
4. **Nothing is ever deleted by a merge.** A seed entry that disappears
   from a later bundle is retained, because `Product.canonicalId` and
   `Lot.productId` would otherwise be orphaned for food the User still
   physically owns. A stale row costs nothing.

### Schema change — `CanonicalIngredient.isSeed`

`src/types/schema.ts` is marked LOCKED, so this is a deliberate amendment
rather than a silent edit. Added `isSeed: boolean`, the same field and
meaning `Recipe` already carries. Backfilled `true` on all 310 ontology
entries (diff is exactly 310 inserted lines, no values altered).

Required rather than optional, and matching `Recipe` rather than inventing
a new convention, because `undefined` quietly meaning "seed" is the kind of
thing that trips someone up two phases later. The alternative of encoding
it in an id prefix was rejected: a rule that lives in a string format
cannot be enforced by the compiler.

Without this field the merge has only two possible behaviours, and both are
wrong — clobber the User's entries, or never update anything.

`SCHEMA_VERSION` deliberately NOT incremented. It is still 1 because no
build has ever been deployed and no IndexedDB database exists anywhere, so
there is no stored data to migrate. The next change to this file after a
real deployment must bump it.

### Engine modules added (Phase 3 scope, form deferred to Phase 4)

- **`src/engine/ingredients.ts`** — `slugifyIngredientId` (seed-ontology id
  style, accent-stripping, so "Gruyère" -> "gruyere"),
  `generateIngredientId` (numeric suffix on collision — ids are foreign
  keys for every Product, so a silent collision would repoint real
  inventory), `validateIngredientDraft` and `createUserIngredient`.

  Validation returns errors and warnings SEPARATELY, each tagged with the
  form field to highlight. Errors are things that make the entry unusable
  (a counted ingredient with no `unitWeightG` can never convert to grams);
  warnings are things that work but lose a capability (a solid with no
  `cupWeightG` can never be measured in cups) and must not block saving.
  Notably, the "no density for solids" rule is enforced here at the point
  of entry, with a message explaining what to enter instead — rather than
  being left for the conversion code to trip over later.

- **`src/engine/seed-merge.ts`** — `needsSeedMerge` (guards on
  `AppMeta.seedVersion`; undefined means fresh install, so the merge also
  serves as first-run seeding) and `mergeSeedOntology`. Merge is pure,
  idempotent, produces no duplicate ids, mutates neither input, and returns
  the original objects where nothing changed. It also forces `isSeed: true`
  on incoming bundled entries whatever the file claims, so a hand-edited
  `ontology.json` cannot inject an entry that later merges then refuse to
  touch. Writing the result to IndexedDB and updating `seedVersion` is the
  caller's job in Phase 4.

68 new tests. Full suite 6289 passing, lint and build clean.

### Still open

- Editing existing ingredients (see decision 1) — deliberately deferred.
- Whether the standalone "manage ingredients" screen is worth building
  alongside the inline form. It is mostly useful once editing exists, so it
  is naturally the same decision.

---

## 2026-08-19 — Phase 4: persistence, export/import, app shell

The first three chunks of Phase 4. This is the phase where the app stops being
a library and starts holding data, so most of what follows is about failure
modes rather than features.

### Decisions confirmed with Jack before writing code

**1. Inventory expiry warnings use TWO bands: 2 days urgent, 5 days soon.**
This is the separate decision the 2026-08-19 expiring-soon entry above said
would be needed. `DEFAULT_EXPIRING_SOON_DAYS` (5) still governs the
recipe-ranking tie-break and is untouched; the inventory screen has its own
pair of numbers in `src/ui/inventory-view.ts` (`EXPIRY_URGENT_DAYS`,
`EXPIRY_SOON_DAYS`). "Soon" landing on the same 5 is a coincidence, not a
link — they are free to move apart. Rationale: the inventory list is where
you decide what to cook tonight, and one band cannot distinguish "eat this
today" from "plan around this".

Bands are `expired` / `urgent` / `soon` / `fine` / `none`. `none` (nothing to
expire) is deliberately distinct from `fine` (a real date, comfortably far
off), because a frozen chicken and a chicken with three weeks left are not
the same thing on screen.

**2. Dexie lives in `src/db/`, behind a repository layer.**
`src/db/db.ts` declares tables; `src/db/repo/*.ts` exposes named functions;
screens call those and never touch Dexie. CLAUDE.md was firm that UI does no
conversion or macro math but said nothing about data access. The reason for
the extra layer is narrow: browser storage is the only copy of this data, and
one reviewable list of every function that can write to it is worth more than
the lines it costs. Rejected `src/data/db/` — `src/data/` already means
bundled read-only JSON, and overloading it invites confusion between the
shipped ontology and the live database.

**3. Routing is react-router in HASH mode.**
Jack asked for the trade-offs explicitly before choosing. Hash routing
(`#/inventory`) makes the back gesture work and survives a reload without
GitHub Pages needing to know anything about the app's paths — no base-path
configuration and no `404.html` redirect trick, which is a moving part that
fails at deploy time rather than in development. Rejected no-router (back
gesture would exit the app; every reload lands on the home pane) and browser
routing (clean URLs, but the Pages redirect trick for no benefit on a
single-device PWA).

**4. Import REPLACES everything. It is not a merge.**
Merging two inventories that have both moved on has no correct answer — the
same lot half-used on both sides cannot be reconciled — and this is a restore
path, not a sync path. The confirmation says "replaces everything" in those
words, shows what the file contains, and offers to export the current data
first. That offer is not decoration: the one moment someone taps Restore
carelessly is the moment they are about to lose a month of entries.

**5. Recipes stay bundled and are NOT copied into IndexedDB in Phase 4.**
The table is created empty. Copying 150 recipes in now would require writing a
recipe merge before Phase 6 has decided what it needs, and recipes are seed
data that a redeploy can always reproduce. Backups therefore carry an empty
`recipes` list for now, which is honest rather than lossy.

### Schema change — `Lot.frozen`

`src/types/schema.ts` is marked LOCKED, so this is a deliberate amendment.
Added `frozen?: boolean` to `Lot`.

The problem it solves is recorded in Open Items above: `defaultShelfLifeDays`
is a fridge/fresh figure — raw chicken breast is 2 days — so without this flag
every frozen lot trips the expiry warning the moment it is added, and the
warning becomes noise you learn to ignore. When `frozen` is set the add-lot
form skips the shelf-life prefill and the lot carries no expiry unless one was
typed deliberately; a frozen lot the User DID date still warns normally.

Optional rather than required, unlike `CanonicalIngredient.isSeed`: absent
means "not frozen", which is the correct reading for any lot written before
the field existed, so there is no backfill and no ambiguity. Rejected a second
shelf-life field on the ontology — it would mean revisiting all 310 entries
for a precision the +/-15% tolerance does not need.

Timing was the deciding factor. Phase 4 creates the first real database, so
this was the last moment the change was free.

**`SCHEMA_VERSION` is still 1** — no build has been deployed and, at the time
of the change, no IndexedDB database existed. That reasoning has now expired:
running `npm run dev` creates the database. **The next change to `schema.ts`
after real data is entered needs a version bump AND a Dexie migration.**
`validateBackupFile` currently accepts only an exact `SCHEMA_VERSION` match
and refuses anything else with a plain-English message, which is where the
conversion logic belongs when that day comes.

### What was built

- **`src/db/`** — `db.ts` (nine tables; `meta` keeps its key outside the
  stored object so an `AppMeta` row is exactly an `AppMeta`), `ids.ts`,
  `repo/{meta,ingredients,products,lots,backup}.ts`, `seed.ts`.
- **`src/data/bundled.ts`** — `BUNDLED_ONTOLOGY` and `BUNDLED_SEED_VERSION`.
  The ontology is imported as a module and compiled into the build, never
  fetched (`resolveJsonModule` added to `tsconfig.app.json`).
- **`src/engine/backup.ts`** — building and checking a `BackupFile` is pure
  logic and belongs in the engine; only reading and writing rows is
  persistence. Errors block a restore, warnings do not, matching
  `ingredients.ts`. Cross-reference problems (a lot whose product is missing)
  are warnings: a slightly odd backup beats no backup.
- **`src/ui/`** — two-pane landscape shell, category list with live counts,
  inventory list, and a working backup screen. `src/lib/clock.ts` is the only
  place the clock is read; the engine convention of passing `now`/`today` in
  is unchanged.

Dependencies added: `dexie`, `dexie-react-hooks`, `react-router`, and
`fake-indexeddb` (tests only). Suite 6357 passing, lint and build clean.
Smoke-tested in a real browser: routing, first-run seeding of all 310
ingredients into IndexedDB, expiry banding, no console errors.

### Two failure modes worth naming

**Half-done writes are the whole risk.** The seed merge writes the ingredient
list and `AppMeta.seedVersion` in ONE transaction, and a restore clears and
rewrites in one. Either half alone is silent and permanent: a stored version
with no ingredients means `needsSeedMerge` returns false forever and those
entries never appear, with no error to notice; a cleared database with a
failed rewrite is simply gone. Both directions have tests that force the
failure and assert the rollback.

**`BUNDLED_SEED_VERSION` must be bumped by hand whenever `ontology.json`
changes.** Forget it and a redeployed ontology never reaches a device that
already ran an earlier build — silently. `src/db/seed.test.ts` pins the
ontology at 310 entries specifically so that growing it turns the suite red
and forces the bump.

### Still open after this pass

- Chunks 4-6: add product / add lot / inline add-ingredient, quantity
  adjustment and the Reconcile screen, and the backup reminder banner
  (DECISIONS.md commits to one after 7 days without an export;
  `AppMeta.lastExportAt` is being recorded, the banner is not built yet).
- Reconcile interaction detail is still unspecified in Open Items. Proposed
  but NOT agreed: one-tap Full / three-quarters / half / quarter / Empty
  against `initialG`, plus a typed amount, applied immediately with an undo.
- Ingredient editing remains deliberately out of v1. A cost comparison was
  done on 2026-08-19 and is recorded in the session notes: editing the User's
  OWN entries is small and merge-safe, because `mergeSeedOntology` already
  skips anything with `isSeed: false`. Editing SEED entries is the expensive
  one — the merge replaces any differing seed entry, so such an edit is
  destroyed silently by the next ontology redeploy. If it is ever wanted, the
  order is: own entries first; then promote-on-edit (flip `isSeed` to false)
  with a visible "this no longer receives app updates" note; and only then, if
  it still hurts, real conflict tracking. Nothing is lost by waiting, because
  the tracking field would be optional — unlike `Lot.frozen`, this was never
  a now-or-never decision.

---

## 2026-08-20 — Schema version 2 (cholesterol); add flows finished

### `MacroSet.cholesterolMg` — and the first real migration

Jack asked for cholesterol in the nutrition form, in US label position between
saturated fat and sodium. `MacroSet` had no field for it. This was flagged
rather than quietly worked around, because the entry above had just recorded
that a change to `schema.ts` now costs a version bump and a migration — the
database exists and has real data in it.

Added `cholesterolMg: number`, **required, not optional**. An optional macro
would have to be defended against in every sum, and the point of `MacroSet` is
that its fields all behave the same way.

**`SCHEMA_VERSION` is now 2.** Two conversions ship with it, and any future
change to `schema.ts` needs both:

1. **Stored rows** — `db.version(2).upgrade()` in `src/db/db.ts` backfills zero
   on every stored `MacroSet`. All three places one is kept are patched:
   `Product.macrosPer100g`, `CookEvent.batchMacros` and
   `ConsumptionEvent.macros`. The last two matter most. They are SNAPSHOTS that
   DECISIONS.md forbids recomputing from products, so a migration that skipped
   them would leave them broken permanently with nothing able to repair them.
2. **Backup files** — `validateBackupFile` no longer demands an exact version
   match. A version 1 file is upgraded through the same backfill and the
   conversion is reported as a warning, so it is never silent. A file from a
   NEWER app is still refused outright: this app cannot know what that version
   added, and guessing is how a restore destroys data without ever throwing.
   The upgrade steps are cumulative, so a version 1 file will pass 1 -> 2 -> 3
   when there is a 3.

Zero is the honest backfill. The figure was never asked for when those rows
were written; anything else would be invented data.

`src/db/migration.test.ts` builds a real version 1 database with Dexie — using
a copy of the version 1 store layout that is deliberately frozen and must not
be updated when `db.ts` changes — then opens it with current code and checks
what came out. Also covers opening twice, which must be a no-op.

### The inventory "Use up" list was wrong

`needsUsingUp` counted only `expired` and `urgent`, so an item three days from
its date was tagged "Use soon" in the list while the filter built to collect
exactly those items reported nothing. Found by Jack using it, on his own data.

Fixed: all three warning bands count. The bands say how loudly to warn, not
whether something is worth warning about. A count that disagrees with the
badges next to it teaches you to stop trusting the count.

### Add-product form, reshaped

- **Three bases: the package, a serving, or 100g.** All three appear on real
  packaging, and each now asks for exactly the one measurement it cannot work
  out. Per serving asks for **servings per package** rather than a package
  weight, because "about 4 servings" is what the label says and multiplying is
  the app's job.
- Number fields are text with a numeric keypad rather than `type="number"`.
  The stepper arrows are useless on a tablet and easy to nudge while scrolling.
- **Enter moves to the next field**, ending on the save button. It skips
  dropdowns on purpose: landing on one stops the typing dead, because the next
  keystroke goes nowhere.
- Heading is "Nutrition".

### Add-ingredient, inline (completes the 2026-08-19 decision)

`src/ui/AddFlow.tsx` gains a step between finding and describing. The button is
shown **always**, not only when a search finds nothing — something can exist
under a name you would not have guessed, and being told "no matches" and then
having to search again to be sure is worse than a button that is simply there.
It carries the search text across, and saving lands you on the product form for
what you just created, which is the "returns you to where you were" half of the
decision: creating the ingredient was never the goal.

Warnings are computed live while typing; errors appear only after a save is
attempted. They are different kinds of thing — a warning says what the entry
will not be able to do and must never block, while shouting an error at a
half-typed form is noise. Warnings raised at creation are carried forward and
shown on the product step rather than interrupting.

Every rule is the engine's. `src/ui/entry-forms.ts` only turns text into a
`CanonicalIngredientDraft`; the messages shown are `validateIngredientDraft`'s,
as written. One subtlety worth keeping: a measurement field that is blank
becomes `undefined`, but one holding text that is not a number becomes `NaN`,
because those are different answers. Treating a typo as "not provided" would
let a mistyped weight vanish instead of being pointed at.

Verified in a browser against the real ontology, where it immediately proved
the alias rule has teeth: "red pepper paste" was refused as an alias for a new
Gochujang entry because it already belongs to *Red pepper paste (biber
salcasi)*.

### Still open

- Chunk 5: quantity adjustment, the Reconcile screen, and the backup reminder
  banner after 7 days without an export.
- Reconcile interaction detail is still unspecified (Open Items). Proposed but
  NOT agreed: one-tap Full / three-quarters / half / quarter / Empty against
  `initialG`, plus a typed amount, applied immediately with an undo.
- Ingredient editing remains out of v1. See the 2026-08-19 entry.

---

## 2026-08-20 — The add sheet stopped listing every ingredient

Jack's observation, using it: the "Add to the kitchen" sheet listed canonical
ingredients under the Recent products, capped at 30 and sorted alphabetically,
so with an empty search box it showed an A-to-B slice of the ontology and
nothing else. It read as though that was the whole catalogue while showing 10%
of it.

Ingredients now appear only once something has been typed. With an empty box
the sheet shows recent products and the "can't find it? add it" button, and
nothing more.

The list was never the way in. Nobody scrolls 310 entries looking for food they
can already name, and the ranked search — which matches aliases, so "coriander"
finds cilantro — was doing the real work from the first keystroke. A list is the
answer to a question, not the starting position.

Recent products are untouched, and deliberately so: that IS a list worth showing
unprompted, because it is short, it is yours, and tapping one is the
sub-20-second repeat path the Product tier exists for.

---

## 2026-08-20 — Phase 4 chunk 5 is outstanding; a handoff exists

`PHASE5-HANDOFF.md` written at Jack's request. It records the state of the
codebase, the locked decisions Phase 5 must respect, the engine functions to use
rather than reimplement, and the questions that are genuinely open.

Recorded here because it names something that would otherwise go quiet: **Phase
4 chunk 5 — quantity adjustment, the Reconcile screen, and the backup reminder
banner — was never built.** Three entries in this file (quantity drift under
Known risks, the sealed/best-by shelf-life convention of 2026-08-14, and the
deduction clamping of 2026-08-19) each name the Reconcile screen as the accepted
mitigation for something they deliberately do not solve. Until it exists, those
three are pointing at nothing.

Not overridden here — flagged. Either chunk 5 gets built before Phase 5, or a
dated decision should say Reconcile is deferred and accept what that means.

---

## 2026-08-20 — Chunk 5: Reconcile, quantity adjustment, backup reminder. Phase 4 done.

Closes the gap flagged earlier today. Jack's call: build it before Phase 5
rather than defer it. The three entries that name the Reconcile screen as their
accepted mitigation now point at something real.

### Reconcile — the interaction, finally decided

Supersedes "Reconcile screen interaction detail" in Open Items, unspecified
since Phase 0.

**Five fractions: Full / ¾ / ½ / ¼ / Empty**, plus a typed exact amount. Three
was the original sketch; five went in because a nearly-full tub and a
half-empty one are genuinely different states and both are things a person can
judge at a glance. Anything finer than a quarter is beyond what anyone can
eyeball, which is what typing a number is for.

**Measured against `initialG`, not against what is left.** "About half a bag"
means half a bag regardless of what the app currently believes. The app's number
is the thing being corrected, so it cannot also be the thing being measured
against.

**Applied immediately, with Undo.** Confirming every correction would double the
cost of the one operation DECISIONS.md promises will be cheap. Undo restores the
whole previous lot record rather than recomputing it, because `depleted` and
`depletedAt` cannot be worked back out from an amount alone.

**It lives on the inventory row, not a separate pane.** Tapping any item opens
its packets. Correcting a quantity is the most frequent thing anyone does to a
stocked ingredient, and it happens when you notice — looking at the shelf, not
during a scheduled sweep. A dedicated Reconcile pane that walks everything was
considered and rejected as the wrong default; it can still be added later if the
spot-fix turns out not to be enough.

**Emptied packets are hidden behind a toggle.** They are kept forever
(DECISIONS.md), but a year of them would bury the two actually in the fridge.
One tap away, because the reason to want one back is having just marked the
wrong packet empty.

### Engine additions

`setLotRemaining(lot, grams, now)` and `gramsForFraction(lot, fraction)` in
`inventory.ts`. Both pure. `setLotRemaining` clamps at `initialG` — a lot cannot
come to hold more than it did when added, so "there is more than the app thinks"
is a second lot, not a bigger one, the same ceiling `revertDeductions` uses.
Reaching zero marks it depleted; going back up un-depletes it and clears
`depletedAt`, which is the undo path for marking the wrong packet empty.

`gramsForFraction` is one line of arithmetic that could have lived in the
component. It does not, so that CLAUDE.md's "components never do the maths" rule
stays literally true rather than nearly true.

### Backup reminder

`src/ui/backup-status.ts`, pure and tested. The banner appears after 7 days
without an export, and **also when there has never been one** — that is the most
dangerous state there is, and it would be perverse for the one case the banner
exists for to be the one it stays quiet about.

Dismissing hides it for that sitting only. It returns next launch, because the
risk does not go away by being acknowledged.

### Phase 4 is complete

Suite 6432 passing, lint and build clean. Verified in a real browser: two
packets reconciled by fraction, undone, emptied, un-emptied, and set by typed
amount, with the inventory list tracking every change.

### Known limitation, accepted

Reconcile cannot set a packet to more than it originally held. If the app says
448g and there is visibly more, the answer is a second lot. Recording this
because it is a deliberate consequence of `initialG` meaning "what was there
when added", not an oversight — revisit only if it turns out to bite.

---

## 2026-08-20 — Phase 5: nutrition UI. Seven decisions, no schema change.

Daily totals, browsing past days, and direct ingredient logging. Chunks 1-3 are
built; suite 6506 passing, lint and build clean, and the whole flow was driven in
a real browser (log from a packet, remove, undo, throw the packet out, log with
typed figures, page the days).

### Decisions confirmed with Jack before writing code

**Logging deducts stock.** Default on when there is stock, with a visible "take
it out of my kitchen" switch to turn it off, and automatically off when nothing
is on hand. Eating your cheese should reduce your cheese; food eaten elsewhere
should not.

**Macros come from the packet being deducted from.** One rule for both
questions, so with two cheddars in the fridge the answer is never arbitrary: the
figures belong to the food that actually moved. Nothing on hand falls back to
the most recently added product for that canonical. No product at all falls back
to a quick log, where the figures are typed for that entry only.

**A day is local midnight to local midnight**, matching expiry rather than
inventing a second convention. `consumedAt` stays a UTC instant, so a day is a
RANGE query between two computed timestamps — an evening meal is stored under
tomorrow's UTC date, and matching the first ten characters of the string would
silently lose it. `localDayRange` and `localDayOf` in `src/lib/clock.ts` do the
conversion, and the timezone is read there and nowhere else.

**Delete with Undo, no editing.** Fixing a mis-tap is a different thing from
rewriting history: withdrawing an entry and logging a new one leaves the
immutability rule literally true, where editing a stored snapshot in place would
not. Deleting puts the grams back. Undo restores the WHOLE original record —
same id, same timestamp, same figures — because a re-log would land on today.

**One packet, not several.** FEFO can span two packets but the schema's
ingredient arm holds a single optional `lotId`. Rather than bump the schema for
it, a log takes what the first-expiring packet has, records the full amount of
macros anyway — you ate what you ate — and says so on screen: "Only 30 g left in
that packet, so 50 g is logged and the packet is emptied." The difference is
quantity drift, which this file already accepts and which Reconcile fixes in one
tap.

**Nutrition is a second top-level area.** "Today" at the top of the rail, past
days on arrows inside the screen rather than as rail entries nobody navigates
by. (Superseded within a day — see the follow-ups below.)

**Lots can be deleted outright.** Jack, on seeing an expired packet he had
thrown away: "thrown out and not undone." This NARROWS "depleted lots are
retained" near the top of this file. That rule protects consumption HISTORY — a
lot you ate your way through is the evidence for what you ate. A packet that
went in the bin has no history in it, and leaving it in the emptied list forever
means the list stops being worth opening. Marking something empty stays a claim
that the food went into a person; binning it is a different claim. Any
`ConsumptionEvent` that debited a deleted lot keeps its macro snapshot untouched
and past totals do not move; what is lost is the inventory link, so deleting
such an entry afterwards puts nothing back. No Undo, deliberately — an app
offering to un-throw-away food would be pretending.

### No schema change was needed

Worth recording because it was the first thing checked. A quick-logged food
still has a canonical ingredient — it simply has no Product — and
`{ type: 'ingredient', canonicalId, grams }` already allows both `productId` and
`lotId` to be absent. So `SCHEMA_VERSION` stays 2: no Dexie migration, no
`upgradeBackup` step.

### Known inaccuracy, accepted

An entry whose deduction was clamped by a nearly-empty packet records the grams
EATEN, not the grams REMOVED, and there is no field for the difference. Deleting
such an entry can therefore hand back slightly more than it took, bounded by
`initialG`. The escape hatch, if it ever bites, is a schema v3 carrying a
`Deduction[]` on the ingredient arm — which Phase 7 wants anyway.

### The quick log asks for four figures, not nine

The product form asks for the whole label because a product is entered once and
reused forever. A quick log is one entry that will never be seen again, and the
other five figures are not displayed anywhere in v1, so asking for them would be
friction with no payoff. Stored as zero, the same honest backfill the cholesterol
migration used.

### Two things the browser caught that the tests did not

The log sheet had "Something else" twice — as a source option and as the back
button — and the Log button was not styled as the primary action, so the sheet
looked like it had no next step. Both are the same lesson as Phase 4: a green
suite says the arithmetic is right, not that the screen makes sense.

### Deferred to the next session — Jack's list of 2026-08-20

Recorded rather than built, at 90% of the usage limit. Full detail, including a
diagnosis of the first one, is in `PHASE5-FOLLOWUPS.md`.

1. **Count-tracked ingredients log the wrong weight.** `toGrams` uses the
   canonical's average `unitWeightG`, not the product's own package or serving
   size, so "1 tortilla" is the ontology's generic tortilla rather than the one
   in the fridge. The product knows better and is not being asked.
2. **Count-tracked ingredients should DISPLAY as counts** — "6 tortillas left",
   not "413 g". Same root cause: which weight is one of them?
3. **Meal slots** (breakfast / lunch / dinner / snack) on a logged entry. This
   one needs `SCHEMA_VERSION` 3, a Dexie `version(3)` upgrade and an
   `upgradeBackup` step. Flagged, not worked around.
4. **Editing a product** — serving size, calories — from the ingredient sheet.
   Note this does NOT conflict with "add-only, no editing" of 2026-08-19: that
   decision is about CANONICAL ingredients and seed-merge safety. Products are a
   different tier, and past days cannot move because their figures are snapshots.
5. **Rename "Today"** in the rail to something that reads as macro tracking.
6. **Rail order**: the nutrition section above "+ Add to the kitchen", and the
   add button next to the kitchen list it belongs to.

---

## 2026-08-21 — Jack's six follow-ups. Schema version 3.

Everything on the list of 2026-08-20 is built. `PHASE5-FOLLOWUPS.md` is deleted
with this entry — it was a holding note for one session, and leaving it beside
this file would be a second, staler account of the same decisions.

Suite 6555 passing, lint and build clean, and the whole lot driven in a real
browser (`qa/smoke-phase5.cjs`, now sixteen steps).

### The count bug, and what actually caused it

Jack logged one tortilla from a 413 g bag of six and the app charged him 45 g.
`toGrams` converted a count with `CanonicalIngredient.unitWeightG` and nothing
else — an average across every brand of the thing. The bag in the kitchen knew
better and was never asked.

**The product now answers the question when it can.** `gramsPerCount(ingredient,
product)` in `src/engine/units.ts` is the one place a count becomes mass, in the
same spirit as `gramsPerMl` for volume: package weight divided by pack count,
falling back to the ontology average when there is no product, and null when
nothing anywhere knows. `toGrams`, `fromGrams`, `canConvert` and
`convertibleUnits` all take an optional product now; leaving it out behaves
exactly as before, so the seed data and the recipe conversions are untouched.

**`Product.unitsPerPackage` is the new field**, asked for on the product form
only when the ingredient is counted. It is stored only alongside a package
weight — one without the other cannot say what a single item weighs, so storing
it alone would look like an answer while still leaving counts unconvertible.
That case warns rather than blocking, per the standing rule about warnings.

**The ordering bug behind the bug.** `validateLogDraft` converted the amount
BEFORE resolving which packet was being logged from. Even with the field in
place that would have kept using the average. Choice first, conversion second.

### Counts display as counts

"6 flour tortillas", not "413 g" — the weight moves to the quiet line
underneath, where it is available without being the thing you have to interpret
first. Counted per PACKET, each with its own product's weight, and summed: a bag
of six and a bag of ten are different sizes of the same thing, and adding their
counts is exact where picking one divisor for both would not be. One packet that
cannot say what one item weighs gives up the whole count — half an answer would
still read as a fact.

Pluralisation is three rules and no dictionary (`pluralize` in
`inventory-view.ts`), and the noun is the head of the ontology name: "Tortilla,
flour" gives "tortillas", because nobody says "six tortilla, flours". An
irregular noun will read a little wrong, once, on a screen that also states the
exact weight — a much smaller cost than an exceptions list nobody maintains.

### Meal slots — grouped, never guessed

`ConsumptionEvent.meal` is optional: breakfast, lunch, dinner, snack. The day
splits into sections with a subtotal on each, empty sections omitted.

**No default and no guess from the clock** (Jack). A 3pm plate is as likely to be
a late lunch as an early dinner, and a wrong default that has to be corrected
every time is worse than no answer. Tapping the chosen meal again clears it, so
"I would rather not say" stays reachable rather than being a trap.

**Unlabelled entries gather under "Other", last, and still count towards the
day.** Every entry logged before this existed is one of them. Optional rather
than required is what lets them stay honest — a required field would have meant
inventing a meal for every row already written, in the one table this file
promises never to rewrite.

### Editing a product is allowed. Editing an ingredient still is not.

Jack asked to correct a product from the ingredient sheet. This does NOT conflict
with "add-only, no editing" of 2026-08-19: **that rule is about CANONICAL
ingredients**, and its whole reasoning is seed-merge safety — a redeployed
`ontology.json` replaces a differing seed entry, so an edit there is destroyed
silently. Products are a different tier. The merge never touches them, and a
logged day cannot move when one changes, because `ConsumptionEvent.macros` was
snapshotted at log time. That is the property the immutability rule was built to
give, and this is the first thing to actually cash it in. There is a test for it
in `repo.test.ts` and a step for it in the browser run.

Two things the form says out loud, both about what editing does not do: the
figures shown are per 100 g whatever was originally typed off the label (the
basis is not stored, so claiming to know it would be a guess), and days already
logged keep the figures they were logged with.

`ProductFields` was extracted from `AddFlow.tsx` into `ProductForm.tsx` so the
add and edit forms cannot drift; `FormControls.tsx` and `form-behaviour.ts` came
out of the same file, because controls used by three sheets should not live
inside one of them.

### Schema version 3, one bump for two fields

`ConsumptionEvent.meal` and `Product.unitsPerPackage`, both optional, shipped
together with one `db.version(3)` upgrade and one `upgradeBackup` step. Two bumps
for two decisions taken on the same day would have been a self-inflicted wound.

**Nothing is backfilled.** Both migrations do exactly one thing — stamp the new
version on the metadata row. Absent is the truth about both fields on older
rows, and `migration.test.ts` now asserts it: opening a version 2 database must
leave `meal` absent rather than inventing "snack" to make the column look full.
The version 2 upgrade was also corrected to stamp the literal `2` rather than
today's `SCHEMA_VERSION`, so a device replaying 1 → 2 → 3 records each step
honestly.

The restore warning is now built per version (`upgradeNotes`). It used to say
every old file had its cholesterol filled in, which was true of the only upgrade
that existed and false the moment a second one did.

### The rail

"Today" became **"Food log"** (Jack's pick from four): the rail entry names the
area, and the screen's own heading already says which day you are looking at, so
having both say "Today" was one word doing two jobs. Nutrition now sits above
the kitchen, and "+ Add to the kitchen" moved down beside the kitchen list it
belongs to — it is the thing done once after a shop, not the app's main action.

---

## 2026-08-21 — Phase 6: the recipe library

Card grid, Missing One tier, filters, recipe detail, and the appliance
question. The manual add form is deliberately not here — see the end.

### Decisions confirmed with Jack before writing code

**1. Seed recipes are READ FROM THE BUNDLE. They are never copied into
IndexedDB.** `db.recipes` holds only recipes he types in; `combineRecipes` in
`src/engine/recipe-source.ts` joins the two, and a User recipe carrying a seed's
id shadows it rather than appearing twice.

This closes the question Phase 4 left open (2026-08-19, item 5). The deciding
argument was the trap named in the Phase 6 handoff. A restore replaces `meta`
wholesale, `seedVersion` included. Had the recipes been merged into the table
and then left out of backup files to keep them small, a restore would clear the
table AND write back a version the running app already matched — the startup
merge would conclude it was up to date and 150 recipes would silently never come
back. Reading them from the bundle removes that failure mode rather than
guarding against it.

Consequences, all good: no recipe merge to write, no second seed version, no
schema version 4, and backups carry exactly the recipes a redeploy cannot
reproduce. `BUNDLED_SEED_VERSION` goes on meaning the ontology alone, and there
is deliberately no `BUNDLED_RECIPE_VERSION` — a stamp exists so a merge knows
whether to run, and nothing merges these.

The cost, recorded so it is not a surprise: a seed recipe is a frozen object in
the bundle and a User recipe is a row, so a seed recipe cannot be EDITED in
place. The escape hatch is already in the join — save the edit as a User recipe
with the seed's id and it shadows the seed. That is copy-on-write in one line,
and v1 has no seed-recipe editing anyway.

**2. Nothing seeds the appliance table. He is asked, on Settings.**
An absent `Appliance` row means UNKNOWN, not "not owned", and a recipe needing
an unknown appliance says nothing. Rejected creating the four rows as `owned:
true` at startup: 57 of the 150 seed recipes need a hob, so guessing wrong in
that direction is a warning on a third of the library, and guessing right is
still a guess made on his behalf — the rule that has held since Phase 5.

The questions are DERIVED from the library (`applianceQuestions`), not
hard-coded, so a recipe typed in later that needs a pressure cooker adds its own
question. Today the seed set yields four: hob (57), oven (40), barbecue (1),
broiler (1).

The Backup screen is therefore now **Settings**, in the rail and in its heading.
Backup keeps the top of the screen and the reminder banner still points straight
at it, but the rail entry has to name a screen that does two things.

**3. The ring shows ownership and nothing else.**
One mark, one meaning. Max batch size, expiring stock and appliance warnings are
words on the card underneath. Rejected tinting expiring-soon into the same arc
(two variables in one mark get read as one) and capping the arc at
`maxBatchScale` (it conflates "missing an ingredient" with "short on one", which
DECISIONS.md separates on purpose).

**4. Browse first; the manual add form comes after he has used it.**
Chunks 1-4 are done. The form is chunk 5 and starts with a conversation, not
code — typing ten lines against a 310-entry ontology is a different
entry-friction problem from the add-product form, and he will have opinions
after using the browse side that neither of us has now.

### The Missing One tier LIFTS recipes out of the list

They do not also appear below. Lifting is the point: ranking is by fraction, so
a recipe needing 11 of its 12 ingredients sits below a three-ingredient one you
happen to have all of, and would never be seen otherwise. Sorting A-Z drops the
tier entirely — lifting a tier out of an alphabetical list breaks the one thing
an alphabetical list promises.

### Two things found while building this

**The DECISIONS.md max-batch example is unreachable as the engine was built.**
The Recipes section gives the example *"You have everything, but only enough for
a ½ batch"* and calls it "a 100% recipe you can't actually make". `owned` means
`availableG >= requiredG` at 1x, so if every counted line is owned then every
`maxScale` is at least 1 and `maxBatchScale` cannot be below it. The decision
itself is untouched and still useful — the mirror image is what happens in
practice, and is what the card now says: a recipe that is NOT fully owned can
still have some of everything, so `maxBatchScale` of 0.6 means a half batch is
genuinely on the table. Only the example was impossible.

**A recipe that lists the same ingredient twice is evaluated wrongly.**
`evaluateOwnership` checks each line independently against the total in the
kitchen, so Chakchouka — one red bell pepper on one line, one green on another —
reads as fully owned with a single pepper in the fridge, and `maxBatchScale`
says 1 when it is really ½. Six of the 150 seed recipes repeat an ingredient
(chakchouka, spanish-tortilla, beef-and-broccoli-stir-fry, pad-see-ew,
montreal-smoked-meat, rigatoni-fennel-sausage-sauce).

This is a Phase 3 engine bug, not a Phase 6 one, and it produces exactly the
surprise the max-batch decision exists to prevent: a 100% recipe you cannot
cook. **Left as found, flagged for Jack**, because it changes ownership numbers
and belongs to the engine rather than to this phase. The fix is contained: total
the requirement per `canonicalId` inside `evaluateOwnership` and compare each
line against that total, leaving `lines` one-per-recipe-line for display.

### What was built

1. **Recipes reach the app.** `BUNDLED_RECIPES` in `src/data/bundled.ts`,
   `combineRecipes` in the engine, `listUserRecipes` in the repository layer,
   and a `useRecipes` hook that joins them inside the query rather than on every
   render.
2. **The grid.** `src/ui/recipe-view.ts` (pure: the labels, the tiers, the
   cuisine list, the percentage) and `src/ui/RecipeScreen.tsx`. Cuisine filter,
   expiring-soon toggle, ownership/alphabetical sort. The rail carries the
   count of recipes needing nothing bought — unfiltered, because the rail
   describes the kitchen and not what the screen is currently showing.
3. **The detail view.** `src/ui/RecipeDetail.tsx` at `#/recipes/:recipeId`.
   Every line is listed, staples and garnishes included, because the list on
   screen has to be the recipe. No "made it" button: cooking is Phase 7.
4. **The appliance question.** `src/db/repo/appliances.ts` and a panel on
   Settings.

Suite **6620** passing, lint and build clean, and fifteen browser steps green in
`qa/smoke-phase6.cjs`. `qa/smoke-phase5.cjs` still passes unchanged.

### Bundle size

458 KB → 778 KB raw, 133 KB → 192 KB gzipped, now that `recipes.json` is
actually reachable from a rendered screen. Fine for an installed PWA and known
about in advance. Vite's 500 KB warning now fires; the answer when Phase 8
measures offline load is a dynamic import of the recipe bundle, which needs
`recipes.json` split out of `bundled.ts` into its own module. Not done now
because it buys nothing until there is a service worker.

---

## 2026-08-21, later — Repeated ingredients, and the kit list

Two pieces of work either side of the Phase 6 commit: the ownership bug flagged
in the entry above, now fixed, and the appliance question grown into a proper
kit list.

### 1. An ingredient on two lines is one ingredient

`evaluateOwnership` judged every recipe line on its own against the whole
kitchen. Six of the 150 seed recipes name the same ingredient twice —
Chakchouka's red and green bell peppers, Spanish tortilla's two pours of olive
oil, the sherry, soy and cornstarch in beef and broccoli, plus pad see ew,
Montreal smoked meat and the rigatoni — and for those, one pepper in the fridge
satisfied both pepper lines. The recipe read 100% and "ready" with half of what
it needs: the exact surprise the max-batch decision exists to prevent.

`pooledRequirements` now totals the requirement per `canonicalId` before any
line is judged, and every line carries both figures — `requiredG` (what the
recipe wrote on that line) and `requiredTotalG` (what the recipe needs
altogether). Ownership, low quantity and `maxScale` all measure against the
total.

Two consequences worth naming:

**The counts are now per distinct INGREDIENT, not per line.** Chakchouka needs
8 ingredients, not 9. "Percentage of required ingredients owned" was always the
wording in DECISIONS.md, and an ingredient written on two lines is one thing to
buy, one thing to be missing, and one thing to count. `missing` is deduplicated
too, so Missing One still works on a recipe that names its single missing
ingredient twice.

**Only counted lines are pooled.** An optional garnish of the same ingredient is
a bonus rather than part of the requirement, and untracked staples are not
measured at all — which is why Montreal smoked meat's two salt lines change
nothing.

The detail view says "119 g of 238 g needed in total" on those rows, because a
row reading "119 g of 119 g" while marked Missing is a bug report waiting to
happen.

### 2. The appliance question is now a kit list

Decisions taken with Jack before building:

**The catalogue is derived from the library, not from an idea of a complete
kitchen.** `src/engine/equipment.ts` holds ~50 canonical items with alias
patterns; `kitQuestions` asks only about what the recipes in front of him
actually mention, most needed first. The seed set yields 35 questions, led by
frying pan (62 recipes), stovetop (57), oven (40), pot (26), wok (20). Rejected
asking about everything a kitchen might have: forty-five questions is the kind
of chore that gets abandoned half-answered, and a half-answered list is
indistinguishable from an unanswered one.

The parser reads `Recipe.tools` free text — 208 of the 225 tool strings across
the seed set match something in the catalogue. The 17 that do not are "two
forks", "kitchen string", "cheesecloth" and friends, and they produce NO
requirement: an unrecognised string is the parser failing, not equipment
missing, and a warning invented out of one teaches him to ignore warnings.

`or` is a choice. "Wok or large frying pan" is satisfied by either, and stays
silent unless he has said no to both — an unanswered alternative counts as
"might have", because unknown is not a problem.

**Sizes are checked only when the recipe states one.** Rejected estimating the
volume a recipe needs from `estimatedYieldG` and comparing it with his biggest
pot: it would have fired on all 150 recipes and been wrong on plenty of them,
since finished weight is not volume, water boils off, and a roasting tin is not
judged by what it holds. Seven seed recipes state a size outright ("6 qt pot",
"12-inch skillet", "20cm non-stick frying pan", "10x14x2-inch baking pan"); six
of those are comparable and are checked. The seventh, a "1.5-litre gratin dish",
is dropped rather than converted through an invented depth — a baking dish is
measured across, and a litre figure cannot answer that question honestly.

He records the BIGGEST of each kind he owns, one number, in the unit that kind
is measured in — pots and casseroles in quarts, pans, tins and dishes in inches
(longest side or diameter). One number answers the only question a recipe asks,
which is whether the thing fits, and someone with a 6 qt pot does not also need
to record the 2 qt one. Half a unit of slack, because 20 cm is 7.87 inches and
pans are not machined parts.

**Asked once on first run, edited on Settings.** The same `KitList` component
serves both, so the two cannot drift. Every tap saves immediately: a pass
abandoned halfway keeps what was answered. "Not now" stamps nothing and asks
again next time — treating a dismissal as an answer would leave the app unable
to warn him about equipment while looking as though it had been set up.

**Known trade-off, flagged for Jack.** The pass opens over the app until it is
finished, so an existing database gets a modal in front of the food log on the
next launch. This broke `qa/smoke-phase5.cjs` until that run learned to dismiss
it, which is a fair preview of how it feels. If it grates, the switch is small:
render it as a banner beside the backup reminder rather than a sheet, and let
tapping the banner open the same list.

### Schema version 4

`Appliance.size` and `AppMeta.kitSetUpAt`, both optional, one bump for one
day's work — the version 3 precedent. `db.version(4)` stamps the version and
changes nothing else; `upgradeBackup` and `upgradeNotes` have their step;
`migration.test.ts` builds a real version 3 database and asserts what comes out.

Unlike versions 2 and 3, the absences here are READ by the app rather than
merely tolerated. No `size` means he has not said how big his is, so no size
warning can fire. No `kitSetUpAt` means he has never been asked, which is what
puts the questions on screen. Backfilling either would silence something he
never chose to silence — including after a restore, where an older file
correctly brings back "never asked".

The `Appliance` type keeps its name while holding colanders and baking trays. A
rename is a data migration bought for a nicer word, and `Recipe` already points
at these ids through `requiredAppliances`.

Suite **6663** passing, lint and build clean, seventeen browser steps green in
`qa/smoke-phase6.cjs`, and `qa/smoke-phase5.cjs` still passes.

---

## 2026-08-21, later still — Chunk 5: typing a recipe in. Phase 6 closed.

The last piece of Phase 6, and the one the handoff called the big unknown.

### Decisions confirmed with Jack before writing code

**1. His recipes are editable and deletable.** Canonical ingredients are
add-only; recipes are not. The add-only rule of 2026-08-19 exists to keep the
seed MERGE safe, and there is no recipe merge — seed recipes are read from the
bundle and never written to the table. A typo in a ten-line recipe with no way
to fix it would be its own argument.

Editing keeps the recipe's id, so its address survives and so will the
`CookEvent`s that point at it from Phase 7. `saveUserRecipe` is a `put` for
exactly that reason.

**2. No steps required.** A recipe you know by heart is a real recipe. Saving
without a method produces a warning, never an error — and the warning says why
it is harmless: ranking uses the ingredients.

**3. Cuisine is picked from the ones already in the library, plus Other.**
`OTHER_CUISINE` is offered alongside the 30 the seed set brought, so "Tuesday
dinner" has somewhere to go without inventing a tag that then sits alone in the
filter menu forever.

**4. Tools are free text.** The kit parser reads them, so a typed "large pot"
warns exactly as a bundled one does. Rejected picking from the kit catalogue:
it would be more exact and slower, and being slower is the thing that loses.

**5. Finished weight is asked for and optional.** Nothing reads it until
leftovers land in v2. Asking costs one field; asking later would mean revisiting
every recipe he had already typed.

**6. Pasting a list is in.** This is the decision that shaped the whole form.

### The paste path

Ten lines, each needing a canonical ingredient, a quantity and a unit, is thirty
interactions — DECISIONS.md's "entry friction" risk in its purest form. So the
sheet opens on a box to paste into, and typing it out by hand is one tap away
for a recipe that only exists in his head.

`parseIngredientLines` in `src/engine/recipe-entry.ts` reads the shapes recipes
are actually written in: "2 lb", "1½ cups", "1 1/2", "½", "2-3 cloves", "400g",
units written out in full and pluralised, preparation after a comma or inside
brackets, list bullets, and section headings ("For the sauce:") which are
dropped. A bare number with no unit is a COUNT — "3 eggs" — which is the
commonest line in any recipe.

Two rules worth naming:

**A range takes the top of it.** "2-3 cloves" needs three. A recipe you thought
you could cook is the failure worth avoiding.

**It gives up rather than guessing.** `matchIngredient` tries the exact name, an
exact alias, both again without plurals, and finally the longest ontology name
appearing inside what was written — which is what lands "boneless skinless
chicken thighs" on the right entry. Anything weaker returns null and the form
asks. A wrong match is silently wrong in the ownership figures for as long as
the recipe exists; a blank is visibly blank. Against a realistic paste it
matched 13 of 14 lines, and the one it refused was a bare "coriander", which is
genuinely ambiguous between the herb and the ground spice.

An unmatched row keeps the pasted text and shows it, so the error can say
*Nothing in the ingredient list matches "a handful of sumac"* rather than
pointing at row four.

### The rest of the form

`quantityG` is computed once at save time by `createUserRecipe`, exactly as the
seed importer did it, so a typed recipe and a bundled one are the same kind of
object by the time anything ranks them. A line whose unit cannot be converted
for its ingredient is an ERROR, not a dropped line: a recipe silently missing an
ingredient would rank as though it did not need it.

Unit menus are per ingredient (`convertibleUnits`), so cups are not offered for
something with no cup weight — offering a unit that cannot convert is offering
an error. Picking an ingredient keeps the unit the parser already read, when
that ingredient can be measured in it.

The "can't find it? add it" path is `IngredientStep` from `AddFlow.tsx` — the
component itself, not a copy. Hitting an unknown ingredient while typing a
recipe is the same moment that form was built for.

### The makeable filter

"Only what I can make now" joins the cuisine and expiring-soon filters. Opt-in
is not the same as hiding: DECISIONS.md forbids HIDING a recipe you lack the kit
for, and this is Jack asking for a shorter list. It counts kit as well as
ingredients — every ingredient present but no wok is not a recipe you can cook
tonight, and a filter that said otherwise would send him to the kitchen to find
out.

### Still deferred: `interchangeableWith`

Raised again and left alone, deliberately. It is populated on none of the 310
ontology entries, and the question it answers — which substitutions Jack
actually accepts — is one the app cannot invent and he cannot usefully answer in
the abstract. Phase 9's two-week live trial is what will produce the list, from
the recipes he wanted to cook and couldn't. Every ownership question still
routes through `availableGramsForLine`, so it stays a change to one function.

### Phase 6 is complete

Suite **6705** passing, lint and build clean, twenty-three browser steps green
in `qa/smoke-phase6.cjs`, and `qa/smoke-phase5.cjs` still passes. Bundle is
808 KB raw, 201 KB gzipped.
