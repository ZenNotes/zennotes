import { describe, expect, it } from 'vitest'
import { maskCodeKeepingOffsets, prepareLinkIndex, rewriteObsidianLinks, type ObsidianLinkIndex } from './links'

const base: ObsidianLinkIndex = {
  notes: ['Home.md', 'Projects/Plan.md', 'Projects/Notes.md', 'Areas/Notes.md', 'Areas/Deep/Idea.md'],
  assets: ['attachments/photo.png', 'Projects/shot one.png', 'Areas/shot.png', 'Projects/dup.png', 'Areas/dup.png', 'report.pdf'],
  existingNotes: [],
  existingAssets: [],
  vaultFolder: 'Obsidian Import'
}

const run = (body: string, notePath = 'Home.md', overrides: Partial<ObsidianLinkIndex> = {}) =>
  rewriteObsidianLinks(body, notePath, prepareLinkIndex({ ...base, ...overrides }))

describe('rewriteObsidianLinks: what stays as it is', () => {
  it('leaves a unique title alone', () => {
    const result = run('See [[Plan]] and [[Plan|the plan]] and [[Plan#Goals]].')
    expect(result.body).toBe('See [[Plan]] and [[Plan|the plan]] and [[Plan#Goals]].')
    expect(result.rewritten).toBe(0)
  })

  it('leaves a path that still finds one note', () => {
    expect(run('[[Projects/Plan]]').rewritten).toBe(0)
    expect(run('[[Areas/Deep/Idea]]').rewritten).toBe(0)
  })

  it('leaves a link to nothing, which in Obsidian is a note waiting to be written', () => {
    const result = run('[[Not written yet]]')
    expect(result.body).toBe('[[Not written yet]]')
    expect(result.rewritten).toBe(0)
  })

  it('leaves a same-note heading link', () => {
    expect(run('[[#Goals]] [[^block]]').rewritten).toBe(0)
  })

  it('leaves a uniquely named embed, and records that the note uses it', () => {
    const result = run('![[photo.png]] and ![[photo.png|300]]')
    expect(result.rewritten).toBe(0)
    expect(result.referencedAssets).toEqual(['attachments/photo.png'])
  })

  it('leaves a relative Markdown link', () => {
    const result = run('![a](../attachments/photo.png) and [b](Notes.md) and ![c](shot%20one.png)', 'Projects/Plan.md')
    expect(result.rewritten).toBe(0)
    expect(result.referencedAssets.sort()).toEqual(['Projects/shot one.png', 'attachments/photo.png'])
  })

  it('never touches outside links', () => {
    const body = '[a](https://x.io/Plan.md) ![b](https://x.io/photo.png) [c](mailto:a@b.c) [d](#top)'
    expect(run(body).body).toBe(body)
  })

  it('never reads a link inside code', () => {
    const body = '`[[Notes]]`\n\n```md\n[[Notes]] ![[dup.png]]\n```\n\n~~~\n[[Notes]]\n~~~'
    const result = run(body)
    expect(result.body).toBe(body)
    expect(result.rewritten).toBe(0)
  })
})

