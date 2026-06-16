import { describe, expect, it } from 'vitest'
import { paneModeForPath, paneModesWithPathMode, type PaneModesByPath } from './pane-mode'

describe('pane mode by path', () => {
  it('defaults newly opened notes to edit mode without changing remembered notes', () => {
    let modesByPath: PaneModesByPath = {}

    modesByPath = paneModesWithPathMode(modesByPath, 'inbox/One.md', 'preview')

    expect(paneModeForPath(modesByPath, 'inbox/One.md')).toBe('preview')
    expect(paneModeForPath(modesByPath, 'inbox/Two.md')).toBe('edit')

    modesByPath = paneModesWithPathMode(modesByPath, 'inbox/Two.md', 'split')

    expect(paneModeForPath(modesByPath, 'inbox/One.md')).toBe('preview')
    expect(paneModeForPath(modesByPath, 'inbox/Two.md')).toBe('split')
    expect(paneModeForPath(modesByPath, 'inbox/Three.md')).toBe('edit')
  })
})
