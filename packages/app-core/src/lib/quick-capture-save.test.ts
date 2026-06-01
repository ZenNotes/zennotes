import { describe, expect, it } from 'vitest'
import {
  deriveTitleFromBody,
  planQuickCaptureSave,
  timestampTitle,
  type QuickCaptureMode
} from './quick-capture-save'

describe('deriveTitleFromBody', () => {
  it('returns empty for an empty or whitespace-only buffer', () => {
    expect(deriveTitleFromBody('')).toBe('')
    expect(deriveTitleFromBody('   \n\n\t')).toBe('')
  })

  it('uses the first non-empty line', () => {
    expect(deriveTitleFromBody('Meeting notes\nrest of body')).toBe('Meeting notes')
  })

  it('skips leading blank lines', () => {
    expect(deriveTitleFromBody('\n\n  Real title\nbody')).toBe('Real title')
  })

  it('strips a markdown heading marker', () => {
    expect(deriveTitleFromBody('# Heading one\ntext')).toBe('Heading one')
    expect(deriveTitleFromBody('### Deeper')).toBe('Deeper')
  })

  it('strips list and quote markers', () => {
    expect(deriveTitleFromBody('- a task')).toBe('a task')
    expect(deriveTitleFromBody('> quoted')).toBe('quoted')
    expect(deriveTitleFromBody('* bullet')).toBe('bullet')
  })

  it('caps the title at 80 characters', () => {
    const long = 'x'.repeat(200)
    expect(deriveTitleFromBody(long)).toHaveLength(80)
  })
})

describe('timestampTitle', () => {
  it('formats a stable, collision-resistant fallback', () => {
    const fixed = new Date(2026, 5, 1, 9, 7) // 2026-06-01 09:07 (month is 0-based)
    expect(timestampTitle(fixed)).toBe('Quick capture 2026-06-01 0907')
  })
})

describe('planQuickCaptureSave', () => {
  const NEW: QuickCaptureMode = { kind: 'new' }
  const quickNote = (title: string): QuickCaptureMode => ({
    kind: 'existing',
    note: { path: `quick/${title}.md`, title, folder: 'quick' }
  })

  it('is a no-op for an empty or whitespace buffer', () => {
    expect(planQuickCaptureSave(NEW, '')).toEqual({ op: 'noop' })
    expect(planQuickCaptureSave(NEW, '   \n\t')).toEqual({ op: 'noop' })
  })

  it('creates a new note titled from the first line', () => {
    expect(planQuickCaptureSave(NEW, 'Groceries\nmilk, eggs')).toEqual({
      op: 'create',
      title: 'Groceries',
      body: 'Groceries\nmilk, eggs\n'
    })
  })

  it('normalizes trailing whitespace to a single newline', () => {
    const plan = planQuickCaptureSave(NEW, 'Note\nbody\n\n\n   ')
    expect(plan).toMatchObject({ op: 'create', body: 'Note\nbody\n' })
  })

  it('falls back to a timestamp title only when the body has no usable line', () => {
    // A non-empty body always yields a usable first line, so the timestamp
    // path is exercised directly via timestampTitle; here we assert the
    // common case never reaches it.
    const plan = planQuickCaptureSave(NEW, '# Real')
    expect(plan).toMatchObject({ op: 'create', title: 'Real' })
  })

  // The regression that motivated this module: editing the title of an
  // already-saved note must update the SAME file, never spawn a copy.
  it('renames a Quick note in place when its first line changes', () => {
    expect(planQuickCaptureSave(quickNote('Foo'), 'Bar\ncontent')).toEqual({
      op: 'rename',
      path: 'quick/Foo.md',
      title: 'Bar',
      body: 'Bar\ncontent\n'
    })
  })

  it('writes in place (no rename) when a Quick note title is unchanged', () => {
    expect(planQuickCaptureSave(quickNote('Foo'), 'Foo\nmore content')).toEqual({
      op: 'write',
      path: 'quick/Foo.md',
      body: 'Foo\nmore content\n'
    })
  })

  it('never renames notes outside the Quick folder, even if the first line differs', () => {
    const inboxNote: QuickCaptureMode = {
      kind: 'existing',
      note: { path: 'inbox/Project Plan.md', title: 'Project Plan', folder: 'inbox' }
    }
    // First line is nothing like the filename — a naive "title = first line"
    // would rename this structured note. It must not.
    expect(planQuickCaptureSave(inboxNote, 'Totally different opening line')).toEqual({
      op: 'write',
      path: 'inbox/Project Plan.md',
      body: 'Totally different opening line\n'
    })
  })

  it('matches the title with a heading-prefixed first line (no spurious rename)', () => {
    // A Quick note whose body opens with "# Foo" derives title "Foo",
    // matching the filename — so saving writes, it does not rename.
    expect(planQuickCaptureSave(quickNote('Foo'), '# Foo\n\nbody')).toMatchObject({
      op: 'write',
      path: 'quick/Foo.md'
    })
  })
})
