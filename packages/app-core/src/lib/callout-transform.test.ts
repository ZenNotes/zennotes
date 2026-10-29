import { describe, expect, it } from 'vitest'
import { CALLOUT_TYPES } from './callout-types'
import {
  applyCalloutChanges,
  calloutMenuEntries,
  calloutTargetAt,
  calloutTypeChoices,
  changeCalloutType,
  mapCalloutPos,
  removeCallout,
  turnIntoCallout,
  type CalloutBlock,
  type CalloutTarget
} from './callout-transform'

/** Offset of `needle` in `doc` (plus `shift`), failing loudly when absent. */
function at(doc: string, needle: string, shift = 0): number {
  const i = doc.indexOf(needle)
  if (i < 0) throw new Error(`"${needle}" not in doc`)
  return i + shift
}

function target(doc: string, from: number, to = from): CalloutTarget {
  return calloutTargetAt(doc, { from, to })
}

function calloutAt(doc: string, pos: number): CalloutBlock {
  const t = target(doc, pos)
  if (t.kind !== 'callout') throw new Error(`expected a callout, got ${t.kind}`)
  return t.callout
}

/** Turn whatever `from..to` targets into a callout of `type`. */
function turnInto(doc: string, from: number, to = from, type = 'warning') {
  const t = target(doc, from, to)
  if (t.kind !== 'block') throw new Error(`expected a block, got ${JSON.stringify(t)}`)
  const edit = turnIntoCallout(doc, t, type, { anchor: from, head: to })
  return { text: applyCalloutChanges(doc, edit.changes), selection: edit.selection }
}

function change(doc: string, pos: number, type: string) {
  const edit = changeCalloutType(calloutAt(doc, pos), type, { anchor: pos, head: pos })
  return edit && { text: applyCalloutChanges(doc, edit.changes), selection: edit.selection }
}

function remove(doc: string, pos: number) {
  const edit = removeCallout(doc, calloutAt(doc, pos), { anchor: pos, head: pos })
  return { text: applyCalloutChanges(doc, edit.changes), selection: edit.selection }
}

