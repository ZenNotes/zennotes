import { describe, expect, it } from 'vitest'
import { buildVaultSwitcherEntries, newWindowVaultRows } from './vault-switcher'

describe('buildVaultSwitcherEntries', () => {
  it('keeps the current local vault and recent local vaults in the switcher list', () => {
    const entries = buildVaultSwitcherEntries({
      localVaults: [
        { root: '/vaults/work', name: 'Work', lastOpenedAt: 2 },
        { root: '/vaults/personal', name: 'Personal', lastOpenedAt: 3 }
      ],
      remoteProfiles: [],
      currentVault: { root: '/vaults/personal', name: 'Personal' },
      workspaceMode: 'local',
      remoteWorkspaceInfo: null
    })

    expect(entries).toEqual([
      {
        kind: 'local',
        root: '/vaults/personal',
        name: 'Personal',
        lastOpenedAt: Number.MAX_SAFE_INTEGER,
        current: true,
        location: '/vaults/personal'
      },
      {
        kind: 'local',
        root: '/vaults/work',
        name: 'Work',
        lastOpenedAt: 2,
        current: false,
        location: '/vaults/work'
      }
    ])
  })

  it('adds the current local vault even when it is not in the recent list', () => {
    const entries = buildVaultSwitcherEntries({
      localVaults: [{ root: '/vaults/work', name: 'Work', lastOpenedAt: 2 }],
      remoteProfiles: [],
      currentVault: { root: '/vaults/current', name: 'Current' },
      workspaceMode: 'local',
      remoteWorkspaceInfo: null
    })

    expect(entries.map((entry) => [entry.kind, entry.name, entry.current])).toEqual([
      ['local', 'Current', true],
      ['local', 'Work', false]
    ])
  })

  it('includes saved remote profiles alongside local vaults', () => {
    const entries = buildVaultSwitcherEntries({
      localVaults: [{ root: '/vaults/work', name: 'Work', lastOpenedAt: 2 }],
      remoteProfiles: [
        {
          id: 'remote-1',
          name: 'Server Notes',
          baseUrl: 'https://notes.example.com',
          hasCredential: true,
          vaultPath: '/team',
          lastConnectedAt: 5
        }
      ],
      currentVault: { root: '/vaults/work', name: 'Work' },
      workspaceMode: 'local',
      remoteWorkspaceInfo: null
    })

    expect(entries.map((entry) => [entry.kind, entry.name, entry.current, entry.location])).toEqual([
      ['local', 'Work', true, '/vaults/work'],
      ['remote', 'Server Notes', false, 'https://notes.example.com /team']
    ])
  })

  it('marks the current remote profile and keeps it at the top', () => {
    const entries = buildVaultSwitcherEntries({
      localVaults: [{ root: '/vaults/work', name: 'Work', lastOpenedAt: 8 }],
      remoteProfiles: [
        {
          id: 'remote-old',
          name: 'Archive Server',
          baseUrl: 'https://archive.example.com',
          hasCredential: true,
          vaultPath: null,
          lastConnectedAt: 10
        },
        {
          id: 'remote-current',
          name: 'Team Server',
          baseUrl: 'https://team.example.com',
          hasCredential: true,
          vaultPath: '/team',
          lastConnectedAt: 4
        }
      ],
      currentVault: { root: '/team', name: 'Team' },
      workspaceMode: 'remote',
      remoteWorkspaceInfo: {
        mode: 'remote',
        baseUrl: 'https://team.example.com',
        authConfigured: true,
        capabilities: null,
        profileId: 'remote-current'
      }
    })

    expect(entries.map((entry) => [entry.kind, entry.name, entry.current])).toEqual([
      ['remote', 'Team Server', true],
      ['remote', 'Archive Server', false],
      ['local', 'Work', false]
    ])
  })

  it('names the current remote vault after the profile, not the server vault folder (#153)', () => {
    // The sidebar header derives its label and badge from the current entry's
    // name. In remote mode the server reports a vault folder name ("workspace"),
    // but the header should show the connection the user named ("Home").
    const entries = buildVaultSwitcherEntries({
      localVaults: [],
      remoteProfiles: [
        {
          id: 'home',
          name: 'Home',
          baseUrl: 'https://home.example.com',
          hasCredential: true,
          vaultPath: null,
          lastConnectedAt: 1
        }
      ],
      currentVault: { root: '/srv/workspace', name: 'workspace' },
      workspaceMode: 'remote',
      remoteWorkspaceInfo: {
        mode: 'remote',
        baseUrl: 'https://home.example.com',
        authConfigured: true,
        capabilities: null,
        profileId: 'home'
      }
    })

    const current = entries.find((entry) => entry.current)
    expect(current?.name).toBe('Home')
  })
})

describe('newWindowVaultRows (#244)', () => {
  it('lists known local vaults then a Browse fallback, dropping remotes', () => {
    const entries = buildVaultSwitcherEntries({
      localVaults: [
        { root: '/vaults/work', name: 'Work', lastOpenedAt: 2 },
        { root: '/vaults/personal', name: 'Personal', lastOpenedAt: 3 }
      ],
      remoteProfiles: [
        {
          id: 'r1',
          name: 'Server',
          baseUrl: 'https://example.com',
          hasCredential: true,
          vaultPath: '/srv',
          lastConnectedAt: 1
        }
      ],
      currentVault: { root: '/vaults/personal', name: 'Personal' },
      workspaceMode: 'local',
      remoteWorkspaceInfo: null
    })

    const rows = newWindowVaultRows(entries)
    // Remote entry dropped; local vaults kept in order; Browse row appended last.
    expect(rows.map((r) => r.kind)).toEqual(['local', 'local', 'browse'])
    expect(rows.at(-1)).toMatchObject({ kind: 'browse', current: false })
  })

  it('returns just the Browse row when there are no known vaults', () => {
    const rows = newWindowVaultRows([])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('browse')
  })
})
