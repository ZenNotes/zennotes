import { describe, expect, it } from 'vitest'
import { defaultQuickLookPrefs, quickLookTheme, readQuickLookPrefs } from './prefs'

describe('readQuickLookPrefs', () => {
  it('reads the look from the sections and keys the desktop writes', () => {
    const prefs = readQuickLookPrefs(`
[vim]
enabled = false  # comments are fine

[editor]
font_size = 18
line_height = 1.5
preview_max_width = 700
completed_task_style = "strikethrough"

[appearance]
theme_family = "catppuccin"
theme_mode = "light"
theme_id = "catppuccin-latte"
content_align = "left"
note_cover_placement = "hidden"

[typography]
text_font = "Iowan Old Style"
mono_font = ""
`)
    expect(prefs).toMatchObject({
      vimMode: false,
      editorFontSize: 18,
      editorLineHeight: 1.5,
      previewMaxWidth: 700,
      completedTaskStyle: 'strikethrough',
      themeFamily: 'catppuccin',
      themeMode: 'light',
      themeId: 'catppuccin-latte',
      contentAlign: 'left',
      noteCoverPlacement: 'hidden',
      textFont: 'Iowan Old Style',
      monoFont: null,
      interfaceFont: null
    })
  })

  it('falls back to the app defaults for a missing file, a broken file, or a wrong type', () => {
    expect(readQuickLookPrefs('')).toEqual(defaultQuickLookPrefs())
    expect(readQuickLookPrefs('[editor\nfont_size = ')).toEqual(defaultQuickLookPrefs())
    const prefs = readQuickLookPrefs('[editor]\nfont_size = "big"\n[appearance]\ntheme_mode = "sepia"\n[vim]\nenabled = "yes"')
    expect(prefs.editorFontSize).toBe(defaultQuickLookPrefs().editorFontSize)
    expect(prefs.themeMode).toBe(defaultQuickLookPrefs().themeMode)
    expect(prefs.vimMode).toBe(true)
    expect(readQuickLookPrefs('[appearance]\nnote_cover_placement = "floating"').noteCoverPlacement).toBe('scroll')
  })
})

describe('quickLookTheme', () => {
  const prefs = defaultQuickLookPrefs()

  it('uses the chosen theme in a fixed mode', () => {
    expect(quickLookTheme({ ...prefs, themeFamily: 'gruvbox', themeMode: 'dark', themeId: 'dark-soft' }, false).id).toBe('dark-soft')
  })

  it('follows the system in auto mode, keeping the chosen variant', () => {
    const auto = { ...prefs, themeFamily: 'gruvbox' as const, themeMode: 'auto' as const, themeId: 'dark-soft' }
    expect(quickLookTheme(auto, true).id).toBe('dark-soft')
    expect(quickLookTheme(auto, false).id).toBe('light-soft')
  })

  it('draws a custom theme with the built-in look of its mode', () => {
    expect(quickLookTheme({ ...prefs, themeFamily: 'custom', themeMode: 'dark', themeId: 'my-theme' }, false).id).toBe('apple-dark')
    expect(quickLookTheme({ ...prefs, themeFamily: 'custom', themeMode: 'auto', themeId: 'my-theme' }, false).id).toBe('apple-light')
  })
})
