/**
 * Phase 5 smoke test — the log flow, in a real browser.
 *
 * Not part of `npm test`: this drives a running dev server with Playwright,
 * because two Phase 4 bugs got through a green unit suite and were only found
 * by clicking. Run with `node qa/smoke-phase5.cjs` while `npm run dev` is up.
 */
/**
 * Playwright is not a dependency of this project — it is a tool for running
 * this one script, so it is resolved wherever it happens to live rather than
 * being added to package.json for something `npm test` never touches.
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
const SHOTS = process.env.SHOTS ?? '/tmp/kitchen-os-shots'

async function main() {
  const fs = require('node:fs')
  // The sandbox keeps its browser somewhere Playwright does not look by default.
  const sandboxChromium = '/opt/pw-browsers/chromium'
  const browser = await playwright.chromium.launch(
    fs.existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {},
  )
  fs.mkdirSync(SHOTS, { recursive: true })
  // Landscape iPad-ish, which is the only viewport this app is for.
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

  await step('open the app', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.waitForSelector('.brand', { timeout: 20000 })

    // Phase 6 added a one-off "what do you cook with" pass that opens over a
    // database which has never answered it. Dismissing it is what a person
    // would do to get on with logging lunch, so this run does the same.
    const kitPass = page.locator('.sheet:has(.kit-list)')
    if ((await kitPass.count()) > 0) {
      await kitPass.locator('.sheet-head button').click()
      await kitPass.waitFor({ state: 'detached', timeout: 10000 })
    }
    await page.waitForSelector('h1', { timeout: 20000 })
    const heading = await page.textContent('h1')
    if (heading.trim() !== 'Today') throw new Error(`landed on "${heading}", expected Today`)
    await page.screenshot({ path: `${SHOTS}/01-today-empty.png` })
  })

  await step('add a packet of cheddar', async () => {
    await page.click('text=+ Add to the kitchen')
    await page.fill('.search', 'cheddar')
    await page.waitForSelector('.pick-name')
    await page.click('.pick-list .pick')

    await page.fill('input[placeholder="Kroger Boneless Chicken Breast"]', 'Test Cheddar')
    await page.selectOption('select', 'per100g')
    // Per-100g basis: package size, then the label figures.
    const numbers = page.locator('.row input[inputmode="decimal"]')
    await numbers.first().fill('200')
    const macros = page.locator('.macro-grid input')
    await macros.nth(0).fill('400') // calories
    await macros.nth(1).fill('33') // fat
    await macros.nth(5).fill('1.3') // carbs
    await macros.nth(8).fill('25') // protein
    await page.click('text=Save product')

    await page.waitForSelector('text=Add to the kitchen')
    await page.screenshot({ path: `${SHOTS}/02-lot-step.png` })
    await page.click('.actions button.primary')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })
  })

  await step('log 50 g of it', async () => {
    await page.click('.nav-link:has-text("Food log")')
    await page.click('text=+ Log something eaten')
    await page.waitForSelector('.pick-name:has-text("Cheddar")')
    await page.click('.pick-list .pick')

    await page.waitForSelector('.sheet-context')
    await page.locator('.row').first().locator('input').first().fill('50')
    await page.screenshot({ path: `${SHOTS}/03-log-amount.png` })

    const button = await page.textContent('button[type="submit"]')
    if (!button.includes('200')) throw new Error(`expected a 200 cal preview, got "${button}"`)
    await page.click('button[type="submit"]')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })
  })

  await step('the day shows it', async () => {
    await page.waitForSelector('.entry')
    const totals = await page.locator('.total-value').allTextContents()
    if (totals[0] !== '200') throw new Error(`calories read "${totals[0]}", expected 200`)
    if (totals[3] !== '12.5g') throw new Error(`protein read "${totals[3]}", expected 12.5g`)
    const detail = await page.textContent('.entry-detail')
    if (detail.trim() !== '50 g') throw new Error(`entry reads "${detail}"`)
    await page.screenshot({ path: `${SHOTS}/04-day-with-entry.png` })
  })

  await step('the packet went down by 50 g', async () => {
    await page.click('.nav-link:has-text("Everything")')
    await page.waitForSelector('.item-amount')
    const amount = await page.textContent('.item-amount')
    if (amount.trim() !== '150 g') throw new Error(`inventory reads "${amount}", expected 150 g`)
  })

  await step('remove the entry and undo it', async () => {
    await page.click('.nav-link:has-text("Food log")')
    await page.waitForSelector('.entry')
    await page.click('.entry-remove')
    await page.waitForSelector('.undo')
    if ((await page.locator('.entry').count()) !== 0) throw new Error('entry survived removal')
    const afterRemove = await page.locator('.total-value').first().textContent()
    if (afterRemove !== '0') throw new Error(`totals read "${afterRemove}" after removal`)

    await page.click('.undo button')
    await page.waitForSelector('.entry')
    const back = await page.locator('.total-value').first().textContent()
    if (back !== '200') throw new Error(`totals read "${back}" after undo`)
    await page.screenshot({ path: `${SHOTS}/05-undo.png` })
  })

  await step('throw the packet out', async () => {
    await page.click('.nav-link:has-text("Everything")')
    await page.click('.items button.item')
    await page.waitForSelector('.lot')
    await page.click('text=Throw out')
    await page.waitForSelector('.lot-confirm')
    await page.screenshot({ path: `${SHOTS}/06-confirm-bin.png` })
    await page.click('text=Yes, it is gone')
    await page.waitForSelector('.lot', { state: 'detached', timeout: 10000 })
    await page.click('.sheet-head button')
    // The ingredient leaves the inventory list with its last packet.
    await page.waitForSelector('.items button.item', { state: 'detached', timeout: 10000 })
  })

  await step('the meal is still on the day', async () => {
    await page.click('.nav-link:has-text("Food log")')
    await page.waitForSelector('.entry')
    const totals = await page.locator('.total-value').allTextContents()
    if (totals[0] !== '200') throw new Error(`history moved: calories now "${totals[0]}"`)
    await page.screenshot({ path: `${SHOTS}/07-history-survives.png` })
  })

  await step('log something with typed figures instead', async () => {
    await page.click('text=+ Log something eaten')
    await page.waitForSelector('.search')
    await page.fill('.search', 'cheddar')
    await page.waitForSelector('.pick-name')
    await page.click('.pick-list .pick')
    await page.waitForSelector('.sheet-context')

    // The product survives its last packet, so this opens on "figures only".
    await page.locator('.row').first().locator('input').first().fill('30')
    await page.click('.pick:has-text("Something else")')

    // Now the four typed fields are on screen: calories is the first of them.
    await page.locator('.row').nth(1).locator('input').first().fill('100')
    const button = await page.textContent('button[type="submit"]')
    if (!button.includes('100')) throw new Error(`typed figures ignored: "${button}"`)
    await page.click('button[type="submit"]')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })

    const totals = await page.locator('.total-value').allTextContents()
    if (totals[0] !== '300') throw new Error(`calories read "${totals[0]}", expected 300`)
    await page.screenshot({ path: `${SHOTS}/08-quick-log.png` })
  })


  await step('add a bag of six tortillas', async () => {
    await page.click('text=+ Add to the kitchen')
    await page.fill('.search', 'tortilla')
    await page.waitForSelector('.pick-name:has-text("Flour tortilla")')
    await page.click('.pick:has-text("Flour tortilla")')

    await page.fill('input[placeholder="Kroger Boneless Chicken Breast"]', 'Test Tortillas')
    await page.selectOption('select', 'per100g')
    await page.locator('label:has-text("Package size") input').fill('413')
    // The field that fixes the bug: six in the bag, so one is 68.8 g and not
    // the ontology's 45 g average.
    await page.locator('label:has-text("How many in a pack?") input').fill('6')
    const macros = page.locator('.macro-grid input')
    await macros.nth(0).fill('300') // calories
    await page.screenshot({ path: `${SHOTS}/09-pack-count.png` })
    await page.click('text=Save product')

    await page.waitForSelector('text=Add to the kitchen')
    await page.click('.actions button.primary')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })
  })

  await step('the shelf says six tortillas, not 413 g', async () => {
    await page.click('.nav-link:has-text("Everything")')
    await page.waitForSelector('.item-amount')
    const amount = await page.textContent('.item-amount')
    // "Flour tortilla" is the ontology's name, so the plural keeps the whole
    // head noun. "6 flour tortillas" is what a person would say too.
    if (amount.trim() !== '6 flour tortillas') {
      throw new Error(`inventory reads "${amount}", expected "6 flour tortillas"`)
    }
    await page.screenshot({ path: `${SHOTS}/10-counted-shelf.png` })
  })

  await step('log one tortilla, as lunch', async () => {
    await page.click('.nav-link:has-text("Food log")')
    await page.click('text=+ Log something eaten')
    await page.fill('.search', 'tortilla')
    await page.waitForSelector('.pick-name:has-text("Flour tortilla")')
    await page.click('.pick:has-text("Flour tortilla")')
    await page.waitForSelector('.sheet-context')

    const unit = await page.locator('select').first().inputValue()
    if (unit !== 'count') throw new Error(`amount opened in "${unit}", expected count`)

    await page.locator('.row').first().locator('input').first().fill('1')
    const hint = await page.textContent('.field-hint')
    if (!hint.includes('69 g')) throw new Error(`one tortilla converted to "${hint}"`)

    await page.click('.meal-picker button:has-text("Lunch")')
    const button = await page.textContent('button[type="submit"]')
    // 413 g / 6 = 68.83 g, at 300 cal per 100 g: 206.5 before floating point,
    // 206 after. Within the ±15% tolerance twice over — the point of the check
    // is that it is no longer 135 cal, which is what the ontology's average gave.
    if (!button.includes('206')) throw new Error(`expected a 206 cal preview, got "${button}"`)
    await page.screenshot({ path: `${SHOTS}/11-log-count-meal.png` })
    await page.click('button[type="submit"]')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })
  })

  await step('the day groups it under Lunch', async () => {
    await page.waitForSelector('.meal-head')
    const headings = await page.locator('.meal-head h2').allTextContents()
    if (!headings.includes('Lunch')) throw new Error(`sections read ${JSON.stringify(headings)}`)
    // Everything logged before meals existed on this screen sits under Other.
    if (!headings.includes('Other')) throw new Error(`no Other section: ${JSON.stringify(headings)}`)
    if (headings[headings.length - 1] !== 'Other') throw new Error('Other is not last')
    await page.screenshot({ path: `${SHOTS}/12-meal-sections.png` })
  })

  await step('the bag went down by one tortilla', async () => {
    await page.click('.nav-link:has-text("Everything")')
    await page.waitForSelector('.item-amount')
    const amount = await page.textContent('.item-amount')
    if (amount.trim() !== '5 flour tortillas') {
      throw new Error(`inventory reads "${amount}", expected "5 flour tortillas"`)
    }
  })

  await step('correct the product without moving the past', async () => {
    await page.click('.items button.item')
    await page.waitForSelector('.lot')
    await page.click('.lot-edit')
    await page.waitForSelector('text=Correcting')
    await page.screenshot({ path: `${SHOTS}/13-edit-product.png` })

    const calories = page.locator('.macro-grid input').first()
    if ((await calories.inputValue()) !== '300') {
      throw new Error('the edit form did not open with the stored figures in it')
    }
    await calories.fill('400')
    await page.click('text=Save changes')
    await page.waitForSelector('.lot')
    await page.click('.sheet-head button')

    await page.click('.nav-link:has-text("Food log")')
    await page.waitForSelector('.meal-head')
    const lunch = await page.locator('.meal:has-text("Lunch") .meal-total').textContent()
    if (!lunch.includes('206')) {
      throw new Error(`correcting a product moved a logged day: lunch now "${lunch}"`)
    }
    await page.screenshot({ path: `${SHOTS}/14-history-holds.png` })
  })

  await step('page back to yesterday and forward again', async () => {
    const back = page.locator('[aria-label="Previous day"]')
    if (await back.isEnabled()) throw new Error('paged back past the first entry')
    const forward = page.locator('[aria-label="Next day"]')
    if (await forward.isEnabled()) throw new Error('paged into the future')
  })

  await browser.close()

  if (problems.length > 0) {
    console.error('\nBrowser complained:')
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log('\nAll good.')
}

main().catch(async (error) => {
  console.error(`\nFAILED: ${error.message}`)
  process.exit(1)
})