describe('turn into a callout (#1016)', () => {
  it('takes the paragraph at the caret, its lines and no further', () => {
    const doc = 'Intro\n\nFirst line\nsecond line\n\nAfter'
    const { text, selection } = turnInto(doc, at(doc, 'second', 3))
    expect(text).toBe('Intro\n\n> [!warning]\n> First line\n> second line\n\nAfter')
    // The caret stays on the same letter.
    expect(text.slice(selection.head, selection.head + 4)).toBe('ond ')
  })

  it('covers the whole lines a selection touches', () => {
    const doc = 'alpha one\nbeta two\ngamma three'
    const { text, selection } = turnInto(doc, at(doc, 'one'), at(doc, 'two'))
    expect(text).toBe('> [!warning]\n> alpha one\n> beta two\n\ngamma three')
    expect(text.slice(selection.anchor, selection.head)).toBe('one\n> beta ')
  })

  it('leaves out the line a selection ends at the very start of', () => {
    const doc = 'one\ntwo\nthree'
    const { text } = turnInto(doc, 0, at(doc, 'three'))
    expect(text).toBe('> [!warning]\n> one\n> two\n\nthree')
  })

  it('keeps blank lines inside a selection in the callout as `>`', () => {
    const doc = 'one\n\ntwo\n'
    const { text } = turnInto(doc, 0, at(doc, 'two', 3))
    expect(text).toBe('> [!warning]\n> one\n>\n> two\n')
  })

  it('drops blank lines at the edges of a selection', () => {
    const doc = 'top\n\none\n\nbottom'
    const { text } = turnInto(doc, at(doc, '\none') , at(doc, 'one', 4))
    expect(text).toBe('top\n\n> [!warning]\n> one\n\nbottom')
  })

  it('puts the title line above a plain blockquote instead of quoting it twice', () => {
    const doc = 'Text\n\n> quoted one\n>\n> quoted two\n\nMore'
    const { text, selection } = turnInto(doc, at(doc, 'two'), at(doc, 'two'), 'tip')
    expect(text).toBe('Text\n\n> [!tip]\n> quoted one\n>\n> quoted two\n\nMore')
    expect(text.slice(selection.head, selection.head + 3)).toBe('two')
  })

  it('grows a selection inside a blockquote to the whole quote', () => {
    const doc = '> first\n> second\n> third'
    const { text } = turnInto(doc, at(doc, 'second'), at(doc, 'second', 3), 'note')
    expect(text).toBe('> [!note]\n> first\n> second\n> third')
  })

  it('wraps a whole list from a caret in one of its items', () => {
    const doc = 'Shopping:\n\n- apples\n- pears\n  - green\n\nDone'
    const { text } = turnInto(doc, at(doc, 'pears'))
    expect(text).toBe('Shopping:\n\n> [!warning]\n> - apples\n> - pears\n>   - green\n\nDone')
  })

  it('takes the whole list from a hard-wrapped item or a nested one', () => {
    const doc = '- first item\n  wraps here\n- second\n  - nested'
    const whole = '> [!warning]\n> - first item\n>   wraps here\n> - second\n>   - nested'
    expect(turnInto(doc, at(doc, 'wraps')).text).toBe(whole)
    expect(turnInto(doc, at(doc, 'nested')).text).toBe(whole)
  })

  it('keeps a callout made from a list item paragraph inside that item', () => {
    const doc = '- item\n\n  More about the item\n  on two lines\n- next'
    const { text } = turnInto(doc, at(doc, 'More'))
    expect(text).toBe('- item\n\n  > [!warning]\n  > More about the item\n  > on two lines\n- next')
  })

  it('stops a paragraph at a heading, and takes a heading on its own', () => {
    const doc = '# Title\nBody line\nmore body'
    expect(turnInto(doc, at(doc, 'Body')).text).toBe('# Title\n> [!warning]\n> Body line\n> more body')
    expect(turnInto(doc, at(doc, 'Title')).text).toBe('> [!warning]\n> # Title\nBody line\nmore body')
  })

  it('stops a paragraph at the edge of a quote, and keeps the quote out of the callout', () => {
    const doc = 'Plain text\n> a quote right after'
    expect(turnInto(doc, at(doc, 'Plain')).text).toBe('> [!warning]\n> Plain text\n\n> a quote right after')
  })

  it('splits a callout made from the middle of a paragraph off the lines below it', () => {
    const doc = 'one\ntwo\nthree'
    const { text, selection } = turnInto(doc, at(doc, 'two'), at(doc, 'two', 3))
    expect(text).toBe('one\n> [!warning]\n> two\n\nthree')
    expect(text.slice(selection.anchor, selection.head)).toBe('two')
  })

  it('puts a blank line between a quote and a callout made from the text under it', () => {
    const doc = '> quote\nlazy line'
    expect(turnInto(doc, at(doc, 'lazy')).text).toBe('> quote\n\n> [!warning]\n> lazy line')
  })

  it('needs no blank line under a callout that ends in a fence or a heading', () => {
    const doc = '# Head\nnext'
    expect(turnInto(doc, 1).text).toBe('> [!warning]\n> # Head\nnext')
  })

  it('works on the last line of a document with no newline after it', () => {
    const doc = 'one\n\nlast line'
    const { text, selection } = turnInto(doc, doc.length)
    expect(text).toBe('one\n\n> [!warning]\n> last line')
    expect(selection.head).toBe(text.length)
  })

  it('works on a one-line document', () => {
    expect(turnInto('solo', 2).text).toBe('> [!warning]\n> solo')
  })

  it('keeps CRLF line endings, the new title line included', () => {
    const doc = 'a\r\n\r\nfirst\r\nsecond\r\n\r\nz'
    const { text } = turnInto(doc, at(doc, 'first'))
    expect(text).toBe('a\r\n\r\n> [!warning]\r\n> first\r\n> second\r\n\r\nz')
  })

  it('gives a CRLF document a CRLF title line from its last line', () => {
    const doc = 'a\r\n\r\nend'
    expect(turnInto(doc, doc.length).text).toBe('a\r\n\r\n> [!warning]\r\n> end')
  })

  it('grows a selection that reaches into part of a callout to all of it, nested', () => {
    const doc = 'Lead in\n> [!note] Title\n> body\n\nafter'
    const { text } = turnInto(doc, 0, at(doc, 'Title'))
    expect(text).toBe('> [!warning]\n> Lead in\n> > [!note] Title\n> > body\n\nafter')
  })

  it('wraps two callouts and what lies between when a selection spans them', () => {
    const doc = '> [!note]\n> one\n\n> [!tip]\n> two'
    const { text } = turnInto(doc, at(doc, 'one'), at(doc, 'two'))
    expect(text).toBe('> [!warning]\n> > [!note]\n> > one\n>\n> > [!tip]\n> > two')
  })
})

