import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { CompletionContext } from '@codemirror/autocomplete'
import { isInMathContext, latexCommandSource, latexTokenBefore } from './cm-latex-completions'
import { mathRenderExtension } from './cm-math-render'

function state(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown()] })
}

/** Position right after the given marker's first occurrence. */
function after(doc: string, marker: string): number {
  const idx = doc.indexOf(marker)
  if (idx === -1) throw new Error(`marker ${marker} not found`)
  return idx + marker.length
}

describe('isInMathContext', () => {
  it('detects inline math, including a formula still being typed', () => {
    const closed = 'before $a + b$ after'
    expect(isInMathContext(state(closed), after(closed, '$a + '))).toBe(true)
    expect(isInMathContext(state(closed), after(closed, 'after'))).toBe(false)
    expect(isInMathContext(state(closed), after(closed, 'before'))).toBe(false)

    const open = 'text $\\su'
    expect(isInMathContext(state(open), open.length)).toBe(true)
  })

  it('detects block math across lines, closed or not', () => {
    const closed = 'a\n$$\nx = y\n$$\nb'
    expect(isInMathContext(state(closed), after(closed, 'x ='))).toBe(true)
    expect(isInMathContext(state(closed), closed.length)).toBe(false)

    const open = 'a\n$$\nx ='
    expect(isInMathContext(state(open), open.length)).toBe(true)
  })

  it('keeps delimiter parity across very long display blocks', () => {
    const longBody = 'x'.repeat(20_100)
    const outside = `$$\n${longBody}\n$$\nplain \\su`
    expect(isInMathContext(state(outside), outside.length)).toBe(false)

    const inside = `$$\n${longBody}\n\\su`
    expect(isInMathContext(state(inside), inside.length)).toBe(true)
  })

  it('treats ```math fences as math, other fences as code', () => {
    const mathFence = 'a\n```math\n\\su\n```\nb'
    expect(isInMathContext(state(mathFence), after(mathFence, '\\su'))).toBe(true)

    const jsFence = 'a\n```js\nconst x = 1\n```\nb'
    expect(isInMathContext(state(jsFence), after(jsFence, 'const x'))).toBe(false)

    const bareFence = 'a\n```\n\\su\n```\nb'
    expect(isInMathContext(state(bareFence), after(bareFence, '\\su'))).toBe(false)
  })

  it('ignores escaped dollars and code regions', () => {
    const escaped = 'price \\$5 and \\$6 end'
    expect(isInMathContext(state(escaped), escaped.length)).toBe(false)

    const fenced = '```\n$a + b$\n```\ntext'
    expect(isInMathContext(state(fenced), after(fenced, '$a + '))).toBe(false)

    const inlineCode = 'use `$HOME` now'
    expect(isInMathContext(state(inlineCode), after(inlineCode, '`$HO'))).toBe(false)
  })
})

describe('latexTokenBefore', () => {
  it('matches a backslash command prefix ending at the cursor', () => {
    const doc = '$\\sum'
    const token = latexTokenBefore(state(doc), doc.length)
    expect(token).not.toBeNull()
    expect(token!.query).toBe('sum')
    expect(token!.from).toBe(1)
  })

  it('matches a bare backslash and rejects non-command contexts', () => {
    const bare = '$x + \\'
    expect(latexTokenBefore(state(bare), bare.length)!.query).toBe('')

    const rowBreak = '$a \\\\'
    expect(latexTokenBefore(state(rowBreak), rowBreak.length)).toBeNull()

    const plain = '$x + y'
    expect(latexTokenBefore(state(plain), plain.length)).toBeNull()
  })
})

// Review follow-ups to #594.
describe('math context, delimiters that are not delimiters', () => {
  it('ignores dollars inside a code block, which would otherwise flip parity', () => {
    // `$$` is the shell PID, and a note that mentions it used to leave every
    // later line reading as display math.
    const doc = 'intro\n\n```bash\necho $$\n```\n\nplain prose here\n'
    expect(isInMathContext(state(doc), after(doc, 'plain prose'))).toBe(false)
  })

  it('ignores a dollar inside inline code on the same line', () => {
    const doc = 'costs `$5` and then more prose'
    expect(isInMathContext(state(doc), after(doc, 'more prose'))).toBe(false)
  })

  it('still sees real math after a code block that mentions dollars', () => {
    const doc = '```bash\necho $$\n```\n\n$x + '
    expect(isInMathContext(state(doc), doc.length)).toBe(true)
  })
})

describe('the typesetter the note is set to', () => {
  const DOC = 'text $\\su'

  function sourceFor(renderer: 'katex' | 'typst') {
    const editorState = EditorState.create({
      doc: DOC,
      extensions: [markdown(), mathRenderExtension(renderer)]
    })
    return latexCommandSource(new CompletionContext(editorState, DOC.length, false))
  }

  it('offers LaTeX commands with KaTeX selected', () => {
    const result = sourceFor('katex')
    expect(result?.options.length ?? 0).toBeGreaterThan(0)
  })

  it('stays out of the way when the note compiles as Typst', () => {
    // Typst is a different language: `\\frac{}{}` is not what it takes, so
    // suggesting it would be wrong every time.
    expect(sourceFor('typst')).toBeNull()
  })
})
