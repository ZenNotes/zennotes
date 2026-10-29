import { describe, expect, it } from 'vitest'
import {
  cachedCodeLanguage,
  detectCodeLanguage,
  DETECTABLE_LANGUAGES,
  MAX_DETECT_CHARS,
  MAX_SAMPLE_CHARS,
  MIN_RELEVANCE,
  warmCodeLanguageDetector
} from './code-language-detect'
import { DETECTED, NOT_CODE, OTHER_LANGUAGES, SHORT, TINY } from './code-language-detect.samples'
import { resolveCodeLanguage } from './cm-code-languages'

const tagOf = (code: string): string | null => detectCodeLanguage(code)?.tag ?? null
const twelveTimes = (code: string): string => Array.from({ length: 12 }, () => code).join('\n')

describe('detectCodeLanguage on real snippets', () => {
  it.each(DETECTED)('names %s (%s)', (tag, _label, code) => {
    expect(tagOf(code)).toBe(tag)
  })

  it('covers the languages people paste most', () => {
    const named = new Set(DETECTED.map(([tag]) => tag))
    for (const tag of [
      'python', 'javascript', 'typescript', 'bash', 'json', 'yaml', 'sql', 'html', 'css',
      'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'php', 'ruby', 'kotlin', 'swift', 'diff', 'toml'
    ]) {
      expect(named, tag).toContain(tag)
    }
  })

  it.each(SHORT)('leaves a short %s snippet (%s) as text or names it right', (tag, _label, code) => {
    expect([null, tag]).toContain(tagOf(code))
  })

  it('still names most short snippets that clear the bar', () => {
    const short = DETECTED.filter(([, label]) => label.endsWith('-short'))
    expect(short.length).toBeGreaterThanOrEqual(10)
  })
})

describe('what stays text', () => {
  it.each(NOT_CODE)('%s is not code', (_label, text) => {
    expect(tagOf(text)).toBeNull()
  })

  it.each(NOT_CODE)('%s is not code twelve times over either', (_label, text) => {
    // Relevance only adds up: a long enough paragraph clears any threshold
    // as CSS. The hallmarks are what keep it text.
    expect(tagOf(twelveTimes(text))).toBeNull()
  })

  it.each(TINY)('%s is too small to tell', (_label, text) => {
    expect(tagOf(text)).toBeNull()
  })

  it.each(OTHER_LANGUAGES)('%s is not taken for a language in the subset', (_label, text) => {
    expect(tagOf(text)).toBeNull()
  })

  it('leaves code valid in two families to text, rather than pick one', () => {
    // Every line is Java and every line is C#; highlight.js scores C# one
    // point ahead, which is noise, not evidence.
    const javaOrCSharp = `public class Point {
    private int x;
    private int y;

    public int getX() {
        return x;
    }
}`
    expect(tagOf(javaOrCSharp)).toBeNull()
  })
})

describe('the guess and its rules', () => {
  it('trusts a shebang and a JSON document over the scores', () => {
    expect(tagOf('#!/usr/bin/env python3\nimport sys\nprint(sys.argv)')).toBe('python')
    expect(tagOf('#!/bin/zsh\nsetopt extendedglob\nls **/*.md')).toBe('bash')
    // highlight.js scores this the same in JSON, Rust and Go.
    expect(tagOf('{\n  "name": "zennotes",\n  "private": true\n}')).toBe('json')
  })

  it('tells TypeScript from JavaScript by its types', () => {
    const js = `function debounce(fn, ms) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
export const save = debounce(() => console.log('saved'), 200)`
    const ts = `function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: T): void => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
export const save = debounce(() => console.log('saved'), 200)`
    expect(tagOf(js)).toBe('javascript')
    expect(tagOf(ts)).toBe('typescript')
  })

  it('maps highlight.js names to the tags the editor reads', () => {
    const html = DETECTED.find(([, label]) => label === 'html')![2]
    expect(tagOf(html)).toBe('html')
    const toml = DETECTED.find(([, label]) => label === 'toml')![2]
    expect(tagOf(toml)).toBe('toml')
  })

  it('only ever names a tag the editor can highlight', () => {
    const tags = new Set(DETECTED.map(([tag]) => tag))
    for (const tag of tags) expect(resolveCodeLanguage(tag), tag).not.toBeNull()
  })

  it('reports the relevance it decided on', () => {
    const rust = DETECTED.find(([, label]) => label === 'rust')![2]
    expect(detectCodeLanguage(rust)?.relevance).toBeGreaterThanOrEqual(MIN_RELEVANCE)
  })
})

describe('size and cost', () => {
  it('scores only the start of a long block, so a big file costs what a page does', () => {
    const python = DETECTED.find(([, label]) => label === 'python')![2]
    let long = ''
    while (long.length < MAX_SAMPLE_CHARS * 8) long += `${python}\n\n`
    const started = performance.now()
    expect(tagOf(long)).toBe('python')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('never guesses at a block over the cap', () => {
    const python = DETECTED.find(([, label]) => label === 'python')![2]
    let huge = ''
    while (huge.length <= MAX_DETECT_CHARS) huge += `${python}\n\n`
    expect(detectCodeLanguage(huge)).toBeNull()
  })

  it('answers from its cache once a text has been seen', () => {
    const text = 'def cached():\n    return "a fresh text the cache has not seen"\n\nprint(cached())'
    expect(cachedCodeLanguage(text)).toBeUndefined()
    const first = detectCodeLanguage(text)
    expect(cachedCodeLanguage(text)).toEqual(first)
  })

  it('compiles its grammars one at a time ahead of the first guess', () => {
    let steps = 0
    while (warmCodeLanguageDetector()) steps++
    expect(steps).toBeLessThan(DETECTABLE_LANGUAGES.length)
    expect(warmCodeLanguageDetector()).toBe(false)
  })
})
