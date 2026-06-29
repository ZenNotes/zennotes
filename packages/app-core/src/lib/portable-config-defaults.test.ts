import { describe, it, expect } from 'vitest'
import { PORTABLE_DEFAULTS, PORTABLE_PREF_KEYS } from '@shared/app-config'
import { DEFAULT_PREFS } from '../store'

// PORTABLE_DEFAULTS (shared-domain) is what the config writer fills unset
// options with so config.toml lists every setting. It must mirror the renderer's
// real defaults — this test fails loudly if the two drift apart.
describe('PORTABLE_DEFAULTS', () => {
  it('matches DEFAULT_PREFS for every portable key', () => {
    const defaults = DEFAULT_PREFS as unknown as Record<string, unknown>
    for (const key of PORTABLE_PREF_KEYS) {
      expect(PORTABLE_DEFAULTS[key]).toEqual(defaults[key])
    }
  })
})
