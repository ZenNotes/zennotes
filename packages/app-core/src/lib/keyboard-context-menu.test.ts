import { describe, expect, it } from 'vitest'
import { editorOpensKeyboardContextMenu, isKeyboardContextMenuKey } from './keyboard-context-menu'

const key = (key: string, mods: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods
})

describe('the keyboard right-click in the editor', () => {
  it('is Shift+F10 or the Context Menu key, and no chord', () => {
    expect(isKeyboardContextMenuKey(key('F10', { shiftKey: true }))).toBe(true)
    expect(isKeyboardContextMenuKey(key('ContextMenu'))).toBe(true)
    expect(isKeyboardContextMenuKey(key('F10'))).toBe(false)
    expect(isKeyboardContextMenuKey(key('F10', { shiftKey: true, metaKey: true }))).toBe(false)
    expect(isKeyboardContextMenuKey(key('ContextMenu', { ctrlKey: true }))).toBe(false)
    expect(isKeyboardContextMenuKey(key('m'))).toBe(false)
  })

  it('opens the editor menu itself only with Vim mode off on macOS, which sends no contextmenu event', () => {
    const shiftF10 = key('F10', { shiftKey: true })
    expect(editorOpensKeyboardContextMenu(shiftF10, { vimMode: false, mac: true })).toBe(true)
    expect(editorOpensKeyboardContextMenu(key('ContextMenu'), { vimMode: false, mac: true })).toBe(true)
    // Elsewhere Chromium's own contextmenu event reaches the editor's handler.
    expect(editorOpensKeyboardContextMenu(shiftF10, { vimMode: false, mac: false })).toBe(false)
    // With Vim mode on, VimNav keeps deciding.
    expect(editorOpensKeyboardContextMenu(shiftF10, { vimMode: true, mac: true })).toBe(false)
  })
})
