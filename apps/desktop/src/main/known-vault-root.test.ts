import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveKnownVaultRoot } from './known-vault-root'

describe('resolveKnownVaultRoot', () => {
  const work = path.resolve('/tmp/vaults/work')
  const home = path.resolve('/tmp/vaults/home')
  const known = [work, home]

  it('finds a vault main knows, trailing separator or not', () => {
    expect(resolveKnownVaultRoot(work, known)).toBe(work)
    expect(resolveKnownVaultRoot(`${home}${path.sep}`, known)).toBe(home)
  })

  it('refuses anything that is not exactly a known root', () => {
    expect(resolveKnownVaultRoot(path.dirname(work), known)).toBeNull()
    expect(resolveKnownVaultRoot(path.join(work, 'note.md'), known)).toBeNull()
    expect(resolveKnownVaultRoot(path.join(work, '..', 'other'), known)).toBeNull()
    expect(resolveKnownVaultRoot(`${work}-evil`, known)).toBeNull()
    expect(resolveKnownVaultRoot('/Applications/Calculator.app', known)).toBeNull()
  })

  it('refuses what is not a path at all', () => {
    for (const value of [undefined, null, '', '   ', 42, {}, [work]]) {
      expect(resolveKnownVaultRoot(value, known)).toBeNull()
    }
  })

  it('knows nothing when the list is empty', () => {
    expect(resolveKnownVaultRoot(work, [])).toBeNull()
  })
})