describe('frontmatter and code fences', () => {
  const withFrontmatter = '---\ntags: [a]\n---\nFirst paragraph\nstill first\n\nSecond'

  it('refuses a caret in the frontmatter', () => {
    expect(target(withFrontmatter, at(withFrontmatter, 'tags'))).toEqual({
      kind: 'refused',
      reason: 'frontmatter'
    })
  })

  it('never pulls the closing fence into the paragraph right after it', () => {
    const { text } = turnInto(withFrontmatter, at(withFrontmatter, 'still'))
    expect(text).toBe('---\ntags: [a]\n---\n> [!warning]\n> First paragraph\n> still first\n\nSecond')
  })

  it('leaves the frontmatter out of a selection that starts in it', () => {
    const { text } = turnInto(withFrontmatter, at(withFrontmatter, 'tags'), at(withFrontmatter, 'still', 3))
    expect(text).toBe('---\ntags: [a]\n---\n> [!warning]\n> First paragraph\n> still first\n\nSecond')
  })

  const fenced = 'Before\n```js\nconst a = 1\n\n> [!note] not a callout\n```\nAfter'

  it('refuses a caret inside a code fence, its fence lines included', () => {
    expect(target(fenced, at(fenced, 'const'))).toEqual({ kind: 'refused', reason: 'code' })
    expect(target(fenced, at(fenced, '```js'))).toEqual({ kind: 'refused', reason: 'code' })
    expect(target(fenced, at(fenced, 'not a callout'))).toEqual({ kind: 'refused', reason: 'code' })
  })

  it('stops a paragraph at a fence that follows it with no blank line', () => {
    expect(turnInto(fenced, 0).text).toBe('> [!warning]\n> Before\n```js\nconst a = 1\n\n> [!note] not a callout\n```\nAfter')
  })

  it('wraps a whole fence that is selected, and grows a selection that reaches into one', () => {
    const whole = turnInto(fenced, at(fenced, '```js'), at(fenced, '```\nAfter', 3)).text
    const partial = turnInto(fenced, 0, at(fenced, 'const')).text
    expect(whole).toBe('Before\n> [!warning]\n> ```js\n> const a = 1\n>\n> > [!note] not a callout\n> ```\nAfter')
    expect(partial).toBe('> [!warning]\n> Before\n> ```js\n> const a = 1\n>\n> > [!note] not a callout\n> ```\nAfter')
  })

  it('reads a `[!note]` line in a fence inside a callout as code, not a nested callout', () => {
    const doc = '> [!tip]\n> ```md\n> > [!note] example\n> ```'
    expect(calloutAt(doc, at(doc, 'example')).type).toBe('tip')
  })

  it('refuses a blank line, which has no paragraph', () => {
    expect(target('a\n\nb', 2)).toEqual({ kind: 'refused', reason: 'blank' })
  })
})

describe('the callout a caret or selection is in', () => {
  const nested = '> [!note] Outer\n> outer body\n> > [!tip] Inner\n> > inner body\n> outer again'

  it('finds the callout from its title line and from its body', () => {
    const doc = 'x\n\n> [!warning]- Heads up\n> body\n\ny'
    for (const pos of [at(doc, 'Heads'), at(doc, 'body')]) {
      const c = calloutAt(doc, pos)
      expect(c).toMatchObject({ type: 'warning', marker: '-', title: 'Heads up', depth: 1 })
    }
  })

  it('takes the innermost callout', () => {
    expect(calloutAt(nested, at(nested, 'inner body')).title).toBe('Inner')
    expect(calloutAt(nested, at(nested, 'outer again')).title).toBe('Outer')
  })

  it('takes the outer callout for a selection that leaves the inner one', () => {
    const t = target(nested, at(nested, 'outer body'), at(nested, 'inner body'))
    expect(t.kind === 'callout' && t.callout.title).toBe('Outer')
  })

  it('does not take a `[!type]` that continues a quote as a callout', () => {
    const doc = '> plain quote\n> [!note] just text'
    const t = target(doc, at(doc, 'just'))
    expect(t.kind).toBe('block')
  })

  it('takes a callout right after the frontmatter', () => {
    const doc = '---\na: 1\n---\n> [!info]\n> hi'
    expect(calloutAt(doc, at(doc, 'hi')).type).toBe('info')
  })
})

