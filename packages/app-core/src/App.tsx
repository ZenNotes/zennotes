import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import { useStore, initConfigSync, initCustomThemes, initOverrides } from './store'
import { resolveAuto, findTheme } from './lib/themes'
import {
  injectActiveTheme,
  injectOverrides,
  injectTweaks,
  isCustomThemeId,
  customThemeSlugFromId,
  resolveCustomThemeMode
} from './lib/custom-themes'
import { Sidebar } from './components/Sidebar'
import { NoteList } from './components/NoteList'
import { TitleBar } from './components/TitleBar'
import { PromptHost } from './components/PromptHost'
import { ConfirmHost } from './components/ConfirmHost'
import { ServerDirectoryPickerHost } from './components/ServerDirectoryPickerHost'
import { ToastHost } from './components/ui'
import { resolveQuickNoteTitle } from './lib/quick-note-title'
import { isMacPlatform, matchesShortcut, matchesSequenceToken } from './lib/keymaps'
import { focusPaneOrEdgePanel } from './lib/pane-nav'
import { requestPaneMode } from './lib/pane-mode'
import { recordRendererPerf } from './lib/perf'
import { focusEditorNormalMode } from './lib/editor-focus'
import { isAppOverlayOpen } from './lib/overlay-open'
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
  const customThemes = useStore((s) => s.customThemes)
  const overrides = useStore((s) => s.overrides)
  const enabledOverrides = useStore((s) => s.enabledOverrides)
  const themeTweaks = useStore((s) => s.themeTweaks)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const previewMaxWidth = useStore((s) => s.previewMaxWidth)
  const editorMaxWidth = useStore((s) => s.editorMaxWidth)
  const contentAlign = useStore((s) => s.contentAlign)
  const lineNumberPosition = useStore((s) => s.lineNumberPosition)
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

  // When a full-surface panel (Tasks/Tags) closes, the store asks the editor to
  // reclaim keyboard focus so the reopened note takes typing without a manual
  // pane jump or mouse click. Routed through a DOM event to keep the store free
  // of an editor-focus import cycle. (#353)
  useEffect(() => {
    const handler = (): void => focusEditorNormalMode({ attempts: 10, delayMs: 24 })
    window.addEventListener('zen:focus-editor', handler)
    return () => window.removeEventListener('zen:focus-editor', handler)
  }, [])

  // Closing the sidebar while it holds keyboard focus (⌘1, Leader E, etc.) used
  // to strand focus on the now-hidden pane; hand it back to the editor. Only
  // fires on the open→closed transition when the sidebar was the focused panel,
  // so hiding it mid-edit never steals focus from the editor. (#353)
  const prevSidebarOpenRef = useRef(sidebarOpen)
  useEffect(() => {
    const wasOpen = prevSidebarOpenRef.current
    prevSidebarOpenRef.current = sidebarOpen
    if (wasOpen && !sidebarOpen && useStore.getState().focusedPanel === 'sidebar') {
      focusEditorNormalMode({ attempts: 10, delayMs: 24 })
    }
  }, [sidebarOpen])

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

  // Mirror portable prefs to the plain-text config file and pick up external
  // edits (synced dotfile / hand-edit). Desktop-only; a no-op on web.
  useEffect(() => {
    initConfigSync()
    initCustomThemes()
    initOverrides()
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

  // Apply theme: set html[data-theme=...] + html[data-theme-mode=...] based on
  // mode/family/id. Custom themes keep one id (`custom-<slug>`) and express
  // light/dark via `data-theme-mode`; built-ins encode mode in their id but we
  // mirror it onto `data-theme-mode` too so overrides/custom CSS can rely on it
  // universally. When mode === 'auto' we mirror `prefers-color-scheme` live.
  useEffect(() => {
    const html = document.documentElement
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const prefersDark = mql.matches
      if (isCustomThemeId(themeId)) {
        const slug = customThemeSlugFromId(themeId)
        const theme = customThemes.find((t) => t.slug === slug)
        const wantDark = themeMode === 'auto' ? prefersDark : themeMode === 'dark'
        html.dataset.theme = themeId
        html.dataset.themeMode = resolveCustomThemeMode(theme, wantDark)
      } else {
        const id = themeMode === 'auto' ? resolveAuto(themeFamily, prefersDark, themeId) : themeId
        html.dataset.theme = id
        html.dataset.themeMode = findTheme(id).mode
      }
    }
    apply()
    if (themeMode === 'auto') {
      mql.addEventListener('change', apply)
      return () => mql.removeEventListener('change', apply)
    }
    return undefined
  }, [themeId, themeFamily, themeMode, customThemes])

  // Inject the active custom theme's raw CSS (built-ins clear it). Reacts to
  // theme switches and to live edits arriving via the file watcher.
  useEffect(() => {
    injectActiveTheme(themeId, customThemes)
  }, [themeId, customThemes])

  // Inject enabled CSS overrides on top of the active theme.
  useEffect(() => {
    injectOverrides(overrides, enabledOverrides)
  }, [overrides, enabledOverrides])

  // Inject the visual color tweaks (the picker UI) as the topmost layer.
  useEffect(() => {
    injectTweaks(themeTweaks)
  }, [themeTweaks])

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
    html.dataset.lineNumberPosition = lineNumberPosition

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
  }, [editorFontSize, editorLineHeight, previewMaxWidth, editorMaxWidth, contentAlign, lineNumberPosition, interfaceFont, textFont, monoFont])

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
      // On macOS ⌥←/→ moves by word inside text fields; don't let note-history
      // nav hijack it while editing — that broke word-motion in insert mode
      // (#302). History nav still works outside text fields, on other platforms,
      // and via Vim's Ctrl+O / Ctrl+I.
      const isMacWordMotion =
        isMacPlatform() &&
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        isEditableShortcutTarget(e.target)
      if (!isMacWordMotion && matchesShortcut(e, overrides, 'global.historyBack')) {
        // Back in note navigation history (works in any mode).
        e.preventDefault()
        void state.jumpToPreviousNote()
        return
      }
      if (!isMacWordMotion && matchesShortcut(e, overrides, 'global.historyForward')) {
        e.preventDefault()
        void state.jumpToNextNote()
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
        // On Linux/Windows `Mod+W` (close tab) resolves to Ctrl+W, which is also
        // the vim pane-focus prefix (`<C-w>hjkl`) and insert-mode word delete.
        // When vim mode is on AND a tab is open, reserve Ctrl+W for vim (close
        // tabs via :q / :bd / the palette). With no tab open the prefix has
        // nothing to act on, so fall through and close the window. On macOS
        // close-tab is Cmd+W, so the vim guard never matches there.
        const hasActiveTab = !!state.selectedPath
        if (
          state.vimMode &&
          hasActiveTab &&
          matchesSequenceToken(e, overrides, 'vim.panePrefix')
        ) {
          return
        }
        e.preventDefault()
        if (hasActiveTab) {
          void state.closeActiveNote()
        } else {
          // No tab left to close — close the window, matching native Cmd+W
          // (macOS) / Ctrl+W behavior even with vim mode on (#192).
          window.zen.windowClose()
        }
        return
      }
      if (matchesShortcut(e, overrides, 'global.reopenClosedTab')) {
        e.preventDefault()
        void state.reopenLastClosedTab()
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
      // ⇧⌘C — toggle the comments panel in the active pane
      if (matchesShortcut(e, overrides, 'global.toggleCommentsPanel')) {
        e.preventDefault()
        window.dispatchEvent(new Event('zen:toggle-comments'))
        return
      }
      // ⌥⌘M — comment the current selection (or line) without the mouse
      if (matchesShortcut(e, overrides, 'global.addComment')) {
        e.preventDefault()
        window.dispatchEvent(new Event('zen:add-comment'))
        return
      }
      // Pane-focus shortcuts (⌥h/j/k/l by default) are handled by a separate
      // capture-phase listener so a remap onto an editor key still wins over
      // CodeMirror — see focusPaneHandler below. (#124)
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
    // Pane-focus shortcuts must win over the editor. CodeMirror binds keys such
    // as Ctrl-h (delete character) and Ctrl-k (delete to line end), so when a
    // user remaps a focusPane shortcut onto one of them the bubble-phase handler
    // above would run *after* CodeMirror already executed its command — the key
    // would both delete text and move focus (#124). Handle these in the capture
    // phase and consume the event so the editor never sees the key.
    const focusPaneHandler = (e: KeyboardEvent): void => {
      const state = useStore.getState()
      // Don't move focus (or swallow the key) while a modal, palette, or the
      // Settings keybinding recorder is open — the recorder also captures keys
      // in this phase, so a focusPane shortcut bound to e.g. Ctrl+H must not
      // intercept it. (#124)
      if (
        state.settingsOpen ||
        state.searchOpen ||
        state.vaultTextSearchOpen ||
        state.commandPaletteOpen ||
        state.bufferPaletteOpen ||
        state.templatePaletteOpen ||
        state.outlinePaletteOpen ||
        document.querySelector('[data-ctx-menu]') ||
        document.querySelector('[data-prompt-modal]') ||
        document.querySelector('[data-confirm-modal]')
      ) {
        return
      }
      const overrides = state.keymapOverrides
      const paneDir = matchesShortcut(e, overrides, 'global.focusPaneLeft')
        ? 'h'
        : matchesShortcut(e, overrides, 'global.focusPaneDown')
          ? 'j'
          : matchesShortcut(e, overrides, 'global.focusPaneUp')
            ? 'k'
            : matchesShortcut(e, overrides, 'global.focusPaneRight')
              ? 'l'
              : null
      if (!paneDir) return
      e.preventDefault()
      e.stopImmediatePropagation()
      focusPaneOrEdgePanel(paneDir)
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('keydown', focusPaneHandler, true)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('keydown', focusPaneHandler, true)
    }
  }, [
    setBufferPaletteOpen,
    setCommandPaletteOpen,
    setOutlinePaletteOpen,
    setTemplatePaletteOpen,
    setSearchOpen,
    setVaultTextSearchOpen
  ])

  // Self-heal keyboard focus when the window wakes from an idle/background
  // state. If Chromium/the OS lets the editor silently lose DOM focus while
  // idle, window shortcuts and the Vim keymap stop receiving keys until focus
  // is re-established. When the window regains focus (or becomes visible again)
  // and the editor was the active surface with no overlay open, re-grab it so
  // the user doesn't have to open Settings + Escape to recover. Pairs with the
  // main-process `backgroundThrottling: false`. (#350)
  useEffect(() => {
    const heal = (): void => {
      const state = useStore.getState()
      if (state.focusedPanel !== 'editor') return
      if (
        state.settingsOpen ||
        state.searchOpen ||
        state.vaultTextSearchOpen ||
        state.commandPaletteOpen ||
        state.bufferPaletteOpen ||
        state.templatePaletteOpen ||
        state.outlinePaletteOpen ||
        isAppOverlayOpen()
      ) {
        return
      }
      const view = state.editorViewRef
      if (!view) return
      const active = document.activeElement
      const editorHasFocus = !!active && (active === view.dom || view.dom.contains(active))
      if (editorHasFocus) return
      // Leave a deliberately-focused note-title input alone.
      if (active instanceof HTMLElement && active.dataset.noteTitleInput != null) return
      focusEditorNormalMode()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') heal()
    }
    window.addEventListener('focus', heal)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', heal)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  if (!hasCompletedOnboarding) {
    return (
      <div className="zn-app-shell w-screen bg-paper-100 text-ink-900">
        {!zenMode && <TitleBar />}
        <Suspense fallback={<div className="flex-1" />}>
          <OnboardingWizard />
        </Suspense>
        <PromptHost />
        <ConfirmHost />
        <ToastHost />
        <ServerDirectoryPickerHost />
        <AppUpdateNotice hidden={zenMode} />
      </div>
    )
  }

  if (!vault) {
    return (
      <div className="zn-app-shell w-screen bg-paper-100 text-ink-900">
        {!zenMode && <TitleBar />}
        <Suspense fallback={<div className="flex-1" />}>
          <EmptyVault />
        </Suspense>
        <PromptHost />
        <ConfirmHost />
        <ToastHost />
        <ServerDirectoryPickerHost />
        <AppUpdateNotice hidden={zenMode} />
      </div>
    )
  }

  return (
    <div className="zn-app-shell flex w-screen flex-col bg-paper-100 text-ink-900">
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
      <ToastHost />
      <ServerDirectoryPickerHost />
      <AppUpdateNotice hidden={zenMode || settingsOpen} />
      <Suspense fallback={null}>
        <VimNav />
      </Suspense>
    </div>
  )
}

export default App
