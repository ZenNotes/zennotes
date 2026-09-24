import { describe, expect, it } from 'vitest'
import {
  VAULT_DISPLAY_NAME_MAX_LENGTH,
  normalizeVaultDisplayName,
  vaultFolderName,
  resolveVaultName
} from './vault-display-name'

describe('normalizeVaultDisplayName (#692)', () => {
  it('keeps an ordinary name as typed', () => {
    expect(normalizeVaultDisplayName('Acme API docs')).toBe('Acme API docs')
    expect(normalizeVaultDisplayName('Été 2026 · notes')).toBe('Été 2026 · notes')
  })

  it('trims and collapses whitespace', () => {
    expect(normalizeVaultDisplayName('  Acme   API\tdocs \n')).toBe('Acme API docs')
  })

  it('drops control characters and folds line separators into a space', () => {
    expect(normalizeVaultDisplayName('Acme\u0000 docs\u2028v2\u0007')).toBe('Acme docs v2')
    // A dropped control between two spaces leaves one space, not two.
    expect(normalizeVaultDisplayName('A \u0007 B')).toBe('A B')
  })

  it('is undefined for nothing usable, so the key is omitted rather than stored empty', () => {
    expect(normalizeVaultDisplayName('')).toBeUndefined()
    expect(normalizeVaultDisplayName('   ')).toBeUndefined()
    expect(normalizeVaultDisplayName('\u0007')).toBeUndefined()
    expect(normalizeVaultDisplayName(undefined)).toBeUndefined()
    expect(normalizeVaultDisplayName(42)).toBeUndefined()
    expect(normalizeVaultDisplayName(null)).toBeUndefined()
  })

  it('cuts at the limit without leaving a trailing space', () => {
    const long = `${'word '.repeat(20)}end`
    const out = normalizeVaultDisplayName(long)!
    expect(out.length).toBeLessThanOrEqual(VAULT_DISPLAY_NAME_MAX_LENGTH)
    expect(out).toBe(out.trimEnd())
    expect(normalizeVaultDisplayName('x'.repeat(VAULT_DISPLAY_NAME_MAX_LENGTH))).toHaveLength(
      VAULT_DISPLAY_NAME_MAX_LENGTH
    )
  })

  it('never splits a surrogate pair at the cut', () => {
    // 63 units of x, then an emoji (2 units): the emoji does not fit, so it goes whole.
    const out = normalizeVaultDisplayName(`${'x'.repeat(63)}😀tail`)!
    expect(out).toBe('x'.repeat(63))
    // 62 units of x, then the emoji fits exactly.
    expect(normalizeVaultDisplayName(`${'x'.repeat(62)}😀tail`)).toBe(`${'x'.repeat(62)}😀`)
  })
})

describe('resolveVaultName', () => {
  it('prefers a usable display name and falls back to the folder name', () => {
    expect(resolveVaultName('Acme API docs', 'docs')).toBe('Acme API docs')
    expect(resolveVaultName('  ', 'docs')).toBe('docs')
    expect(resolveVaultName(undefined, 'docs')).toBe('docs')
  })
})

describe('vaultFolderName', () => {
  it('takes the last segment of a path root, POSIX or Windows', () => {
    expect(vaultFolderName({ root: '/Users/me/repos/acme/docs' })).toBe('docs')
    expect(vaultFolderName({ root: 'C:\\Users\\me\\repos\\acme\\docs\\' })).toBe('docs')
    expect(vaultFolderName({ root: '/docs' })).toBe('docs')
  })

  it('prefers the folder name a host gave, which a label root cannot provide', () => {
    // The phone shells describe a vault by a label, not a path: without the
    // host's folder name the whole label would stand in for it.
    const label = 'On this device › ZenNotes › docs'
    expect(vaultFolderName({ root: label, folderName: 'docs' })).toBe('docs')
    expect(vaultFolderName({ root: label })).toBe(label)
    // A host that gives it for a path root is simply believed.
    expect(vaultFolderName({ root: '/Users/me/repos/acme/docs', folderName: 'docs' })).toBe('docs')
  })
})
