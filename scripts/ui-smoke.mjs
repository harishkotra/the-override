// UI smoke test: loads the built app, compiles the default policy, clicks through
// to a real CLI verdict, and dumps what a human would read.
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

await page.goto('http://127.0.0.1:8791/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('header h1', { timeout: 20000 })
console.log('TITLE:', await page.title())
console.log('HEADER:', (await page.locator('header').innerText()).replace(/\n/g, ' | '))

await page.getByRole('button', { name: /Compile extension/ }).click({ timeout: 150000 })
await page.waitForSelector('.verdict.pass, .verdict.fail', { timeout: 240000 })
await page.waitForTimeout(1200)

console.log('\nVERDICT:', (await page.locator('.verdict').innerText()).replace(/\n/g, ' | '))
const terms = await page.locator('.term').allInnerTexts()
terms.forEach((t, i) => console.log(`\n[term ${i + 1}]\n${t}`))

await page.getByRole('button', { name: /Run the command for real/i }).click()
await page.waitForTimeout(9000)
const big = await page.locator('.term-big').innerText()
console.log('\n[LIVE RUN]\n' + big)

await page.screenshot({ path: 'screens/ui-full.png', fullPage: true })
console.log('\nconsole errors:', errors.length ? errors : 'none')
await browser.close()
