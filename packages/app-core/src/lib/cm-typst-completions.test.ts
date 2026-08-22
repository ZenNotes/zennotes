import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { CompletionContext } from '@codemirror/autocomplete'
import { previewSourceOf, typstCommandSource, typstTokenBefore } from './cm-typst-completions'
import { mathRenderExtension } from './cm-math-render'

function state(doc: string, renderer: 'katex' | 'typst' = 'typst'): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown(), mathRenderExtension(renderer)]
  })
}

function sourceAt(doc: string, renderer: 'katex' | 'typst' = 'typst', explicit = false) {
  return typstCommandSource(new CompletionContext(state(doc, renderer), doc.length, explicit))
}

describe('typstTokenBefore', () => {
  it('matches the identifier being typed, from two letters on', () => {
    const doc = '$su'
    const token = typstTokenBefore(state(doc), doc.length)
    expect(token).not.toBeNull()
    expect(token!.query).toBe('su')
    expect(token!.from).toBe(1)
  })

  it('stays silent on a single letter unless summoned explicitly', () => {
    // One-letter variables are the normal case in math, not a prefix.
    const doc = '$x'
    expect(typstTokenBefore(state(doc), doc.length)).toBeNull()
    expect(typstTokenBefore(state(doc), doc.length, true)).not.toBeNull()
  })

  it('matches dotted names and rejects non-identifiers', () => {
    const dotted = '$dots.h'
    expect(typstTokenBefore(state(dotted), dotted.length)!.query).toBe('dots.h')

    const afterDigits = '$12'
    expect(typstTokenBefore(state(afterDigits), afterDigits.length)).toBeNull()
  })
})

describe('typstCommandSource', () => {
  it('offers Typst words inside math when the note compiles as Typst', () => {
    const result = sourceAt('formule $su')
    expect(result).not.toBeNull()
    const labels = result!.options.map((o) => o.label)
    expect(labels).toContain('sum')
    expect(labels).toContain('alpha')
  })

  it('stays out of the way when the note compiles as KaTeX', () => {
    // The exact mirror of the LaTeX source's Typst gate: `sum_(i=1)^(n)` is
    // not KaTeX, so offering it there would be wrong every time.
    expect(sourceAt('formule $su', 'katex')).toBeNull()
  })

  it('stays out of prose and code even with Typst selected', () => {
    expect(sourceAt('prose without math: su')).toBeNull()
    expect(sourceAt('```bash\necho su')).toBeNull()
  })

  it('works in display math still being typed', () => {
    expect(sourceAt('$$\nx = su')).not.toBeNull()
  })

  it('covers the slice-3 families: arrows, comparisons, sets, styles', () => {
    const labels = sourceAt('formule $ar')!.options.map((o) => o.label)
    for (const word of ['arrow.r.double', 'lt.eq', 'inter', 'nothing', 'dif', 'bold', 'bb']) {
      expect(labels, word).toContain(word)
    }
  })

  it('the token matcher reaches doubly-dotted names like arrow.l.r.double', () => {
    const doc = '$arrow.l.r.double'
    expect(typstTokenBefore(state(doc), doc.length)!.query).toBe('arrow.l.r.double')
  })
})

describe('compiled previews', () => {
  it('derives the preview by unwrapping the snippet fields', () => {
    expect(previewSourceOf({ template: 'frac(${a}, ${b})' })).toBe('frac(a, b)')
    expect(previewSourceOf({ template: 'sum_(${i=1})^(${n})' })).toBe('sum_(i=1)^(n)')
    expect(previewSourceOf({})).toBeNull()
    expect(previewSourceOf({ preview: 'mat(1;2)', template: 'mat(${})' })).toBe('mat(1;2)')
  })

  it('every templated option carries a well-formed preview', () => {
    const result = sourceAt('formule $su')!
    for (const option of result.options) {
      const preview = (option as { _preview?: string | null })._preview
      if ((option as { apply?: unknown }).apply === undefined) continue
      expect(preview, option.label).toBeTruthy()
      // No snippet syntax may leak into what the compiler will typeset.
      expect(preview, option.label).not.toMatch(/\$\{|\}/)
    }
  })
})
