/**
 * Phase 7 smoke test — the cook flow, in a real browser.
 *
 * Not part of `npm test`: it drives a running dev server with Playwright,
 * because the Phase 4, 5 and 6 experience was that a green unit suite still
 * misses things you only see by clicking. Run with `node qa/smoke-phase7.cjs`
 * while `npm run dev -- --port 5174` is up.
 *
 * The path it walks is the whole phase, in the order a person would meet it:
 * cook Padron Peppers, watch the packets actually go down, eat a quarter of it,
 * find the rest of the batch in the log sheet TWO STEPS LATER, eat the rest,
 * and try to undo a cook that has already been eaten from. Padron Peppers is
 * the seed recipe with the fewest counted ingredients (olive oil and bell
 * pepper), which is what makes it reachable in a smoke test.
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

const BASE = process.env.BASE ?? 'http://localhost:5174'
const SHOTS = process.env.SHOTS ?? '/tmp/kitchen-os-shots-7'

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

  const contains = (haystack, needle, what) => {
    if (!String(haystack).includes(needle)) {
      throw new Error(`${what}: "${haystack}" does not contain "${needle}"`)
    }
  }

  const sheet = page.locator('.sheet')

  /** Add one packet through the real add flow, per-100g basis. */
  const addPacket = async ({ search, pick, name, grams, calories }) => {
    await page.click('text=+ Add to the kitchen')
    await page.fill('.search', search)
    await page.waitForSelector(`.pick-name:has-text("${pick}")`)
    await page.click(`.pick:has-text("${pick}")`)

    await sheet.locator('input[placeholder="Kroger Boneless Chicken Breast"]').fill(name)
    await sheet.locator('select').first().selectOption('per100g')
    await sheet.locator('label:has-text("Package size") input').fill(String(grams))
    await sheet.locator('.macro-grid input').nth(0).fill(String(calories))
    await page.click('text=Save product')

    await page.waitForSelector('text=Add to the kitchen')
    await page.click('.actions button.primary')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })
  }

  const openRecipe = async (title) => {
    await page.goto(`${BASE}#/recipes/padron-peppers`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1')
    expect((await page.textContent('h1')).trim(), title, 'recipe heading')
  }

  const openLogSheet = async () => {
    await page.click('.nav-link:has-text("Food log")')
    await page.waitForSelector('.log-button')
    await page.click('.log-button')
    await page.waitForSelector('.sheet')
  }

  /** What the kitchen says is left of one ingredient, in grams. */
  const remainingOf = async (ingredientName) => {
    await page.goto(`${BASE}#/inventory`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.item')
    const row = page.locator(`.item:has-text("${ingredientName}")`).first()
    return (await row.textContent()).trim()
  }

  // -------------------------------------------------------------------------

  await step('get past the kit questions', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.waitForSelector('.kit-list')
    await page.click('.actions button.primary')
    await page.waitForSelector('.kit-list', { state: 'detached', timeout: 10000 })
  })

  await step('stock the kitchen for Padron Peppers', async () => {
    await addPacket({
      search: 'olive oil',
      pick: 'Olive oil',
      name: 'Test Olive Oil',
      grams: 500,
      calories: 884,
    })
    await addPacket({
      search: 'bell pepper',
      pick: 'Bell pepper',
      name: 'Test Bell Peppers',
      grams: 1190,
      calories: 31,
    })
  })

  await step('the recipe detail offers Made it', async () => {
    await openRecipe('Padron Peppers')
    const button = page.locator('.stand .actions button.primary')
    expect((await button.textContent()).trim(), 'Made it', 'cook button')
    await page.screenshot({ path: `${SHOTS}/01-recipe-detail.png` })
  })

  await step('the cook sheet previews exactly what would be debited', async () => {
    await page.click('.stand .actions button.primary')
    await page.waitForSelector('.sheet')

    expect((await sheet.locator('.sheet-head h2').textContent()).trim(), 'Made it', 'sheet title')

    // Olive oil: 13.6 g a batch, from the one bottle. Peppers: 500 g.
    const rows = sheet.locator('.ings .ing')
    expect(await rows.count(), 3, 'preview rows')
    contains(await rows.nth(0).textContent(), '14 g', 'oil amount')
    contains(await rows.nth(0).textContent(), 'Test Olive Oil', 'oil packet named')
    contains(await rows.nth(1).textContent(), '500 g', 'pepper amount')

    // Salt is untracked: on the list because it is in the recipe, with nothing
    // to debit and no way to be short.
    contains(await rows.nth(2).textContent(), 'Salt', 'salt row present')
    contains(await rows.nth(2).textContent(), 'Assumed in the cupboard', 'salt is a staple')

    contains(
      await sheet.locator('.warnings').textContent(),
      '2 packets will be used',
      'packet count note',
    )
    await page.screenshot({ path: `${SHOTS}/02-preview.png` })
  })

  await step('the commit button does not say the same thing as the one that opened it', async () => {
    // The Phase 5 lesson: two buttons reading "Something else" made the sheet
    // look like it had no next step. One phrase must not mean both "start
    // this" and "yes, commit".
    const label = (await sheet.locator('.actions button.primary').textContent()).trim()
    expect(label, 'Cook it · 2 packets', 'commit button')
  })

  await step('batch sizes are offered, and the impossible one is marked', async () => {
    const steps = sheet.locator('.meal-picker .step')
    expect(await steps.count(), 4, 'scale steps')
    expect((await steps.nth(0).textContent()).trim(), '½ batch', 'first step')
    expect((await steps.nth(1).textContent()).trim(), 'Full batch', 'second step')

    // 1190 g of peppers against 500 g a batch: two batches, not three.
    await steps.nth(3).click()
    await page.waitForSelector('.sheet .field-hint')
    contains(
      await sheet.locator('.field-hint').textContent(),
      'only enough for 2 batches',
      'scale note',
    )

    // And it is still allowed — warn and proceed, never block (Jack, 2026-08-22).
    if (await sheet.locator('.actions button.primary').isDisabled()) {
      throw new Error('the commit button was disabled for a size the kitchen cannot cover')
    }
    contains(await sheet.locator('.warnings').textContent(), 'short of', 'shortfall named')
    await page.screenshot({ path: `${SHOTS}/03-short.png` })

    await steps.nth(1).click()
    await page.waitForSelector('.sheet .actions button.primary:has-text("2 packets")')
  })

  await step('cooking it takes the food out and offers the portion question', async () => {
    await sheet.locator('.actions button.primary').click()
    await page.waitForSelector('.sheet .stand-headline')

    contains(
      await sheet.locator('.stand-headline').textContent(),
      'Cooked Padron Peppers',
      'confirmation',
    )
    // 13.6 g of oil at 884/100g plus 500 g of peppers at 31/100g.
    contains(await sheet.locator('.stand-notes').textContent(), '275 calories', 'batch calories')
    expect((await sheet.locator('.sheet-head h2').textContent()).trim(), 'Cooked', 'step 2 title')
    await page.screenshot({ path: `${SHOTS}/04-cooked.png` })
  })

  await step('eating a quarter logs it against the day', async () => {
    const portions = sheet.locator('.meal-picker').first().locator('.step')
    expect((await portions.nth(0).textContent()).trim(), '¼', 'first portion')
    expect((await portions.nth(3).textContent()).trim(), 'All of it', 'last portion')

    await portions.nth(0).click()
    await sheet.locator('.actions button.primary:has-text("Log it")').click()
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })

    // Closing the sheet leaves you on the recipe, which is where you were
    // standing. The entry is on the food log.
    await page.click('.nav-link:has-text("Food log")')
    await page.waitForSelector('.entry')
    const entry = page.locator('.entry').first()
    contains(await entry.textContent(), 'Padron Peppers', 'entry name')
    contains(await entry.textContent(), '25% of the batch', 'entry detail')
    contains(await entry.textContent(), '69', 'entry calories')
    await page.screenshot({ path: `${SHOTS}/05-logged.png` })
  })

  await step('the packets actually went down', async () => {
    contains(await remainingOf('Bell pepper'), '690 g', 'peppers left')
    contains(await remainingOf('Olive oil'), '486 g', 'oil left')
  })

  await step('a cook-sourced entry can be removed, and Undo puts it back', async () => {
    await page.click('.nav-link:has-text("Food log")')
    await page.waitForSelector('.entry')

    // Until Phase 7 this button was absent on a cooked row, because
    // deleteConsumption refused one.
    await page.click('.entry-remove')
    await page.waitForSelector('.undo')
    contains(await page.textContent('.undo'), 'Removed Padron Peppers', 'undo banner')

    await page.click('.undo button')
    await page.waitForSelector('.entry')
    contains(await page.textContent('.entry'), '25% of the batch', 'entry is back')
  })

  await step('the rest of the batch is findable in the log sheet, later', async () => {
    await openLogSheet()

    // The question the whole phase was shaped around.
    contains(
      await sheet.locator('.list-heading').first().textContent(),
      'Cooked and not finished',
      'batch section heading',
    )
    const batch = sheet.locator('.pick:has-text("Padron Peppers")').first()
    contains(await batch.textContent(), 'Cooked today', 'when it was cooked')
    contains(await batch.textContent(), '75% left', 'how much is left')
    await page.screenshot({ path: `${SHOTS}/06-batch-in-log-sheet.png` })
  })

  await step('undoing a cook that has been eaten from refuses, and says why', async () => {
    await sheet.locator('.pick:has-text("Padron Peppers")').first().click()
    await page.waitForSelector('.sheet .undo')

    await sheet.locator('.undo button').click()
    await page.waitForSelector('.sheet .errors')

    const message = await sheet.locator('.errors').textContent()
    contains(message, 'already been eaten from', 'refusal')
    contains(message, 'food log', 'refusal says what to do')
    await page.screenshot({ path: `${SHOTS}/07-refused.png` })
  })

  await step('a portion bigger than what is left is clamped, not refused', async () => {
    await sheet.locator('input[placeholder="40"]').fill('90')
    await page.waitForSelector('.sheet .warnings')
    contains(
      await sheet.locator('.warnings').textContent(),
      '75% of this batch is left',
      'clamp warning',
    )
  })

  await step('eating the rest finishes the batch and takes it off the list', async () => {
    await sheet.locator('input[placeholder="40"]').fill('')
    const portions = sheet.locator('.meal-picker').first().locator('.step')
    expect((await portions.nth(3).textContent()).trim(), 'The rest', 'last portion when part-eaten')

    // ¾ is exactly what is left, so it is still offered; a whole batch is not.
    await portions.nth(3).click()
    await sheet.locator('.actions button.primary:has-text("Log it")').click()
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })

    await page.waitForFunction(() => document.querySelectorAll('.entry').length === 2)

    await openLogSheet()
    if ((await sheet.locator('.pick:has-text("Padron Peppers")').count()) !== 0) {
      throw new Error('a finished batch is still being offered to eat')
    }
    await page.screenshot({ path: `${SHOTS}/08-finished.png` })
    await page.click('.sheet-head button')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })
  })

  await step('the day adds up to the whole batch', async () => {
    await page.waitForSelector('.total-value')
    const calories = (await page.locator('.total-value').first().textContent()).trim()
    expect(calories, '275', 'day total is the whole batch')
    await page.screenshot({ path: `${SHOTS}/09-day-total.png` })
  })

  await step('cooking with nothing in the kitchen is allowed and says so', async () => {
    await page.goto(`${BASE}#/recipes/poutine`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.stand .actions button.primary')
    await page.click('.stand .actions button.primary')
    await page.waitForSelector('.sheet')

    contains(
      await sheet.locator('.warnings').textContent(),
      'Nothing will come out of your kitchen',
      'empty-kitchen note',
    )
    expect(
      (await sheet.locator('.actions button.primary').textContent()).trim(),
      'Cook it',
      'commit button with no packets',
    )
    await page.click('.sheet-head button')
    await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 })
  })

  await step('a reload keeps everything', async () => {
    await page.goto(`${BASE}#/today`, { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.entry')
    const rows = await page.locator('.entry').count()
    if (rows !== 2) throw new Error(`after a reload the day has ${rows} entries, expected 2`)
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
