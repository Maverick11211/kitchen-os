# tools/reference-macros

Where `CanonicalIngredient.referenceMacrosPer100g` comes from.

Nothing here ships. It is run by hand, it writes into `src/data/ontology.json`,
and the app never imports it — same arrangement as `qa/`, and for the same
reason: build-time tooling and shipped code should not be able to drift into
each other.

## What the reference figures are for

Kitchen OS was built on the rule that only a `Product` carries macros, because a
Product is a real thing with a real label on it. That rule holds for branded
groceries and breaks in the produce aisle. A loose sweet potato has no
packaging, so there is no label to read, and adding one meant searching the
internet for nine numbers before the app would take it.

So 122 of the 310 ontology entries now carry a generic figure, used **only where
no Product exists**. The rule for which ones is Jack's, and it is about
packaging rather than nutrition: *does this arrive with a label on it?* Loose
carrots yes, a bag of baby carrots no. Milk, eggs and a supermarket tray of
chicken all have labels, so they are out; a fish counter, a butcher counter, a
deli slicer and a bulk bin all hand you food in paper, so they are in.

See `DECISIONS.md`, 2026-08-23, for the full reasoning and the three conditions
that keep this from undoing what the original rule protected.

## Source

USDA National Nutrient Database for **Standard Reference, Release 28** — the
`ABBREV.txt` flat file. Public-domain US government data.

Figures are **as purchased and uncooked**: raw for produce, meat and fish, dry
for grains and pulses. That is what gets weighed into the kitchen, and it is the
one convention that has to hold across the whole table. Dry rice is 365 kcal per
100g against about 130 cooked, so mixing the two would be a silent 3x error.

## The files

| File | What it is |
|---|---|
| `mapping.json` | The auditable table. One entry per ingredient: the USDA NDB number, that row's description, the nine extracted figures, and a note wherever the match is approximate. **This is the source of truth.** |
| `apply.cjs` | Copies `mapping.json` into `src/data/ontology.json`. Idempotent. `--check` reports drift without writing and exits non-zero. |

Every figure the app shows can be traced to a public row: look up the `ndb` on
USDA's site and compare. That chain is the point, and it is why the figures are
maintained here rather than edited into `ontology.json` by hand.

## Changing something

1. Edit `mapping.json` — the NDB number, and the figures to match that row.
2. `node tools/reference-macros/apply.cjs`
3. **Bump `BUNDLED_SEED_VERSION` in `src/data/bundled.ts`.** Not optional. It is
   what tells the seed merge there is new ontology data to fold into a database
   that already exists. Without it the change ships and reaches nobody.
4. `npm test` — `qa/seed-data.validate.test.ts` checks the mapping and the
   ontology still agree, that no row is internally impossible, and that the
   calories follow from the macros beside them.

## Approximations, on purpose

Some entries have no exact SR28 row. Each carries a `note` in `mapping.json`
saying so; the significant ones:

- **Jasmine and basmati rice** → long-grain white. Same grain, and SR does not
  separate them.
- **Farro** → spelt, its nearest relative in the database.
- **Steel-cut oats** → the same oat entry as rolled. SR does not distinguish
  the cut, and cutting does not change the nutrition.
- **Ground turkey** → whole turkey, meat and skin. SR28 has no ground turkey.
- **Bell pepper** → red. SR lists colours separately (green is 20 kcal, red 31)
  and the ontology has one entry for all of them.
- **Boneless pork chop** → the bone-in row, which is lean *and fat*. The only
  boneless raw rows are lean-only and describe a trimmed chop rather than a real
  one. Figures are per 100g of meat, so the bone does not enter into it.

## Two things to be careful about

**The refuse problem.** SR figures are per 100g of *edible* portion. The
ontology's `unitWeightG` values were checked against USDA's own portion weights
and are edible weights too, so the two agree — a medium banana is 118g of banana
in both. Two entries are worth knowing about anyway: `corn-on-the-cob` has 64%
refuse, so its 192g unit weight is a whole ear while the figures are per 100g of
kernels; and `mussels` are sold in the shell. Log those by weight of what you
actually eat.

**`qa/calorie-reference.json` must stay independent.** It was built by hand in
Phase 2 from general knowledge, and the validation test compares it against
these figures as a second opinion. Regenerating it from USDA would make it agree
by construction and the check would stop checking anything. Four entries
disagree on purpose — the QA table used cooked figures for some meats — and the
exemptions are listed in the test with their reasons.
