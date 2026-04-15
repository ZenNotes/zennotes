import { useEffect } from 'react'
import { useStore } from './store'
import { resolveAuto } from './lib/themes'
import { Sidebar } from './components/Sidebar'
import { NoteList } from './components/NoteList'
import { Editor } from './components/Editor'
import { TitleBar } from './components/TitleBar'
import { SearchPalette } from './components/SearchPalette'
import { CommandPalette } from './components/CommandPalette'
import { BufferPalette } from './components/BufferPalette'
import { OutlinePalette } from './components/OutlinePalette'
import { SettingsModal } from './components/SettingsModal'
import { VimNav } from './components/VimNav'
import { EmptyVault } from './components/EmptyVault'
import { PromptHost } from './components/PromptHost'
import { PinnedReferencePane } from './components/PinnedReferencePane'
import { resolveQuickNoteTitle } from './lib/quick-note-title'

function App(): JSX.Element {
  const vault = useStore((s) => s.vault)
  const init = useStore((s) => s.init)
  const searchOpen = useStore((s) => s.searchOpen)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen)
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen)
  const bufferPaletteOpen = useStore((s) => s.bufferPaletteOpen)
  const setBufferPaletteOpen = useStore((s) => s.setBufferPaletteOpen)
  const outlinePaletteOpen = useStore((s) => s.outlinePaletteOpen)
  const setOutlinePaletteOpen = useStore((s) => s.setOutlinePaletteOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const noteListOpen = useStore((s) => s.noteListOpen)
  const unifiedSidebar = useStore((s) => s.unifiedSidebar)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const themeId = useStore((s) => s.themeId)
  const themeFamily = useStore((s) => s.themeFamily)
  const themeMode = useStore((s) => s.themeMode)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const previewMaxWidth = useStore((s) => s.previewMaxWidth)
  const editorMaxWidth = useStore((s) => s.editorMaxWidth)
  const contentAlign = useStore((s) => s.contentAlign)
  const interfaceFont = useStore((s) => s.interfaceFont)
  const textFont = useStore((s) => s.textFont)
  const monoFont = useStore((s) => s.monoFont)
  const darkSidebar = useStore((s) => s.darkSidebar)

  useEffect(() => {
    void init()
  }, [init])

  // Apply theme: set html[data-theme=...] based on mode/family/id.
  // When mode === 'auto', we mirror `prefers-color-scheme` and also
  // react to changes while the app is running.
  useEffect(() => {
    const html = document.documentElement
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      let id = themeId
      if (themeMode === 'auto') {
        id = resolveAuto(themeFamily, mql.matches)
      }
      html.dataset.theme = id
    }
    apply()
    if (themeMode === 'auto') {
      mql.addEventListener('change', apply)
      return () => mql.removeEventListener('change', apply)
    }
    return undefined
  }, [themeId, themeFamily, themeMode])

  // Apply editor font size + line height + all three font families as
  // CSS variables. Each family has its own fallback stack so leaving it
  // unset gracefully uses the platform default.
  useEffect(() => {
    const html = document.documentElement
    html.style.setProperty('--z-editor-font-size', `${editorFontSize}px`)
    html.style.setProperty('--z-editor-line-height', String(editorLineHeight))
    html.style.setProperty('--z-preview-max-width', `${previewMaxWidth}px`)
    html.style.setProperty('--z-editor-max-width', `${editorMaxWidth}px`)
    html.dataset.contentAlign = contentAlign

    const setFont = (name: string, value: string | null, fallback: string): void => {
      if (value) html.style.setProperty(name, `"${value}", ${fallback}`)
      else html.style.removeProperty(name)
    }
    setFont(
      '--z-interface-font',
      interfaceFont,
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif'
    )
    setFont(
      '--z-text-font',
      textFont,
      '"SF Mono", "SFMono-Regular", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace'
    )
    setFont(
      '--z-mono-font',
      monoFont,
      '"SF Mono", "SFMono-Regular", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace'
    )
  }, [editorFontSize, editorLineHeight, previewMaxWidth, editorMaxWidth, contentAlign, interfaceFont, textFont, monoFont])

  // The app now always runs fully opaque.
  useEffect(() => {
    document.documentElement.setAttribute('data-opaque', '')
  }, [])

  // Sidebar darken toggle: when on, the sidebar reads `--z-bg-1`
  // (one step darker than the main canvas `--z-bg`) regardless of
  // theme, giving a subtle chrome/content separation.
  useEffect(() => {
    const html = document.documentElement
    if (darkSidebar) html.setAttribute('data-dark-sidebar', '')
    else html.removeAttribute('data-dark-sidebar')
  }, [darkSidebar])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const state = useStore.getState()

      if (mod && e.shiftKey && key === 'p') {
        // ⇧⌘P — command palette
        e.preventDefault()
        setBufferPaletteOpen(false)
        setCommandPaletteOpen(!state.commandPaletteOpen)
        return
      }
      if (mod && e.shiftKey && key === 'n') {
        // ⇧⌘N — new quick note
        e.preventDefault()
        const title = resolveQuickNoteTitle(state.notes, state.quickNoteDateTitle)
        void state.createAndOpen('quick', '', { title, focusTitle: true })
        return
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && key === 'z') {
        // ⌥Z — toggle word wrap (matches VSCode/Sublime convention)
        e.preventDefault()
        state.setWordWrap(!state.wordWrap)
        return
      }
      if (mod && !e.shiftKey && key === 'p') {
        // ⌘P — note search
        e.preventDefault()
        setBufferPaletteOpen(false)
        setSearchOpen(!state.searchOpen)
        return
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && key === 'w') {
        e.preventDefault()
        void state.closeActiveNote()
        return
      }
      if (e.key === 'Escape' && state.searchOpen) {
        setSearchOpen(false)
        return
      }
      if (e.key === 'Escape' && state.commandPaletteOpen) {
        setCommandPaletteOpen(false)
        return
      }
      if (e.key === 'Escape' && state.bufferPaletteOpen) {
        setBufferPaletteOpen(false)
        return
      }
      if (e.key === 'Escape' && state.outlinePaletteOpen) {
        setOutlinePaletteOpen(false)
        return
      }
      // ⌘1 — toggle sidebar
      if (mod && (e.key === '1' || e.code === 'Digit1')) {
        e.preventDefault()
        state.toggleSidebar()
        return
      }
      // ⌘2 — toggle connections
      if (mod && (e.key === '2' || e.code === 'Digit2')) {
        e.preventDefault()
        window.dispatchEvent(new Event('zen:toggle-connections'))
        return
      }
      // ⌘3 — toggle outline panel in the active pane
      if (mod && (e.key === '3' || e.code === 'Digit3')) {
        e.preventDefault()
        window.dispatchEvent(new Event('zen:toggle-outline'))
        return
      }
      // ⌘. — toggle focus mode (hide both)
      if (mod && (e.key === '.' || e.code === 'Period')) {
        e.preventDefault()
        const anyOpen = state.sidebarOpen || state.noteListOpen
        state.setFocusMode(anyOpen)
        return
      }
      // ⌘, — open settings (macOS convention)
      if (mod && (e.key === ',' || e.code === 'Comma')) {
        e.preventDefault()
        state.setSettingsOpen(!state.settingsOpen)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setBufferPaletteOpen, setCommandPaletteOpen, setOutlinePaletteOpen, setSearchOpen])

  if (!vault) {
    return (
      <div className="h-screen w-screen bg-paper-100 text-ink-900">
        <TitleBar />
        <EmptyVault />
      </div>
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-paper-100 text-ink-900">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <Sidebar />}
        {noteListOpen && !unifiedSidebar && <NoteList />}
        <Editor />
        <PinnedReferencePane />
      </div>
      {searchOpen && <SearchPalette />}
      {commandPaletteOpen && <CommandPalette />}
      {bufferPaletteOpen && <BufferPalette />}
      {outlinePaletteOpen && <OutlinePalette />}
      {settingsOpen && <SettingsModal />}
      <PromptHost />
      <VimNav />
    </div>
  )
}

export default App
