import { describe, expect, it } from 'vitest'
import { getBool, getString, parse, VALUELESS_FLAGS } from './args'

// A markdown task passed to `zn capture "- [ ] task"` arrives as one token
// that starts with `-`; it must stay positional, not be parsed as a flag.
describe('cli args parse — leading-dash text', () => {
  it('keeps a markdown task as a positional, not a flag', () => {
    const { positionals, flags } = parse(['capture', '- [ ] buy milk'])
    expect(positionals).toEqual(['capture', '- [ ] buy milk'])
    expect(flags.size).toBe(0)
  })

  it('keeps list items and negative numbers positional', () => {
    expect(parse(['- a list item']).positionals).toEqual(['- a list item'])
    expect(parse(['-5']).positionals).toEqual(['-5'])
  })

  it('still parses real short and long flags', () => {
    expect(parse(['-h']).flags.has('h')).toBe(true)
    expect(getString(parse(['--tag', 'idea']), 'tag')).toBe('idea')
  })

  it('honors `--` to force the rest positional', () => {
    expect(parse(['--', '--not-a-flag']).positionals).toEqual(['--not-a-flag'])
  })
})

// A switch written before a positional used to swallow it: `zn open
// --new-window ~/notes` parsed as new-window="~/notes" with no path (#815).
describe('cli args parse: switches never take the next token as a value', () => {
  it('keeps the path after --new-window positional', () => {
    const args = parse(['open', '--new-window', '/home/user/notes'])
    expect(args.positionals).toEqual(['open', '/home/user/notes'])
    expect(getBool(args, 'new-window')).toBe(true)
  })

  it('applies to every listed switch, before or after the positional', () => {
    for (const name of VALUELESS_FLAGS) {
      const before = parse([`--${name}`, 'inbox/a.md'])
      expect(before.positionals, `--${name} before`).toEqual(['inbox/a.md'])
      expect(getBool(before, name), `--${name} before`).toBe(true)

      const after = parse(['inbox/a.md', `--${name}`])
      expect(after.positionals, `--${name} after`).toEqual(['inbox/a.md'])
      expect(getBool(after, name), `--${name} after`).toBe(true)
    }
  })

  it('still accepts an explicit --flag=value for a switch', () => {
    expect(getString(parse(['--json=false']), 'json')).toBe('false')
    expect(getBool(parse(['--json=false']), 'json')).toBe(false)
  })

  it('leaves value flags alone', () => {
    const args = parse(['list', '--tag', 'idea', '--limit', '5'])
    expect(args.positionals).toEqual(['list'])
    expect(getString(args, 'tag')).toBe('idea')
    expect(getString(args, 'limit')).toBe('5')
  })

  it('reads the short -n switch without eating the path', () => {
    const args = parse(['open', '-n', '/home/user/notes'])
    expect(args.positionals).toEqual(['open', '/home/user/notes'])
    expect(getBool(args, 'n')).toBe(true)
  })
})
