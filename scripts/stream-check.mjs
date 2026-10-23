// Proves the verdict panel fills progressively instead of appearing all at once.
import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1280, height: 1000 } })
await p.goto('http://127.0.0.1:8791/', { waitUntil: 'domcontentloaded' })
await p.waitForSelector('header h1')
const t0 = Date.now()
await p.getByRole('button', { name: /Compile extension/ }).click({ timeout: 150000 })
const marks = []
for (let i = 0; i < 60; i++) {
  const st = await p.evaluate(() => ({
    steps: document.querySelectorAll('.term').length,
    badge: document.querySelector('.verdict .big')?.textContent || '',
    partial: document.querySelectorAll('#root .pulse').length,
  }))
  const key = st.steps + '|' + st.badge
  if (marks.at(-1)?.key !== key) marks.push({ at: Date.now() - t0, ...st, key })
  if (st.badge === 'ACCEPTED' || st.badge === 'REJECTED') break
  await p.waitForTimeout(500)
}
marks.forEach((m) => console.log(`+${String(m.at).padStart(6)}ms  steps=${m.steps}  verdict=${m.badge}  spinner=${m.partial}`))
await p.screenshot({ path: 'screens/ui-fixed.png', fullPage: true })
await b.close()
