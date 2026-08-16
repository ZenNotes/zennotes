import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { parseTasksFromBody } from '@shared/tasks'
import { buildForwardTaskPrompt } from './forward-task'

const task = parseTasksFromBody('- [ ] Ship the picker', {
  path: 'inbox/today.md',
  title: 'today',
  folder: 'inbox'
})[0]

const notes: Pick<NoteMeta, 'path' | 'title' | 'folder'>[] = [
  { path: 'inbox/today.md', title: 'today', folder: 'inbox' },
  { path: 'inbox/Work.md', title: 'Work', folder: 'inbox' },
  { path: 'archive/Work.md', title: 'Work', folder: 'archive' },
  { path: 'trash/Old.md', title: 'Old', folder: 'trash' },
  { path: 'inbox/notes.txt', title: 'notes', folder: 'inbox' }
]

describe('forward-task destination picker (#600)', () => {
  it('preselects the first match as you type, the way the folder pickers do (#467)', () => {
    expect(buildForwardTaskPrompt(task, notes)?.options.autoHighlightFirst).toBe(true)
  })

  it('names the Ctrl+J / Ctrl+K navigation in the hint, so the shortcut is discoverable', () => {
    expect(buildForwardTaskPrompt(task, notes)?.options.suggestionsHint).toContain('⌃J/⌃K')
  })

  it('offers every other markdown note, never the source note or the trash', () => {
    const suggestions = buildForwardTaskPrompt(task, notes)?.options.suggestions
    expect(suggestions?.map((s) => s.value)).toEqual(['inbox/Work.md', 'archive/Work.md'])
    expect(suggestions?.map((s) => s.label)).toEqual(['Work', 'Work'])
  })

  it('resolves the picker answer from either a path or a title', () => {
    const prompt = buildForwardTaskPrompt(task, notes)
    expect(prompt?.resolveTargetPath('archive/Work.md')).toBe('archive/Work.md')
    expect(prompt?.resolveTargetPath('  inbox/Work.md  ')).toBe('inbox/Work.md')
    // A bare title takes the first note carrying it; the twin stays reachable by path.
    expect(prompt?.resolveTargetPath('Work')).toBe('inbox/Work.md')
    expect(prompt?.resolveTargetPath('Not a note')).toBeUndefined()
  })

  it('still refuses a typed value that is not an existing note', () => {
    const validate = buildForwardTaskPrompt(task, notes)?.options.validate
    expect(validate?.('inbox/Work.md')).toBeNull()
    expect(validate?.('Something new')).toBe('Pick an existing note')
  })

  it('has nothing to offer when the vault holds no other note', () => {
    expect(buildForwardTaskPrompt(task, [notes[0]])).toBeNull()
  })
})
