/**
 * Kitchen OS — write reference macros into the bundled ontology
 *
 *     node tools/reference-macros/apply.cjs [--check]
 *
 * Reads `mapping.json` beside this file and copies each entry's
 * `macrosPer100g` onto the matching `CanonicalIngredient` in
 * `src/data/ontology.json` as `referenceMacrosPer100g`.
 *
 * `--check` reports what WOULD change and exits non-zero if anything would,
 * without writing. That is what to run if you want to know whether the two
 * files have drifted apart.
 *
 * Idempotent: running it twice changes nothing the second time.
 *
 * WHY A SCRIPT RATHER THAN AN EDIT BY HAND
 *
 * `mapping.json` is the auditable artifact — every figure in it carries the
 * USDA NDB number it came from, so any number the app shows can be traced back
 * to a row in a public database. Hand-editing `ontology.json` would break that
 * chain the first time somebody adjusted a value in the wrong file.
 *
 * REMEMBER TO BUMP THE SEED VERSION
 *
 * `BUNDLED_SEED_VERSION` in `src/data/bundled.ts` is what tells an existing
 * database to fold new ontology data in. Change the ontology without bumping
 * it and the new figures ship but never reach anybody who already has the app
 * open. This script prints a reminder.
 */
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname
const ROOT = path.join(HERE, '..', '..')
const MAPPING = path.join(HERE, 'mapping.json')
const ONTOLOGY = path.join(ROOT, 'src', 'data', 'ontology.json')

const checkOnly = process.argv.includes('--check')

const mapping = JSON.parse(fs.readFileSync(MAPPING, 'utf8'))
const ontology = JSON.parse(fs.readFileSync(ONTOLOGY, 'utf8'))
const byId = new Map(ontology.map((entry) => [entry.id, entry]))

const unknown = Object.keys(mapping).filter((id) => !byId.has(id))
if (unknown.length > 0) {
  console.error(`mapping.json names ${String(unknown.length)} ids that are not in the ontology:`)
  for (const id of unknown) console.error(`  ${id}`)
  process.exit(1)
}

let added = 0
let changed = 0
let same = 0

for (const [id, entry] of Object.entries(mapping)) {
  const target = byId.get(id)
  const next = entry.macrosPer100g
  const current = target.referenceMacrosPer100g

  if (current === undefined) {
    added++
  } else if (JSON.stringify(current) !== JSON.stringify(next)) {
    changed++
    console.log(`  changed ${id}`)
  } else {
    same++
    continue
  }

  target.referenceMacrosPer100g = next
}

// An entry that used to have a reference and no longer appears in the mapping
// has been deliberately taken out of scope, so the field goes with it.
let removed = 0
for (const entry of ontology) {
  if (entry.referenceMacrosPer100g !== undefined && !(entry.id in mapping)) {
    delete entry.referenceMacrosPer100g
    removed++
    console.log(`  removed ${entry.id}`)
  }
}

const dirty = added + changed + removed > 0

console.log(
  `${String(added)} added, ${String(changed)} changed, ${String(removed)} removed, ${String(same)} already current` +
    ` — ${String(Object.keys(mapping).length)} of ${String(ontology.length)} ontology entries have a reference`,
)

if (checkOnly) {
  if (dirty) {
    console.error('ontology.json is out of date. Run without --check to update it.')
    process.exit(1)
  }
  console.log('ontology.json is up to date.')
  process.exit(0)
}

if (!dirty) process.exit(0)

// Two-space JSON with a trailing newline, matching how the file already reads.
fs.writeFileSync(ONTOLOGY, `${JSON.stringify(ontology, null, 2)}\n`, 'utf8')
console.log('\nWrote src/data/ontology.json.')
console.log('NOW BUMP BUNDLED_SEED_VERSION in src/data/bundled.ts, or this never reaches an existing database.')
