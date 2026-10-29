import { describe, expect, it } from 'vitest'
import {
  cloudSyncConflictCopyPath,
  cloudSyncLegacyConflictOriginalPath,
  cloudSyncPathFitsCloud,
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

describe('cloudSyncLegacyConflictOriginalPath', () => {
  it('recognizes old generated copies and reconstructs the likely original path', () => {
    expect(cloudSyncLegacyConflictOriginalPath('inbox/Note (cloud conflict).md')).toBe(
      'inbox/Note.md'
    )
    expect(cloudSyncLegacyConflictOriginalPath('Note (cloud conflict 3).md')).toBe('Note.md')
    expect(cloudSyncLegacyConflictOriginalPath('Plan (cloud conflict).tar.gz')).toBe(
      'Plan.tar.gz'
    )
    expect(cloudSyncLegacyConflictOriginalPath('.gitignore (cloud conflict)')).toBe('.gitignore')
  })

  it('does not label ordinary filenames as old conflict copies', () => {
    expect(cloudSyncLegacyConflictOriginalPath('My cloud conflict notes.md')).toBeNull()
    expect(cloudSyncLegacyConflictOriginalPath('Note (cloud conflict 1).md')).toBeNull()
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
    '.zennotes/agent-edits/inbox/Note.md.json',
    '.zennotes/note-metadata/inbox/Note.md.metadata.json',
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
    '.zennotes/agent-edits/inbox/Note.md.json.6f1c2a.tmp',
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
    'node_modules/package/index.js',
    'zennotes-cloud-sync/links/vault.json',
    'zennotes-cloud-sync/states/vault/account/state.json',
    'zennotes-cloud-sync/scan-cache/vault.json',
    'zennotes-cloud-sync/retired-states/previous.json',
    'Documents/zennotes-cloud-sync/states/vault.json',
    'ZENNOTES-CLOUD-SYNC/states/vault.json'
  ])('excludes device-local or temporary file %s', (path) => {
    expect(shouldSyncVaultPath(path)).toBe(false)
  })

  // A SYNCED COPY of Cloud's list. The website repo's
  // tests/Feature/Api/SyncApiTest.php ("the server accepts every internal path
  // the desktop client uploads") holds the same dataset for
  // VaultPathService::shouldSync. A path this client uploads and Cloud
  // refuses once failed every sync of that vault (#1004), so a row added or
  // changed here is added or changed there, in the same words, and the other
  // way round. Since 2.80 sync sets a refused path aside instead of stopping,
  // but the file still never reaches Cloud.
  //
  // The length rows are this side's only: Cloud caps a path in its request
  // rules (max:1024 on mutations.*.path and on a direct upload's path), not
  // in shouldSync, and this client holds such a path itself rather than
  // leave it out of the scan (cloudSyncPathFitsCloud).
  it.each([
    ['vault settings', '.zennotes/vault.json', true],
    ['comments', '.zennotes/comments/inbox/Note.md.comments.json', true],
    ['assistant edit record', '.zennotes/agent-edits/inbox/Note.md.json', true],
    ['creation metadata', '.zennotes/note-metadata/inbox/Note.md.metadata.json', true],
    ['templates', '.zennotes/templates/Meeting.md', true],
    ['workflows', '.zennotes/workflows/Daily.workflow', true],
    ['an assistant edit that is not json', '.zennotes/agent-edits/inbox/Note.md.tmp', false],
    ['sync state', '.zennotes/sync/cursor.json', false],
    ['a path of 1,024 characters', `${'abcdefghi/'.repeat(102)}a.md`, true],
    ['a path of 1,025 characters', `${'abcdefghi/'.repeat(102)}ab.md`, false],
    // Cloud counts characters, not UTF-16 units: 2,045 units here.
    ['a path of 1,024 characters outside the BMP', `${'😀'.repeat(1021)}.md`, true]
  ] as const)('agrees with Cloud about %s', (_name, path, synced) => {
    expect(shouldSyncVaultPath(path) && cloudSyncPathFitsCloud(path)).toBe(synced)
  })

  it('prunes repository metadata and dependency directories during traversal', () => {
    expect(shouldTraverseCloudSyncDirectory('notes')).toBe(true)
    expect(shouldTraverseCloudSyncDirectory('.zennotes/templates')).toBe(true)
    expect(shouldTraverseCloudSyncDirectory('.git')).toBe(false)
    expect(shouldTraverseCloudSyncDirectory('project/node_modules')).toBe(false)
    expect(shouldTraverseCloudSyncDirectory('zennotes-cloud-sync')).toBe(false)
    expect(shouldTraverseCloudSyncDirectory('Documents/ZENNOTES-CLOUD-SYNC/states')).toBe(false)
    expect(shouldSyncVaultPath('notes/zennotes-cloud-sync-guide.md')).toBe(true)
  })
})