describe('rewriteObsidianLinks: what has to change', () => {
  it('pins a title two folders share, to the one Obsidian would open', () => {
    expect(run('[[Notes]]', 'Projects/Plan.md').body).toBe('[[Obsidian Import/Projects/Notes|Notes]]')
    expect(run('[[Notes]]', 'Areas/Deep/Idea.md').body).toBe('[[Obsidian Import/Areas/Notes|Notes]]')
  })

  it('pins a title that clashes with a note already in the vault, keeping how it reads', () => {
    const existingNotes = ['inbox/Plan.md']
    expect(run('[[Plan]]', 'Home.md', { existingNotes }).body).toBe('[[Obsidian Import/Projects/Plan|Plan]]')
    expect(run('[[Plan|my plan]]', 'Home.md', { existingNotes }).body).toBe('[[Obsidian Import/Projects/Plan|my plan]]')
    expect(run('![[Plan#Goals]]', 'Home.md', { existingNotes }).body).toBe('![[Obsidian Import/Projects/Plan#Goals|Plan#Goals]]')
  })

  it('pins a path the vault already matches elsewhere', () => {
    const existingNotes = ['Other/Projects/Plan.md']
    expect(run('[[Projects/Plan]]', 'Home.md', { existingNotes }).body).toBe('[[Obsidian Import/Projects/Plan|Projects/Plan]]')
  })

  it('resolves a relative wikilink, since the destination reads it differently', () => {
    expect(run('[[../Notes]]', 'Areas/Deep/Idea.md').body).toBe('[[Obsidian Import/Areas/Notes|../Notes]]')
  })

  it('pins an image name two folders share, keeping its size', () => {
    expect(run('![[dup.png|200]]', 'Home.md').body).toBe('![[Obsidian Import/Areas/dup.png|200]]')
  })

  it('leaves one in the note’s own folder, which is read first', () => {
    expect(run('![[dup.png]]', 'Projects/Plan.md').rewritten).toBe(0)
    expect(run('![[dup.png]]', 'Projects/Plan.md').referencedAssets).toEqual(['Projects/dup.png'])
  })

  it('pins an image name already used in the vault', () => {
    const result = run('![[photo.png]]', 'Home.md', { existingAssets: ['assets/photo.png'] })
    expect(result.body).toBe('![[Obsidian Import/attachments/photo.png]]')
    expect(result.referencedAssets).toEqual(['attachments/photo.png'])
  })

  it('moves a Markdown link written from the old root', () => {
    expect(run('![a](attachments/photo.png)', 'Projects/Plan.md').body).toBe('![a](<Obsidian Import/attachments/photo.png>)')
    expect(run('[b](Projects/Plan.md#Goals)', 'Areas/Notes.md').body).toBe('[b](<Obsidian Import/Projects/Plan.md#Goals>)')
  })

  it('keeps a table cell’s escaped pipe', () => {
    expect(run('| [[Notes\\|n]] |', 'Projects/Plan.md').body).toBe('| [[Obsidian Import/Projects/Notes\\|n]] |')
  })

  it('edits several links in one note without losing its place', () => {
    const result = run('a [[Notes]] b ![[dup.png]] c [[Plan]] d', 'Home.md')
    expect(result.body).toBe('a [[Obsidian Import/Areas/Notes|Notes]] b ![[Obsidian Import/Areas/dup.png]] c [[Plan]] d')
    expect(result.rewritten).toBe(2)
  })
})

describe('what it notices', () => {
  it('finds tasks, in lists and callouts, but not in code', () => {
    expect(run('- [ ] open').hasTasks).toBe(true)
    expect(run('1. [x] done').hasTasks).toBe(true)
    expect(run('> - [ ] quoted').hasTasks).toBe(true)
    expect(run('- plain').hasTasks).toBe(false)
    expect(run('```\n- [ ] code\n```').hasTasks).toBe(false)
  })

  it('counts Dataview blocks', () => {
    expect(run('```dataview\nLIST\n```\n\n```dataviewjs\nx\n```\n\n```js\ny\n```').dataviewBlocks).toBe(2)
  })
})

describe('maskCodeKeepingOffsets', () => {
  it('keeps every offset outside code', () => {
    const body = 'a `b` c\n```\nd\n```\ne'
    const masked = maskCodeKeepingOffsets(body)
    expect(masked).toHaveLength(body.length)
    expect(masked.indexOf('e')).toBe(body.indexOf('e'))
    expect(masked).not.toContain('b')
    expect(masked).not.toContain('d')
  })

  it('sees a fence inside a callout', () => {
    expect(maskCodeKeepingOffsets('> ```\n> [[x]]\n> ```')).not.toContain('[[x]]')
  })
})
