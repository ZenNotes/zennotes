import { describe, expect, it } from 'vitest'
import type { NoteFolder, NoteMeta, VaultSettings } from '@shared/ipc'
import type { NoteCover } from '@shared/note-cover'
import { gradientCoverDataUrl, NOTE_COVER_GRADIENTS } from '@shared/note-cover-gradients'
import {
  GALLERY_CARD_TEXT_HEIGHT,
  filterGalleryNotes,
  formatGalleryDate,
  galleryCardTimestamp,
  galleryContentHeight,
  galleryFolderExists,
  galleryFolderFromTabPath,
  galleryFolderName,
  galleryFolderOfNote,
  galleryGeometry,
  galleryInitial,
  galleryNotesIn,
  galleryRowRange,
  galleryScrollTopFor,
  galleryTabPath,
  galleryThumbnail,
  isGalleryTabPath,
  normalizeGallerySort,
  resolveGalleryFolderArgument,
  rewriteGalleryTabPath,
  sortGalleryNotes,
  stepGalleryCursor,
  unsplashThumbnailUrl
} from './folder-gallery'

const INBOX_MODE = { primaryNotesLocation: 'inbox', systemFolderPaths: {} } as unknown as VaultSettings
const ROOT_MODE = { primaryNotesLocation: 'root', systemFolderPaths: {} } as unknown as VaultSettings
const LABELS: Record<NoteFolder, string> = {
  inbox: 'Inbox',
  quick: 'Quick Notes',
  archive: 'Archive',
  trash: 'Trash'
}

function note(path: string, extra: Partial<NoteMeta> = {}): NoteMeta {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return {
    path,
    title: file.replace(/\.md$/i, ''),
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: '',
    ...extra
  }
}

function cover(target: NoteCover['target'], y = 0.5): NoteCover {
  return { key: 'banner', target, y }
}

describe('gallery tab paths', () => {
  it('round-trip a folder, nested subpaths and odd characters included', () => {
    for (const [folder, subpath] of [
      ['inbox', ''],
      ['inbox', 'Projects'],
      ['inbox', 'Projects/Web site'],
      ['archive', '2025/Q1 #1 & more'],
      ['quick', '']
    ] as Array<[NoteFolder, string]>) {
      const path = galleryTabPath(folder, subpath)
      expect(path.startsWith('zen://gallery/')).toBe(true)
      expect(isGalleryTabPath(path)).toBe(true)
      expect(galleryFolderFromTabPath(path)).toEqual({ folder, subpath })
    }
  })

  it('trims slashes so one folder has one tab', () => {
    expect(galleryTabPath('inbox', '/Projects/')).toBe(galleryTabPath('inbox', 'Projects'))
  })

  it('refuses paths that are not a gallery of a known folder', () => {
    expect(isGalleryTabPath('inbox/gallery.md')).toBe(false)
    expect(isGalleryTabPath(null)).toBe(false)
    expect(galleryFolderFromTabPath('zen://gallery/elsewhere/x')).toBeNull()
    expect(galleryFolderFromTabPath('zen://unresolved-links')).toBeNull()
  })

  it('names the folder by its last segment, or its label at the top', () => {
    expect(galleryFolderName({ folder: 'inbox', subpath: 'Projects/Website' }, LABELS)).toBe('Website')
    expect(galleryFolderName({ folder: 'quick', subpath: '' }, LABELS)).toBe('Quick Notes')
  })
})

