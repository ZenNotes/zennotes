import { describe, expect, it } from 'vitest'
import type { VaultBackend } from '../cli/backend'
import { RemoteRequestError } from '../main/remote/connection'
import { callTool, describeToolError, listToolNames } from './server'

// Only the members a given test reaches are implemented; the cast keeps the
// stubs honest about being partial.
function backend(partial: Partial<VaultBackend>): VaultBackend {
  return partial as VaultBackend
}

describe('vault_info (#688)', () => {
  it('describes a server-backed vault as remote, with the auth state and no disk paths', async () => {
    const info = (await callTool(
      'vault_info',
      {},
      backend({
        kind: 'remote',
        describe: async () => ({
          kind: 'remote',
          baseUrl: 'http://192.168.1.10:7878',
          name: 'home',
          vaultPath: '/srv/notes',
          vaultName: 'notes',
          primaryNotesLocation: 'inbox',
          authConfigured: false
        }),
        listFolders: async () => [{ folder: 'inbox', subpath: 'Work' }]
      })
    )) as Record<string, unknown>
    expect(info).toMatchObject({
      kind: 'remote',
      server: 'http://192.168.1.10:7878',
      serverName: 'home',
      vaultPath: '/srv/notes',
      vaultName: 'notes',
      primaryNotesLocation: 'inbox',
      authConfigured: false,
      subfolders: [{ folder: 'inbox', subpath: 'Work' }]
    })
    expect(info).not.toHaveProperty('vaultRoot')
    expect(String(info.notes)).toContain('ZENNOTES_REMOTE_TOKEN')
    expect(String(info.notes)).toContain('INBOX mode')
  })

  it('keeps the local shape (vaultRoot, inboxAbsolutePath) for a folder vault', async () => {
    const info = (await callTool(
      'vault_info',
      {},
      backend({
        kind: 'local',
        describe: async () => ({
          kind: 'local',
          root: '/home/me/notes',
          primaryNotesLocation: 'root'
        }),
        listFolders: async () => []
      })
    )) as Record<string, unknown>
    expect(info).toMatchObject({
      kind: 'local',
      vaultRoot: '/home/me/notes',
      inboxAbsolutePath: '/home/me/notes',
      primaryNotesLocation: 'root'
    })
    expect(String(info.notes)).toContain('ROOT mode')
    expect(String(info.notes)).not.toContain('ZENNOTES_REMOTE_TOKEN')
  })
})

describe('tools run through the backend', () => {
  it('routes a write through the backend rather than the filesystem', async () => {
    const calls: unknown[] = []
    const result = await callTool(
      'append_to_note',
      { path: 'inbox/Daily.md', text: '- item' },
      backend({
        appendToNote: async (rel, text) => {
          calls.push([rel, text])
          return { path: rel, title: 'Daily' } as never
        }
      })
    )
    expect(calls).toEqual([['inbox/Daily.md', '- item']])
    expect(result).toMatchObject({ path: 'inbox/Daily.md' })
  })

  it('exposes every tool the server advertised before the refactor', () => {
    expect(listToolNames()).toEqual([
      'vault_info',
      'list_notes',
      'list_folders',
      'list_assets',
      'read_note',
      'write_note',
      'create_note',
      'rename_note',
      'move_note',
      'duplicate_note',
      'move_to_trash',
      'restore_from_trash',
      'empty_trash',
      'delete_note',
      'archive_note',
      'unarchive_note',
      'create_folder',
      'rename_folder',
      'delete_folder',
      'search_text',
      'search_by_title',
      'search_by_tag',
      'list_tags',
      'backlinks',
      'list_tasks',
      'toggle_task',
      'append_to_note',
      'prepend_to_note',
      'insert_at_line',
      'replace_in_note'
    ])
  })
})

describe('describeToolError', () => {
  it('turns a 401 from the server into the token hint', () => {
    const text = describeToolError(
      new RemoteRequestError('The ZenNotes server rejected the connection.', 401)
    )
    expect(text).toContain('rejected the connection')
    expect(text).toContain('ZENNOTES_REMOTE_TOKEN')
  })
  it('passes other errors through untouched', () => {
    expect(describeToolError(new Error('boom'))).toBe('boom')
    expect(describeToolError(new RemoteRequestError('nope', 500))).toBe('nope')
  })
})
