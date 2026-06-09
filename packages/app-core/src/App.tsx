import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import { useStore } from './store'
import { resolveAuto } from './lib/themes'
import { Sidebar } from './components/Sidebar'
import { NoteList } from './components/NoteList'
import { TitleBar } from './components/TitleBar'
import { PromptHost } from './components/PromptHost'
import { ConfirmHost } from './components/ConfirmHost'
import { ServerDirectoryPickerHost } from './components/ServerDirectoryPickerHost'
import { resolveQuickNoteTitle } from './lib/quick-note-title'
import { matchesShortcut, matchesSequenceToken } from './lib/keymaps'
import { requestPaneMode } from './lib/pane-mode'
import { recordRendererPerf } from './lib/perf'
import { focusEditorNormalMode } from './lib/editor-focus'
import { installMarkdownFileDropHandler } from './lib/markdown-file-drop'
import {
  appUpdateNoticeLabel,
  appUpdatePrimaryActionLabel,
  useAppUpdateState
} from './lib/app-update-state'

let editorModulePromise: Promise<typeof import('./components/Editor')> | null = null
const EDITOR_MODULE_WARMUP_GRACE_MS = 40
let searchPaletteModulePromise: Promise<typeof import('./components/SearchPalette')> | null = null
const SEARCH_PALETTE_MODULE_WARMUP_DELAY_MS = 40
const ASSET_UNDO_SHORTCUT_GRACE_MS = 30_000

function loadEditorModule(): Promise<typeof import('./components/Editor')> {
  editorModulePromise ??= import('./components/Editor')
  return editorModulePromise
}

function loadSearchPaletteModule(): Promise<typeof import('./components/SearchPalette')> {
  searchPaletteModulePromise ??= import('./components/SearchPalette')
  return searchPaletteModulePromise
}

function scheduleEditorModuleWarmup(): () => void {
  let cancelled = false
  let delayId: number | null = null
  let frameId: number | null = null

  const warmup = (): void => {
    if (!cancelled) void loadEditorModule()
  }

  delayId = window.setTimeout(() => {
    delayId = null
    frameId = window.requestAnimationFrame(() => {
      frameId = null
      warmup()
    })
  }, EDITOR_MODULE_WARMUP_GRACE_MS)

  return () => {
    cancelled = true
    if (delayId !== null) window.clearTimeout(delayId)
    if (frameId !== null) window.cancelAnimationFrame(frameId)
  }
}

function scheduleSearchPaletteModuleWarmup(): () => void {
  let cancelled = false
  let delayId: number | null = null
  let frameId: number | null = null
  let idleId: number | null = null

  const warmup = (): void => {
    if (!cancelled) void loadSearchPaletteModule()
  }

  delayId = window.setTimeout(() => {
    delayId = null
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(
        () => {
          idleId = null
          warmup()
        },
        { timeout: 300 }
      )
      return
    }
    frameId = window.requestAnimationFrame(() => {
      frameId = null
      warmup()
    })
  }, SEARCH_PALETTE_MODULE_WARMUP_DELAY_MS)

  return () => {
    cancelled = true
    if (delayId !== null) window.clearTimeout(delayId)
    if (frameId !== null) window.cancelAnimationFrame(frameId)
    if (idleId !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId)
    }
  }
}

function isUndoShortcut(e: KeyboardEvent): boolean {
  return (
    e.key.toLowerCase() === 'z' &&
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey
  )
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], .cm-editor'
    )
  )
}

const Editor = lazy(async () => {
  const module = await loadEditorModule()
  return { default: module.Editor }
})

const PinnedReferencePane = lazy(async () => {
  const module = await import('./components/PinnedReferencePane')
  return { default: module.PinnedReferencePane }
})

const VimNav = lazy(async () => {
  const module = await import('./components/VimNav')
  return { default: module.VimNav }
})

const SearchPalette = lazy(async () => {
  const module = await loadSearchPaletteModule()
  return { default: module.SearchPalette }
})

const VaultTextSearchPalette = lazy(async () => {
  const module = await import('./components/VaultTextSearchPalette')
  return { default: module.VaultTextSearchPalette }
})

