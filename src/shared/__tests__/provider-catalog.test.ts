import { describe, expect, it } from 'vitest'

import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  PROVIDER_CATALOG,
  entriesByCategory,
} from '../provider-catalog'

describe('provider-catalog', () => {
  it('every entry has a non-empty id, name, and apiKeyHelpUrl', () => {
    for (const e of PROVIDER_CATALOG) {
      expect(e.id.length).toBeGreaterThan(0)
      expect(e.name.length).toBeGreaterThan(0)
      expect(e.apiKeyHelpUrl.startsWith('http')).toBe(true)
    }
  })

  it('ids are unique', () => {
    const ids = PROVIDER_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every category in CATEGORY_ORDER has at least one entry', () => {
    const grouped = entriesByCategory()
    for (const cat of CATEGORY_ORDER) {
      expect(grouped[cat].length).toBeGreaterThan(0)
    }
  })

  it('CATEGORY_LABELS covers every category', () => {
    for (const cat of CATEGORY_ORDER) {
      expect(CATEGORY_LABELS[cat].length).toBeGreaterThan(0)
    }
  })

  it('every entry references one of the known categories', () => {
    const allowed = new Set<string>(CATEGORY_ORDER)
    for (const e of PROVIDER_CATALOG) {
      expect(allowed.has(e.category)).toBe(true)
    }
  })
})
