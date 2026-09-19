import { describe, expect, it } from 'vitest'
import { DEFAULT_VAULT_SETTINGS, type VaultSettings } from '@zennotes/bridge-contract/ipc'
import {
  VAULT_SETTINGS_SECTIONS,
  diffVaultSettings,
  mergeVaultSettings,
  unknownVaultSettingsKeys,
  vaultSettingsValueEqual
} from './vault-settings-conflict'

function settings(overrides: Partial<VaultSettings> = {}): VaultSettings {
  return {
    ...DEFAULT_VAULT_SETTINGS,
    dailyNotes: { ...DEFAULT_VAULT_SETTINGS.dailyNotes },
    weeklyNotes: { ...DEFAULT_VAULT_SETTINGS.weeklyNotes },
    monthlyNotes: { ...DEFAULT_VAULT_SETTINGS.monthlyNotes },
    folderIcons: {},
    folderColors: {},
    favorites: [],
    systemFolderPaths: {},
    ...overrides
  }
}

describe('diffVaultSettings', () => {
  it('reports nothing for two files that differ only in key order', () => {
    const local = settings({
      favorites: ['inbox/A.md', 'inbox/B.md'],
      folderIcons: { 'inbox:Work': 'briefcase', 'inbox:Home': 'home' }
    })
    const cloud = settings({
      folderIcons: { 'inbox:Home': 'home', 'inbox:Work': 'briefcase' },
      favorites: ['inbox/A.md', 'inbox/B.md']
    })
    expect(diffVaultSettings(local, cloud)).toEqual([])
  })

  it('names the leaf that differs inside a section, and only the sections that differ', () => {
    const local = settings({
      dailyNotes: { ...DEFAULT_VAULT_SETTINGS.dailyNotes, enabled: true, directory: 'Journal' }
    })
    const cloud = settings({
      dailyNotes: { ...DEFAULT_VAULT_SETTINGS.dailyNotes, enabled: true, directory: 'Daily Notes' },
      favorites: ['inbox/Plan.md']
    })
    const differences = diffVaultSettings(local, cloud)
    expect(differences.map((difference) => difference.section)).toEqual(['dailyNotes', 'favorites'])
    expect(differences[0].fields).toEqual([
      { path: ['dailyNotes', 'directory'], local: 'Journal', cloud: 'Daily Notes' }
    ])
    // A list is one setting: the whole favorites order is the leaf.
    expect(differences[1].fields).toEqual([
      { path: ['favorites'], local: [], cloud: ['inbox/Plan.md'] }
    ])
  })

  it('treats a reordered list as a difference', () => {
    const local = settings({ favorites: ['inbox/A.md', 'inbox/B.md'] })
    const cloud = settings({ favorites: ['inbox/B.md', 'inbox/A.md'] })
    expect(diffVaultSettings(local, cloud)).toHaveLength(1)
  })

  it('ignores the date-note pattern history the app maintains on its own', () => {
    const local = settings({
      dailyNotes: {
        ...DEFAULT_VAULT_SETTINGS.dailyNotes,
        legacyPatterns: [{ directory: 'Old', titlePattern: 'yyyy-MM-dd', locale: 'system' }]
      }
    })
    const cloud = settings()
    expect(diffVaultSettings(local, cloud)).toEqual([])
  })

  it('compares a section one side lacks field by field, not as one opaque value', () => {
    const local = settings({ view: { noteSortOrder: 'title-asc', autoReveal: true } })
    const cloud = settings()
    const [difference] = diffVaultSettings(local, cloud)
    expect(difference.section).toBe('view')
    expect(difference.fields).toEqual([
      { path: ['view', 'autoReveal'], local: true, cloud: undefined },
      { path: ['view', 'noteSortOrder'], local: 'title-asc', cloud: undefined }
    ])
    // An empty object and an absent section mean the same thing.
    expect(diffVaultSettings(settings({ view: {} }), settings())).toEqual([])
  })

  it('reports each remapped built-in folder on its own', () => {
    const local = settings({ systemFolderPaths: { inbox: '01 - Entry' } })
    const cloud = settings({ systemFolderPaths: { inbox: 'Inbox', archive: 'Old' } })
    const [difference] = diffVaultSettings(local, cloud)
    expect(difference.fields).toEqual([
      { path: ['systemFolderPaths', 'archive'], local: undefined, cloud: 'Old' },
      { path: ['systemFolderPaths', 'inbox'], local: '01 - Entry', cloud: 'Inbox' }
    ])
  })

  it('covers every vault.json section', () => {
    const declared: Record<keyof VaultSettings, true> = {
      primaryNotesLocation: true,
      dailyNotes: true,
      weeklyNotes: true,
      monthlyNotes: true,
      drawingsLocation: true,
      databasesLocation: true,
      tasksLocation: true,
      view: true,
      folderIcons: true,
      folderColors: true,
      favorites: true,
      systemFolderPaths: true,
      tasks: true,
      typstPreambles: true,
      harper: true
    }
    expect([...VAULT_SETTINGS_SECTIONS].sort()).toEqual(Object.keys(declared).sort())
  })
})

