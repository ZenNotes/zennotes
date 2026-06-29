import { describe, it, expect } from 'vitest'
import { KEYMAP_CATALOG } from '@shared/keymaps-catalog'
import { getKeymapDefinitions } from './keymaps'

// KEYMAP_CATALOG (shared-domain) is a slim mirror of KEYMAP_DEFINITIONS used by
// the config writer to list every action as a commented default. KEYMAP_DEFINITIONS
// is the source of truth — this test fails if the catalog drifts (added/removed
// action, changed default binding, group, or title).
describe('KEYMAP_CATALOG', () => {
  it('mirrors every keymap definition (id, group, defaultBinding, title)', () => {
    const definitions = getKeymapDefinitions()
    const catalogById = new Map(KEYMAP_CATALOG.map((e) => [e.id, e]))

    expect(KEYMAP_CATALOG).toHaveLength(definitions.length)

    for (const def of definitions) {
      const entry = catalogById.get(def.id)
      expect(entry, `missing catalog entry for ${def.id}`).toBeDefined()
      expect(entry).toEqual({
        id: def.id,
        group: def.group,
        defaultBinding: def.defaultBinding,
        title: def.title
      })
    }
  })
})
