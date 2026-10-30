import { history, undo, undoDepth } from '@codemirror/commands'
import {
  insertNewlineContinueMarkup,
  markdown,
  markdownLanguage
} from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import {
  EditorState,
  type ChangeSpec,
  type Extension,
  type TransactionSpec
} from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  orderedListRenumber,
  skipOrderedListRenumber
} from './cm-ordered-list-renumber'
import { listContinuationPrefix } from './list-continuation'

function makeState(
  doc: string,
  cursor = 0,
  extensions: Extension[] = []
): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      markdown({ base: markdownLanguage }),
      orderedListRenumber,
      ...extensions
    ]
  })
  // Force a full parse so the transactionExtender can rely on a
  // complete syntax tree when it walks for OrderedList nodes.
  ensureSyntaxTree(state, doc.length, 5_000)
  return state
}

function applyAndRead(
  doc: string,
  changes: ChangeSpec,
  opts: Pick<TransactionSpec, 'annotations'> = {}
): string {
  const state = makeState(doc)
  return state.update({ changes, ...opts }).state.doc.toString()
}

describe('orderedListRenumber', () => {
  it('renumbers when a line is moved down past another item', () => {
    // Simulates Alt+Down on the first item: line-swap of "1. one" and "2. two".
    const result = applyAndRead('1. one\n2. two\n3. three', {
      from: 0,
      to: 13,
      insert: '2. two\n1. one'
    })
    expect(result).toBe('1. two\n2. one\n3. three')
  })

  it('renumbers after a middle item is deleted', () => {
    // Delete "2. b\n" (positions 5..10). Survivors should be 1, 2, 3.
    const result = applyAndRead('1. a\n2. b\n3. c\n4. d', {
      from: 5,
      to: 10,
      insert: ''
    })
    expect(result).toBe('1. a\n2. c\n3. d')
  })

  it('renumbers when the first item itself is deleted', () => {
    // Delete "1. a\n" — second item slides to top, should become 1.
    const result = applyAndRead('1. a\n2. b\n3. c', {
      from: 0,
      to: 5,
      insert: ''
    })
    expect(result).toBe('1. b\n2. c')
  })

  it('renumbers after pasting a new item between existing ones', () => {
    // Insert "1. new\n" after the first line. Surviving items renumber.
    const result = applyAndRead('1. a\n2. b\n3. c', {
      from: 5,
      to: 5,
      insert: '1. new\n'
    })
    expect(result).toBe('1. a\n2. new\n3. b\n4. c')
  })

  it('preserves a non-1 starting number for in-place edits', () => {
    // User edits later items only — start number 5 stays.
    const result = applyAndRead('5. a\n6. b\n7. c', {
      from: 14,
      to: 14,
      insert: ' tail'
    })
    expect(result).toBe('5. a\n6. b\n7. c tail')
  })

  it('fixes a single out-of-order number from a single-line edit', () => {
    // Replace "7" with "9" on the third line; renumber should restore 7.
    const result = applyAndRead('5. a\n6. b\n7. c', {
      from: 10,
      to: 11,
      insert: '9'
    })
    expect(result).toBe('5. a\n6. b\n7. c')
  })

  it('preserves marker punctuation `)` per list', () => {
    const result = applyAndRead('1) a\n5) b\n9) c', {
      from: 14,
      to: 14,
      insert: ' '
    })
    expect(result).toBe('1) a\n2) b\n3) c ')
  })

  it('leaves bullet lists alone', () => {
    const result = applyAndRead('- one\n- two\n- three', {
      from: 5,
      to: 5,
      insert: ' x'
    })
    expect(result).toBe('- one x\n- two\n- three')
  })

  it('leaves numbered-looking lines inside a fenced code block alone', () => {
    const doc = '```\n1. one\n5. two\n```'
    const result = applyAndRead(doc, {
      from: doc.length,
      to: doc.length,
      insert: '\n'
    })
    expect(result).toBe('```\n1. one\n5. two\n```\n')
  })

  it('skips renumbering when skipOrderedListRenumber is set', () => {
    const result = applyAndRead(
      '1. a\n5. b\n9. c',
      { from: 14, to: 14, insert: ' ' },
      { annotations: skipOrderedListRenumber.of(true) }
    )
    expect(result).toBe('1. a\n5. b\n9. c ')
  })

  it('renumbers a nested ordered list independently of its outer list', () => {
    // Inner list's third item is mis-numbered (`5.`). Touching the
    // inner list triggers renumbering of just that nested list — the
    // outer list's numbering, already correct, is left alone.
    const initial = '1. outer a\n   1. inner a\n   2. inner b\n   5. inner c\n2. outer b'
    const innerEnd = initial.indexOf('inner c') + 'inner c'.length
    const result = applyAndRead(initial, {
      from: innerEnd,
      to: innerEnd,
      insert: '!'
    })
    expect(result).toBe(
      '1. outer a\n   1. inner a\n   2. inner b\n   3. inner c!\n2. outer b'
    )
  })

  it('does not re-trigger on undo (single undo step covers the whole edit)', () => {
    // Simulate the move-line-down flow: dispatch the user transaction
    // through the filter (so the renumber is appended), then dispatch
    // an undo-tagged transaction reversing the composed change. The
    // undo dispatch should pass through untouched.
    const before = '1. one\n2. two\n3. three'
    const state = makeState(before)
    const moved = state.update({
      changes: { from: 0, to: 13, insert: '2. two\n1. one' }
    })
    expect(moved.state.doc.toString()).toBe('1. two\n2. one\n3. three')

    const undone = moved.state.update({
      changes: moved.changes.invert(state.doc),
      userEvent: 'undo'
    })
    expect(undone.state.doc.toString()).toBe(before)
  })
})

