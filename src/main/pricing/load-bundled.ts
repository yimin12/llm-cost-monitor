import { app } from 'electron'
import { resolve } from 'node:path'

import { PricingTable } from './pricing-table'

// Loads the bundled pricing.json. In dev electron-vite runs main from `out/main/`
// and the resources tree is at the repo root; in packaged builds electron-builder
// copies `resources/` into `process.resourcesPath`.
export function loadBundledPricing(): PricingTable {
  const path = app.isPackaged
    ? resolve(process.resourcesPath, 'pricing.json')
    : resolve(app.getAppPath(), 'resources', 'pricing.json')
  return PricingTable.fromFile(path)
}
