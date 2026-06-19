import { describe, expect, it } from 'vitest'
import type { NoteMeta, VaultSettings } from '@shared/ipc'
import {
  assetBelongsToFolderView,
  assetFolderSubpath,
  classifyDateNote,
  dailyNoteLocationForDate,
  dateNoteFolderMayBelongToDatePattern,
  dateNoteDirectoryDisplayLabel,
  favoriteFolderKey,
  folderForVaultRelativePath,
  isFavoriteFolderKey,
  noteFolderSubpath,
  normalizeVaultSettings,
  parseFavoriteFolderKey,
  removeFavoritesForFolder,
  rewriteFavoriteNotePath,
  rewriteFavoritesForFolderRename,
  toggleFavorite,
  weeklyNoteLocationForDate
} from './vault-layout'

function note(path: string, title: string): NoteMeta {
  return {
    path,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: ''
  }
}

function settings(dailyDirectory: string, weeklyDirectory: string): VaultSettings {
  return {
    primaryNotesLocation: 'inbox',
    dailyNotes: { enabled: true, directory: dailyDirectory },
    weeklyNotes: { enabled: true, directory: weeklyDirectory },
    folderIcons: {},
    folderColors: {},
    favorites: []
  }
}

describe('classifyDateNote', () => {
  it('recognizes daily notes when the configured directory includes the primary inbox prefix', () => {
    const info = classifyDateNote(
      note('inbox/Journal/2026-06-12.md', '2026-06-12'),
      settings('inbox/Journal', 'Weekly Notes')
    )

    expect(info).toMatchObject({ kind: 'daily' })
    expect(info?.date).toEqual(new Date(2026, 5, 12))
  })

  it('recognizes weekly notes when the configured directory includes the primary inbox prefix', () => {
    const info = classifyDateNote(
      note('inbox/Weeks/2026-W24.md', '2026-W24'),
      settings('Daily Notes', 'inbox/Weeks')
    )

    expect(info).toMatchObject({ kind: 'weekly' })
    expect(info?.date).toEqual(new Date(2026, 5, 8))
  })

  it('recognizes weekly notes created from date-based directory and title patterns', () => {
    const info = classifyDateNote(
      note('inbox/2026/06-Jun/2026-W24-Mon.md', '2026-W24-Mon'),
      {
        primaryNotesLocation: 'inbox',
        dailyNotes: { enabled: false, directory: 'Daily Notes' },
        weeklyNotes: {
          enabled: true,
          directory: 'yyyy/MM-MMM',
          titlePattern: "yyyy-'W'ww-EEE",
          locale: 'en-US'
        },
        folderIcons: {},
        folderColors: {},
        favorites: []
      } as VaultSettings
    )

    expect(info).toMatchObject({ kind: 'weekly' })
    expect(info?.date).toEqual(new Date(2026, 5, 8))
  })

  it('recognizes daily notes created from date-based directory and title patterns', () => {
    const info = classifyDateNote(
      note('inbox/2026/06-Jun/2026-06-09-Tue.md', '2026-06-09-Tue'),
      {
        primaryNotesLocation: 'inbox',
        dailyNotes: {
          enabled: true,
          directory: 'yyyy/MM-MMM',
          titlePattern: 'yyyy-MM-dd-EEE',
          locale: 'en-US'
        },
        weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
        folderIcons: {},
        folderColors: {},
        favorites: []
      } as VaultSettings
    )

    expect(info).toMatchObject({ kind: 'daily' })
    expect(info?.date).toEqual(new Date(2026, 5, 9))
  })

  it('keeps existing lowercase daily directories literal', () => {
    const date = new Date(2026, 5, 9)
    const vaultSettings = settings('daily', 'Weekly Notes')

    expect(dailyNoteLocationForDate(date, vaultSettings)).toEqual({
      subpath: 'daily',
      title: '2026-06-09'
    })

    const info = classifyDateNote(note('inbox/daily/2026-06-09.md', '2026-06-09'), vaultSettings)

    expect(info).toMatchObject({ kind: 'daily' })
    expect(info?.date).toEqual(date)
  })

  it('renders daily note locations from date-based directory and title patterns', () => {
    const location = dailyNoteLocationForDate(new Date(2026, 5, 9), {
      primaryNotesLocation: 'inbox',
      dailyNotes: {
        enabled: true,
        directory: 'yyyy/MM-MMM',
        titlePattern: 'yyyy-MM-dd-EEE',
        locale: 'en-US'
      },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings)

    expect(location).toEqual({
      subpath: '2026/06-Jun',
      title: '2026-06-09-Tue'
    })
  })

  it('supports month-only daily directory patterns when the title supplies the date', () => {
    const vaultSettings = {
      primaryNotesLocation: 'inbox',
      dailyNotes: {
        enabled: true,
        directory: 'MM-MMM',
        titlePattern: 'yyyy-MM-dd',
        locale: 'en-US'
      },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings

    expect(dailyNoteLocationForDate(new Date(2026, 5, 9), vaultSettings)).toEqual({
      subpath: '06-Jun',
      title: '2026-06-09'
    })

    const info = classifyDateNote(
      note('inbox/06-Jun/2026-06-09.md', '2026-06-09'),
      vaultSettings
    )

    expect(info).toMatchObject({ kind: 'daily' })
    expect(info?.date).toEqual(new Date(2026, 5, 9))
  })

  it('renders quoted literals inside daily directory patterns', () => {
    const location = dailyNoteLocationForDate(new Date(2026, 5, 9), {
      primaryNotesLocation: 'inbox',
      dailyNotes: {
        enabled: true,
        directory: "'Daily Notes'/yyyy/MM-MMM",
        titlePattern: 'yyyy-MM-dd-EEE',
        locale: 'en-US'
      },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings)

    expect(location).toEqual({
      subpath: 'Daily Notes/2026/06-Jun',
      title: '2026-06-09-Tue'
    })
  })

  it('renders weekly note locations from date-based directory and title patterns', () => {
    const location = weeklyNoteLocationForDate(new Date(2026, 5, 9), {
      primaryNotesLocation: 'inbox',
      dailyNotes: { enabled: false, directory: 'Daily Notes' },
      weeklyNotes: {
        enabled: true,
        directory: "'Weekly Notes'/yyyy/MM-MMM",
        titlePattern: "yyyy-'W'ww-EEE",
        locale: 'en-US'
      },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings)

    expect(location).toEqual({
      subpath: 'Weekly Notes/2026/06-Jun',
      title: '2026-W24-Mon'
    })
  })

  it('uses the ISO week-year for weekly pattern years', () => {
    const location = weeklyNoteLocationForDate(new Date(2021, 0, 1), {
      primaryNotesLocation: 'inbox',
      dailyNotes: { enabled: false, directory: 'Daily Notes' },
      weeklyNotes: {
        enabled: true,
        directory: 'yyyy',
        titlePattern: "yyyy-'W'ww",
        locale: 'en-US'
      },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings)

    expect(location).toEqual({
      subpath: '2020',
      title: '2020-W53'
    })
  })

  it('supports ISO week-only weekly directory patterns', () => {
    const location = weeklyNoteLocationForDate(new Date(2026, 5, 9), {
      primaryNotesLocation: 'inbox',
      dailyNotes: { enabled: false, directory: 'Daily Notes' },
      weeklyNotes: {
        enabled: true,
        directory: 'ww',
        titlePattern: "yyyy-'W'ww",
        locale: 'en-US'
      },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings)

    expect(location).toEqual({
      subpath: '24',
      title: '2026-W24'
    })
  })

  it('keeps existing lowercase weekly directories literal', () => {
    const vaultSettings = {
      primaryNotesLocation: 'inbox',
      dailyNotes: { enabled: false, directory: 'Daily Notes' },
      weeklyNotes: {
        enabled: true,
        directory: 'week',
        titlePattern: "yyyy-'W'ww",
        locale: 'en-US'
      },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings

    expect(weeklyNoteLocationForDate(new Date(2026, 5, 9), vaultSettings)).toEqual({
      subpath: 'week',
      title: '2026-W24'
    })

    const info = classifyDateNote(note('inbox/week/2026-W24.md', '2026-W24'), vaultSettings)

    expect(info).toMatchObject({ kind: 'weekly' })
    expect(info?.date).toEqual(new Date(2026, 5, 8))
  })

  it('recognizes a daily note whose title encodes the day via ISO week and weekday', () => {
    // The title carries no day-of-month token; the day is implied by the ISO
    // week (`ww`) plus the weekday name (`EEE`). 2026-W24-Fri is Fri Jun 12.
    const vaultSettings = {
      primaryNotesLocation: 'inbox',
      dailyNotes: {
        enabled: true,
        directory: 'yyyy/MM-MMM',
        titlePattern: "yyyy-'W'ww-EEE",
        locale: 'en-US'
      },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings

    const info = classifyDateNote(
      note('inbox/2026/06-Jun/2026-W24-Fri.md', '2026-W24-Fri'),
      vaultSettings
    )

    expect(info).toMatchObject({ kind: 'daily' })
    expect(info?.date).toEqual(new Date(2026, 5, 12))
  })

  it('recognizes a daily note when the year comes only from the directory', () => {
    const vaultSettings = {
      primaryNotesLocation: 'inbox',
      dailyNotes: {
        enabled: true,
        directory: 'yyyy',
        titlePattern: 'MM-dd',
        locale: 'en-US'
      },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings

    const info = classifyDateNote(note('inbox/2026/06-09.md', '06-09'), vaultSettings)

    expect(info).toMatchObject({ kind: 'daily' })
    expect(info?.date).toEqual(new Date(2026, 5, 9))
  })

  it('does not classify a note whose directory and title disagree on the date', () => {
    const vaultSettings = {
      primaryNotesLocation: 'inbox',
      dailyNotes: {
        enabled: true,
        directory: 'yyyy/MM-MMM',
        titlePattern: "yyyy-'W'ww-EEE",
        locale: 'en-US'
      },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings

    // ISO week 24 falls entirely in June, so a July folder cannot round-trip.
    const info = classifyDateNote(
      note('inbox/2026/07-Jul/2026-W24-Fri.md', '2026-W24-Fri'),
      vaultSettings
    )

    expect(info).toBeNull()
  })

  it('recognizes daily notes from legacy patterns after the active pattern changes', () => {
    const vaultSettings = {
      primaryNotesLocation: 'inbox',
      dailyNotes: {
        enabled: true,
        directory: 'yyyy/MM-MMM',
        titlePattern: 'yyyy-MM-dd-EEE',
        locale: 'en-US',
        legacyPatterns: [
          { directory: 'Daily Notes', titlePattern: 'yyyy-MM-dd', locale: 'en-US' }
        ]
      },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings

    const info = classifyDateNote(
      note('inbox/Daily Notes/2026-06-12.md', '2026-06-12'),
      vaultSettings
    )

    expect(info).toMatchObject({ kind: 'daily' })
    expect(info?.date).toEqual(new Date(2026, 5, 12))
  })

  it('recognizes weekly notes from legacy patterns after the active pattern changes', () => {
    const vaultSettings = {
      primaryNotesLocation: 'inbox',
      dailyNotes: { enabled: false, directory: 'Daily Notes' },
      weeklyNotes: {
        enabled: true,
        directory: 'yyyy/MM-MMM',
        titlePattern: "yyyy-'W'ww-EEE",
        locale: 'en-US',
        legacyPatterns: [
          { directory: 'Weekly Notes', titlePattern: "yyyy-'W'ww", locale: 'en-US' }
        ]
      },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings

    const info = classifyDateNote(
      note('inbox/Weekly Notes/2026-W24.md', '2026-W24'),
      vaultSettings
    )

    expect(info).toMatchObject({ kind: 'weekly' })
    expect(info?.date).toEqual(new Date(2026, 5, 8))
  })
})

describe('dateNoteDirectoryDisplayLabel', () => {
  it('uses the fallback label for fully date-based directory patterns', () => {
    expect(dateNoteDirectoryDisplayLabel('yyyy/MM-MMM', 'Daily Notes')).toBe('Daily Notes')
  })

  it('uses quoted literal directory segments as the label', () => {
    expect(dateNoteDirectoryDisplayLabel("'Journal'/yyyy/MM-MMM", 'Daily Notes')).toBe('Journal')
  })

  it('keeps literal legacy directories unchanged', () => {
    expect(dateNoteDirectoryDisplayLabel('week', 'Weekly Notes')).toBe('week')
  })
})

describe('dateNoteFolderMayBelongToDatePattern', () => {
  it('matches active and legacy date-pattern folders for sidebar pruning', () => {
    const vaultSettings = {
      primaryNotesLocation: 'inbox',
      dailyNotes: {
        enabled: true,
        directory: 'yyyy/MMM-MMM',
        titlePattern: 'yyyy-MM-dd-EEE',
        locale: 'en-US',
        legacyPatterns: [
          { directory: 'Daily Notes', titlePattern: 'yyyy-MM-dd', locale: 'en-US' }
        ]
      },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    } as VaultSettings

    expect(dateNoteFolderMayBelongToDatePattern('2026/Jun-Jun', vaultSettings)).toBe(true)
    expect(dateNoteFolderMayBelongToDatePattern('Daily Notes', vaultSettings)).toBe(true)
    expect(dateNoteFolderMayBelongToDatePattern('Projects', vaultSettings)).toBe(false)
  })
})

describe('folderForVaultRelativePath — case-insensitive system folders (#186)', () => {
  // On case-insensitive filesystems, `listAssets` preserves the on-disk casing
  // (`Inbox/photo.png`) while notes always arrive canonical-lowercased
  // (`inbox/note.md`). Both must classify to the same folder, or the browser
  // shows the markdown but hides the images/PDFs.
  const inboxMode = { primaryNotesLocation: 'inbox' } as VaultSettings

  it('classifies a capitalized inbox folder the same as lowercase', () => {
    expect(folderForVaultRelativePath('inbox/photo.png', inboxMode)).toBe('inbox')
    expect(folderForVaultRelativePath('Inbox/photo.png', inboxMode)).toBe('inbox')
    expect(folderForVaultRelativePath('INBOX/photo.png', inboxMode)).toBe('inbox')
  })

  it('matches the other system folders case-insensitively too', () => {
    expect(folderForVaultRelativePath('Archive/scan.pdf', inboxMode)).toBe('archive')
    expect(folderForVaultRelativePath('Quick/clip.png', inboxMode)).toBe('quick')
    expect(folderForVaultRelativePath('Trash/old.png', inboxMode)).toBe('trash')
  })

  it('still returns null for a non-system root folder in inbox mode', () => {
    expect(folderForVaultRelativePath('Random/photo.png', inboxMode)).toBeNull()
  })

  it('keeps a capitalized asset in the same subpath tree as its notes', () => {
    // A note under a capital `Inbox/Projects/` resolves to subpath `Projects`
    // (folder is assigned authoritatively by the main-process walk); the asset
    // under the same folder must resolve to the identical `Projects`.
    expect(noteFolderSubpath({ folder: 'inbox', path: 'Inbox/Projects/n.md' }, inboxMode)).toBe(
      'Projects'
    )
    expect(assetFolderSubpath({ path: 'Inbox/Projects/photo.png' }, inboxMode)).toBe('Projects')
    expect(
      assetBelongsToFolderView({ path: 'Inbox/Projects/photo.png' }, 'inbox', 'Projects', inboxMode)
    ).toBe(true)
    expect(assetBelongsToFolderView({ path: 'Inbox/photo.png' }, 'inbox', '', inboxMode)).toBe(true)
    // A top-level note in a capital `Inbox/` is at the root of the view, not
    // nested under a phantom `Inbox` subfolder.
    expect(noteFolderSubpath({ folder: 'inbox', path: 'Inbox/n.md' }, inboxMode)).toBe('')
  })
})

describe('favorites', () => {
  it('discriminates folder keys from note paths by the colon', () => {
    expect(isFavoriteFolderKey('inbox:Projects')).toBe(true)
    expect(isFavoriteFolderKey('inbox:')).toBe(true) // top-level folder key
    expect(isFavoriteFolderKey('inbox/Idea.md')).toBe(false)
    expect(favoriteFolderKey('inbox', 'Projects')).toBe('inbox:Projects')
    expect(parseFavoriteFolderKey('inbox:Projects/Sub')).toEqual({
      folder: 'inbox',
      subpath: 'Projects/Sub'
    })
    expect(parseFavoriteFolderKey('inbox/Idea.md')).toBeNull()
  })

  it('toggles a key on and off', () => {
    expect(toggleFavorite([], 'inbox/A.md')).toEqual(['inbox/A.md'])
    expect(toggleFavorite(['inbox/A.md', 'x:y'], 'inbox/A.md')).toEqual(['x:y'])
    // Added at the end, preserving order.
    expect(toggleFavorite(['x:y'], 'inbox/A.md')).toEqual(['x:y', 'inbox/A.md'])
  })

  it('rewrites a note favorite when the note is renamed/moved', () => {
    const favs = ['inbox/A.md', 'inbox:Projects']
    expect(rewriteFavoriteNotePath(favs, 'inbox/A.md', 'inbox/B.md')).toEqual([
      'inbox/B.md',
      'inbox:Projects'
    ])
    // Unaffected favorites return the same reference (no needless persist).
    expect(rewriteFavoriteNotePath(favs, 'inbox/Z.md', 'inbox/Q.md')).toBe(favs)
  })

  it('repoints favorites when a folder is renamed', () => {
    const favs = ['inbox:Projects', 'inbox:Projects/Sub', 'inbox/Projects/note.md', 'quick:Keep']
    const next = rewriteFavoritesForFolderRename(
      favs,
      'inbox',
      'Projects',
      'Work',
      'inbox/Projects/',
      'inbox/Work/'
    )
    expect(next).toEqual(['inbox:Work', 'inbox:Work/Sub', 'inbox/Work/note.md', 'quick:Keep'])
  })

  it('removes favorites for a deleted folder and its notes', () => {
    const favs = ['inbox:Projects', 'inbox:Projects/Sub', 'inbox/Projects/note.md', 'inbox/Other.md']
    expect(
      removeFavoritesForFolder(favs, 'inbox', 'Projects', 'inbox/Projects/')
    ).toEqual(['inbox/Other.md'])
  })

  it('normalizes favorites: drops empties/dupes, keeps order', () => {
    const settings = normalizeVaultSettings({
      favorites: ['inbox/A.md', '', 'inbox/A.md', 'inbox:Projects']
    } as unknown as VaultSettings)
    expect(settings.favorites).toEqual(['inbox/A.md', 'inbox:Projects'])
  })

  it('defaults favorites to an empty array', () => {
    const settings = normalizeVaultSettings({} as unknown as VaultSettings)
    expect(settings.favorites).toEqual([])
  })
})