/**
 * One item per entry of `texts`, numbered from 1. `width` right-aligns the
 * numbers to that many digits (` 9.` above `10.`); 0 writes them bare.
 */
function items(texts: string[], width = 0, indent = ''): string {
  return texts
    .map((text, i) => `${indent}${String(i + 1).padStart(width)}. ${text}`)
    .join('\n')
}

function letters(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    String.fromCharCode(97 + (i % 26))
  )
}

/** Press Enter (lang-markdown's list continuation) with the cursor at `pos`. */
function pressEnter(doc: string, pos: number): { doc: string; head: number } {
  let state = makeState(doc, pos)
  insertNewlineContinueMarkup({
    state,
    dispatch: (tr) => {
      state = tr.state
    }
  })
  return { doc: state.doc.toString(), head: state.selection.main.head }
}

/** Vim `o` (below) or `O` (above) on 1-based `lineNumber`, as cm-vim-open-line writes it. */
function openLine(doc: string, lineNumber: number, below: boolean): string {
  const state = makeState(doc)
  const line = state.doc.line(lineNumber)
  const prefix = listContinuationPrefix(line.text)
  if (prefix == null) throw new Error(`line ${lineNumber} is not a list item`)
  const changes = below
    ? { from: line.to, insert: `\n${prefix}` }
    : { from: line.from, insert: `${prefix}\n` }
  return state.update({ changes }).state.doc.toString()
}

function endOfLine(doc: string, lineNumber: number): number {
  return makeState(doc).doc.line(lineNumber).to
}

