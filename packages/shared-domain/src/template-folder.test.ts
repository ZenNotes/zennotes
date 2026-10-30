import { describe, expect, it } from 'vitest'
import {
  isPathInTemplateFolder,
  normalizeTemplateFolder,
  normalizeTemplateFolderSettings,
  outsideTemplateFolder,
  resolveTemplateFolder,
  rewriteTemplateFolderForRename,
  templateFolderEntryKey
} from './template-folder'

describe('normalizeTemplateFolder', () => {
  it('keeps a vault-relative directory path as it exists on disk', () => {
    expect(normalizeTemplateFolder('Templates')).toBe('Templates')
    expect(normalizeTemplateFolder('inbox/Templates')).toBe('inbox/Templates')
    expect(normalizeTemplateFolder('  Meta / My Templates ')).toBe('Meta/My Templates')
    expect(normalizeTemplateFolder('/Templates/')).toBe('Templates')
    expect(normalizeTemplateFolder('Meta\\Templates')).toBe('Meta/Templates')
    expect(normalizeTemplateFolder('Meta//Templates')).toBe('Meta/Templates')
  })

  it('refuses traversal, hidden folders, and anything that is not a path', () => {
    for (const bad of [
      '',
      '   ',
      '/',
      '.',
      '..',
      '../Templates',
      'Templates/..',
      '.zennotes/templates',
      'Meta/.hidden',
      42,
      null,
      undefined,
      ['Templates'],
      { folder: 'Templates' }
    ]) {
      expect(normalizeTemplateFolder(bad)).toBeNull()
    }
  })

  it('refuses a path longer than the vault layer accepts', () => {
    expect(normalizeTemplateFolder('a'.repeat(512))).toBe('a'.repeat(512))
    expect(normalizeTemplateFolder('a'.repeat(513))).toBeNull()
  })
})

describe('normalizeTemplateFolderSettings', () => {
  it('carries a valid folder and drops the section otherwise', () => {
    expect(normalizeTemplateFolderSettings({ folder: ' Templates/ ' })).toEqual({
      folder: 'Templates'
    })
    expect(normalizeTemplateFolderSettings({ folder: '' })).toBeUndefined()
    expect(normalizeTemplateFolderSettings({ folder: '../x' })).toBeUndefined()
    expect(normalizeTemplateFolderSettings({})).toBeUndefined()
    expect(normalizeTemplateFolderSettings('Templates')).toBeUndefined()
    expect(normalizeTemplateFolderSettings(['Templates'])).toBeUndefined()
    expect(normalizeTemplateFolderSettings(null)).toBeUndefined()
  })

  it('keeps only the folder, so a stray key never reaches vault.json', () => {
    expect(normalizeTemplateFolderSettings({ folder: 'Templates', extra: 1 })).toEqual({
      folder: 'Templates'
    })
  })
})

describe('resolveTemplateFolder', () => {
  it('reads the folder off vault settings, or null when none is set', () => {
    expect(resolveTemplateFolder({ templates: { folder: 'Templates' } })).toBe('Templates')
    expect(resolveTemplateFolder({ templates: { folder: '.zennotes' } })).toBeNull()
    expect(resolveTemplateFolder({ templates: undefined })).toBeNull()
    expect(resolveTemplateFolder({})).toBeNull()
    expect(resolveTemplateFolder(null)).toBeNull()
    expect(resolveTemplateFolder(undefined)).toBeNull()
  })
})

describe('isPathInTemplateFolder', () => {
  it('matches the folder and everything below it, by whole segments', () => {
    expect(isPathInTemplateFolder('Templates/Meeting.md', 'Templates')).toBe(true)
    expect(isPathInTemplateFolder('Templates/Work/Standup.md', 'Templates')).toBe(true)
    expect(isPathInTemplateFolder('Templates Old/Meeting.md', 'Templates')).toBe(false)
    expect(isPathInTemplateFolder('TemplatesX.md', 'Templates')).toBe(false)
    expect(isPathInTemplateFolder('inbox/Templates/Meeting.md', 'Templates')).toBe(false)
    expect(isPathInTemplateFolder('inbox/Templates/Meeting.md', 'inbox/Templates')).toBe(true)
  })

  it('is case-sensitive like the rest of the vault layer', () => {
    expect(isPathInTemplateFolder('templates/Meeting.md', 'Templates')).toBe(false)
  })

  it('matches nothing without a folder', () => {
    expect(isPathInTemplateFolder('Templates/Meeting.md', null)).toBe(false)
    expect(isPathInTemplateFolder('Templates/Meeting.md', undefined)).toBe(false)
    expect(isPathInTemplateFolder('Templates/Meeting.md', '')).toBe(false)
  })
})

describe('templateFolderEntryKey', () => {
  it('names a template by its path inside the folder, without the extension', () => {
    expect(templateFolderEntryKey('Templates/Meeting.md', 'Templates')).toBe('Meeting')
    expect(templateFolderEntryKey('Templates/Work/Standup.MD', 'Templates')).toBe('Work/Standup')
    expect(templateFolderEntryKey('inbox/Templates/Daily.md', 'inbox/Templates')).toBe('Daily')
  })

  it('returns null for a path outside the folder', () => {
    expect(templateFolderEntryKey('Notes/Meeting.md', 'Templates')).toBeNull()
    expect(templateFolderEntryKey('Templates', 'Templates')).toBeNull()
  })
})

describe('rewriteTemplateFolderForRename', () => {
  it('follows the folder, or a folder above it, to its new path', () => {
    expect(rewriteTemplateFolderForRename({ folder: 'Templates' }, 'Templates', 'Blueprints')).toEqual(
      { folder: 'Blueprints' }
    )
    expect(
      rewriteTemplateFolderForRename({ folder: 'Meta/Templates' }, 'Meta', 'Archive/Meta')
    ).toEqual({ folder: 'Archive/Meta/Templates' })
  })

  it('leaves the setting alone when the rename is somewhere else', () => {
    const settings = { folder: 'Templates' }
    expect(rewriteTemplateFolderForRename(settings, 'Templates Old', 'Old')).toBe(settings)
    expect(rewriteTemplateFolderForRename(settings, 'Templates/Work', 'Templates/Jobs')).toBe(
      settings
    )
    expect(rewriteTemplateFolderForRename(undefined, 'Templates', 'X')).toBeUndefined()
    expect(rewriteTemplateFolderForRename(settings, 'Templates', 'Templates')).toBe(settings)
  })
})

describe('outsideTemplateFolder: what the tag surfaces count (#1024)', () => {
  const notes = [
    { path: 'Notes.md' },
    { path: 'Templates/Meeting.md' },
    { path: 'Templates/Work/Retro.md' },
    { path: 'Templates Old/Kept.md' }
  ]

  it('leaves the template folder out, subfolders included, and nothing else', () => {
    expect(outsideTemplateFolder(notes, 'Templates').map((n) => n.path)).toEqual([
      'Notes.md',
      'Templates Old/Kept.md'
    ])
  })

  it('hands back the same list when the vault has no template folder', () => {
    expect(outsideTemplateFolder(notes, null)).toBe(notes)
    expect(outsideTemplateFolder(notes, undefined)).toBe(notes)
  })
})
