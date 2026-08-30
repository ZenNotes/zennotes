import { describe, expect, it } from 'vitest'
import {
  cloudSyncConflictCopyPath,
  cloudSyncPathKey,
  isCloudSyncVaultSettingsPath,
  normalizeCloudSyncPath,
  shouldTraverseCloudSyncDirectory,
  shouldSyncVaultPath
} from './cloud-sync'

describe('normalizeCloudSyncPath', () => {
  it('normalizes separators and unicode without changing the visible path', () => {
    expect(normalizeCloudSyncPath('inbox\\Cafe\u0301.md')).toBe('inbox/Café.md')
  })

  it.each(['', '/inbox/Note.md', 'inbox/', 'inbox/../Note.md', './Note.md', 'C:\\Note.md'])(
    'rejects unsafe file path %s',
    (path) => {
      expect(() => normalizeCloudSyncPath(path)).toThrow('Invalid sync path')
    }
  )
})

describe('cloudSyncPathKey', () => {
  it('uses a case-insensitive unicode-normalized collision key', () => {
    expect(cloudSyncPathKey('Inbox/Cafe\u0301.md')).toBe(cloudSyncPathKey('inbox/CAFÉ.md'))
  })
})

describe('cloudSyncConflictCopyPath', () => {
  it('keeps the extension so the copy opens like the original', () => {
    expect(cloudSyncConflictCopyPath('inbox/Note.md', 1)).toBe('inbox/Note (cloud conflict).md')
    expect(cloudSyncConflictCopyPath('inbox/Note.md', 3)).toBe('inbox/Note (cloud conflict 3).md')
    expect(cloudSyncConflictCopyPath('Note.md', 1)).toBe('Note (cloud conflict).md')
  })

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(cloudSyncConflictCopyPath('.gitignore', 1)).toBe('.gitignore (cloud conflict)')
  })
})

describe('isCloudSyncVaultSettingsPath', () => {
  it('matches only the vault settings file', () => {
    expect(isCloudSyncVaultSettingsPath('.zennotes/vault.json')).toBe(true)
    expect(isCloudSyncVaultSettingsPath('.zennotes/vault.cloud-conflict.json')).toBe(false)
    expect(isCloudSyncVaultSettingsPath('inbox/vault.json')).toBe(false)
  })
})

describe('shouldSyncVaultPath', () => {
  it.each([
    'inbox/Note.md',
    'Projects/Database.csv',
    'Projects/Database.csv.base.json',
    'assets/diagram.png',
    '.zennotes/vault.json',
    '.zennotes/comments/inbox/Note.md.comments.json',
    '.zennotes/templates/meeting.md',
    '.zennotes/workflows/review.json'
  ])('includes user-authored vault file %s', (path) => {
    expect(shouldSyncVaultPath(path)).toBe(true)
  })

  it.each([
    '.DS_Store',
    'Thumbs.db',
    'inbox/Note.md.tmp',
    'inbox/2026-08-26 Wed.md.3252272.1787800172047252.tmp',
    'inbox/Note.md.bak',
    '.zennotes/workspace.json',
    '.zennotes/mobile-note-meta-cache-v1.json',
    '.zennotes/deleted-assets/token/file.png',
    '.zennotes/sync/device-state.json',
    '.zennotes/unknown-runtime-cache.json',
    // The cloud's settings waiting for an answer are this device's business,
    // and uploading them would hand the question to every other device too.
    '.zennotes/vault.cloud-conflict.json',
    '.git/config',
    'vendor/project/.svn/entries',
    'node_modules/package/index.js'
  ])('excludes device-local or temporary file %s', (path) => {
    expect(shouldSyncVaultPath(path)).toBe(false)
  })

  it('prunes repository metadata and dependency directories during traversal', () => {
    expect(shouldTraverseCloudSyncDirectory('notes')).toBe(true)
    expect(shouldTraverseCloudSyncDirectory('.zennotes/templates')).toBe(true)
    expect(shouldTraverseCloudSyncDirectory('.git')).toBe(false)
    expect(shouldTraverseCloudSyncDirectory('project/node_modules')).toBe(false)
  })
})
