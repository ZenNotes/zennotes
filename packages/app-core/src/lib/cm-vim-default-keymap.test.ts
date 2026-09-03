// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap, vimAwareSearchKeymap } from './cm-vim-default-keymap'

// Regression guard for the macOS Vim `Ctrl-d` bug: defaultKeymap's emacs-style
// mac chords used to shadow Vim's <C-d> (half-page down) and delete a char.
describe('vimAwareDefaultKeymap', () => {
  it('strips the macOS emacs chords in Vim mode so Vim handles them', () => {
    const macs = new Set(
      vimAwareDefaultKeymap(true)
        .map((b) => b.mac)
        .filter(Boolean)
    )
    for (const chord of ['Ctrl-d', 'Ctrl-a', 'Ctrl-e', 'Ctrl-f', 'Ctrl-b', 'Ctrl-v', 'Ctrl-h']) {
      expect(macs.has(chord)).toBe(false)
    }
  })

  it('keeps the emacs chords when Vim is off (standard macOS editing keys)', () => {
    const macs = new Set(vimAwareDefaultKeymap(false).map((b) => b.mac))
    expect(macs.has('Ctrl-d')).toBe(true)
    expect(macs.has('Ctrl-e')).toBe(true)
  })

  it('never drops non-emacs bindings (Mod-a, arrows survive in Vim mode)', () => {
    const vim = vimAwareDefaultKeymap(true)
    expect(vim.some((b) => b.key === 'Mod-a')).toBe(true)
    expect(vim.some((b) => b.key === 'ArrowDown')).toBe(true)
    expect(vim.some((b) => b.key === 'Enter')).toBe(true)
  })

  it('removes exactly the 13 documented emacs chords, nothing more', () => {
    expect(vimAwareDefaultKeymap(false).length - vimAwareDefaultKeymap(true).length).toBe(13)
  })

  // Issue #287: in Vim mode the arrows must defer to the Vim plugin, which means
  // dropping the native `preventDefault: true` (otherwise the key is consumed
  // even when our command returns false, re-blocking Vim).
  it('drops preventDefault on the arrow bindings in Vim mode, keeps it when off', () => {
    const vimKm = vimAwareDefaultKeymap(true)
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const binding = vimKm.find((b) => b.key === key)
      expect(binding, key).toBeTruthy()
      expect(binding?.preventDefault, key).toBe(false)
    }
    // With Vim off the native bindings (preventDefault: true) are untouched.
    expect(vimAwareDefaultKeymap(false).find((b) => b.key === 'ArrowLeft')?.preventDefault).toBe(
      true
    )
  })
})

