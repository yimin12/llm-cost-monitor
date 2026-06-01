#!/usr/bin/env node
// Headless screenshot of the WebDashboard. Pre-seeds localStorage to land
// on the team tab so the merged-team view is what we capture. Used by
// the team-demo PR to produce reproducible visual proof of the dashboard
// state — re-run after `Scripts/seed-mock-team.py` to refresh.
//
// Usage:
//   node Scripts/screenshot-dashboard.mjs                                  # local 5174 → docs/screenshots/team.png
//   node Scripts/screenshot-dashboard.mjs --url URL --out PATH [--tab T]

import puppeteer from 'puppeteer-core'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const args = process.argv.slice(2)
function arg(name, def) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const url = arg('url', 'http://localhost:5174/')
const out = resolve(arg('out', 'docs/screenshots/team-dashboard.png'))
const tab = arg('tab', 'team')
const period = arg('period', '30d')

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1400, height: 2200, deviceScaleFactor: 2 },
})
const page = await browser.newPage()
// Land on the page once, write localStorage at its origin, reload so React
// reads the seeded value on mount.
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.evaluate(
  ({ tab, period }) => {
    localStorage.setItem('lcm.web.tab', tab)
    localStorage.setItem('lcm.web.period', period)
  },
  { tab, period },
)
await page.reload({ waitUntil: 'networkidle0' })
// Give async fetches (team-overview etc.) a moment to populate.
await new Promise((r) => setTimeout(r, 1500))
await page.screenshot({ path: out, fullPage: true })
await browser.close()
console.log(`wrote ${out}`)
