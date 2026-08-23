/**
 * Phase 6 smoke test — the recipe library, in a real browser.
 *
 * Not part of `npm test`: it drives a running dev server with Playwright,
 * because the Phase 4 and Phase 5 experience was that a green unit suite still
 * misses things you only see by clicking. Run with `node qa/smoke-phase6.cjs`
 * while `npm run dev -- --port 5174` is up.
 *
 * The path it walks is the one that matters: an empty kitchen makes nothing, a
 * packet of olive oil puts Padron Peppers one ingredient away, and a bag of
 * peppers makes it cookable. Padron Peppers is the seed recipe with the fewest
 * counted ingredients (two), which is what makes it reachable in a smoke test.
 */
function loadPlaywright() {
  for (const candidate of [
    'playwright',
    '/home/claude/.npm-global/lib/node_modules/playwright/index.js',
  ]) {
    try {
      return require(candidate)
    } catch {
      continue
    }
  }
  throw new Error('Playwright is not installed. `npm i -g playwright` and try again.')
}

const playwright = loadPlaywright()

/*
 * Includes the trailing `/kitchen-os/`. Phase 8 set Vite's `base` to the
 * repository subpath GitHub Pages serves from, and deliberately left it set for
 * the dev server too, so that a scope or path mistake shows up here rather than
 * for the first time on the iPad.
 */
const BASE = process.env.BASE ?? 'http://localhost:5174/kitchen-os/'
const SHOTS = process.env.SHOTS ?? '/tmp/kitchen-os-shots-6'

