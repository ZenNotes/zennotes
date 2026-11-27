import { markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { describe, expect, it, vi } from 'vitest'
import { frontmatterRange } from './cm-frontmatter'
import { noteMarkdown } from './cm-markdown-language'

function parse(doc: string): { state: EditorState; tree: Tree } {
  const state = EditorState.create({ doc, extensions: [noteMarkdown()] })
  const tree = ensureSyntaxTree(state, doc.length, 5000)
  if (!tree) throw new Error('parse did not finish')
  return { state, tree }
}

/** Names of the nodes in the tree, pre-order, with absolute ranges. */
function nodes(tree: Tree, from = 0, to = tree.length): string[] {
  const out: string[] = []
  tree.iterate({
    from,
    to,
    enter: (node) => {
      out.push(`${node.name}[${node.from},${node.to}]`)
    }
  })
  return out
}

function names(tree: Tree): string[] {
  return nodes(tree).map((entry) => entry.replace(/\[.*$/, ''))
}

/** The markdown Document mounted on the body: the last child of the outer
 *  Document once the mount replaces the Body node. */
function markdownDocument(tree: Tree): SyntaxNode {
  const doc = tree.topNode.lastChild
  if (!doc || doc.name !== 'Document') throw new Error(`no markdown document, got ${doc?.name}`)
  return doc
}

/** The markdown block (a direct child of the mounted Document) that contains
 *  `pos`. Its `.tree` is the object the incremental parser either reused from
 *  the previous tree or rebuilt, so identity between two trees means reuse. */
function blockTreeAt(tree: Tree, pos: number): Tree {
  for (let block = markdownDocument(tree).firstChild; block; block = block.nextSibling) {
    if (block.from <= pos && pos < block.to) {
      if (!block.tree) throw new Error(`block ${block.name} at ${pos} has no tree`)
      return block.tree
    }
  }
  throw new Error(`no block at ${pos}`)
}

const REPORTED = `---
title: InfSec
parent: [[Cyber Security]]
type: Uni Folder
tags:
  - todo
---
# InfSec

Body text
Setext
------

---
`

describe('noteMarkdown: frontmatter is not markdown', () => {
  it('parses the reported note without a setext heading in the frontmatter', () => {
    const { tree } = parse(REPORTED)
    const closing = REPORTED.indexOf('\n---\n#') + 1
    const all = nodes(tree)
    expect(all[0]).toBe(`Document[0,${REPORTED.length}]`)
    expect(all[1]).toBe(`Frontmatter[0,${closing + 3}]`)
    expect(all[2]).toBe('FrontmatterMark[0,3]')
    expect(all[3]).toBe(`FrontmatterMark[${closing},${closing + 3}]`)
    // Nothing markdown-shaped inside the block: the outer Frontmatter node has
    // exactly its two fences as children.
    const frontmatter = nodes(tree, 0, closing + 3).filter((n) => !n.startsWith('Document'))
    expect(frontmatter).toEqual([
      `Frontmatter[0,${closing + 3}]`,
      'FrontmatterMark[0,3]',
      `FrontmatterMark[${closing},${closing + 3}]`
    ])
    // The body keeps its markdown, at absolute positions. A setext underline
    // turns the whole paragraph above it into the heading, so the real one
    // starts at "Body text" and runs to the end of the dashes.
    const heading = REPORTED.indexOf('# InfSec')
    expect(all).toContain(`ATXHeading1[${heading},${heading + 8}]`)
    const setextFrom = REPORTED.indexOf('Body text')
    const setextTo = REPORTED.indexOf('------') + 6
    expect(all).toContain(`SetextHeading2[${setextFrom},${setextTo}]`)
    expect(names(tree).filter((n) => n === 'SetextHeading2')).toHaveLength(1)
    const rule = REPORTED.lastIndexOf('---')
    expect(all).toContain(`HorizontalRule[${rule},${rule + 3}]`)
    expect(names(tree).filter((n) => n === 'HorizontalRule')).toHaveLength(1)
  })

  it('agrees with frontmatterRange about where the block ends', () => {
    for (const doc of [
      REPORTED,
      '--- \nkey: value\n  ---\nbody',
      '---\nkey: value\n---',
      '---\nkey: value\n---\n',
      '---\n\nkey: value\n\n---\n\n# Title'
    ]) {
      const { state, tree } = parse(doc)
      const range = frontmatterRange(state)
      expect(range).not.toBeNull()
      const frontmatter = tree.topNode.firstChild
      expect(frontmatter?.name).toBe('Frontmatter')
      expect({ from: frontmatter!.from, to: frontmatter!.to }).toEqual(range)
    }
  })

  it('leaves an unclosed opening fence to markdown, as a horizontal rule', () => {
    const doc = '---\ntitle: x\n\n# Heading'
    const { state, tree } = parse(doc)
    expect(frontmatterRange(state)).toBeNull()
    const all = nodes(tree)
    expect(all).not.toContain(expect.stringMatching(/^Frontmatter/))
    expect(all).toContain('HorizontalRule[0,3]')
    expect(all).toContain(`ATXHeading1[${doc.indexOf('#')},${doc.length}]`)
  })

  it('only recognises a block that starts on line 1', () => {
    const doc = '\n---\ntitle: x\n---\nbody'
    const { tree } = parse(doc)
    expect(names(tree)).not.toContain('Frontmatter')
    expect(names(tree)).toContain('HorizontalRule')
  })

  it('does not mistake a longer dash run or a fence with text for a fence', () => {
    for (const doc of ['----\ntitle: x\n---\nbody', '---\ntitle: x\n--- end\nbody']) {
      const { state, tree } = parse(doc)
      expect(frontmatterRange(state)).toBeNull()
      expect(names(tree)).not.toContain('Frontmatter')
    }
  })

  it('handles an empty document and a document that is only frontmatter', () => {
    expect(nodes(parse('').tree)).toEqual(['Document[0,0]', 'Document[0,0]'])
    const { tree } = parse('---\n---')
    expect(nodes(tree)).toEqual([
      'Document[0,7]',
      'Frontmatter[0,7]',
      'FrontmatterMark[0,3]',
      'FrontmatterMark[4,7]',
      'Document[7,7]'
    ])
  })

  it('finds a closing fence that straddles the read chunk boundary', () => {
    const filler = 'k: ' + 'v'.repeat(4096 - 6) + '\n'
    const doc = `---\n${filler}---\n# After`
    const { state, tree } = parse(doc)
    const range = frontmatterRange(state)
    const frontmatter = tree.topNode.firstChild
    expect(frontmatter?.name).toBe('Frontmatter')
    expect({ from: frontmatter!.from, to: frontmatter!.to }).toEqual(range)
    expect(names(tree)).toContain('ATXHeading1')
  })

  it('reports the markdown language active in the body and inactive in the frontmatter', () => {
    const { state } = parse(REPORTED)
    const inFrontmatter = REPORTED.indexOf('title') + 2
    const inBody = REPORTED.indexOf('Body') + 2
    expect(markdownLanguage.isActiveAt(state, inFrontmatter)).toBe(false)
    expect(markdownLanguage.isActiveAt(state, inBody)).toBe(true)
    expect(markdownLanguage.isActiveAt(state, REPORTED.length)).toBe(true)
  })

  it('still nests code fence languages in the body', () => {
    const doc = '---\ntitle: x\n---\n\n```js\nconst a = 1\n```\n'
    const { tree } = parse(doc)
    expect(names(tree)).toContain('FencedCode')
    // Code languages mount as overlays, which plain iteration skips but
    // `resolveInner` enters: the `a` in `const a` is a JavaScript node.
    const variable = doc.indexOf('const a') + 'const '.length
    expect(tree.resolveInner(variable, 1).name).toBe('VariableDefinition')
  })
})

describe('noteMarkdown: incremental parsing', () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some words.`)
  const BODY = paragraphs.join('\n\n')

  function update(state: EditorState, from: number, to: number, insert: string): EditorState {
    // The state update parses for a 20 ms slice of time, and on a slow CI
    // runner the slice ran out before the reused blocks ("no block at 634").
    // A frozen clock lets this update's own parse finish, which is the one
    // that reuses blocks.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    let next: EditorState
    try {
      next = state.update({ changes: { from, to, insert } }).state
    } finally {
      clock.mockRestore()
    }
    ensureSyntaxTree(next, next.doc.length, 5000)
    return next
  }

  // A block well below the edit: the markdown parser never reuses the block
  // touching the change or the final one, so those prove nothing either way.
  const PROBE = 'Paragraph 20 '

  it('reuses body blocks below an edit in the body', () => {
    const doc = `---\ntitle: x\n---\n${BODY}`
    const { state, tree } = parse(doc)
    const probeAt = doc.indexOf(PROBE)
    const probeTree = blockTreeAt(tree, probeAt)

    const editAt = doc.indexOf('Paragraph 3 ')
    const next = update(state, editAt, editAt, 'Edited ')
    const after = syntaxTree(next)
    expect(blockTreeAt(after, probeAt + 'Edited '.length)).toBe(probeTree)
    // And the edited block itself was reparsed with the new text.
    const edited = blockTreeAt(after, editAt)
    expect(edited).not.toBe(blockTreeAt(tree, editAt))
    expect(edited.length).toBe(blockTreeAt(tree, editAt).length + 'Edited '.length)
  })

  it('reuses body blocks below an edit inside the frontmatter', () => {
    const doc = `---\ntitle: x\n---\n${BODY}`
    const { state, tree } = parse(doc)
    const probeAt = doc.indexOf(PROBE)
    const probeTree = blockTreeAt(tree, probeAt)

    const editAt = doc.indexOf('title: x') + 'title: x'.length
    const next = update(state, editAt, editAt, 'yz')
    const after = syntaxTree(next)
    expect(after.topNode.firstChild!.name).toBe('Frontmatter')
    expect(after.topNode.firstChild!.to).toBe(doc.indexOf('\n---\n') + 1 + 3 + 2)
    expect(blockTreeAt(after, probeAt + 2)).toBe(probeTree)
  })

  it('recognises the block the moment the closing fence is typed below an open one', () => {
    // The "type frontmatter from scratch" flow: `---` on line 1 is a
    // horizontal rule until the closing fence exists two lines further down.
    const doc = `---\ntitle: x\n\n${BODY}`
    const { state, tree } = parse(doc)
    expect(names(tree)).toContain('HorizontalRule')
    expect(names(tree)).not.toContain('Frontmatter')
    const probeAt = doc.indexOf(PROBE)
    const probeTree = blockTreeAt(tree, probeAt)

    const fenceAt = doc.indexOf('\n\n') + 1
    const next = update(state, fenceAt, fenceAt, '---')
    const after = syntaxTree(next)
    expect(nodes(after).slice(0, 4)).toEqual([
      `Document[0,${next.doc.length}]`,
      `Frontmatter[0,${fenceAt + 3}]`,
      'FrontmatterMark[0,3]',
      `FrontmatterMark[${fenceAt},${fenceAt + 3}]`
    ])
    expect(names(after)).not.toContain('HorizontalRule')
    expect(names(after)).not.toContain('SetextHeading2')
    // This one transition reparses the body in full: the Body node moved from
    // position 0 to the closing fence. Through @lezer/common 1.5.4 parseMixed
    // lost track of the old mount there by itself; 1.5.5 finds it again, so
    // the grammar now withholds the older trees (`bodyKeptItsStart`). Keep it
    // that way: blocks reused across a moved start can keep a meaning the
    // move changed (the header of cm-markdown-language.ts has the numbers).
    // It costs one parse, the same as opening the note, and the very next
    // edit is incremental again.
    expect(blockTreeAt(after, probeAt + 3)).not.toBe(probeTree)
    const settled = blockTreeAt(after, probeAt + 3)
    const editAt = next.doc.toString().indexOf('Paragraph 3 ')
    const again = update(next, editAt, editAt, 'Edited ')
    expect(blockTreeAt(syntaxTree(again), probeAt + 3 + 'Edited '.length)).toBe(settled)
  })

  it('reparses a note without frontmatter when its first characters are deleted', () => {
    // The fragment left by a deletion at position 0 starts at the body's
    // start without being the old start. Lezer's markdown reuse then keeps
    // blocks whose meaning the cut changed, so nothing older is reused.
    const { state, tree } = parse(BODY)
    const probeAt = BODY.indexOf(PROBE)
    const probeTree = blockTreeAt(tree, probeAt)
    const next = update(state, 0, 2, '')
    expect(blockTreeAt(syntaxTree(next), probeAt - 2)).not.toBe(probeTree)

    // The note that showed it: six spaces of indent cut to four.
    const doc =
      '      - nested\n    more\n\n    ## Sub heading\n\n---x\nParagraph one with words.\n\n' +
      'Paragr\naph one with words.\n\n    indente|d code\n\n -   indented code'
    const cut = update(parse(doc).state, 0, 2, '')
    expect(nodes(syntaxTree(cut))).toEqual(nodes(parse(doc.slice(2)).tree))
  })

  it('drops the block the moment its closing fence is broken', () => {
    const doc = `---\ntitle: x\n---\n${BODY}`
    const { state } = parse(doc)
    const closing = doc.indexOf('\n---\n') + 1
    const next = update(state, closing + 3, closing + 3, 'x')
    const after = syntaxTree(next)
    expect(names(after)).not.toContain('Frontmatter')
    expect(names(after)).toContain('HorizontalRule')
  })

  it('reads the text past a parse that ran out of time again', () => {
    // When an update's 20 ms slice runs out, the whole-note outer tree makes
    // CodeMirror drop the older tree past that point, so the parse that
    // resumes reads the rest again instead of reusing blocks parsed before
    // the edit. That is the safe outcome (the header of
    // cm-markdown-language.ts says why); a change that starts reusing them
    // should be a decision, not an accident.
    const doc = `---\ntitle: x\n---\n${BODY}`
    const { state, tree } = parse(doc)
    const probeAt = doc.indexOf(PROBE)
    const probeTree = blockTreeAt(tree, probeAt)

    const editAt = doc.indexOf('Paragraph 3 ')
    // A clock that moves 30 ms per read ends the slice after one step.
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 30))
    let next: EditorState
    try {
      next = state.update({ changes: { from: editAt, to: editAt, insert: 'Edited ' } }).state
    } finally {
      clock.mockRestore()
    }
    expect(syntaxTreeAvailable(next)).toBe(false)
    const after = ensureSyntaxTree(next, next.doc.length, 5000)!
    expect(blockTreeAt(after, probeAt + 'Edited '.length)).not.toBe(probeTree)
    expect(nodes(after)).toEqual(nodes(parse(next.doc.toString()).tree))
  })
})

describe('a lone dash under a line of text (#898)', () => {
  it('keeps the line a paragraph, with the dash as its last line', () => {
    for (const dash of ['-', '- ', '   -  ']) {
      const doc = `Some text\n${dash}\n`
      const { tree } = parse(doc)
      expect(names(tree)).not.toContain('SetextHeading2')
      expect(nodes(tree)).toContain(`Paragraph[0,${'Some text\n'.length + dash.length}]`)
    }
  })

  it('still reads two or more dashes, and an = underline, as a heading', () => {
    expect(names(parse('Some text\n--\n').tree)).toContain('SetextHeading2')
    expect(names(parse('Some text\n---\n').tree)).toContain('SetextHeading2')
    expect(names(parse('Some text\n=\n').tree)).toContain('SetextHeading1')
  })

  it('ends the paragraph on the dash line, where the heading would have ended', () => {
    const { tree } = parse('Some text\n-\nmore text\n- item\n')
    const all = nodes(tree)
    expect(all).toContain('Paragraph[0,11]')
    expect(all).toContain('Paragraph[12,21]')
    expect(names(tree)).toContain('BulletList')
  })

  it('applies inside a blockquote and leaves a dash after a blank line a list', () => {
    const quoted = parse('> quoted\n> -\n').tree
    expect(names(quoted)).not.toContain('SetextHeading2')
    expect(nodes(quoted)).toContain('Paragraph[2,12]')
    const list = parse('Some text\n\n-\n').tree
    expect(names(list)).toContain('BulletList')
    expect(nodes(list)).toContain('Paragraph[0,9]')
  })
})
