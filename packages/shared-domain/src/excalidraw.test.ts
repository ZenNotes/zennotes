import { describe, it, expect } from 'vitest'
import { compressToBase64 } from 'lz-string'
import {
  isExcalidrawPath,
  isObsidianExcalidrawPath,
  isObsidianExcalidrawMarkdown,
  extractObsidianExcalidrawScene
} from './excalidraw'

const scene = {
  type: 'excalidraw',
  version: 2,
  source: 'https://github.com/zsviczian/obsidian-excalidraw-plugin',
  elements: [
    { id: 'a1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50 },
    { id: 't1', type: 'text', x: 30, y: 40, text: 'hello' }
  ],
  appState: { gridSize: null, viewBackgroundColor: '#fffef5' },
  files: {}
}

/** Build a realistic Obsidian `.excalidraw.md` body around a given `## Drawing` block. */
function obsidianMarkdown(drawingBlock: string): string {
  return [
    '---',
    '',
    'excalidraw-plugin: parsed',
    'tags: [excalidraw]',
    '',
    '---',
    '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==',
    '',
    '# Excalidraw Data',
    '',
    '## Text Elements',
    'hello',
    '',
    '## Drawing',
    drawingBlock,
    '%%'
  ].join('\n')
}

describe('Obsidian Excalidraw import (#266)', () => {
  it('detects Obsidian drawings by filename, distinct from native .excalidraw', () => {
    expect(isObsidianExcalidrawPath('inbox/My Drawing.excalidraw.md')).toBe(true)
    expect(isObsidianExcalidrawPath('inbox/note.md')).toBe(false)
    expect(isObsidianExcalidrawPath('inbox/native.excalidraw')).toBe(false)
    // The two file types must not be confused with each other.
    expect(isExcalidrawPath('inbox/My Drawing.excalidraw.md')).toBe(false)
    expect(isExcalidrawPath('inbox/native.excalidraw')).toBe(true)
  })

  it('detects Obsidian drawings by the excalidraw-plugin frontmatter marker', () => {
    expect(isObsidianExcalidrawMarkdown('---\nexcalidraw-plugin: parsed\n---\n# hi')).toBe(true)
    expect(isObsidianExcalidrawMarkdown('---\nexcalidraw-plugin: raw\ntags: [x]\n---\n')).toBe(true)
    expect(isObsidianExcalidrawMarkdown('---\ntags: [note]\n---\n# hi')).toBe(false)
    expect(isObsidianExcalidrawMarkdown('# just a note')).toBe(false)
    expect(isObsidianExcalidrawMarkdown(null)).toBe(false)
  })

  it('extracts a plain ```json drawing', () => {
    const md = obsidianMarkdown('```json\n' + JSON.stringify(scene) + '\n```')
    const doc = extractObsidianExcalidrawScene(md)
    expect(doc).not.toBeNull()
    expect(doc?.type).toBe('excalidraw')
    expect(doc?.elements).toHaveLength(2)
    expect((doc?.elements[0] as { id: string }).id).toBe('a1')
    expect((doc?.appState as { viewBackgroundColor: string }).viewBackgroundColor).toBe('#fffef5')
  })

  it('extracts a ```compressed-json drawing using Obsidian’s LZString codec', () => {
    const compressed = compressToBase64(JSON.stringify(scene))
    // Obsidian wraps the base64 across lines for readability; ensure we strip them.
    const wrapped = compressed.replace(/(.{64})/g, '$1\n')
    const md = obsidianMarkdown('```compressed-json\n' + wrapped + '\n```')
    const doc = extractObsidianExcalidrawScene(md)
    expect(doc).not.toBeNull()
    expect(doc?.elements).toHaveLength(2)
    expect((doc?.elements[1] as { text: string }).text).toBe('hello')
  })

  it('prefers the code block under the ## Drawing heading', () => {
    const md = [
      '---',
      'excalidraw-plugin: parsed',
      '---',
      '## Some Other Section',
      '```json',
      '{"type":"not-excalidraw","note":"decoy"}',
      '```',
      '## Drawing',
      '```json',
      JSON.stringify(scene),
      '```',
      '%%'
    ].join('\n')
    const doc = extractObsidianExcalidrawScene(md)
    expect(doc?.elements).toHaveLength(2)
  })

  it('returns null when there is no recoverable scene', () => {
    expect(extractObsidianExcalidrawScene('# Just a note\n\nsome text')).toBeNull()
    // a JSON block that is not an Excalidraw scene
    expect(extractObsidianExcalidrawScene('```json\n{"foo":1}\n```')).toBeNull()
    expect(extractObsidianExcalidrawScene('')).toBeNull()
    expect(extractObsidianExcalidrawScene(null)).toBeNull()
  })
})