const CommandPalette = lazy(async () => {
  const module = await import('./components/CommandPalette')
  return { default: module.CommandPalette }
})

const BufferPalette = lazy(async () => {
  const module = await import('./components/BufferPalette')
  return { default: module.BufferPalette }
})

const OutlinePalette = lazy(async () => {
  const module = await import('./components/OutlinePalette')
  return { default: module.OutlinePalette }
})

const TemplatePalette = lazy(async () => {
  const module = await import('./components/TemplatePalette')
  return { default: module.TemplatePalette }
})

const SettingsModal = lazy(async () => {
  const module = await import('./components/SettingsModal')
  return { default: module.SettingsModal }
})

const EmptyVault = lazy(async () => {
  const module = await import('./components/EmptyVault')
  return { default: module.EmptyVault }
})

const OnboardingWizard = lazy(async () => {
  const module = await import('./components/OnboardingWizard')
  return { default: module.OnboardingWizard }
})

function EditorLoadingFallback(): JSX.Element {
  return <div className="min-w-0 flex-1 bg-paper-100" aria-label="Loading editor" />
}

function AppUpdateNotice({
  hidden
}: {
  hidden: boolean
}): JSX.Element | null {
  const updateState = useAppUpdateState()
  const label = appUpdateNoticeLabel(updateState)
  const actionLabel = appUpdatePrimaryActionLabel(updateState)

  if (hidden || !label) return null

  const runPrimaryAction = (): void => {
    if (updateState?.phase === 'available') {
      void window.zen.downloadAppUpdate()
      return
    }
    if (updateState?.phase === 'downloaded') {
      void window.zen.installAppUpdate()
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-40 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-2 rounded-xl border border-accent/30 bg-paper-50/95 px-3 py-2 text-sm text-ink-800 shadow-float backdrop-blur"
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_0_4px_rgb(var(--z-accent)/0.12)]" />
      <span className="min-w-0 truncate font-medium">{label}</span>
      {updateState?.phase === 'downloading' && (
        <span className="shrink-0 rounded-md bg-paper-200/80 px-1.5 py-0.5 text-xs font-medium text-ink-600">
          {Math.round(updateState.progressPercent ?? 0)}%
        </span>
      )}
      {actionLabel && (
        <button
          type="button"
          onClick={runPrimaryAction}
          className="shrink-0 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/15"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}

function App(): JSX.Element {
  const mountedAtRef = useRef(performance.now())
  const workspaceReadyLoggedRef = useRef(false)
  const searchPaletteWarmupCleanupRef = useRef<(() => void) | null>(null)
  const pendingOpenNoteRequestsRef = useRef<string[]>([])
  const vault = useStore((s) => s.vault)
  const init = useStore((s) => s.init)
  const workspaceRestored = useStore((s) => s.workspaceRestored)
  const searchOpen = useStore((s) => s.searchOpen)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const vaultTextSearchOpen = useStore((s) => s.vaultTextSearchOpen)
  const setVaultTextSearchOpen = useStore((s) => s.setVaultTextSearchOpen)
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen)
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen)
  const bufferPaletteOpen = useStore((s) => s.bufferPaletteOpen)
  const setBufferPaletteOpen = useStore((s) => s.setBufferPaletteOpen)
  const outlinePaletteOpen = useStore((s) => s.outlinePaletteOpen)
  const setOutlinePaletteOpen = useStore((s) => s.setOutlinePaletteOpen)
  const templatePaletteOpen = useStore((s) => s.templatePaletteOpen)
  const setTemplatePaletteOpen = useStore((s) => s.setTemplatePaletteOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const noteListOpen = useStore((s) => s.noteListOpen)
  const zenMode = useStore((s) => s.zenMode)
  const paneLayout = useStore((s) => s.paneLayout)
  const activePaneId = useStore((s) => s.activePaneId)
  const view = useStore((s) => s.view)
  const selectedPath = useStore((s) => s.selectedPath)
  const selectedTags = useStore((s) => s.selectedTags)
  const noteRefs = useStore((s) => s.noteRefs)
  const pinnedRefPath = useStore((s) => s.pinnedRefPath)
  const pinnedRefVisible = useStore((s) => s.pinnedRefVisible)
  const unifiedSidebar = useStore((s) => s.unifiedSidebar)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
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
  const hasCompletedOnboarding = useStore((s) => s.hasCompletedOnboarding)
  const persistWorkspace = useStore((s) => s.persistWorkspace)
  const flushDirtyNotes = useStore((s) => s.flushDirtyNotes)
  const activePinnedRefPath = useMemo(
    () => (selectedPath ? noteRefs[selectedPath]?.path ?? pinnedRefPath : pinnedRefPath),
    [noteRefs, pinnedRefPath, selectedPath]
  )
  const showPinnedReferencePane = !zenMode && pinnedRefVisible && !!activePinnedRefPath

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!vault) return undefined
    return scheduleEditorModuleWarmup()
  }, [vault])

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      recordRendererPerf('renderer.app.mounted', performance.now() - mountedAtRef.current)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    return window.zen.onOpenSettings(() => {
      setSettingsOpen(true)
    })
  }, [setSettingsOpen])

  useEffect(() => {
    return window.zen.onOpenNoteRequested((relPath) => {
      const state = useStore.getState()
      if (state.vault && state.workspaceRestored) {
        void state.openNoteInTab(relPath)
        return
      }
      pendingOpenNoteRequestsRef.current.push(relPath)
    })
  }, [])

  useEffect(() => {
    window.zen.notifyRendererReady()
  }, [])

  // Drag a markdown file from the OS onto the window to open it. Desktop
  // resolves the file to a path and opens it in place (vault note when it
  // lives inside a known vault, otherwise a standalone external-file window) —
  // the counterpart of the Finder "Open in ZenNotes" entry. The web build has
  // no OS paths, so it imports the dropped contents as a new note instead.
  useEffect(() => {
    const runtime = window.zen.getAppInfo().runtime
    return installMarkdownFileDropHandler(document, {
      onMarkdownFiles: (files) => {
        if (runtime === 'web') {
          void useStore.getState().importDroppedMarkdownFiles(files)
          return
        }
        for (const file of files) {
          const path = window.zen.getPathForFile(file)
          if (path) void window.zen.openMarkdownFile(path)
        }
      }
    })
  }, [])

  useEffect(() => {
    if (!vault || !workspaceRestored || pendingOpenNoteRequestsRef.current.length === 0) return
    const requests = pendingOpenNoteRequestsRef.current.splice(0)
    for (const relPath of requests) {
      void useStore.getState().openNoteInTab(relPath)
    }
  }, [vault, workspaceRestored])

  useEffect(() => {
    if (!vault || !workspaceRestored) return
    if (!workspaceReadyLoggedRef.current) {
      workspaceReadyLoggedRef.current = true
      void loadEditorModule()
        .catch(() => null)
        .then(() => {
          requestAnimationFrame(() => {
            recordRendererPerf('renderer.workspace.ready', performance.now() - mountedAtRef.current, {
              hasVault: true
            })
            searchPaletteWarmupCleanupRef.current ??= scheduleSearchPaletteModuleWarmup()
          })
        })
    }
    persistWorkspace()
  }, [
    activePaneId,
    noteListOpen,
    paneLayout,
    persistWorkspace,
    selectedTags,
    sidebarOpen,
    vault,
    view,
    workspaceRestored
  ])

  useEffect(() => {
    return () => {
      searchPaletteWarmupCleanupRef.current?.()
      searchPaletteWarmupCleanupRef.current = null
    }
  }, [])

  useEffect(() => {
    const flush = (): void => {
      void flushDirtyNotes()
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [flushDirtyNotes])

  // Apply theme: set html[data-theme=...] based on mode/family/id.
  // When mode === 'auto', we mirror `prefers-color-scheme` and also
  // react to changes while the app is running.
  useEffect(() => {
    const html = document.documentElement
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      let id = themeId
      if (themeMode === 'auto') {
        id = resolveAuto(themeFamily, mql.matches, themeId)
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
      const state = useStore.getState()
      const overrides = state.keymapOverrides

      if (isUndoShortcut(e)) {
        const assetUndoEntry = state.assetUndoStack.at(-1)
        if (assetUndoEntry) {
          const recentAssetDelete =
            Date.now() - assetUndoEntry.createdAt <= ASSET_UNDO_SHORTCUT_GRACE_MS
          if (recentAssetDelete || !isEditableShortcutTarget(e.target)) {
            e.preventDefault()
            void state.undoLastAssetAction()
            return
          }
        }
      }

      if (matchesShortcut(e, overrides, 'global.commandPalette')) {
        // ⇧⌘P — command palette
        e.preventDefault()
        setBufferPaletteOpen(false)
        setVaultTextSearchOpen(false)
        setCommandPaletteOpen(!state.commandPaletteOpen)
        return
      }
      if (!state.vimMode && matchesShortcut(e, overrides, 'global.searchNotesNonVim')) {
        // ⌘F / Ctrl+F — note search when Vim mode is off
        e.preventDefault()
        setBufferPaletteOpen(false)
        setVaultTextSearchOpen(false)
        setSearchOpen(true)
        return
      }
      if (matchesShortcut(e, overrides, 'global.newQuickNote')) {
        // ⇧⌘N — new quick note
        e.preventDefault()
        const title = resolveQuickNoteTitle(
          state.notes,
          state.quickNoteDateTitle,
          state.quickNoteTitlePrefix ?? undefined
        )
        void state.createAndOpen('quick', '', { title, focusTitle: true })
        return
      }
      if (matchesShortcut(e, overrides, 'global.toggleWordWrap')) {
        // ⌥Z — toggle word wrap (matches VSCode/Sublime convention)
        e.preventDefault()
        state.setWordWrap(!state.wordWrap)
        return
      }
      if (matchesShortcut(e, overrides, 'global.exportNotePdf')) {
        e.preventDefault()
        void state.exportActiveNotePdf()
        return
      }
      if (matchesShortcut(e, overrides, 'global.zoomIn')) {
        e.preventDefault()
        void window.zen.zoomInApp()
        return
      }
      if (matchesShortcut(e, overrides, 'global.zoomOut')) {
        e.preventDefault()
        void window.zen.zoomOutApp()
        return
      }
      if (matchesShortcut(e, overrides, 'global.zoomReset')) {
        e.preventDefault()
        void window.zen.resetAppZoom()
        return
      }
      if (matchesShortcut(e, overrides, 'global.searchNotes')) {
        // ⌘P — note search
        e.preventDefault()
        setBufferPaletteOpen(false)
        setVaultTextSearchOpen(false)
        setSearchOpen(!state.searchOpen)
        return
      }
      if (matchesShortcut(e, overrides, 'global.closeActiveTab')) {
        // On Linux/Windows `Mod+W` (close tab) resolves to Ctrl+W, which also
        // is the vim pane-focus prefix (`<C-w>hjkl`) and insert-mode word
        // delete. When vim mode is on, reserve that key for vim — VimNav's
        // capture-phase handler arms the prefix; close tabs via :q / :bd / the
        // command palette. On macOS close-tab is Cmd+W, so this never triggers.
        if (state.vimMode && matchesSequenceToken(e, overrides, 'vim.panePrefix')) {
          return
        }
        e.preventDefault()
        void state.closeActiveNote()
        return
      }
      if (e.key === 'Escape' && state.searchOpen) {
        setSearchOpen(false)
        focusEditorNormalMode()
        return
      }
      if (e.key === 'Escape' && state.vaultTextSearchOpen) {
        setVaultTextSearchOpen(false)
        focusEditorNormalMode()
        return
      }
      if (e.key === 'Escape' && state.commandPaletteOpen) {
        setCommandPaletteOpen(false)
        focusEditorNormalMode()
        return
      }
      if (e.key === 'Escape' && state.bufferPaletteOpen) {
        setBufferPaletteOpen(false)
        focusEditorNormalMode()
        return
      }
      if (e.key === 'Escape' && state.templatePaletteOpen) {
        setTemplatePaletteOpen(false)
        focusEditorNormalMode()
        return
      }
      if (e.key === 'Escape' && state.outlinePaletteOpen) {
        setOutlinePaletteOpen(false)
        focusEditorNormalMode()
        return
      }
      // ⌘1 — toggle sidebar
      if (matchesShortcut(e, overrides, 'global.toggleSidebar')) {
        e.preventDefault()
        state.toggleSidebar()
        return
      }
      // ⌘2 — toggle connections
      if (matchesShortcut(e, overrides, 'global.toggleConnections')) {
        e.preventDefault()
        window.dispatchEvent(new Event('zen:toggle-connections'))
        return
      }
      // ⌘3 — toggle outline panel in the active pane
      if (matchesShortcut(e, overrides, 'global.toggleOutlinePanel')) {
        e.preventDefault()
        window.dispatchEvent(new Event('zen:toggle-outline'))
        return
      }
      if (matchesShortcut(e, overrides, 'global.modeEdit')) {
        e.preventDefault()
        requestPaneMode('edit')
        return
      }
      if (matchesShortcut(e, overrides, 'global.modeSplit')) {
        e.preventDefault()
        requestPaneMode('split')
        return
      }
      if (matchesShortcut(e, overrides, 'global.modePreview')) {
        e.preventDefault()
        requestPaneMode('preview')
        return
      }
      // ⌘. — toggle Zen mode
      if (matchesShortcut(e, overrides, 'global.toggleZenMode')) {
        e.preventDefault()
        state.setFocusMode(!state.zenMode)
        return
      }
      // ⌘, — open settings (macOS convention)
      if (matchesShortcut(e, overrides, 'global.openSettings')) {
        e.preventDefault()
        state.setSettingsOpen(!state.settingsOpen)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    setBufferPaletteOpen,
    setCommandPaletteOpen,
    setOutlinePaletteOpen,
    setTemplatePaletteOpen,
    setSearchOpen,
    setVaultTextSearchOpen
  ])

  if (!hasCompletedOnboarding) {
    return (
      <div className="h-screen w-screen bg-paper-100 text-ink-900">
        {!zenMode && <TitleBar />}
        <Suspense fallback={<div className="flex-1" />}>
          <OnboardingWizard />
        </Suspense>
        <PromptHost />
        <ConfirmHost />
        <ServerDirectoryPickerHost />
        <AppUpdateNotice hidden={zenMode} />
      </div>
    )
  }

  if (!vault) {
    return (
      <div className="h-screen w-screen bg-paper-100 text-ink-900">
        {!zenMode && <TitleBar />}
        <Suspense fallback={<div className="flex-1" />}>
          <EmptyVault />
        </Suspense>
        <PromptHost />
        <ConfirmHost />
        <ServerDirectoryPickerHost />
        <AppUpdateNotice hidden={zenMode} />
      </div>
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-paper-100 text-ink-900">
      {!zenMode && <TitleBar />}
      <div className="flex min-h-0 flex-1">
        {!zenMode && sidebarOpen && <Sidebar />}
        {!zenMode && noteListOpen && !unifiedSidebar && <NoteList />}
        <Suspense fallback={<EditorLoadingFallback />}>
          <Editor />
        </Suspense>
        {showPinnedReferencePane && (
          <Suspense fallback={null}>
            <PinnedReferencePane />
          </Suspense>
        )}
      </div>
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchPalette />
        </Suspense>
      )}
      {vaultTextSearchOpen && (
        <Suspense fallback={null}>
          <VaultTextSearchPalette />
        </Suspense>
      )}
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
      {bufferPaletteOpen && (
        <Suspense fallback={null}>
          <BufferPalette />
        </Suspense>
      )}
      {outlinePaletteOpen && (
        <Suspense fallback={null}>
          <OutlinePalette />
        </Suspense>
      )}
      {templatePaletteOpen && (
        <Suspense fallback={null}>
          <TemplatePalette />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      <PromptHost />
      <ConfirmHost />
      <ServerDirectoryPickerHost />
      <AppUpdateNotice hidden={zenMode || settingsOpen} />
      <Suspense fallback={null}>
        <VimNav />
      </Suspense>
    </div>
  )
}

export default App
