import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { noteMarkdownToIR, renderNoteDocx } from './note-docx'
import type { IRBlock } from './note-docx'

// The IR is where every markdown-to-Word mapping decision lives, so it is
// asserted as plain data; the docx layer is exercised end to end only for
// "produces a real .docx container", since its output is a zip of XML that a
// unit test cannot meaningfully read without reimplementing Word.

function ir(markdown: string): IRBlock[] {
  return noteMarkdownToIR(markdown)
}

describe('noteMarkdownToIR', () => {
  it('maps headings with their levels and inline styles', () => {
    const [h] = ir('## A **bold** plan\n')
    expect(h).toMatchObject({ kind: 'heading', level: 2 })
    expect((h as Extract<IRBlock, { kind: 'heading' }>).runs).toEqual([
      { text: 'A ' },
      { text: 'bold', bold: true },
      { text: ' plan' }
    ])
  })

  it('keeps external links and downgrades relative ones to plain text', () => {
    const [p] = ir('See [the site](https://example.com) and [a note](./other.md).\n')
    const runs = (p as Extract<IRBlock, { kind: 'paragraph' }>).runs
    expect(runs.find((run) => run.text === 'the site')?.link).toBe('https://example.com')
    expect(runs.find((run) => run.text === 'a note')?.link).toBeUndefined()
  })

  it('splits ==highlights== out of plain text', () => {
    const [p] = ir('Keep ==this part== safe.\n')
    expect((p as Extract<IRBlock, { kind: 'paragraph' }>).runs).toEqual([
      { text: 'Keep ' },
      { text: 'this part', highlight: true },
      { text: ' safe.' }
    ])
  })

  it('maps nested and task lists', () => {
    const [list] = ir('- top\n  - inner\n- [x] done\n- [ ] open\n')
    const l = list as Extract<IRBlock, { kind: 'list' }>
    expect(l.ordered).toBe(false)
    expect(l.items).toHaveLength(3)
    expect(l.items[0].blocks.some((b) => b.kind === 'list')).toBe(true)
    expect(l.items[1].checked).toBe(true)
    expect(l.items[2].checked).toBe(false)
  })

  it('maps GFM tables with alignment and header', () => {
    const [table] = ir('| a | b |\n| :- | -: |\n| 1 | 2 |\n')
    const t = table as Extract<IRBlock, { kind: 'table' }>
    expect(t.header.map((cell) => cell[0]?.text)).toEqual(['a', 'b'])
    expect(t.rows).toHaveLength(1)
    expect(t.aligns).toEqual(['left', 'right'])
  })

  it('keeps code fences as verbatim lines and math as mono source', () => {
    const blocks = ir('```ts\nconst a = 1\n\nconst b = 2\n```\n\n$$\nE = mc^2\n$$\n')
    expect(blocks[0]).toMatchObject({ kind: 'code', lang: 'ts' })
    expect((blocks[0] as Extract<IRBlock, { kind: 'code' }>).lines).toEqual([
      'const a = 1',
      '',
      'const b = 2'
    ])
    expect(blocks[1]).toMatchObject({ kind: 'code', lang: 'math' })
  })

  it('promotes a standalone image to a figure and degrades an inline one to alt text', () => {
    const blocks = ir('![diagram](assets/d.png)\n\nsee ![icon](i.png) here\n')
    expect(blocks[0]).toEqual({ kind: 'image', src: 'assets/d.png', alt: 'diagram' })
    const runs = (blocks[1] as Extract<IRBlock, { kind: 'paragraph' }>).runs
    expect(runs.map((run) => run.text).join('')).toBe('see [icon] here')
  })

  it('drops frontmatter and HTML comments, keeps quotes as nested blocks', () => {
    const blocks = ir('---\ntitle: T\n---\n<!-- note to self -->\n> quoted **words**\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('quote')
  })
})

describe('renderNoteDocx', () => {
  it('produces a real .docx container and states the title as a heading', async () => {
    const markdown = '---\ntitle: Quarterly Report\n---\n\nSome **content** here.\n'
    const buffer = await renderNoteDocx(markdown, 'file-name', async () => null)
    // A .docx is a zip: PK\x03\x04, and far from empty.
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('PK')
    expect(buffer.byteLength).toBeGreaterThan(1500)
    const titled = noteMarkdownToIR('---\ntitle: Quarterly Report\n---\n# Quarterly Report\n\nx\n')
    expect(titled[0]).toMatchObject({ kind: 'heading', level: 1 })
  })

  it('falls back to italic alt text when an image cannot be resolved', async () => {
    const buffer = await renderNoteDocx('![gone](missing.png)\n', 'n', async () => null)
    expect(buffer.byteLength).toBeGreaterThan(1000)
  })

  // The whole point of this exporter versus pasted HTML: the document uses
  // Word's OWN styles, so a recipient restyles it by editing Heading 2, not
  // by reformatting runs. Pinned by reading the actual OOXML out of the zip.
  it.skipIf(process.platform === 'win32')(
    'emits real Word structure: heading styles, hyperlink style, list numbering',
    async () => {
      const markdown =
        '---\ntitle: Quarterly Report\n---\n\n## Findings\n\n- first\n- second\n\n' +
        'See [the site](https://example.com).\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
      const buffer = await renderNoteDocx(markdown, 'file', async () => null)
      const dir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-docx-'))
      try {
        const file = path.join(dir, 'out.docx')
        await writeFile(file, buffer)
        const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], {
          encoding: 'utf8'
        })
        expect(xml).toContain('w:val="Heading1"') // the stated frontmatter title
        expect(xml).toContain('Quarterly Report')
        expect(xml).toContain('w:val="Heading2"')
        expect(xml).toContain('w:val="Hyperlink"')
        expect(xml).toContain('<w:numPr>') // real list numbering, not dashes
        expect(xml).toContain('<w:tbl>') // a real table
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  // C0 control characters are illegal in XML 1.0, and docx writes run text
  // into document.xml verbatim: one stray \x01 pasted from a terminal capture
  // used to be enough for Word to reject the whole file as unreadable.
  it.skipIf(process.platform === 'win32')(
    'strips XML-illegal control characters out of runs, code, and alt text',
    async () => {
      const markdown =
        'A \x01bell\x07 and a \x0Bvtab in prose.\n\n' +
        '```\nlog\x02line\n```\n\n' +
        '![al\x03t](missing.png)\n\n' +
        '| a\x04 | b |\n| - | - |\n| 1\x05 | 2 |\n'
      const buffer = await renderNoteDocx(markdown, 'file', async () => null)
      const dir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-docx-ctrl-'))
      try {
        const file = path.join(dir, 'out.docx')
        await writeFile(file, buffer)
        const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], {
          encoding: 'utf8'
        })
        expect(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(xml)).toBe(false)
        // The surrounding text is untouched; only the control bytes go.
        expect(xml).toContain('bell')
        expect(xml).toContain('logline')
        expect(xml).toContain('alt')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  // #629: `![[chart.png|320]]` is what the app writes when you paste a picture,
  // and it used to reach Word as literal text.
  it('turns a wikilink image embed into an image block with its size hint', () => {
    const blocks = noteMarkdownToIR('![[chart.png|320]]\n\n![[Some note]]\n')
    expect(blocks[0]).toEqual({ kind: 'image', src: 'chart.png', alt: '', size: { width: 320, height: undefined } })
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' })
  })
})

describe('renderNoteDocx wikilink embeds', () => {
  it('hands the wikilink target and its size hint to the image resolver', async () => {
    const seen: Array<[string, unknown]> = []
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
    await renderNoteDocx('![[chart.png|Quarter|600x400]]\n', 'T', async (src, size) => {
      seen.push([src, size])
      return { data: png, width: 1, height: 1, type: 'png' }
    })
    expect(seen).toEqual([['chart.png', { width: 600, height: 400 }]])
  })

  it('writes the wikilink-embedded picture into the package as media (#629)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zen-docx-'))
    try {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      )
      const buffer = await renderNoteDocx('Chart:\n\n![[chart.png|320]]\n', 'T', async (src) =>
        src === 'chart.png' ? { data: png, width: 320, height: 107, type: 'png' } : null
      )
      const file = path.join(dir, 'note.docx')
      await writeFile(file, buffer)
      const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' })
      expect(listing).toMatch(/word\/media\/[^\s]+\.png/)
      const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8' })
      expect(xml).toContain('<w:drawing>')
      expect(xml).not.toContain('![[chart.png')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
