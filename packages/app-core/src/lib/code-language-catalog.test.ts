import { LanguageDescription } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { resolveCodeLanguage } from './cm-code-languages'
import { codeLanguageOptions, findCodeLanguageOption } from './code-language-catalog'

describe('codeLanguageOptions', () => {
  const options = codeLanguageOptions()

  it('lists the eager grammars and the language-data list, by name', () => {
    const names = options.map((option) => option.name)
    for (const name of ['TypeScript', 'Python', 'Rust', 'Go', 'Shell', 'Ruby', 'Kotlin', 'Swift', 'C#', 'TOML']) {
      expect(names).toContain(name)
    }
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    expect(names).toEqual(sorted)
  })

  it('writes the tags people use, not the display names', () => {
    const tagOf = (name: string): string | undefined =>
      options.find((option) => option.name === name)?.tag
    expect(tagOf('C++')).toBe('cpp')
    expect(tagOf('C#')).toBe('csharp')
    expect(tagOf('Shell')).toBe('bash')
    expect(tagOf('TypeScript')).toBe('typescript')
    expect(tagOf('Objective-C')).toBe('objc')
    expect(tagOf('Properties files')).toBe('ini')
  })

  it('offers only tags the editor reads back as a language', () => {
    for (const option of options) {
      expect(resolveCodeLanguage(option.tag), option.name).not.toBeNull()
    }
  })

  it('reads every language-data pick back as the language it names', () => {
    for (const option of options) {
      const resolved = resolveCodeLanguage(option.tag)
      if (resolved instanceof LanguageDescription) expect(resolved.name, option.tag).toBe(option.name)
    }
  })

  it('leaves out languages no fence tag can reach', () => {
    const names = options.map((option) => option.name)
    expect(names).not.toContain('VB.NET')
    expect(names).not.toContain('MS SQL')
  })

  it('gives each tag one row', () => {
    const tags = options.map((option) => option.tag)
    expect(new Set(tags).size).toBe(tags.length)
  })

  it('finds a row by its tag or any alias, the eager ones too', () => {
    expect(findCodeLanguageOption('golang')?.name).toBe('Go')
    expect(findCodeLanguageOption('py')?.name).toBe('Python')
    expect(findCodeLanguageOption('ts')?.name).toBe('TypeScript')
    expect(findCodeLanguageOption('sh')?.name).toBe('Shell')
    expect(findCodeLanguageOption('YML')?.name).toBe('YAML')
    expect(findCodeLanguageOption('mermaid')).toBeNull()
  })
})

describe('resolveCodeLanguage and plain text', () => {
  it('reads text and its spellings as no language, not LaTeX', () => {
    expect(resolveCodeLanguage('text')).toBeNull()
    expect(resolveCodeLanguage('plaintext')).toBeNull()
    expect(resolveCodeLanguage('text title="x"')).toBeNull()
    expect(resolveCodeLanguage('tex')).not.toBeNull()
  })
})