describe('orderedListRenumber on right-aligned lists', () => {
  it('Enter after ` 9.` writes `10.`, not the ` 10.` lang-markdown copies', () => {
    // A top-level list whose numbers carry a leading space is padded
    // ahead of its tenth item, as Julie writes them.
    const doc = items(letters(9), 2)
    const result = pressEnter(doc, doc.length)
    expect(result.doc).toBe(`${doc}\n10. `)
    expect(result.head).toBe(result.doc.length)
  })

  it('Vim `o` after ` 9.` writes `10.`', () => {
    const doc = items(letters(9), 2)
    expect(openLine(doc, 9, true)).toBe(`${doc}\n10. `)
  })

  it('Vim `O` above ` 9.` keeps both markers in line', () => {
    const doc = items(letters(9), 2)
    expect(openLine(doc, 9, false)).toBe(
      items([...letters(8), '', 'i'], 2)
    )
  })

  it('an item added mid-list moves ` 9.` to `10.` and drops its space', () => {
    const doc = items(letters(12), 2)
    const result = pressEnter(doc, endOfLine(doc, 5))
    const texts = letters(12)
    texts.splice(5, 0, '')
    expect(result.doc).toBe(items(texts, 2))
  })

  it('pads an unpadded item pasted into a padded list', () => {
    const doc = items(letters(10), 2)
    const at = makeState(doc).doc.line(3).from
    const result = applyAndRead(doc, { from: at, insert: '1. new\n' })
    const texts = letters(10)
    texts.splice(2, 0, 'new')
    expect(result).toBe(items(texts, 2))
  })

  it('keeps the alignment when an item moves across `10.`', () => {
    // Alt+Down on ` 9. i`: one change rewrites both lines.
    const doc = items(letters(11), 2)
    const state = makeState(doc)
    const from = state.doc.line(9).from
    const to = state.doc.line(10).to
    const result = state
      .update({ changes: { from, to, insert: '10. j\n 9. i' } })
      .state.doc.toString()
    const texts = letters(11)
    texts.splice(8, 2, 'j', 'i')
    expect(result).toBe(items(texts, 2))
  })

  it('a deleted item narrows `10.` to ` 9.`', () => {
    const doc = items(letters(10), 2)
    const state = makeState(doc)
    const line = state.doc.line(4)
    const result = state
      .update({ changes: { from: line.from, to: line.to + 1 } })
      .state.doc.toString()
    const texts = letters(10)
    texts.splice(3, 1)
    expect(result).toBe(items(texts, 2))
  })

  it('pads every marker once the list outgrows the column (99 to 100)', () => {
    const doc = items(letters(99), 2)
    const result = pressEnter(doc, doc.length)
    expect(result.doc).toBe(items([...letters(99), ''], 3))
  })

  it('keeps a child nested when its item widens from ` 9.` to `10.`', () => {
    // Right-aligned markers keep every item's text in one column, so the
    // child indented to that column stays inside its item.
    const doc = [items(letters(9), 2), '    - child', '10. j'].join('\n')
    const result = pressEnter(doc, endOfLine(doc, 1))
    expect(result.doc).toBe(
      [items(['a', '', ...letters(9).slice(1)], 2), '    - child', '11. j'].join(
        '\n'
      )
    )
    const state = makeState(result.doc)
    const bullet = syntaxTree(state).resolveInner(
      result.doc.indexOf('- child'),
      1
    )
    expect(bullet.parent?.parent?.name).toBe('BulletList')
    expect(bullet.parent?.parent?.parent?.name).toBe('ListItem')
  })

  it('keeps a padded list inside a quote aligned', () => {
    const doc = items(letters(9), 2)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    const result = pressEnter(doc, doc.length)
    expect(result.doc).toBe(`${doc}\n> 10. `)
  })

  it('keeps a nested list padded by hand aligned', () => {
    // Under `1. outer` the content column is 3. Markers of two widths
    // ending in one column prove the padding.
    const inner = items(letters(10), 2, '   ')
    const doc = `1. outer\n${inner}`
    const result = pressEnter(doc, endOfLine(doc, 6))
    const texts = letters(10)
    texts.splice(5, 0, '')
    expect(result.doc).toBe(`1. outer\n${items(texts, 2, '   ')}`)
  })

  it('leaves a marker someone just unpadded by hand', () => {
    const doc = items(letters(10), 2)
    const result = applyAndRead(doc, { from: 0, to: 1 })
    expect(result).toBe(doc.slice(1))
  })

  it('leaves a marker someone just padded further by hand', () => {
    const doc = items(letters(10), 2)
    const result = applyAndRead(doc, { from: 0, insert: ' ' })
    expect(result).toBe(` ${doc}`)
  })

  it('undoes Enter and the realignment in one step', () => {
    const doc = items(letters(12), 2)
    let state = makeState(doc, endOfLine(doc, 5), [history()])
    insertNewlineContinueMarkup({
      state,
      dispatch: (tr) => {
        state = tr.state
      }
    })
    expect(state.doc.toString()).not.toBe(doc)
    expect(undoDepth(state)).toBe(1)
    undo({
      state,
      dispatch: (tr) => {
        state = tr.state
      }
    })
    expect(state.doc.toString()).toBe(doc)
  })
})

describe('orderedListRenumber on lists nobody padded', () => {
  it('Enter after `9.` still writes `10.`', () => {
    const doc = items(letters(9))
    expect(pressEnter(doc, doc.length).doc).toBe(`${doc}\n10. `)
  })

  it('Vim `o` after `9.` still writes `10.`', () => {
    const doc = items(letters(9))
    expect(openLine(doc, 9, true)).toBe(`${doc}\n10. `)
  })

  it('an item added mid-list only changes digits', () => {
    const doc = items(letters(12))
    const result = pressEnter(doc, endOfLine(doc, 5))
    const texts = letters(12)
    texts.splice(5, 0, '')
    expect(result.doc).toBe(items(texts))
  })

  it('a moved item only changes digits', () => {
    const doc = items(letters(11))
    const state = makeState(doc)
    const from = state.doc.line(9).from
    const to = state.doc.line(10).to
    const result = state
      .update({ changes: { from, to, insert: '10. j\n9. i' } })
      .state.doc.toString()
    const texts = letters(11)
    texts.splice(8, 2, 'j', 'i')
    expect(result).toBe(items(texts))
  })

  it('keeps the spaces of a list that was not aligned', () => {
    // ` 9.` then ` 10.`: what Enter wrote before this pass aligned lists.
    const doc = ' 8. h\n 9. i\n 10. j'
    expect(pressEnter(doc, doc.length).doc).toBe(`${doc}\n 11. `)
  })

  it('keeps the indentation of a nested list under `1. `', () => {
    // Tab writes four spaces: one past the parent's content column.
    const doc = `1. outer\n${items(letters(9), 0, '    ')}`
    expect(pressEnter(doc, doc.length).doc).toBe(`${doc}\n    10. `)
  })

  it('keeps the indentation of a nested list under `- `', () => {
    // Two past the parent's content column.
    const doc = `- outer\n${items(letters(9), 0, '    ')}`
    expect(pressEnter(doc, doc.length).doc).toBe(`${doc}\n    10. `)
    const inserted = items(['new', ...letters(9)], 0, '    ')
    expect(
      applyAndRead(doc, { from: '- outer\n'.length, insert: '    1. new\n' })
    ).toBe(`- outer\n${inserted}`)
  })
})