describe('change the callout type', () => {
  it('rewrites only the keyword, keeping the fold marker and the title', () => {
    const doc = 'a\n\n> [!warning]- Mind the gap\n> body'
    const result = change(doc, at(doc, 'body'), 'tip')
    expect(result?.text).toBe('a\n\n> [!tip]- Mind the gap\n> body')
    expect(result && result.text.slice(result.selection.head, result.selection.head + 4)).toBe('body')
  })

  it('keeps a caret on the title line on the same letter', () => {
    const doc = '> [!note] Title'
    const result = change(doc, at(doc, 'itle'), 'question')
    expect(result?.text).toBe('> [!question] Title')
    expect(result && result.text.slice(result.selection.head)).toBe('itle')
  })

  it('does nothing when the callout already is that type, an alias or any case included', () => {
    expect(change('> [!error] Boom', 2, 'danger')).toBeNull()
    expect(change('> [!WARNING]\n> x', 2, 'warning')).toBeNull()
    expect(change('> [!error] Boom', 2, 'failure')?.text).toBe('> [!failure] Boom')
  })

  it('changes an unknown type to a known one', () => {
    expect(change('> [!custom]\n> x', 2, 'note')?.text).toBe('> [!note]\n> x')
  })

  it('changes a nested callout and leaves the outer one alone', () => {
    const doc = '> [!note]\n> > [!tip] Inner\n> > text'
    expect(change(doc, at(doc, 'text'), 'bug')?.text).toBe('> [!note]\n> > [!bug] Inner\n> > text')
  })
})

describe('remove the callout', () => {
  it('keeps a custom title as a plain first line and strips one level of `> `', () => {
    const doc = 'a\n\n> [!warning]+ Heads up\n> first\n>\n> second\n\nb'
    expect(remove(doc, at(doc, 'first')).text).toBe('a\n\nHeads up\nfirst\n\nsecond\n\nb')
  })

  it('drops a title line with no title, the caret on it landing on the body', () => {
    const doc = 'a\n\n> [!note]\n> body\n\nb'
    const { text, selection } = remove(doc, at(doc, '[!note]'))
    expect(text).toBe('a\n\nbody\n\nb')
    expect(text.slice(selection.head, selection.head + 4)).toBe('body')
  })

  it('keeps the caret on the same letter of the body', () => {
    const doc = '> [!tip] T\n> some body'
    const { text, selection } = remove(doc, at(doc, 'body'))
    expect(text).toBe('T\nsome body')
    expect(text.slice(selection.head)).toBe('body')
  })

  it('removes a nested callout and leaves the outer quote marker', () => {
    const doc = '> [!note] Outer\n> > [!tip] Inner\n> > text\n> outer'
    expect(remove(doc, at(doc, 'text')).text).toBe('> [!note] Outer\n> Inner\n> text\n> outer')
  })

  it('removes the outer callout and keeps the nested one whole', () => {
    const doc = '> [!note] Outer\n> > [!tip] Inner\n> > text\n> outer'
    expect(remove(doc, at(doc, 'outer')).text).toBe('Outer\n> [!tip] Inner\n> text\nouter')
  })

  it('strips the quote marker from a fence inside the callout, not the code', () => {
    const doc = '> [!example]\n> ```\n> > quoted in code\n> ```'
    expect(remove(doc, at(doc, 'quoted')).text).toBe('```\n> quoted in code\n```')
  })

  it('keeps CRLF line endings', () => {
    const doc = 'a\r\n\r\n> [!note] T\r\n> body\r\n'
    expect(remove(doc, at(doc, 'body')).text).toBe('a\r\n\r\nT\r\nbody\r\n')
  })

  it('removes a title-only callout on the last line of the document', () => {
    const doc = 'text\n\n> [!note]'
    const { text, selection } = remove(doc, doc.length)
    expect(text).toBe('text\n')
    expect(selection.head).toBe(text.length)
  })

  it('keeps the indentation of a callout inside a list item', () => {
    const doc = '- item\n\n  > [!info] Note\n  > body'
    expect(remove(doc, at(doc, 'body')).text).toBe('- item\n\n  Note\n  body')
  })

  it('round-trips a turned-into paragraph back to the same text', () => {
    const doc = 'one\n\nalpha\nbeta\n\ntwo'
    const wrapped = turnInto(doc, at(doc, 'alpha')).text
    expect(remove(wrapped, at(wrapped, 'beta')).text).toBe(doc)
  })
})