describe('mergeVaultSettings', () => {
  const local = settings({
    favorites: ['inbox/Mine.md'],
    folderIcons: { 'inbox:Work': 'briefcase' },
    view: { noteSortOrder: 'title-asc' }
  })
  const cloud = settings({
    favorites: ['inbox/Theirs.md'],
    folderIcons: { 'inbox:Work': 'star' },
    harper: { words: ['zennotes'], ignoredLints: [] }
  })

  it('takes the cloud value only for the sections answered cloud', () => {
    const merged = mergeVaultSettings(local, cloud, { favorites: 'cloud', folderIcons: 'local' })
    expect(merged.favorites).toEqual(['inbox/Theirs.md'])
    expect(merged.folderIcons).toEqual({ 'inbox:Work': 'briefcase' })
    // Unanswered sections are this device's, whichever side has a value.
    expect(merged.view).toEqual({ noteSortOrder: 'title-asc' })
    expect(merged.harper).toBeUndefined()
  })

  it('drops a section the cloud does not have when the cloud is chosen for it', () => {
    const merged = mergeVaultSettings(local, cloud, { view: 'cloud', harper: 'cloud' })
    expect('view' in merged).toBe(false)
    expect(merged.harper).toEqual({ words: ['zennotes'], ignoredLints: [] })
  })

  it('leaves both inputs untouched', () => {
    const localBefore = JSON.stringify(local)
    const cloudBefore = JSON.stringify(cloud)
    mergeVaultSettings(local, cloud, { favorites: 'cloud', view: 'cloud' })
    expect(JSON.stringify(local)).toBe(localBefore)
    expect(JSON.stringify(cloud)).toBe(cloudBefore)
  })
})

describe('unknownVaultSettingsKeys', () => {
  it('lists, sorted, the top-level keys this runtime has no section for', () => {
    expect(
      unknownVaultSettingsKeys({ favorites: [], zeta: 1, alpha: { nested: true }, view: {} })
    ).toEqual(['alpha', 'zeta'])
  })

  it('has nothing to say about a file that is not an object', () => {
    expect(unknownVaultSettingsKeys(null)).toEqual([])
    expect(unknownVaultSettingsKeys(['favorites'])).toEqual([])
    expect(unknownVaultSettingsKeys('{}')).toEqual([])
  })
})

describe('vaultSettingsValueEqual', () => {
  it('ignores undefined properties but not null ones', () => {
    expect(vaultSettingsValueEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(vaultSettingsValueEqual({ a: 1, b: null }, { a: 1 })).toBe(false)
  })

  it('does not confuse a list with an object of the same keys', () => {
    expect(vaultSettingsValueEqual(['a'], { 0: 'a' })).toBe(false)
  })
})
