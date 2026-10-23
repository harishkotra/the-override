// Layout guard: the right panel holds long YAML, so every breakpoint has to keep
// both columns real and the page free of horizontal overflow.
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const widths = [1440, 1280, 1184, 1024, 921, 920, 820, 390]
let fail = 0
for (const w of widths) {
  await page.setViewportSize({ width: w, height: 1000 })
  await page.goto('http://127.0.0.1:8791/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.grid > .panel')
  const m = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('.grid > .panel')].map((p) => {
      const r = p.getBoundingClientRect()
      return { w: Math.round(r.width), x: Math.round(r.x) }
    })
    return {
      panels,
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      stacked: panels.length === 2 ? panels[0].x === panels[1].x : null,
    }
  })
  const ratio = m.panels.length === 2 && !m.stacked ? (m.panels[0].w / m.panels[1].w).toFixed(2) : 'stacked'
  const overflow = m.scrollW - m.innerW
  const bad = overflow > 0 || (w > 920 && (m.stacked || Number(ratio) < 0.8 || Number(ratio) > 1.25))
  if (bad) fail++
  console.log(
    `${String(w).padStart(4)}px  cols=${m.panels.map((p) => p.w).join('/')}  ratio=${ratio}  overflow=${overflow}px  ${bad ? 'FAIL' : 'ok'}`,
  )
}

// fill the panels with the longest output (a compiled spec plus a verdict) and re-measure
await page.setViewportSize({ width: 1280, height: 1000 })
await page.goto('http://127.0.0.1:8791/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('header h1')
await page.getByRole('button', { name: /Compile extension/ }).click({ timeout: 150000 })
await page.waitForSelector('.verdict.pass, .verdict.fail', { timeout: 240000 })
await page.waitForTimeout(1500)
const filled = await page.evaluate(() => {
  const p = [...document.querySelectorAll('.grid > .panel')].map((x) => Math.round(x.getBoundingClientRect().width))
  const code = document.querySelector('.code')
  return {
    cols: p,
    codeOverflow: code ? code.scrollWidth - code.clientWidth : 0,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    verdictVisible: !!document.querySelector('.verdict'),
    steps: document.querySelectorAll('.term').length,
  }
})
console.log('\nafter compile at 1280px:', JSON.stringify(filled))
if (filled.pageOverflow > 0 || Math.abs(filled.cols[0] - filled.cols[1]) > 8) fail++

await page.screenshot({ path: 'screens/ui-fixed.png', fullPage: true })
console.log('console errors:', errors.length ? errors : 'none')
console.log(fail ? `\n${fail} layout check(s) FAILED` : '\nall layout checks passed')
await browser.close()
process.exit(fail ? 1 : 0)
