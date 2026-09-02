import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isStandaloneLink,
  resolveStandaloneLink,
  WIKILINK_SEARCH_DEPTH
} from './standalone-links'

// The layout from #626: a generated wiki two levels below a repo root.
//   proj/README.md
//   proj/docs/wiki/index.md          <- the standalone note
//   proj/docs/wiki/topic-name.md
//   proj/docs/wiki/t00-converter-ts.md
//   proj/docs/wiki/graphify-out/GRAPH_REPORT.md
//   proj/docs/wiki/graphify-out/deep/Nested.md
//   proj/docs/wiki/diagram.png
let root = ''
let note = ''
const dirs: string[] = []

function file(rel: string, body = '# x\n'): string {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body)
  return abs
}

function setup(): void {
  root = mkdtempSync(path.join(tmpdir(), 'zen-standalone-links-'))
  dirs.push(root)
  file('proj/README.md')
  note = file('proj/docs/wiki/index.md')
  file('proj/docs/wiki/topic-name.md')
  file('proj/docs/wiki/t00-converter-ts.md')
  file('proj/docs/wiki/graphify-out/GRAPH_REPORT.md')
  file('proj/docs/wiki/graphify-out/deep/Nested.md')
  file('proj/docs/wiki/diagram.png', 'png')
  file('proj/docs/wiki/node_modules/pkg/Hidden.md')
  file('proj/docs/wiki/.cache/Shadow.md')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const resolve = (link: Parameters<typeof resolveStandaloneLink>[1]) =>
  resolveStandaloneLink(note, link)

describe('resolveStandaloneLink: relative hrefs', () => {
  it('resolves ../ and ./ hrefs from the note directory', async () => {
    setup()
    expect(await resolve({ kind: 'href', href: '../../README.md' })).toEqual({
      kind: 'markdown',
      absPath: path.join(root, 'proj/README.md')
    })
    expect(await resolve({ kind: 'href', href: 'graphify-out/GRAPH_REPORT.md' })).toEqual({
      kind: 'markdown',
      absPath: path.join(root, 'proj/docs/wiki/graphify-out/GRAPH_REPORT.md')
    })
    expect(await resolve({ kind: 'href', href: './topic-name.md#section' })).toEqual({
      kind: 'markdown',
      absPath: path.join(root, 'proj/docs/wiki/topic-name.md')
    })
  })

  it('adds the markdown extension for an extension-less link and decodes percent escapes', async () => {
    setup()
    file('proj/docs/wiki/My Page.md')
    expect((await resolve({ kind: 'href', href: '../../README' }))?.absPath).toBe(
      path.join(root, 'proj/README.md')
    )
    expect((await resolve({ kind: 'href', href: 'My%20Page.md' }))?.absPath).toBe(
      path.join(root, 'proj/docs/wiki/My Page.md')
    )
  })

  it('reports a non-markdown file as a plain file', async () => {
    setup()
    expect(await resolve({ kind: 'href', href: 'diagram.png' })).toEqual({
      kind: 'file',
      absPath: path.join(root, 'proj/docs/wiki/diagram.png')
    })
  })

  it('accepts absolute paths and file URLs', async () => {
    setup()
    const readme = path.join(root, 'proj/README.md')
    expect((await resolve({ kind: 'href', href: readme }))?.absPath).toBe(readme)
    expect((await resolve({ kind: 'href', href: `file://${readme}` }))?.absPath).toBe(readme)
  })

  it('answers null for web, mail, app-scheme and in-page links, and for missing files', async () => {
    setup()
    for (const href of ['https://example.com/a.md', 'mailto:a@b.c', 'zen-asset://local/x.png', '#heading', '', 'nope.md', '../../missing'])
      expect(await resolve({ kind: 'href', href })).toBeNull()
  })
})

describe('resolveStandaloneLink: wikilinks', () => {
  it('finds a page by name next to the note, ignoring alias and anchors', async () => {
    setup()
    const expected = path.join(root, 'proj/docs/wiki/t00-converter-ts.md')
    expect((await resolve({ kind: 'wikilink', target: 't00-converter-ts' }))?.absPath).toBe(expected)
    expect((await resolve({ kind: 'wikilink', target: 't00-converter-ts|converter.ts' }))?.absPath).toBe(expected)
    expect((await resolve({ kind: 'wikilink', target: 'T00-Converter-TS#Usage' }))?.absPath).toBe(expected)
    expect((await resolve({ kind: 'wikilink', target: 'topic-name^block' }))?.kind).toBe('markdown')
  })

  it('looks below the note directory, shallowest match first, skipping dot and node_modules folders', async () => {
    setup()
    expect((await resolve({ kind: 'wikilink', target: 'Nested' }))?.absPath).toBe(
      path.join(root, 'proj/docs/wiki/graphify-out/deep/Nested.md')
    )
    file('proj/docs/wiki/Nested.md')
    expect((await resolve({ kind: 'wikilink', target: 'Nested' }))?.absPath).toBe(
      path.join(root, 'proj/docs/wiki/Nested.md')
    )
    expect(await resolve({ kind: 'wikilink', target: 'Hidden' })).toBeNull()
    expect(await resolve({ kind: 'wikilink', target: 'Shadow' })).toBeNull()
  })

  it('does not look above the note directory or past the depth limit', async () => {
    setup()
    expect(await resolve({ kind: 'wikilink', target: 'README' })).toBeNull()
    const deep = 'proj/docs/wiki/' + Array.from({ length: WIKILINK_SEARCH_DEPTH + 1 }, (_, i) => `d${i}`).join('/')
    file(`${deep}/TooDeep.md`)
    expect(await resolve({ kind: 'wikilink', target: 'TooDeep' })).toBeNull()
  })

  it('treats a path-like target as relative to the note, like Obsidian', async () => {
    setup()
    expect((await resolve({ kind: 'wikilink', target: 'graphify-out/GRAPH_REPORT' }))?.absPath).toBe(
      path.join(root, 'proj/docs/wiki/graphify-out/GRAPH_REPORT.md')
    )
    expect((await resolve({ kind: 'wikilink', target: '../../README.md' }))?.absPath).toBe(
      path.join(root, 'proj/README.md')
    )
    expect(await resolve({ kind: 'wikilink', target: 'graphify-out/Missing' })).toBeNull()
  })

  it('answers null for an empty or anchor-only target', async () => {
    setup()
    expect(await resolve({ kind: 'wikilink', target: '' })).toBeNull()
    expect(await resolve({ kind: 'wikilink', target: '#Heading' })).toBeNull()
  })
})

describe('isStandaloneLink', () => {
  it('accepts only the two link shapes with string payloads', () => {
    expect(isStandaloneLink({ kind: 'wikilink', target: 'x' })).toBe(true)
    expect(isStandaloneLink({ kind: 'href', href: 'x' })).toBe(true)
    expect(isStandaloneLink({ kind: 'href', target: 'x' })).toBe(false)
    expect(isStandaloneLink({ kind: 'note', href: 'x' })).toBe(false)
    expect(isStandaloneLink('x')).toBe(false)
    expect(isStandaloneLink(null)).toBe(false)
  })
})
