import { describe, expect, it } from 'vitest'
import { getSettingsSearchResults } from './settings-search'

const categories = [
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme family, mode, and chrome surface styling.',
    keywords: ['theme', 'mode'],
    searchItems: [
      {
        id: 'dark-sidebar',
        title: 'Dark sidebar',
        description: 'Tint the sidebar one step darker than the canvas.'
      }
    ]
  },
  {
    id: 'editor',
    title: 'Editor',
    description: 'Vim, leader hints, live preview, tabs, and writing behavior.',
    keywords: ['vim', 'leader', 'preview', 'tabs', 'wrap'],
    searchItems: [
      {
        id: 'word-wrap',
        title: 'Word wrap',
        description: 'Wrap long lines to the editor width.'
      }
    ]
  }
]

describe('getSettingsSearchResults', () => {
  it('surfaces the matching setting title instead of only the category title', () => {
    const results = getSettingsSearchResults(categories, 'wrap')

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'editor:word-wrap',
      type: 'setting',
      title: 'Word wrap',
      targetId: 'word-wrap',
      category: { id: 'editor', title: 'Editor' }
    })
  })

  it('falls back to category results when a section itself matches', () => {
    const results = getSettingsSearchResults(categories, 'appearance')

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'appearance:category',
      type: 'category',
      title: 'Appearance'
    })
  })

  it('returns category navigation when the query is empty', () => {
    const results = getSettingsSearchResults(categories, '')

    expect(results.map((result) => result.title)).toEqual(['Appearance', 'Editor'])
    expect(results.every((result) => result.type === 'category')).toBe(true)
  })

  it('omits matching settings that are not currently available', () => {
    const results = getSettingsSearchResults(
      [
        {
          id: 'vault',
          title: 'Vault',
          description: 'Current vault location and root-folder controls.',
          keywords: ['folder', 'root', 'location'],
          searchItems: [
            {
              id: 'saved-remote-workspaces',
              title: 'Saved Remote Workspaces',
              description: 'Keep multiple ZenNotes servers and vaults ready to reconnect.',
              keywords: ['remote', 'server', 'workspace'],
              available: false
            }
          ]
        }
      ],
      'remote'
    )

    expect(results).toEqual([])
  })

  it('uses an explicit target when a matching setting should jump to a visible prerequisite', () => {
    const results = getSettingsSearchResults(
      [
        {
          id: 'editor',
          title: 'Editor',
          description: 'Vim, leader hints, live preview, tabs, and writing behavior.',
          keywords: ['vim', 'leader'],
          searchItems: [
            {
              id: 'leader-hint-behavior',
              title: 'Leader hint behavior',
              description: 'Timed auto-hides after a short delay.',
              keywords: ['leader', 'sticky', 'timed'],
              targetId: 'leader-key-hints'
            }
          ]
        }
      ],
      'behavior'
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'editor:leader-hint-behavior',
      type: 'setting',
      title: 'Leader hint behavior',
      targetId: 'leader-key-hints'
    })
  })
})
