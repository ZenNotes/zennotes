import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { bodyHasLocalAsset, extractAssetEmbeds, extractWikilinks } from './vault-core'

// A table writes a wikilink as `[[C\\|d]]`, because GFM needs the escape to keep
// the pipe in its cell. Same scanners as the desktop's vault.ts (de50f31d).

describe('a wikilink escaped for a table', () => {
  it('links to its note, not to a name ending in a backslash', () => {
    assert.deepEqual(extractWikilinks('| [[Note\\|alias]] | x |\n'), ['Note'])
    assert.deepEqual(extractWikilinks('[[Note|alias]] [[Other]]'), ['Note', 'Other'])
  })

  it('counts an escaped embed of a note as a link, and of a file as an asset', () => {
    assert.deepEqual(extractWikilinks('| ![[Note\\|alias]] | x |'), ['Note'])
    assert.deepEqual(extractAssetEmbeds('| ![[pic.png\\|200]] | x |'), ['pic.png'])
    assert.equal(bodyHasLocalAsset('| ![[pic.png\\|200]] | x |'), true)
  })

  it('reads a bare escape as nothing', () => {
    assert.deepEqual(extractWikilinks('[[\\|d]]'), [])
  })

  it('makes every vault re-read its notes once', () => {
    // The package's copy of the phones' vault-fs.ts.
    const vaultFs = readFileSync(new URL('./vault-fs.ts', import.meta.url), 'utf8')
    assert.match(vaultFs, /const META_CACHE_VERSION = 2/)
    assert.doesNotMatch(vaultFs, /parsed\.version === 1/)
  })
})