async function main() {
  const fs = require('node:fs')
  const sandboxChromium = '/opt/pw-browsers/chromium'
  const browser = await playwright.chromium.launch(
    fs.existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {},
  )
  fs.mkdirSync(SHOTS, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } })
  const page = await context.newPage()

  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  const step = async (name, run) => {
    process.stdout.write(`• ${name}\n`)
    await run()
  }

  const expect = (actual, wanted, what) => {
    if (actual !== wanted) throw new Error(`${what}: got "${actual}", expected "${wanted}"`)
  }

  /** Add one packet through the real add flow, per-100g basis. */
  const addPacket = async ({ search, pick, name, grams, packCount, calories }) => {
    await page.click('text=+ Add to the kitchen')
    await page.fill('.search', search)
    await page.waitForSelector(`.pick-name:has-text("${pick}")`)
    await page.click(`.pick:has-text("${pick}")`)

    // Scoped to the sheet: the recipe screen's own filter selects are still in
    // the document behind it, and a bare `select` picks one of those.
    const sheet = page.locator('.sheet')
    await sheet.locator('input[placeholder="Kroger Boneless Chicken Breast"]').fill(name)
    await sheet.locator('select').first().selectOption('per100g')
    await sheet.locator('label:has-text("Package size") input').fill(String(grams))
    if (packCount !== undefined) {
      await sheet.locator('label:has-text("How many in a pack?") input').fill(String(packCount))
    }
    await sheet.locator('.macro-grid input').nth(0).fill(String(calories))
    await page.click('text=Save product')

    await page.waitForSelector('text=Add to the kitchen')
    await page.click('.actions button.primary')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })
  }

  const openRecipes = async () => {
    await page.click('.nav-link:has-text("Recipes")')
    await page.waitForSelector('.recipe-card')
  }

  const cardFor = (title) => page.locator(`.recipe-card:has-text("${title}")`).first()

  await step('the app asks what he cooks with, once', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.waitForSelector('.kit-list')

    const rows = await page.locator('.kit-row').count()
    if (rows < 20) throw new Error(`kit list offers ${rows} rows, expected the whole library's worth`)

    // Most needed first, and a size box only on the kinds where size decides
    // whether a recipe fits.
    const first = await page.locator('.kit-name').first().textContent()
    expect(first.trim(), 'Frying pan / skillet', 'first question')
    if ((await page.locator('.kit-size').count()) !== 0) {
      throw new Error('a size box appeared before anything was answered yes')
    }
    await page.screenshot({ path: `${SHOTS}/00-kit-setup.png` })
  })

  await step('answering yes to a pot asks how big it is', async () => {
    const potRow = page.locator('.kit-row:has-text("Pot")').first()
    await potRow.locator('.kit-choice:has-text("Yes")').click()
    await potRow.locator('.kit-size input').waitFor()
    await potRow.locator('.kit-size input').fill('3')

    const unit = await potRow.locator('.kit-size-unit').textContent()
    expect(unit.trim(), 'quarts', 'pot unit')

    // And no is no: the wok gets answered too, for the warning below.
    await page.locator('.kit-row:has-text("Wok")').first().locator('.kit-choice:has-text("No")').click()
    await page.waitForSelector('.kit-row:has-text("Wok") .kit-choice.is-chosen')
    await page.screenshot({ path: `${SHOTS}/00b-kit-answered.png` })

    await page.click('.actions button.primary')
    await page.waitForSelector('.kit-list', { state: 'detached', timeout: 10000 })
  })

  await step('and does not ask again once it has been told', async () => {
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.brand')
    if ((await page.locator('.sheet .kit-list').count()) !== 0) {
      throw new Error('the kit pass came back after being finished')
    }
  })

  await step('open the app and reach the recipes', async () => {
    await openRecipes()
    expect((await page.textContent('h1')).trim(), 'Recipes', 'heading')

    const count = await page.locator('.recipe-card').count()
    if (count !== 150) throw new Error(`grid shows ${count} cards, expected all 150`)
    await page.screenshot({ path: `${SHOTS}/01-empty-kitchen.png` })
  })

  await step('an empty kitchen makes nothing, and says so', async () => {
    const summary = await page.textContent('.screen-count')
    if (!summary.includes('Nothing you can make right now')) {
      throw new Error(`header reads "${summary}"`)
    }
    const badge = await page.textContent('.nav-link:has-text("Recipes") .count')
    expect(badge.trim(), '0', 'rail badge')

    // Nothing is one ingredient away either, so the tier is absent entirely
    // rather than sitting there empty.
    if ((await page.locator('.tier-head').count()) !== 0) {
      throw new Error('a tier heading appeared with an empty kitchen')
    }
  })

  await step('a bottle of olive oil puts Padron Peppers one thing away', async () => {
    await addPacket({
      search: 'olive oil',
      pick: 'Olive oil',
      name: 'Test Olive Oil',
      grams: 500,
      calories: 884,
    })
    await openRecipes()

    const tier = await page.textContent('.tier-head')
    expect(tier.trim(), 'One thing away', 'first tier heading')

    const card = page.locator('.tier').first().locator('.recipe-card:has-text("Padron Peppers")')
    if ((await card.count()) === 0) throw new Error('Padron Peppers is not in the tier')

    const note = await card.locator('.note-missing').textContent()
    expect(note.trim(), 'Missing Bell pepper', 'missing note')
    expect((await card.locator('.ring-label').textContent()).trim(), '50', 'ring reads')
    await page.screenshot({ path: `${SHOTS}/02-one-thing-away.png` })
  })

  await step('a bag of peppers makes it cookable', async () => {
    await addPacket({
      search: 'bell pepper',
      pick: 'Bell pepper',
      name: 'Test Bell Peppers',
      grams: 1190,
      packCount: 10,
      calories: 31,
    })
    await openRecipes()

    const card = cardFor('Padron Peppers')
    expect((await card.locator('.ring-label').textContent()).trim(), '100', 'ring reads')
    if ((await card.locator('.note-missing').count()) !== 0) {
      throw new Error('a cookable recipe still shows a missing note')
    }

    const classes = await card.getAttribute('class')
    if (!classes.includes('recipe-card-ready')) throw new Error('ready card is not marked ready')

    // 1190 g of peppers against 500 g a batch, and oil to spare: two batches.
    const batch = await card.locator('.note').first().textContent()
    expect(batch.trim(), 'Enough for 2 batches', 'batch note')

    const badge = await page.textContent('.nav-link:has-text("Recipes") .count')
    expect(badge.trim(), '1', 'rail badge')

    const summary = await page.textContent('.screen-count')
    if (!summary.includes('1 you can make now')) throw new Error(`header reads "${summary}"`)
    await page.screenshot({ path: `${SHOTS}/03-ready.png` })
  })

  await step('the ready recipe sorts to the top', async () => {
    const first = await page.locator('.recipe-card').first().textContent()
    if (!first.includes('Padron Peppers')) {
      throw new Error(`the list starts with "${first.slice(0, 40)}"`)
    }
  })

  await step('filtering by cuisine narrows the grid', async () => {
    await page.selectOption('.filter:has-text("Cuisine") select', 'Spanish')
    await page.waitForFunction(() => document.querySelectorAll('.recipe-card').length < 150)
    const count = await page.locator('.recipe-card').count()
    if (count === 0) throw new Error('Spanish filter emptied the grid')

    const names = await page.locator('.recipe-sub').allTextContents()
    if (!names.every((sub) => sub.startsWith('Spanish'))) {
      throw new Error('a non-Spanish recipe survived the filter')
    }
    await page.screenshot({ path: `${SHOTS}/04-cuisine-filter.png` })
    await page.selectOption('.filter:has-text("Cuisine") select', '')
    await page.waitForFunction(() => document.querySelectorAll('.recipe-card').length === 150)
  })

  await step('A–Z drops the tier and orders by name', async () => {
    await page.selectOption('.filter:has-text("Sort") select', 'alphabetical')
    await page.waitForFunction(() => document.querySelectorAll('.tier-head').length === 0)

    const names = await page.locator('.recipe-name').allTextContents()
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    if (names.join('|') !== sorted.join('|')) throw new Error('A–Z is not in order')
    await page.screenshot({ path: `${SHOTS}/05-alphabetical.png` })
    await page.selectOption('.filter:has-text("Sort") select', 'ownership')
  })

  await step('the expiring filter says so when nothing is going off', async () => {
    await page.click('.filter-toggle')
    await page.waitForSelector('.empty')
    const empty = await page.textContent('.empty')
    expect(empty.trim(), 'Nothing needs using up right now.', 'empty note')
    await page.screenshot({ path: `${SHOTS}/06-expiring-empty.png` })
    await page.click('.filter-toggle')
    await page.waitForSelector('.recipe-card')
  })

  await step('opening a card shows the whole recipe', async () => {
    await cardFor('Padron Peppers').click()
    await page.waitForSelector('.ings')
    expect((await page.textContent('h1')).trim(), 'Padron Peppers', 'detail heading')

    const stand = await page.textContent('.stand-headline')
    expect(stand.trim(), 'You have everything for this.', 'standing')

    // Every line is listed, staples included — the list on screen has to be
    // the recipe, not the shopping list.
    const rows = await page.locator('.ing').count()
    if (rows < 3) throw new Error(`ingredient list has ${rows} rows`)
    if ((await page.locator('.ing-staple').count()) === 0) {
      throw new Error('the salt line is not shown')
    }
    if ((await page.locator('.steps li').count()) === 0) throw new Error('no method shown')
    await page.screenshot({ path: `${SHOTS}/07-detail-ready.png` })
  })

  await step('a recipe you are short on says what is short', async () => {
    await page.goto(`${BASE}#/recipes/spaghetti-carbonara`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.ings')

    const missing = await page.locator('.ing-tag-missing').count()
    if (missing === 0) throw new Error('nothing is marked missing')

    const stock = await page.locator('.ing-stock').first().textContent()
    expect(stock.trim(), 'None in the kitchen', 'stock line')
    await page.screenshot({ path: `${SHOTS}/08-detail-missing.png` })
  })

  await step('a recipe needing the wok he has not got says so', async () => {
    await page.goto(`${BASE}#/recipes`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.recipe-card')

    // Sweet and Sour Pork asks for a wok flat out. Chicken Fried Rice would
    // NOT warn: it says "wok or large skillet", and a skillet he has not been
    // asked about might well be in the cupboard.
    const card = cardFor('Sweet and Sour Pork')
    if ((await card.count()) === 0) throw new Error('the recipe was hidden, not warned about')
    const warning = await card.locator('.note-warn').textContent()
    expect(warning.trim(), 'You have no wok', 'card kit warning')

    const orCard = cardFor('Chicken Fried Rice')
    if ((await orCard.locator('.note-warn').count()) !== 0) {
      throw new Error('warned about a wok on a recipe that offers a skillet instead')
    }
    await page.screenshot({ path: `${SHOTS}/10-kit-warning.png` })
  })

  await step('a recipe wanting a bigger pot than his says by how much', async () => {
    // Beef lo mein asks for a 6 qt pot. His biggest is the 3 qt he entered.
    await page.goto(`${BASE}#/recipes/beef-lo-mein`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.stand-notes')
    const notes = await page.textContent('.stand-notes')
    if (!notes.includes('Your biggest pot is 3 qt; this needs 6')) {
      throw new Error(`standing reads "${notes}"`)
    }
    await page.screenshot({ path: `${SHOTS}/11-too-small.png` })
  })

  await step('kit answers can be changed on Settings afterwards', async () => {
    await page.click('.nav-link:has-text("Settings")')
    await page.waitForSelector('.kit-list')

    const potRow = page.locator('.kit-row:has-text("Pot")').first()
    await potRow.locator('.kit-size input').fill('8')

    await page.goto(`${BASE}#/recipes/beef-lo-mein`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.stand-notes')
    if ((await page.textContent('.stand-notes')).includes('biggest pot')) {
      throw new Error('the size warning survived being given a bigger pot')
    }
  })

  await step('pasting an ingredient list fills the form in', async () => {
    await page.goto(`${BASE}#/recipes`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.recipe-card')
    await page.click('.filter-add')
    await page.waitForSelector('.paste-box')

    await page.fill(
      '.paste-box',
      [
        'For the pan:',
        '2 lb chicken thighs, cut into chunks',
        '1½ cups jasmine rice',
        '3 large eggs (whisked)',
        '2 tbsp soy sauce',
        'a handful of sumac',
      ].join('\n'),
    )
    await page.click('.sheet-foot button.primary')
    await page.waitForSelector('.lines')

    // Five rows: the heading is dropped, the unmatched one is kept to be fixed.
    const rows = await page.locator('.line').count()
    if (rows !== 5) throw new Error(`parsed into ${rows} rows, expected 5`)

    const unmatched = await page.locator('.line-unmatched').count()
    if (unmatched !== 1) throw new Error(`${unmatched} rows unmatched, expected just the sumac`)
    expect((await page.locator('.line-unmatched').textContent()).trim(), 'a handful of sumac', 'unmatched row')
    await page.screenshot({ path: `${SHOTS}/12-pasted.png` })
  })

  await step('the form refuses to save until the unmatched line is dealt with', async () => {
    await page.fill('.sheet .row input[type="text"]', 'Test Fried Rice')
    await page.selectOption('.sheet .row select', 'Chinese')
    await page.click('.sheet-foot button.primary')

    await page.waitForSelector('.line-error')
    const message = await page.textContent('.line-error')
    if (!message.includes('sumac')) throw new Error(`error reads "${message}"`)

    // Removing it is one tap.
    await page.locator('.line:has(.line-unmatched) .line-remove').click()
    await page.waitForFunction(() => document.querySelectorAll('.line').length === 4)
    await page.screenshot({ path: `${SHOTS}/13-line-error.png` })
  })

  await step('saving puts it in the library, marked as yours', async () => {
    await page.click('.sheet-foot button.primary')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })

    await page.waitForSelector('.recipe-card:has-text("Test Fried Rice")')
    const card = cardFor('Test Fried Rice')
    const sub = await card.locator('.recipe-sub').textContent()
    if (!sub.includes('yours')) throw new Error(`card reads "${sub}"`)
    if (!sub.includes('4 ingredients')) throw new Error(`card reads "${sub}"`)

    const count = await page.locator('.recipe-card').count()
    if (count !== 151) throw new Error(`library shows ${count}, expected 151`)
    await page.screenshot({ path: `${SHOTS}/14-saved.png` })
  })

  await step('the grams were worked out from the units typed', async () => {
    await cardFor('Test Fried Rice').click()
    await page.waitForSelector('.ings')

    const amounts = await page.locator('.ing-amount').allTextContents()
    expect(amounts[0].trim(), '2 lb', 'first amount')
    expect(amounts[1].trim(), '1½ cup', 'second amount')
    // Three eggs at the ontology's average weight, not 3 g.
    const stock = await page.locator('.ing').nth(2).locator('.ing-stock').textContent()
    expect(stock.trim(), 'None in the kitchen', 'egg stock line')
  })

  await step('editing it keeps its address and its place', async () => {
    await page.click('.own-recipe button:has-text("Edit")')
    await page.waitForSelector('.lines')

    const name = page.locator('.sheet .row input[type="text"]').first()
    await name.fill('Test Fried Rice v2')
    await page.click('.sheet-foot button.primary')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })

    await page.waitForSelector('h1:has-text("Test Fried Rice v2")')
    if (!page.url().includes('/recipes/test-fried-rice')) {
      throw new Error(`the address moved to ${page.url()}`)
    }
  })

  await step('deleting it asks first, then removes it', async () => {
    await page.click('.own-recipe button:has-text("Delete")')
    await page.waitForSelector('.panel-warn')
    await page.click('.panel-warn button:has-text("Keep it")')
    if ((await page.locator('.panel-warn').count()) !== 0) throw new Error('Keep it did not close it')

    await page.click('.own-recipe button:has-text("Delete")')
    await page.click('.panel-warn button:has-text("Yes, delete it")')
    await page.waitForSelector('.recipe-card')

    const count = await page.locator('.recipe-card').count()
    if (count !== 150) throw new Error(`library shows ${count} after deleting, expected 150`)
  })

  await step('the makeable filter shows only what needs nothing bought', async () => {
    await page.click('.filter-toggle:has-text("Only what I can make now")')
    await page.waitForFunction(() => document.querySelectorAll('.recipe-card').length < 150)

    const rings = await page.locator('.ring-label').allTextContents()
    if (!rings.every((ring) => ring.trim() === '100')) {
      throw new Error('the makeable filter kept a recipe that is not fully owned')
    }
    await page.screenshot({ path: `${SHOTS}/15-makeable.png` })
    await page.click('.filter-toggle:has-text("Only what I can make now")')
    await page.waitForFunction(() => document.querySelectorAll('.recipe-card').length === 150)
  })

  await step('an unknown recipe id says so instead of breaking', async () => {
    await page.goto(`${BASE}#/recipes/not-a-recipe`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1')
    expect((await page.textContent('h1')).trim(), 'Recipe not found', 'unknown id')
  })

  await step('a reload lands back on the recipes', async () => {
    await page.goto(`${BASE}#/recipes`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.recipe-card')
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.recipe-card')
    expect((await page.textContent('h1')).trim(), 'Recipes', 'heading after reload')
  })

  if (problems.length > 0) {
    throw new Error(`browser reported problems:\n  ${problems.join('\n  ')}`)
  }

  await context.close()
  await browser.close()
  process.stdout.write(`\nAll steps passed. Screenshots in ${SHOTS}\n`)
}

main().catch((error) => {
  process.stderr.write(`\nSMOKE FAILED: ${error.message}\n`)
  process.exit(1)
})
