import { describe, expect, it } from 'vitest'
import { buildTagTree, extractTags, flattenTagTree, matchesSelectedTags } from './tags'

describe('extractTags — code fences are never scanned for tags (#293)', () => {
  it('ignores #tags inside a top-level fenced code block', () => {
    expect(extractTags('#real\n\n```c\n#include <stdio.h>\n```\n')).toEqual(['real'])
  })

  it('ignores #tags inside a fence INDENTED under a list item (the #293 repro)', () => {
    const body = '- bullet\n\n  ```c\n  #include <stdio.h>\n  ```\n\n#kept'
    expect(extractTags(body)).toEqual(['kept'])
  })

  it('handles tilde fences and longer (4-backtick) fences', () => {
    expect(extractTags('~~~\n#nope\n~~~\n#yes')).toEqual(['yes'])
    expect(extractTags('````\n```\n#nope\n```\n````\n#yes')).toEqual(['yes'])
  })

  it('ignores #tags in inline code but keeps real tags', () => {
    expect(extractTags('use `#notatag` but #tagme')).toEqual(['tagme'])
  })

  it('extracts a real tag sitting right after a closed indented fence', () => {
    expect(extractTags('- item\n  ```\n  #include\n  ```\n  #after')).toEqual(['after'])
  })

  it('ignores #tags inside a fence in a note saved with CRLF line endings', () => {
    expect(extractTags('```c\r\n#include <x>\r\n```\r\nreal #ok\r\n')).toEqual(['ok'])
    expect(extractTags('- item\r\n  ~~~\r\n  #nope\r\n  ~~~\r\n  #after\r\n')).toEqual(['after'])
  })

  it('includes first-class frontmatter tags', () => {
    expect(extractTags('---\ntags: [frontmatter, "#quoted", project/nested]\ntitle: #ignored\n---\n\n#inline')).toEqual([
      'frontmatter',
      'quoted',
      'project/nested',
      'inline'
    ])
  })

  it('splits a bare frontmatter scalar into separate tags', () => {
    // `tags: daily, work` is two tags everywhere else that reads this field,
    // and a tag can hold neither a comma nor a space. (#444)
    expect(extractTags('---\ntags: daily, work\n---\nbody')).toEqual(['daily', 'work'])
    expect(extractTags('---\ntags: solo\n---\nbody')).toEqual(['solo'])
    expect(extractTags('---\ntags: "#quoted two"\n---\nbody')).toEqual(['quoted', 'two'])
  })

  it('supports block-list frontmatter tags', () => {
    expect(extractTags('---\ntags:\n  - daily\n  - "#log"\n---\n\nbody')).toEqual(['daily', 'log'])
  })
})

describe('matchesSelectedTags', () => {
  const note = ['project', 'urgent', 'design']

  it('all (AND): requires every selected tag — the #221 fix', () => {
    expect(matchesSelectedTags(note, ['project', 'urgent'], 'all')).toBe(true)
    expect(matchesSelectedTags(note, ['project', 'missing'], 'all')).toBe(false)
    expect(matchesSelectedTags(note, ['project'], 'all')).toBe(true)
  })

  it('any (OR): requires at least one selected tag', () => {
    expect(matchesSelectedTags(note, ['project', 'missing'], 'any')).toBe(true)
    expect(matchesSelectedTags(note, ['nope', 'missing'], 'any')).toBe(false)
  })

  it('is case-insensitive on both sides', () => {
    expect(matchesSelectedTags(['Project', 'URGENT'], ['project', 'urgent'], 'all')).toBe(true)
    expect(matchesSelectedTags(['Project'], ['PROJECT'], 'any')).toBe(true)
  })

  it('no selection never matches', () => {
    expect(matchesSelectedTags(note, [], 'all')).toBe(false)
    expect(matchesSelectedTags(note, [], 'any')).toBe(false)
  })

  it('a note with no tags never matches a non-empty selection', () => {
    expect(matchesSelectedTags([], ['project'], 'all')).toBe(false)
    expect(matchesSelectedTags([], ['project'], 'any')).toBe(false)
  })
})

describe('buildTagTree — hierarchical grouping on "/" (#439)', () => {
  it('groups tags under a shared prefix and rolls up counts', () => {
    const tree = buildTagTree([
      ['project/compiler', 2],
      ['project/website', 1],
      ['area/linux', 3]
    ])
    expect(tree.map((n) => n.path)).toEqual(['area', 'project']) // sorted, case-insensitive
    const project = tree.find((n) => n.path === 'project')!
    expect(project.isTag).toBe(false) // only inferred as a parent
    expect(project.count).toBe(0)
    expect(project.subtreeCount).toBe(3) // 2 + 1
    expect(project.children.map((c) => c.path)).toEqual(['project/compiler', 'project/website'])
    expect(project.children[0].name).toBe('compiler')
    expect(project.children[0].depth).toBe(1)
  })

  it('marks a parent that is also a real tag, regardless of child order', () => {
    const tree = buildTagTree([
      ['project/compiler', 1],
      ['project', 5]
    ])
    const project = tree[0]
    expect(project.isTag).toBe(true)
    expect(project.count).toBe(5)
    expect(project.subtreeCount).toBe(6)
    expect(project.children).toHaveLength(1)
  })

  it('keeps a flat vault flat (single-segment tags are root leaves)', () => {
    const tree = buildTagTree([
      ['todo', 4],
      ['idea', 2]
    ])
    expect(tree.map((n) => n.path)).toEqual(['idea', 'todo'])
    expect(tree.every((n) => n.children.length === 0 && n.isTag)).toBe(true)
  })

  it('drops empty segments from stray or trailing slashes', () => {
    const tree = buildTagTree([['a//b', 1], ['c/', 2]])
    expect(tree.map((n) => n.path)).toEqual(['a', 'c'])
    expect(tree.find((n) => n.path === 'a')!.children[0].path).toBe('a/b')
    expect(tree.find((n) => n.path === 'c')!.isTag).toBe(true)
  })

  it('handles three levels deep', () => {
    const tree = buildTagTree([['a/b/c', 1]])
    expect(tree[0].children[0].children[0].path).toBe('a/b/c')
    expect(tree[0].children[0].children[0].depth).toBe(2)
  })
})

describe('flattenTagTree — visible rows honor collapsed set (#439)', () => {
  const tree = buildTagTree([
    ['project/compiler', 1],
    ['project/website', 1],
    ['area/linux', 1]
  ])

  it('lists every node when nothing is collapsed', () => {
    const rows = flattenTagTree(tree, new Set())
    expect(rows.map((n) => n.path)).toEqual([
      'area',
      'area/linux',
      'project',
      'project/compiler',
      'project/website'
    ])
  })

  it('hides the subtree of a collapsed node but keeps the node itself', () => {
    const rows = flattenTagTree(tree, new Set(['project']))
    expect(rows.map((n) => n.path)).toEqual(['area', 'area/linux', 'project'])
  })
})