describe('rewriteGalleryTabPath', () => {
  // The workspace's own rewrite for a folder rename: a `dir/` prefix swap.
  const renamer = (from: string, to: string | null) => (path: string): string | null =>
    path.startsWith(from) ? (to === null ? null : to + path.slice(from.length)) : path

  it('follows a renamed folder and the folders under it', () => {
    const rename = renamer('inbox/Projects/', 'inbox/Work/')
    expect(rewriteGalleryTabPath(galleryTabPath('inbox', 'Projects'), rename, INBOX_MODE)).toBe(
      galleryTabPath('inbox', 'Work')
    )
    expect(rewriteGalleryTabPath(galleryTabPath('inbox', 'Projects/Web'), rename, INBOX_MODE)).toBe(
      galleryTabPath('inbox', 'Work/Web')
    )
  })

  it('follows a rename in a root-mode vault, where the notes have no inbox/ prefix', () => {
    const rename = renamer('Projects/', 'Work/')
    expect(rewriteGalleryTabPath(galleryTabPath('inbox', 'Projects'), rename, ROOT_MODE)).toBe(
      galleryTabPath('inbox', 'Work')
    )
  })

  it('follows a rename inside a remapped archive', () => {
    const settings = {
      primaryNotesLocation: 'inbox',
      systemFolderPaths: { archive: '99 - Archive' }
    } as unknown as VaultSettings
    const rename = renamer('99 - Archive/2025/', '99 - Archive/Done/')
    expect(rewriteGalleryTabPath(galleryTabPath('archive', '2025'), rename, settings)).toBe(
      galleryTabPath('archive', 'Done')
    )
  })

  it('closes the gallery of a deleted folder and leaves others alone', () => {
    const remove = renamer('inbox/Projects/', null)
    expect(rewriteGalleryTabPath(galleryTabPath('inbox', 'Projects'), remove, INBOX_MODE)).toBeNull()
    const other = galleryTabPath('inbox', 'Recipes')
    expect(rewriteGalleryTabPath(other, remove, INBOX_MODE)).toBe(other)
    const top = galleryTabPath('inbox', '')
    expect(rewriteGalleryTabPath(top, remove, INBOX_MODE)).toBe(top)
  })

  it('passes any other tab through', () => {
    expect(rewriteGalleryTabPath('inbox/Projects/a.md', () => null, INBOX_MODE)).toBe('inbox/Projects/a.md')
  })
})

describe('galleryNotesIn', () => {
  const notes = [
    note('inbox/Recipes/Pasta.md'),
    note('inbox/Recipes/Soup.md'),
    note('inbox/Recipes/Desserts/Cake.md'),
    note('inbox/Recipes/Desserts/Deep/Tart.md'),
    note('inbox/Recipes/Sketch.excalidraw'),
    note('inbox/Recipes/Board.excalidraw.md'),
    note('inbox/Recipes/Pantry.base/pages/Flour.md'),
    note('inbox/Recipesque/Other.md'),
    note('inbox/Top.md'),
    note('archive/Recipes/Old.md', { folder: 'archive' })
  ]
  const recipes = { folder: 'inbox' as const, subpath: 'Recipes' }

  it('holds the folder’s own notes by default, without drawings', () => {
    expect(galleryNotesIn(notes, recipes, false, INBOX_MODE).map((n) => n.title)).toEqual([
      'Pasta',
      'Soup'
    ])
  })

  it('adds every note below it with subfolders on, but no database record pages', () => {
    expect(galleryNotesIn(notes, recipes, true, INBOX_MODE).map((n) => n.title)).toEqual([
      'Pasta',
      'Soup',
      'Cake',
      'Tart'
    ])
  })

  it('never mistakes a sibling folder with a longer name for a subfolder', () => {
    const titles = galleryNotesIn(notes, recipes, true, INBOX_MODE).map((n) => n.title)
    expect(titles).not.toContain('Other')
  })

  it('stays inside its top-level folder', () => {
    expect(
      galleryNotesIn(notes, { folder: 'archive', subpath: 'Recipes' }, true, INBOX_MODE).map(
        (n) => n.title
      )
    ).toEqual(['Old'])
  })

  it('takes the whole folder from its top', () => {
    expect(galleryNotesIn(notes, { folder: 'inbox', subpath: '' }, false, INBOX_MODE).map((n) => n.title)).toEqual([
      'Top'
    ])
    expect(galleryNotesIn(notes, { folder: 'inbox', subpath: '' }, true, INBOX_MODE)).toHaveLength(6)
  })

  it('reads folders the same way in a root-mode vault', () => {
    const rootNotes = [note('Recipes/Pasta.md'), note('Recipes/Desserts/Cake.md'), note('Top.md')]
    expect(galleryNotesIn(rootNotes, recipes, false, ROOT_MODE).map((n) => n.title)).toEqual(['Pasta'])
    expect(galleryNotesIn(rootNotes, recipes, true, ROOT_MODE).map((n) => n.title)).toEqual([
      'Pasta',
      'Cake'
    ])
  })
})

