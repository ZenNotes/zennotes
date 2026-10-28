import { describe, expect, it } from 'vitest'
import { commandLanding } from './command-landing'

describe('commandLanding (where a phone keyboard goes after a palette command)', () => {
  it('reads a note the command only put on screen, before anything else', () => {
    expect(commandLanding({ id: 'nav.back', opensToRead: () => true })).toBe('read')
    // An existing daily note is read even though the id is a writing one.
    expect(commandLanding({ id: 'note.daily.today', opensToRead: () => true })).toBe('read')
  })

  it('gives the editor the keyboard where typing or the focus is the point', () => {
    expect(commandLanding({ id: 'note.daily.today', opensToRead: () => false })).toBe('edit')
    const writing = ['note.new.inbox', 'task.new', 'note.format', 'editor.reflow-paragraph']
    for (const id of [...writing, 'nav.focus.editor', 'ref.focus']) {
      expect(commandLanding({ id })).toBe('edit')
    }
  })

  it('leaves the focus where it was for everything else, a new toggle included', () => {
    const toggles = [
      'view.status-bar',
      'view.dark-sidebar',
      'view.line-numbers.relative',
      'editor.word-wrap.toggle',
      'editor.vim.toggle',
      'editor.live-preview.toggle',
      'fold.all',
      'task.toggle-checkbox',
      'note.copy-wikilink',
      'ui.themes',
      'some.future-toggle'
    ]
    for (const id of toggles) expect(commandLanding({ id })).toBe('stay')
  })
})
