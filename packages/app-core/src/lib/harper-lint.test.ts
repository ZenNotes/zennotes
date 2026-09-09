/**
 * Runs Harper's real engine under Node (LocalLinter reads the wasm from disk),
 * so these pin the contract the editor relies on rather than a mock of it.
 *
 * Skipped on Windows: harper.js 2.7 reads a `file://` binary through
 * `new URL(url).pathname`, which on Windows yields `/D:/...` and makes Node
 * look for `D:\D:\...`. The app never loads Harper through Node (the
 * renderer fetches the wasm over the zen-harper scheme), so the contract
 * these tests pin is exercised on the other runners.
 */
import { describe, expect, it } from 'vitest'
import { HARPER_LINT_CHAR_LIMIT, harperSessionFromLinter, harperSuggestionChange } from './harper-lint'

async function session() {
  const harper = await import('harper.js')
  const { binary } = await import('harper.js/binary')
  const linter = new harper.LocalLinter({ binary })
  await linter.setup()
  return harperSessionFromLinter(harper, linter)
}

describe.skipIf(process.platform === 'win32')('Harper session', () => {
  it('reports spans in UTF-16 units, so an emoji before the word does not shift it', async () => {
    const text = 'I 😀 beleive this is teh answer.'
    const lints = await (await session()).lint(text)
    const spelling = lints.find((lint) => lint.problem === 'beleive')
    expect(spelling).toBeDefined()
    expect(text.slice(spelling!.from, spelling!.to)).toBe('beleive')
    expect(spelling!.kind).toBe('Spelling')
    expect(spelling!.suggestions[0]).toMatchObject({ kind: 'replace', text: 'believe', label: 'believe' })
  }, 30_000)

  it('leaves code and link targets alone in Markdown', async () => {
    const text = 'Run `teh command` at [teh site](http://teh.example).\n\n```\nteh block\n```\n'
    const lints = await (await session()).lint(text)
    const problems = lints.map((lint) => text.slice(lint.from, lint.to))
    // Only the visible link text is prose; the code span, the fenced block and
    // the URL are not.
    expect(problems).toEqual(['teh'])
  }, 30_000)

  it('keeps the heading marker out of a title-case problem and its fix', async () => {
    const text = '# Harper test\n\nBody.\n'
    const [lint] = await (await session()).lint(text)
    expect(lint.kind).toBe('Capitalization')
    expect(text.slice(lint.from, lint.to)).toBe('Harper test')
    expect(lint.problem).toBe('Harper test')
    expect(lint.suggestions[0]).toMatchObject({ kind: 'replace', text: 'Harper Test' })
  }, 30_000)

  it('turns a suggestion into one editor change', () => {
    expect(harperSuggestionChange({ from: 5, to: 8 }, { kind: 'replace', text: 'the', label: 'the' })).toEqual({
      from: 5,
      to: 8,
      insert: 'the'
    })
    expect(harperSuggestionChange({ from: 5, to: 8 }, { kind: 'remove', text: '', label: 'Remove' })).toEqual({
      from: 5,
      to: 8,
      insert: ''
    })
    expect(
      harperSuggestionChange({ from: 5, to: 8 }, { kind: 'insert-after', text: ',', label: 'Insert "," after' })
    ).toEqual({ from: 8, to: 8, insert: ',' })
  })

  it('stops flagging a word once it is in the dictionary, and exports it for the vault', async () => {
    const current = await session()
    const text = 'Open Zennotez today.'
    expect((await current.lint(text)).map((lint) => lint.problem)).toContain('Zennotez')
    await current.addWord('Zennotez')
    expect((await current.lint(text)).map((lint) => lint.problem)).not.toContain('Zennotez')
    expect((await current.exportState()).words).toEqual(['Zennotez'])
  }, 30_000)

  it('ignores one suggestion per rule and carries the hashes as strings', async () => {
    const current = await session()
    const text = 'This is teh answer.'
    // Harper raises a Typo lint and a Spelling lint on the same word; dedup
    // shows one at a time. An ignore is per rule, so the second surfaces
    // after the first is ignored, exactly as in Harper's own editors.
    const [first] = await current.lint(text)
    expect(first).toMatchObject({ problem: 'teh', kind: 'Typo' })
    await current.ignore(text, first)
    const [second] = await current.lint(text)
    expect(second).toMatchObject({ problem: 'teh', kind: 'Spelling' })
    await current.ignore(text, second)
    expect(await current.lint(text)).toEqual([])

    const state = await current.exportState()
    expect(state.ignoredLints).toHaveLength(2)
    for (const hash of state.ignoredLints) expect(hash).toMatch(/^\d+$/)

    // A fresh session fed the exported state ignores the same things.
    const other = await session()
    await other.importState(state)
    expect(await other.lint(text)).toEqual([])
  }, 30_000)

  it('does not lint a note past the size cap', async () => {
    const current = await session()
    const text = 'teh '.repeat(HARPER_LINT_CHAR_LIMIT / 4 + 1)
    expect(await current.lint(text)).toEqual([])
  }, 30_000)
})
