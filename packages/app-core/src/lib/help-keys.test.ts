import { describe, expect, it } from 'vitest'
import { HELP_SHORTCUT_SECTIONS, HELP_VIM_COMMANDS } from './help'
import { parseHelpKeys } from './help-keys'

const keysOf = (raw: string, mac: boolean): string[] =>
  parseHelpKeys(raw, mac).parts.map((part) => part.text)

describe('parseHelpKeys', () => {
  it('draws a Mod combo the way the platform names it', () => {
    expect(keysOf('Mod+P', true)).toEqual(['⌘P'])
    expect(keysOf('Mod+P', false)).toEqual(['Ctrl+P'])
    expect(keysOf('Shift+Mod+Space', true)).toEqual(['⇧⌘Space'])
    expect(keysOf('Mod+Enter', true)).toEqual(['⌘↵'])
    expect(keysOf('Mod+-', true)).toEqual(['⌘-'])
  })

  it('puts modifiers in the order the rest of the app draws them', () => {
    expect(keysOf('Mod+Shift+C', true)).toEqual(['⇧⌘C'])
    expect(keysOf('Mod+Alt+M', true)).toEqual(['⌥⌘M'])
    expect(keysOf('Mod+Shift+C', false)).toEqual(['Shift+Ctrl+C'])
  })

  it('leaves keys without Mod as written, so they match the prose', () => {
    expect(keysOf('Ctrl+D', true)).toEqual(['Ctrl+D'])
    expect(keysOf('Shift+Enter', true)).toEqual(['Shift+Enter'])
    expect(keysOf('Space l s', true)).toEqual(['Space l s'])
  })

  it('moves a trailing aside out of the keycap', () => {
    expect(parseHelpKeys('Ctrl+D (in Search notes)', true)).toEqual({
      parts: [{ kind: 'key', text: 'Ctrl+D' }],
      context: '(in Search notes)'
    })
    expect(parseHelpKeys('Mod+F (in the editor)', true)).toEqual({
      parts: [{ kind: 'key', text: '⌘F' }],
      context: '(in the editor)'
    })
    expect(parseHelpKeys('Alt+Q (macOS: Ctrl+Q)', true).context).toBe('(macOS: Ctrl+Q)')
  })

  it('gives each alternative its own keycap', () => {
    expect(parseHelpKeys('Mod+4 / Mod+5 / Mod+6', true).parts).toEqual([
      { kind: 'key', text: '⌘4' },
      { kind: 'separator', text: '/' },
      { kind: 'key', text: '⌘5' },
      { kind: 'separator', text: '/' },
      { kind: 'key', text: '⌘6' }
    ])
    expect(parseHelpKeys('↑ / ↓ · Enter (in a picker)', true)).toEqual({
      parts: [
        { kind: 'key', text: '↑' },
        { kind: 'separator', text: '/' },
        { kind: 'key', text: '↓' },
        { kind: 'separator', text: '·' },
        { kind: 'key', text: 'Enter' }
      ],
      context: '(in a picker)'
    })
  })

  it('keeps shorthand alternatives together, since a lone key would mislead', () => {
    expect(keysOf('Ctrl-w h / j / k / l', true)).toEqual(['Ctrl-w h / j / k / l'])
    expect(keysOf(':zen [toggle|on|off] / :zenmode', true)).toEqual([
      ':zen [toggle|on|off] / :zenmode'
    ])
  })

  it('never drops text from a manual row', () => {
    const rows = [
      ...HELP_SHORTCUT_SECTIONS.flatMap((section) => section.items.map((item) => item.keys)),
      ...HELP_VIM_COMMANDS.map((command) => command.command)
    ].filter((raw) => !/\bMod\b/.test(raw))
    expect(rows.length).toBeGreaterThan(50)
    for (const raw of rows) {
      const { parts, context } = parseHelpKeys(raw, true)
      const keys = parts
        .map((part) => (part.kind === 'separator' ? ` ${part.text} ` : part.text))
        .join('')
      expect(context ? `${keys} ${context}` : keys).toBe(raw)
    }
  })
})
