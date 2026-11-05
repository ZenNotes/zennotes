// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { formatKeymapBinding, getKeymapDisplay, labelWithShortcut } from './keymaps'

function onPlatform<T>(platform: string, run: () => T): T {
  const zen = (window as unknown as { zen?: unknown }).zen
  ;(window as unknown as { zen: unknown }).zen = { platformSync: () => platform }
  try {
    return run()
  } finally {
    ;(window as unknown as { zen?: unknown }).zen = zen
  }
}

describe('shortcuts named in a tooltip', () => {
  it('reads Ctrl on Android, Windows and Linux, and the Mac keys on a Mac or an iPad', () => {
    for (const platform of ['android', 'win32', 'linux']) {
      onPlatform(platform, () => {
        expect(getKeymapDisplay(null, 'global.toggleSidebar')).toBe('Ctrl+1')
        expect(getKeymapDisplay(null, 'global.exportNotePdf')).toBe('Shift+Ctrl+E')
      })
    }
    onPlatform('darwin', () => {
      expect(getKeymapDisplay(null, 'global.toggleSidebar')).toBe('⌘1')
      expect(getKeymapDisplay(null, 'global.exportNotePdf')).toBe('⇧⌘E')
    })
  })

  it('reads the submit key of the comment box for the platform', () => {
    onPlatform('android', () => expect(formatKeymapBinding('Mod+Enter', 'shortcut')).toBe('Ctrl+Enter'))
    onPlatform('darwin', () => expect(formatKeymapBinding('Mod+Enter', 'shortcut')).toBe('⌘↵'))
  })

  it('leaves the key out of a tooltip when the action is unbound', () => {
    expect(labelWithShortcut('Show sidebar', '')).toBe('Show sidebar')
  })
})