describe('sortGalleryNotes', () => {
  const a = note('inbox/a.md', { title: 'Note 10', createdAt: 100, updatedAt: 500 })
  const b = note('inbox/b.md', { title: 'Note 2', createdAt: 300, updatedAt: 400 })
  const c = note('inbox/c.md', { title: 'apple', createdAt: 200, updatedAt: 500 })

  it('puts the last edited first, ties by title', () => {
    expect(sortGalleryNotes([a, b, c], 'updated').map((n) => n.title)).toEqual([
      'apple',
      'Note 10',
      'Note 2'
    ])
  })

  it('puts the newest first under Created', () => {
    expect(sortGalleryNotes([a, b, c], 'created').map((n) => n.title)).toEqual([
      'Note 2',
      'apple',
      'Note 10'
    ])
  })

  it('sorts titles naturally, ignoring case, under Title', () => {
    expect(sortGalleryNotes([a, b, c], 'title').map((n) => n.title)).toEqual([
      'apple',
      'Note 2',
      'Note 10'
    ])
  })

  it('does not touch the list it was given', () => {
    const list = [a, b, c]
    sortGalleryNotes(list, 'title')
    expect(list).toEqual([a, b, c])
  })

  it('reads an unknown stored sort as Updated', () => {
    expect(normalizeGallerySort('created')).toBe('created')
    expect(normalizeGallerySort('title')).toBe('title')
    expect(normalizeGallerySort('size')).toBe('updated')
    expect(normalizeGallerySort(undefined)).toBe('updated')
  })

  it('shows the date the sort is about', () => {
    expect(galleryCardTimestamp(a, 'created')).toBe(100)
    expect(galleryCardTimestamp(a, 'updated')).toBe(500)
    expect(galleryCardTimestamp(a, 'title')).toBe(500)
  })
})

describe('filterGalleryNotes', () => {
  const list = [note('inbox/x/Garden Plan.md'), note('inbox/x/Plant list.md'), note('inbox/x/Soup.md')]

  it('keeps titles holding every word, in any case and order', () => {
    expect(filterGalleryNotes(list, 'PLAN').map((n) => n.title)).toEqual(['Garden Plan', 'Plant list'])
    expect(filterGalleryNotes(list, 'plan garden').map((n) => n.title)).toEqual(['Garden Plan'])
  })

  it('keeps everything for an empty query', () => {
    expect(filterGalleryNotes(list, '   ')).toHaveLength(3)
  })
})

describe('card text', () => {
  it('takes the first letter or digit of a title', () => {
    expect(galleryInitial('pasta')).toBe('P')
    expect(galleryInitial('🍕 pizza night')).toBe('P')
    expect(galleryInitial('[draft] essay')).toBe('D')
    expect(galleryInitial('2026 plan')).toBe('2')
    expect(galleryInitial('élan')).toBe('É')
    expect(galleryInitial('#')).toBe('#')
    expect(galleryInitial('')).toBe('?')
  })

  it('writes the year only when it is not this year', () => {
    const now = new Date(2026, 9, 29).getTime()
    const thisYear = new Date(2026, 2, 4).getTime()
    const lastYear = new Date(2025, 2, 4).getTime()
    expect(formatGalleryDate(thisYear, now)).toBe(
      new Date(thisYear).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    )
    expect(formatGalleryDate(lastYear, now)).toContain('2025')
  })
})

describe('opening a gallery', () => {
  const folders = [
    { folder: 'inbox' as const, subpath: 'Projects' },
    { folder: 'inbox' as const, subpath: 'Projects/Website' },
    { folder: 'archive' as const, subpath: '2025' }
  ]

  it('finds a folder by its vault path, its notes-area path or a system folder name', () => {
    expect(resolveGalleryFolderArgument('inbox/Projects', folders, INBOX_MODE, LABELS)).toEqual({
      folder: 'inbox',
      subpath: 'Projects'
    })
    expect(resolveGalleryFolderArgument('projects/website/', folders, INBOX_MODE, LABELS)).toEqual({
      folder: 'inbox',
      subpath: 'Projects/Website'
    })
    expect(resolveGalleryFolderArgument('archive/2025', folders, INBOX_MODE, LABELS)).toEqual({
      folder: 'archive',
      subpath: '2025'
    })
    expect(resolveGalleryFolderArgument('Quick Notes', folders, INBOX_MODE, LABELS)).toEqual({
      folder: 'quick',
      subpath: ''
    })
    expect(resolveGalleryFolderArgument('inbox', folders, INBOX_MODE, LABELS)).toEqual({
      folder: 'inbox',
      subpath: ''
    })
  })

  it('reads a root-mode vault’s folders without an inbox/ prefix', () => {
    expect(resolveGalleryFolderArgument('Projects', folders, ROOT_MODE, LABELS)).toEqual({
      folder: 'inbox',
      subpath: 'Projects'
    })
  })

  it('answers null for a folder the vault does not have', () => {
    expect(resolveGalleryFolderArgument('Nowhere', folders, INBOX_MODE, LABELS)).toBeNull()
    expect(resolveGalleryFolderArgument('  ', folders, INBOX_MODE, LABELS)).toBeNull()
  })

  it('takes a note’s own folder', () => {
    expect(galleryFolderOfNote(note('inbox/Projects/Website/a.md'), INBOX_MODE)).toEqual({
      folder: 'inbox',
      subpath: 'Projects/Website'
    })
    expect(galleryFolderOfNote(note('a.md'), ROOT_MODE)).toEqual({ folder: 'inbox', subpath: '' })
  })

  it('knows when its folder is gone', () => {
    expect(galleryFolderExists({ folder: 'inbox', subpath: 'Projects' }, folders)).toBe(true)
    expect(galleryFolderExists({ folder: 'inbox', subpath: 'Gone' }, folders)).toBe(false)
    expect(galleryFolderExists({ folder: 'trash', subpath: '' }, folders)).toBe(true)
  })
})