// Behavioral guard for #287, at the level the fix actually controls: the arrow
// command must *defer* (return false → the keypress falls through to the Vim
// plugin, which applies the h/j/k/l motion and extends the selection) whenever
// Vim is in a non-insert mode, and fall back to the native caret motion in
// insert mode (where Vim doesn't map the arrows). This is precedence- and
// layout-independent — unlike a full key-dispatch test, whose precedence in a
// minimal extension set doesn't match the real editor's.
describe('vim arrow bindings defer to the Vim plugin (issue #287)', () => {
  const views: EditorView[] = []
  afterEach(() => {
    views.splice(0).forEach((v) => v.destroy())
  })

  const mountVim = (doc: string): EditorView => {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [vim(), keymap.of([...vimAwareDefaultKeymap(true)])]
      }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    return view
  }

  const press = (view: EditorView, key: string, keyCode: number): void => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true })
    )
  }

  const arrowRun = (key: string): NonNullable<KeyBinding['run']> => {
    const binding = vimAwareDefaultKeymap(true).find((b) => b.key === key)
    if (!binding?.run) throw new Error(`no run for ${key}`)
    return binding.run
  }

  it('defers in normal mode (so the arrow becomes a Vim motion)', () => {
    const view = mountVim('hello world') // codemirror-vim starts in normal mode
    expect(arrowRun('ArrowLeft')(view)).toBe(false)
    expect(arrowRun('ArrowDown')(view)).toBe(false)
  })

  it('defers in visual mode (so the arrow extends the selection like hjkl)', () => {
    const view = mountVim('hello world')
    press(view, 'v', 86) // enter visual mode
    expect(arrowRun('ArrowRight')(view)).toBe(false)
    expect(arrowRun('ArrowUp')(view)).toBe(false)
  })

  it('moves natively in insert mode (Vim does not map insert-mode arrows)', () => {
    const view = mountVim('hello world')
    press(view, 'i', 73) // enter insert mode
    // Native cursorCharRight/etc. handle it (return true) so the caret still moves.
    expect(arrowRun('ArrowRight')(view)).toBe(true)
  })

  // Enter/Backspace are Vim motions in normal mode (<CR> → j^, <BS> → h) but
  // editing commands in defaultKeymap — they must defer exactly like the arrows.
  it('defers Enter and Backspace in normal mode (Vim motions, not edits)', () => {
    const view = mountVim('hello\nworld')
    expect(arrowRun('Enter')(view)).toBe(false)
    expect(arrowRun('Backspace')(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('hello\nworld') // nothing edited
  })

  it('edits natively with Enter/Backspace in insert mode', () => {
    const view = mountVim('hello')
    press(view, 'i', 73) // enter insert mode
    expect(arrowRun('Enter')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('\nhello')
  })
})

// The markdown language keymap (Enter → insertNewlineContinueMarkup at
// Prec.high) used to swallow Enter before the Vim plugin, inserting a newline
// in normal mode. vimAwareMarkdownKeymap replaces it (addKeymap: false) with
// deferred bindings; this exercises the full dispatch chain the real editors
// use: markdown keymap → default keymap → Vim plugin.
describe('vimAwareMarkdownKeymap (Enter in Vim normal mode acts as <CR>)', () => {
  const views: EditorView[] = []
  afterEach(() => {
    views.splice(0).forEach((v) => v.destroy())
  })

  const mount = (doc: string): EditorView => {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          vim(),
          markdown({ base: markdownLanguage, addKeymap: false }),
          vimAwareMarkdownKeymap,
          keymap.of([...vimAwareDefaultKeymap(true)])
        ]
      }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    return view
  }

  const press = (view: EditorView, key: string, keyCode: number): void => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true })
    )
  }

  it('does not insert a newline on Enter in normal mode', () => {
    const view = mount('hello\n  world')
    // Before the fix, the markdown keymap's Enter → insertNewlineContinueMarkup
    // fired here and edited the doc. The j^ motion itself can't be asserted:
    // jsdom has no layout, so Vim's vertical motion cannot measure lines.
    press(view, 'Enter', 13)
    expect(view.state.doc.toString()).toBe('hello\n  world')
  })

  it('still continues list markup on Enter in insert mode', () => {
    const view = mount('- item')
    press(view, 'A', 65) // append at end of line → insert mode
    press(view, 'Enter', 13)
    expect(view.state.doc.toString()).toBe('- item\n- ')
  })
})

// #510: on Linux/Windows the search panel's Mod-f is Ctrl+F, which Vim wants
// for page-forward; the keymap runs ahead of the Vim plugin, so the panel won.
describe('vimAwareSearchKeymap', () => {
  const keys = (bindings: readonly KeyBinding[]) => bindings.map((b) => b.key)

  it('drops Mod-f in Vim mode where Mod is Ctrl, so Ctrl+F pages like Ctrl+B', () => {
    expect(keys(vimAwareSearchKeymap(true, false))).not.toContain('Mod-f')
  })

  it('keeps the rest of the search keymap there (find next, replace, select matches)', () => {
    const kept = keys(vimAwareSearchKeymap(true, false))
    for (const key of ['F3', 'Mod-g', 'Escape', 'Mod-Shift-l', 'Mod-Alt-g', 'Mod-d']) {
      expect(kept).toContain(key)
    }
  })

  it('keeps Mod-f on macOS in Vim mode (Cmd+F never collided) and everywhere with Vim off', () => {
    expect(keys(vimAwareSearchKeymap(true, true))).toContain('Mod-f')
    expect(keys(vimAwareSearchKeymap(false, false))).toContain('Mod-f')
    expect(keys(vimAwareSearchKeymap(false, true))).toContain('Mod-f')
  })
})

