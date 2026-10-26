import { describe, expect, it } from 'vitest'
import { getSettingsSearchResults, inNavigationOrder } from './settings-search'

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

// #993: Ctrl+J/K walk the results list, which with an empty search used to
// follow the definition order while the nav showed the section order.
describe('inNavigationOrder', () => {
  const cat = (id: string) => ({ id, title: id, description: '', keywords: [] })
  const defined = ['appearance', 'editor', 'keymaps', 'tasks', 'typography', 'cloud', 'vault'].map(cat)
  const nav = ['appearance', 'typography', 'editor', 'tasks', 'keymaps', 'vault', 'cloud']

  it('puts the categories in the order the navigation shows them', () => {
    expect(inNavigationOrder(defined, nav).map((c) => c.id)).toEqual(nav)
  })

  it('so the empty-search results Ctrl+J walks match the nav', () => {
    const results = getSettingsSearchResults(inNavigationOrder(defined, nav), '')
    expect(results.map((r) => r.category.id)).toEqual(nav)
  })

  it('keeps categories the order does not name, after the named ones', () => {
    const ids = inNavigationOrder([cat('extra'), ...defined], ['vault', 'appearance']).map((c) => c.id)
    expect(ids.slice(0, 2)).toEqual(['vault', 'appearance'])
    expect(ids.slice(2)).toEqual(['extra', 'editor', 'keymaps', 'tasks', 'typography', 'cloud'])
  })

  it('leaves the input untouched', () => {
    const input = [...defined]
    inNavigationOrder(input, nav)
    expect(input.map((c) => c.id)).toEqual(defined.map((c) => c.id))
  })
})