describe('the callout menus', () => {
  it('lists all twelve types in CALLOUT_TYPES order, Danger named for Error', () => {
    const choices = calloutTypeChoices(null)
    expect(choices.map((c) => c.type)).toEqual(CALLOUT_TYPES.map((d) => d.type))
    expect(choices).toHaveLength(12)
    expect(choices.find((c) => c.type === 'danger')?.label).toBe('Danger (Error)')
    expect(choices.find((c) => c.type === 'warning')?.icon).toBe('⚠️')
    expect(choices.some((c) => c.checked)).toBe(false)
  })

  it('finds Error under Danger, as the aliases say', () => {
    const matches = calloutTypeChoices(null).filter(
      (c) => c.label.toLowerCase().includes('error') || c.keywords.includes('error')
    )
    expect(matches.map((c) => c.type)).toEqual(['danger'])
  })

  it('checks the current type, an alias resolved to its entry', () => {
    expect(calloutTypeChoices('tip').filter((c) => c.checked).map((c) => c.type)).toEqual(['tip'])
    expect(calloutTypeChoices('Error').filter((c) => c.checked).map((c) => c.type)).toEqual(['danger'])
    expect(calloutTypeChoices('custom').some((c) => c.checked)).toBe(false)
  })

  it('offers Turn into outside a callout, Change and Remove inside one', () => {
    const doc = 'Para\n\n> [!note]\n> body\n\n```\ncode\n```\n\n'
    expect(calloutMenuEntries(target(doc, 0))).toEqual([
      { action: 'turn-into', label: 'Turn into callout…' }
    ])
    expect(calloutMenuEntries(target(doc, at(doc, 'body'))).map((e) => e.label)).toEqual([
      'Change callout type…',
      'Remove callout'
    ])
  })

  it('shows Turn into disabled with the reason in code and in the frontmatter, and nothing on a blank line', () => {
    const doc = '---\na: 1\n---\n\n```\ncode\n```\n'
    expect(calloutMenuEntries(target(doc, at(doc, 'code')))).toEqual([
      { action: 'turn-into', label: 'Turn into callout…', disabled: true, reason: 'in a code block' }
    ])
    expect(calloutMenuEntries(target(doc, at(doc, 'a: 1')))).toEqual([
      { action: 'turn-into', label: 'Turn into callout…', disabled: true, reason: 'in properties' }
    ])
    expect(calloutMenuEntries(target(doc, at(doc, '\n\n```', 1)))).toEqual([])
  })
})

describe('mapCalloutPos', () => {
  it('puts a position after text inserted right at it, or before with assoc -1', () => {
    const changes = [{ from: 2, to: 2, insert: 'xx' }]
    expect(mapCalloutPos(changes, 2)).toBe(4)
    expect(mapCalloutPos(changes, 2, -1)).toBe(2)
    expect(mapCalloutPos(changes, 1)).toBe(1)
    expect(mapCalloutPos(changes, 5)).toBe(7)
  })

  it('moves a position inside deleted text to where the deletion was', () => {
    const changes = [{ from: 2, to: 6, insert: '' }]
    expect(mapCalloutPos(changes, 4)).toBe(2)
    expect(mapCalloutPos(changes, 8)).toBe(4)
  })
})