describe('galleryGeometry', () => {
  it('shows two columns at phone width, never one', () => {
    for (const width of [320, 375, 430]) {
      const g = galleryGeometry(width)
      expect(g.columns).toBe(2)
      expect(g.cardWidth * 2 + g.gap + g.padding * 2).toBeCloseTo(width)
    }
  })

  it('adds columns as the pane widens, up to eight', () => {
    expect(galleryGeometry(700).columns).toBe(3)
    expect(galleryGeometry(900).columns).toBe(4)
    expect(galleryGeometry(1280).columns).toBe(5)
    expect(galleryGeometry(5000).columns).toBe(8)
  })

  it('gives every card the cover plus the text block, and a row the gap under it', () => {
    const g = galleryGeometry(1000)
    expect(g.cardHeight).toBe(g.coverHeight + GALLERY_CARD_TEXT_HEIGHT)
    expect(g.rowHeight).toBe(g.cardHeight + g.gap)
    expect(g.coverHeight).toBeLessThan(g.cardWidth)
  })

  it('measures the content without a gap after the last row', () => {
    const g = galleryGeometry(1000)
    expect(galleryContentHeight(0, g)).toBe(0)
    expect(galleryContentHeight(1, g)).toBe(g.padding * 2 + g.cardHeight)
    expect(galleryContentHeight(g.columns + 1, g)).toBe(g.padding * 2 + g.rowHeight + g.cardHeight)
  })
})

describe('galleryRowRange', () => {
  const g = galleryGeometry(1000)

  it('mounts only the rows on screen, plus the overscan', () => {
    const count = 1000
    const view = galleryRowRange(count, g, 0, g.rowHeight * 3, 0)
    expect(view.start).toBe(0)
    expect(view.end).toBeLessThanOrEqual(4)
    const scrolled = galleryRowRange(count, g, g.padding + g.rowHeight * 50, g.rowHeight * 3, 2)
    expect(scrolled.start).toBe(48)
    expect(scrolled.end).toBeLessThanOrEqual(56)
  })

  it('stops at the last row and handles an empty gallery', () => {
    const rows = Math.ceil(10 / g.columns)
    expect(galleryRowRange(10, g, 100000, 800, 3).end).toBe(rows)
    expect(galleryRowRange(0, g, 0, 800, 3)).toEqual({ start: 0, end: 0 })
  })
})

describe('galleryScrollTopFor', () => {
  const g = galleryGeometry(1000)
  const viewport = g.rowHeight * 2

  it('leaves the scroll alone for a card in view', () => {
    expect(galleryScrollTopFor(0, g, 0, viewport)).toBe(0)
  })

  it('scrolls down just enough to show a card below', () => {
    const index = g.columns * 5
    const top = galleryScrollTopFor(index, g, 0, viewport)
    const cardBottom = g.padding + 5 * g.rowHeight + g.cardHeight
    expect(top).toBe(cardBottom + g.padding - viewport)
  })

  it('scrolls up to a card above', () => {
    expect(galleryScrollTopFor(g.columns * 2, g, g.rowHeight * 10, viewport)).toBe(2 * g.rowHeight)
  })
})

