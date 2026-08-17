import { describe, expect, it } from 'vitest'
import {
  detectRtl,
  noteRtlOverride,
  resolveNoteDirection
} from './bidi-dir'

describe('detectRtl', () => {
  it('reads Arabic body as RTL', () => {
    expect(detectRtl('مرحبا بالعالم\nهذه ملاحظة عربية')).toBe(true)
  })

  it('reads English body as LTR', () => {
    expect(detectRtl('Hello world\nThis is an English note.')).toBe(false)
  })

  it('treats a tie as LTR', () => {
    expect(detectRtl('مرحبا بالعالم\nenglish line')).toBe(false)
  })

  it('majority RTL wins', () => {
    expect(detectRtl('مرحبا\nبالعالم\nhello')).toBe(true)
  })

  it('ignores the frontmatter block', () => {
    expect(detectRtl('---\ndir: rtl\ntags: [x]\n---\n\ntext body')).toBe(false)
  })

  it('skips fenced code blocks', () => {
    expect(detectRtl('```\nمرحبا داخل الكود\n```')).toBe(false)
  })

  it('handles an empty body as LTR', () => {
    expect(detectRtl('')).toBe(false)
  })
})

describe('noteRtlOverride', () => {
  it('reads dir: rtl', () => {
    expect(noteRtlOverride('---\ndir: rtl\n---\n\nbody')).toBe('rtl')
  })

  it('reads dir: ltr', () => {
    expect(noteRtlOverride('---\ndir: ltr\n---\n\nbody')).toBe('ltr')
  })

  it('treats dir: auto as no override', () => {
    expect(noteRtlOverride('---\ndir: auto\n---\n\nbody')).toBeNull()
  })

  it('returns null without frontmatter', () => {
    expect(noteRtlOverride('plain body')).toBeNull()
  })
})

describe('resolveNoteDirection', () => {
  it('forces LTR in off mode', () => {
    expect(resolveNoteDirection('مرحبا', 'off')).toBe('ltr')
  })

  it('forces RTL in on mode', () => {
    expect(resolveNoteDirection('Hello world', 'on')).toBe('rtl')
  })

  it('auto: frontmatter dir: ltr overrides an Arabic body', () => {
    expect(resolveNoteDirection('---\ndir: ltr\n---\n\nمرحبا', 'auto')).toBe('ltr')
  })

  it('auto: plain Arabic body detects RTL', () => {
    expect(resolveNoteDirection('مرحبا بالعالم', 'auto')).toBe('rtl')
  })

  it('auto: English body detects LTR', () => {
    expect(resolveNoteDirection('Hello world', 'auto')).toBe('ltr')
  })
})
