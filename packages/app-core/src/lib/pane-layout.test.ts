import { describe, expect, it } from 'vitest'
import {
  leafWithAddedTab,
  leafWithPinnedTab,
  leafWithPreviewTab,
  leafWithPromotedTab,
  leafWithReorderedTab,
  leafWithoutTab,
  makeLeaf,
  preserveLayoutIfPruneEmptiesNoteTabs,
  rewritePathsInTree,
  type PaneLeaf
} from './pane-layout'

function leaf(overrides: Partial<PaneLeaf> = {}): PaneLeaf {
  return { ...makeLeaf(), ...overrides }
}

describe('preview tabs (VS Code-style)', () => {
  it('opens a new note as the preview tab, appended to the unpinned zone', () => {
    const base = leaf({ tabs: ['a.md'], activeTab: 'a.md' })
    const next = leafWithPreviewTab(base, 'b.md')
    expect(next.tabs).toEqual(['a.md', 'b.md'])
    expect(next.previewTab).toBe('b.md')
    expect(next.activeTab).toBe('b.md')
  })

  it('replaces the existing preview tab in place', () => {
    const base = leaf({
      tabs: ['a.md', 'p.md', 'z.md'],
      activeTab: 'p.md',
      previewTab: 'p.md'
    })
    const next = leafWithPreviewTab(base, 'q.md')
    expect(next.tabs).toEqual(['a.md', 'q.md', 'z.md'])
    expect(next.previewTab).toBe('q.md')
    expect(next.activeTab).toBe('q.md')
  })

  it('focusing an already-open permanent tab keeps it permanent', () => {
    const base = leaf({
      tabs: ['a.md', 'p.md'],
      activeTab: 'p.md',
      previewTab: 'p.md'
    })
    const next = leafWithPreviewTab(base, 'a.md')
    expect(next.tabs).toEqual(['a.md', 'p.md'])
    expect(next.previewTab).toBe('p.md')
    expect(next.activeTab).toBe('a.md')
  })

  it('previewing the current preview tab again is a no-op', () => {
    const base = leaf({ tabs: ['p.md'], activeTab: 'p.md', previewTab: 'p.md' })
    expect(leafWithPreviewTab(base, 'p.md')).toBe(base)
  })

  it('never replaces a pinned tab, even if the preview flag points at it', () => {
    const base = leaf({
      tabs: ['p.md', 'a.md'],
      pinnedTabs: ['p.md'],
      activeTab: 'a.md',
      previewTab: 'p.md' // inconsistent state — must not eat the pinned tab
    })
    const next = leafWithPreviewTab(base, 'q.md')
    expect(next.tabs).toContain('p.md')
    expect(next.tabs).toContain('q.md')
    expect(next.previewTab).toBe('q.md')
  })

  it('promotes a preview tab to permanent', () => {
    const base = leaf({ tabs: ['p.md'], activeTab: 'p.md', previewTab: 'p.md' })
    const next = leafWithPromotedTab(base, 'p.md')
    expect(next.previewTab).toBeNull()
    expect(next.tabs).toEqual(['p.md'])
  })

  it('promotion of a non-preview path is a no-op', () => {
    const base = leaf({ tabs: ['a.md', 'p.md'], previewTab: 'p.md' })
    expect(leafWithPromotedTab(base, 'a.md')).toBe(base)
  })

  it('pinning a preview tab promotes it', () => {
    const base = leaf({ tabs: ['p.md'], activeTab: 'p.md', previewTab: 'p.md' })
    const next = leafWithPinnedTab(base, 'p.md')
    expect(next.pinnedTabs).toEqual(['p.md'])
    expect(next.previewTab).toBeNull()
  })

  it('closing the preview tab clears the flag', () => {
    const base = leaf({
      tabs: ['a.md', 'p.md'],
      activeTab: 'p.md',
      previewTab: 'p.md'
    })
    const next = leafWithoutTab(base, 'p.md')
    expect(next?.tabs).toEqual(['a.md'])
    expect(next?.previewTab).toBeNull()
  })

  it('closing another tab leaves the preview flag alone', () => {
    const base = leaf({
      tabs: ['a.md', 'p.md'],
      activeTab: 'p.md',
      previewTab: 'p.md'
    })
    const next = leafWithoutTab(base, 'a.md')
    expect(next?.previewTab).toBe('p.md')
  })

  it('adding a tab permanently does not mark it preview', () => {
    const base = leaf({ tabs: ['a.md'], activeTab: 'a.md' })
    const next = leafWithAddedTab(base, 'b.md')
    expect(next.previewTab ?? null).toBeNull()
  })

  it('renames the preview tab through rewritePathsInTree', () => {
    const base = leaf({
      tabs: ['a.md', 'p.md'],
      activeTab: 'p.md',
      previewTab: 'p.md'
    })
    const next = rewritePathsInTree(base, (p) => (p === 'p.md' ? 'renamed.md' : p))
    expect(next.kind).toBe('leaf')
    if (next.kind === 'leaf') {
      expect(next.tabs).toEqual(['a.md', 'renamed.md'])
      expect(next.previewTab).toBe('renamed.md')
    }
  })

  it('drops the preview flag when the path is dropped from the tree', () => {
    const base = leaf({
      tabs: ['a.md', 'p.md'],
      activeTab: 'p.md',
      previewTab: 'p.md'
    })
    const next = rewritePathsInTree(base, (p) => (p === 'p.md' ? null : p))
    if (next.kind === 'leaf') {
      expect(next.tabs).toEqual(['a.md'])
      expect(next.previewTab).toBeNull()
    }
  })

  it('dragging a preview tab into the pinned zone promotes it', () => {
    const base = leaf({
      tabs: ['pin.md', 'a.md', 'p.md'],
      pinnedTabs: ['pin.md'],
      activeTab: 'p.md',
      previewTab: 'p.md'
    })
    const next = leafWithReorderedTab(base, 'p.md', 'pin.md', 'before')
    expect(next.pinnedTabs).toContain('p.md')
    expect(next.previewTab).toBeNull()
  })
})

