import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { isInMathContext, latexTokenBefore } from './cm-latex-completions'

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