describe('stepGalleryCursor', () => {
  // 3 columns, 8 cards:
  //   0 1 2
  //   3 4 5
  //   6 7
  it('walks left and right in reading order, across rows', () => {
    expect(stepGalleryCursor(2, 8, 3, 'right')).toBe(3)
    expect(stepGalleryCursor(3, 8, 3, 'left')).toBe(2)
    expect(stepGalleryCursor(0, 8, 3, 'left')).toBe(0)
    expect(stepGalleryCursor(7, 8, 3, 'right')).toBe(7)
  })

  it('keeps the column up and down', () => {
    expect(stepGalleryCursor(1, 8, 3, 'down')).toBe(4)
    expect(stepGalleryCursor(4, 8, 3, 'up')).toBe(1)
    expect(stepGalleryCursor(1, 8, 3, 'up')).toBe(1)
  })

  it('lands on the last card going down past the short last row', () => {
    expect(stepGalleryCursor(5, 8, 3, 'down')).toBe(7)
    expect(stepGalleryCursor(7, 8, 3, 'down')).toBe(7)
    expect(stepGalleryCursor(6, 8, 3, 'down')).toBe(6)
  })

  it('jumps to the ends', () => {
    expect(stepGalleryCursor(4, 8, 3, 'first')).toBe(0)
    expect(stepGalleryCursor(4, 8, 3, 'last')).toBe(7)
  })

  it('clamps a stale index and has nowhere to go in an empty gallery', () => {
    expect(stepGalleryCursor(40, 8, 3, 'left')).toBe(6)
    expect(stepGalleryCursor(0, 0, 3, 'down')).toBe(-1)
  })
})

describe('galleryThumbnail', () => {
  const served = (href: string): string | null => (href.startsWith('assets/') ? `zen-asset://vault/${href}` : null)

  it('draws the placeholder for a note without a cover', () => {
    expect(galleryThumbnail(null, served)).toEqual({ kind: 'placeholder' })
  })

  it('draws a vault image from where the host serves it, at its focal point', () => {
    expect(galleryThumbnail(cover({ kind: 'vault', href: 'assets/lisbon.jpg' }, 0.3), served)).toEqual({
      kind: 'image',
      url: 'zen-asset://vault/assets/lisbon.jpg',
      y: 0.3,
      source: 'vault'
    })
  })

  it('draws a built-in gradient from the vault, or from its own SVG when the vault cannot serve it', () => {
    const gradient = NOTE_COVER_GRADIENTS[0]
    const file = `cover-gradient-${gradient.id}.svg`
    expect(galleryThumbnail(cover({ kind: 'vault', href: `assets/${file}` }), served)).toMatchObject({
      kind: 'image',
      url: `zen-asset://vault/assets/${file}`,
      source: 'gradient'
    })
    expect(galleryThumbnail(cover({ kind: 'vault', href: `elsewhere/${file}` }), served)).toEqual({
      kind: 'image',
      url: gradientCoverDataUrl(gradient),
      y: 0.5,
      source: 'gradient'
    })
  })

  it('falls back to the placeholder for a vault image this device cannot find', () => {
    expect(galleryThumbnail(cover({ kind: 'vault', href: 'gone.png' }), served)).toEqual({
      kind: 'placeholder'
    })
  })

  it('asks Unsplash for a thumbnail-sized photo and keeps any other link as it is', () => {
    const photo = 'https://images.unsplash.com/photo-1?ixid=AbC%3D&w=2400&q=80&auto=format'
    expect(galleryThumbnail(cover({ kind: 'url', url: photo }), served)).toEqual({
      kind: 'image',
      url: 'https://images.unsplash.com/photo-1?ixid=AbC%3D&w=800&q=80&auto=format',
      y: 0.5,
      source: 'unsplash'
    })
    const web = 'https://example.com/cover.jpg?w=2400'
    expect(galleryThumbnail(cover({ kind: 'url', url: web }), served)).toMatchObject({
      url: web,
      source: 'web'
    })
  })
})

describe('unsplashThumbnailUrl', () => {
  it('swaps the width and keeps the rest byte for byte', () => {
    expect(unsplashThumbnailUrl('https://images.unsplash.com/p?ixid=a%2Bb&w=2400&q=80', 640)).toBe(
      'https://images.unsplash.com/p?ixid=a%2Bb&w=640&q=80'
    )
  })

  it('adds a width to a raw URL', () => {
    expect(unsplashThumbnailUrl('https://images.unsplash.com/p?ixid=x', 640)).toBe(
      'https://images.unsplash.com/p?ixid=x&w=640'
    )
    expect(unsplashThumbnailUrl('https://images.unsplash.com/p', 640)).toBe(
      'https://images.unsplash.com/p?w=640'
    )
  })

  it('leaves other hosts alone', () => {
    expect(unsplashThumbnailUrl('https://unsplash.com.evil.test/p?w=2400', 640)).toBe(
      'https://unsplash.com.evil.test/p?w=2400'
    )
  })
})