describe('preserveLayoutIfPruneEmptiesNoteTabs (#384)', () => {
  const isVirtual = (p: string): boolean => p.startsWith('workspace:')

  it('keeps the previous layout when a prune would remove every note tab', () => {
    // e.g. a transient/incomplete note list pruned all tabs (the reported bug).
    const prev = leaf({ tabs: ['a.md', 'b.md', 'c.md'], activeTab: 'a.md' })
    const pruned = makeLeaf()
    expect(preserveLayoutIfPruneEmptiesNoteTabs(prev, pruned, isVirtual)).toBe(prev)
  })

  it('accepts the prune when at least one note tab survives', () => {
    const prev = leaf({ tabs: ['a.md', 'b.md', 'c.md'], activeTab: 'a.md' })
    const pruned = leaf({ tabs: ['a.md', 'b.md'], activeTab: 'a.md' })
    expect(preserveLayoutIfPruneEmptiesNoteTabs(prev, pruned, isVirtual)).toBe(pruned)
  })

  it('treats a lone surviving workspace tab as still-empty (keeps previous)', () => {
    const prev = leaf({ tabs: ['workspace:tasks', 'a.md', 'b.md'], activeTab: 'a.md' })
    const pruned = leaf({ tabs: ['workspace:tasks'], activeTab: 'workspace:tasks' })
    expect(preserveLayoutIfPruneEmptiesNoteTabs(prev, pruned, isVirtual)).toBe(prev)
  })

  it('does not over-guard when there were no note tabs to begin with', () => {
    const prev = leaf({ tabs: ['workspace:tasks'], activeTab: 'workspace:tasks' })
    const pruned = makeLeaf()
    expect(preserveLayoutIfPruneEmptiesNoteTabs(prev, pruned, isVirtual)).toBe(pruned)
  })
})
