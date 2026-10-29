import { requestSettingsTarget } from './lib/settings-navigation'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  useStore,
  initConfigSync,
  initCustomThemes,
  initCustomCodeLanguages,
  initOverrides
} from './store'
import { resolveAuto, findTheme } from './lib/themes'
import { applyTypographyVariables } from './lib/typography-variables'
import { activeReferencePath } from './lib/pinned-reference'
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
import { DatePickerHost } from './components/DatePickerHost'
import { PublishNoteHost } from './components/PublishNoteHost'
import { CloudConflictReviewHost } from './components/CloudConflictReviewHost'
import { CloudSettingsConflictHost } from './components/CloudSettingsConflictHost'
import { ServerDirectoryPickerHost } from './components/ServerDirectoryPickerHost'
import { IconButton, ToastHost } from './components/ui'
import { CloseIcon } from './components/icons'
import { ExcalidrawEmbedMenuHost } from './components/ExcalidrawEmbedMenuHost'
import { resolveQuickNoteTitle } from './lib/quick-note-title'
import { escapeEmbedFrame } from './lib/embed-renderers'
import {
  eventMatchesUserOverride,
  isMacPlatform,
  matchesShortcut,
  TAB_SELECT_KEYMAP_IDS
} from './lib/keymaps'
import { selectActiveBuffer, stepActiveTab } from './lib/buffer-navigation'
import { resolveCloseShortcut } from './lib/close-shortcut'
import { focusPaneOrEdgePanel } from './lib/pane-nav'
import { requestPaneMode } from './lib/pane-mode'
import { recordRendererPerf } from './lib/perf'
import {
  focusEditorAfterPaletteClose,
  focusEditorAfterReadOpen,
  focusEditorNormalMode
} from './lib/editor-focus'
import { isAppOverlayOpen, isOverlayOrDialogOpen } from './lib/overlay-open'
import { installMarkdownFileDropHandler } from './lib/markdown-file-drop'
import {
  setMarkdownDetectCodeLanguages,
  setMarkdownLooseMathDelimiters,
  setMarkdownMathRenderer
} from './lib/markdown-settings'
import {
  appUpdateNoticeLabel,
  appUpdatePrimaryActionLabel,
  useAppUpdateState
} from './lib/app-update-state'
import { ensureCloudAutoSyncStarted, stopCloudAutoSync } from './lib/cloud-auto-sync'
import { loadKeepRunningInTray, startTraySyncStatusReporter } from './lib/tray-runtime'
import { installHarperRuntime } from './lib/harper-runtime'
import { installIgnoredKeysGuard } from './lib/ignored-keys'
import { installCommandKeymapDispatcher, isMainAppWindow } from './lib/command-keymap-dispatch'
import { installSidebarTrashKeys } from './lib/sidebar-note-actions'

// The ignored-keys guard (#732) has to be on `window` before any component
// registers a capture listener there, so it is installed at import time,
// not from an effect: children's effects run before App's, and VimNav's
// would otherwise see the stray key first. Reads the live list on each key.
installIgnoredKeysGuard(() => useStore.getState().ignoredKeys)
// Keys the user gave command palette commands (#971) go next, for the same
// reason: a binding the user chose wins over every default, VimNav's and the
// editor's included, so its listener has to be ahead of theirs. Leader
// sequences are not handled here but in VimNav, after the built-in leader
// keys. See lib/command-keymap-dispatch.ts.
installCommandKeymapDispatcher(() => useStore.getState())
// The sidebar's Mod+Backspace (#972) after those, ahead of every component:
// a list view left active behind a focused sidebar listens on the window too,
// and must not see the chord first. Only the main window has a sidebar.
if (typeof window !== 'undefined' && isMainAppWindow(window.location.search)) {
  installSidebarTrashKeys(() => useStore.getState())
}

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

const LinkPopover = lazy(async () => {
  const module = await import('./components/LinkPopover')
  return { default: module.LinkPopover }
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

const EmbedDrawingPalette = lazy(async () => {
  const module = await import('./components/EmbedDrawingPalette')
  return { default: module.EmbedDrawingPalette }
})
const NoteCoverPicker = lazy(async () => {
  const module = await import('./components/NoteCoverPicker')
  return { default: module.NoteCoverPicker }
})

const SettingsModal = lazy(async () => {
  const module = await import('./components/SettingsModal')
  return { default: module.SettingsModal }
})

const WhatsNewModal = lazy(() => import('./components/WhatsNewModal'))

/** How long after launch What's New waits, so it opens over a settled
 *  window rather than racing the vault and the restored tabs. */
const WHATS_NEW_DELAY_MS = 1200

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
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const noticeKey = updateState
    ? `${updateState.availableVersion ?? ''}:${updateState.phase}`
    : null
  const label = appUpdateNoticeLabel(updateState)
  const actionLabel = appUpdatePrimaryActionLabel(updateState)

  if (hidden || !label || dismissedNotice === noticeKey) return null

  const runPrimaryAction = (): void => {
    if (updateState?.phase === 'available') {
      void window.zen.downloadAppUpdate()
      return
    }
    if (updateState?.phase === 'error') {
      requestSettingsTarget('about')
      useStore.getState().setSettingsOpen(true)
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
      <span className="min-w-0 font-medium">{label}</span>
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
      <IconButton
        size="sm"
        aria-label="Dismiss update notification"
        onClick={() => setDismissedNotice(noticeKey)}
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  )
}

function App(): JSX.Element {
  const mountedAtRef = useRef(performance.now())
  const workspaceReadyLoggedRef = useRef(false)
  const searchPaletteWarmupCleanupRef = useRef<(() => void) | null>(null)
  const pendingOpenNoteRequestsRef = useRef<Array<{ path: string; vault: ReturnType<typeof useStore.getState>['vault'] }>>([])
  const vault = useStore((s) => s.vault)
  const init = useStore((s) => s.init)
  const workspaceRestored = useStore((s) => s.workspaceRestored && !s.workspaceTransitioning)
  const searchOpen = useStore((s) => s.searchOpen)
  const linkPopoverOpen = useStore((s) => s.linkPopover !== null)
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
  const embedDrawingPaletteOpen = useStore((s) => s.embedDrawingPaletteOpen)
  const noteCoverPickerPath = useStore((s) => s.noteCoverPickerPath)
  const setEmbedDrawingPaletteOpen = useStore((s) => s.setEmbedDrawingPaletteOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const noteListOpen = useStore((s) => s.noteListOpen)
  const focusedPanel = useStore((s) => s.focusedPanel)
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
  const whatsNewOpen = useStore((s) => s.whatsNewOpen)
  const themeId = useStore((s) => s.themeId)
  const themeFamily = useStore((s) => s.themeFamily)
  const themeMode = useStore((s) => s.themeMode)
  const customThemes = useStore((s) => s.customThemes)
  const overrides = useStore((s) => s.overrides)
  const enabledOverrides = useStore((s) => s.enabledOverrides)
  const themeTweaks = useStore((s) => s.themeTweaks)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const mathFontScale = useStore((s) => s.mathFontScale)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const previewMaxWidth = useStore((s) => s.previewMaxWidth)
  const editorMaxWidth = useStore((s) => s.editorMaxWidth)
  const contentAlign = useStore((s) => s.contentAlign)
  const completedTaskStyle = useStore((s) => s.completedTaskStyle)
  const mathRenderer = useStore((s) => s.mathRenderer)
  const looseMathDelimiters = useStore((s) => s.looseMathDelimiters)
  const detectCodeLanguages = useStore((s) => s.detectCodeLanguages)
  const lineNumberPosition = useStore((s) => s.lineNumberPosition)
  const interfaceFont = useStore((s) => s.interfaceFont)
  const textFont = useStore((s) => s.textFont)
  const monoFont = useStore((s) => s.monoFont)
  const darkSidebar = useStore((s) => s.darkSidebar)
  const hasCompletedOnboarding = useStore((s) => s.hasCompletedOnboarding)
  const persistWorkspace = useStore((s) => s.persistWorkspace)
  const flushDirtyNotes = useStore((s) => s.flushDirtyNotes)
  const activePinnedRefPath = useMemo(
    () => activeReferencePath({ selectedPath, noteRefs, pinnedRefPath }),
    [noteRefs, pinnedRefPath, selectedPath]
  )
  const showPinnedReferencePane = !zenMode && pinnedRefVisible && !!activePinnedRefPath

  useEffect(() => {
    void init()
  }, [init])

  // The first launch after an update shows what it brought (lib/whats-new.ts).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void useStore.getState().showWhatsNewAfterUpdate()
    }, WHATS_NEW_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!vault) return undefined
    ensureCloudAutoSyncStarted(vault.root)
    return stopCloudAutoSync
  }, [vault?.root])
  // Keep running in the tray (#947): the setting for the palette and leader,
  // and this window's sync state for the tray icon.
  useEffect(() => {
    void loadKeepRunningInTray()
    // Another window's Settings may have changed it meanwhile.
    const refresh = (): void => void loadKeepRunningInTray()
    window.addEventListener('focus', refresh)
    const stopReporting = startTraySyncStatusReporter()
    return () => {
      window.removeEventListener('focus', refresh)
      stopReporting()
    }
  }, [])
  useEffect(() => installHarperRuntime(), [])

  useEffect(() => {
    if (!vault) return undefined
    return scheduleEditorModuleWarmup()
  }, [vault])

  // When a full-surface panel (Tasks/Tags) closes, the store asks the editor to
  // reclaim keyboard focus so the reopened note takes typing without a manual
  // pane jump or mouse click. Routed through a DOM event to keep the store free
  // of an editor-focus import cycle. (#353)
  useEffect(() => {
    // A request marked `read` (a periodic note that already existed, opened
    // from the command palette) lands the way a search pick does: focused on
    // desktop, left to read on a phone.
    const handler = (event: Event): void => {
      const options = { attempts: 10, delayMs: 24 }
      const detail = (event as CustomEvent<{ read?: boolean } | null>).detail
      if (detail?.read) focusEditorAfterReadOpen(options)
      else focusEditorNormalMode(options)
    }
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
      // The macOS menu takes Mod+, before the page does. Asking for Settings
      // while What's New is up replaces it, as the shortcut does below,
      // instead of opening Settings underneath with the keyboard in it.
      const state = useStore.getState()
      if (state.whatsNewOpen) state.closeWhatsNew()
      setSettingsOpen(true)
    })
  }, [setSettingsOpen])

  useEffect(() => {
    return window.zen.onOpenNoteRequested((relPath) => {
      const state = useStore.getState()
      if (state.vault && state.workspaceRestored && !state.workspaceTransitioning) {
        void state.openNoteInTab(relPath)
        return
      }
      pendingOpenNoteRequestsRef.current.push({ path: relPath, vault: state.vault })
    })
  }, [])

  // Escape inside an embedded video player never reaches the page; desktop
  // main relays it so the note gets its keyboard back.
  useEffect(() => {
    return window.zen.onFrameEscape?.(() => {
      escapeEmbedFrame()
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
    initCustomCodeLanguages()
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
      },
      // Dragging a folder onto the window opens it as a temporary session.
      // Desktop-only (the web build has no OS paths).
      ...(runtime === 'web'
        ? {}
        : {
            onFolders: (folders: File[]) => {
              for (const folder of folders) {
                const path = window.zen.getPathForFile(folder)
                if (path) void window.zen.openFolderTemporary(path)
              }
            }
          })
    })
  }, [])

  useEffect(() => {
    if (!vault || !workspaceRestored || pendingOpenNoteRequestsRef.current.length === 0) return
    const requests = pendingOpenNoteRequestsRef.current.splice(0)
    for (const request of requests) {
      if (request.vault && request.vault !== vault) continue
      void useStore.getState().openNoteInTab(request.path)
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

  // "Keep undo history after quitting" off means the saved histories go too:
  // they hold text the user deleted, so they do not outlive the setting that
  // asked for them. Watched here rather than in the setter, because the
  // preference can also be turned off from config.toml. (#793)
  const persistUndoHistory = useStore((s) => s.persistUndoHistory)
  const persistedUndoHistoryRef = useRef(persistUndoHistory)
  useEffect(() => {
    const was = persistedUndoHistoryRef.current
    persistedUndoHistoryRef.current = persistUndoHistory
    if (was && !persistUndoHistory) {
      void window.zen?.clearNoteUndoHistories?.()?.catch(() => undefined)
    }
  }, [persistUndoHistory])

  // Apply theme: set html[data-theme=...] + html[data-theme-mode=...] based on
  // mode/family/id. Custom themes keep one id (`custom-<slug>`) and express
  // light/dark via `data-theme-mode`; built-ins encode mode in their id but we
  // mirror it onto `data-theme-mode` too so overrides/custom CSS can rely on it
  // universally. When mode === 'auto' we mirror `prefers-color-scheme` live.
  useEffect(() => {
    const html = document.documentElement
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const prevMode = html.dataset.themeMode
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
      // Excalidraw embed previews are exported light/dark to match the theme;
      // re-render them when the resolved mode flips so a dark note never shows a
      // white drawing. (#363)
      if (prevMode && prevMode !== html.dataset.themeMode) {
        useStore.setState((s) => ({
          excalidrawPreviewVersion: s.excalidrawPreviewVersion + 1
        }))
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
  // CSS variables (shared with the Quick Look preview).
  useEffect(() => {
    applyTypographyVariables(document.documentElement, {
      editorFontSize,
      mathFontScale,
      editorLineHeight,
      previewMaxWidth,
      editorMaxWidth,
      contentAlign,
      completedTaskStyle,
      mathRenderer,
      lineNumberPosition,
      interfaceFont,
      textFont,
      monoFont
    })
  }, [editorFontSize, mathFontScale, editorLineHeight, previewMaxWidth, editorMaxWidth, contentAlign, completedTaskStyle, mathRenderer, lineNumberPosition, interfaceFont, textFont, monoFont])

  // Keep the markdown/preview pipeline pointed at the active math engine, even
  // on surfaces that render markdown without the Preview component mounted
  // (note hover cards, comments). Preview also sets this inline before its own
  // render to avoid any effect-ordering race on toggle.
  useEffect(() => {
    setMarkdownMathRenderer(mathRenderer)
  }, [mathRenderer])

  useEffect(() => {
    setMarkdownLooseMathDelimiters(looseMathDelimiters)
  }, [looseMathDelimiters])

  useEffect(() => {
    setMarkdownDetectCodeLanguages(detectCodeLanguages)
  }, [detectCodeLanguages])

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

      // What's New opens by itself on the first launch after an update, so
      // the keys people press out of habit land on it. No app shortcut acts
      // behind it: Mod+N made a note under it and moved the keyboard there,
      // Mod+P opened a search nobody could see. Its own buttons, Tab and
      // Escape are its own. Asking for Settings replaces it, as the macOS
      // menu does.
      if (state.whatsNewOpen) {
        if (matchesShortcut(e, overrides, 'global.openSettings')) {
          e.preventDefault()
          state.closeWhatsNew()
          state.setSettingsOpen(true)
        }
        return
      }

      // A modal, palette, menu, or Settings (with its keymap recorder) is
      // open. Per the house rule for global key handlers, a shortcut that
      // switches, reopens or creates the note must not act under it: it
      // strands the user on a different note than they left, and a new note
      // pulls the keyboard into a title field nobody can see. The DOM check
      // also covers every dialog the shared Modal shell draws without a
      // data-* hook of its own (the sidebar icon and color pickers, Publish,
      // the workflow pickers), where Shift+Mod+N used to make a quick note
      // behind the picker.
      const overlayOpen =
        state.settingsOpen ||
        state.searchOpen ||
        state.vaultTextSearchOpen ||
        state.commandPaletteOpen ||
        state.bufferPaletteOpen ||
        state.templatePaletteOpen ||
        state.embedDrawingPaletteOpen ||
        state.outlinePaletteOpen ||
        isOverlayOrDialogOpen()

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
        if (overlayOpen) return
        e.preventDefault()
        const title = resolveQuickNoteTitle(
          state.notes,
          state.quickNoteDateTitle,
          state.quickNoteTitlePrefix
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
      // Alt+1..9 (⌃1..9 on macOS): jump straight to tab N (#497). Position
      // counts across panes in the same order gt cycles through. Bails while
      // an overlay is open (the rule above).
      if (!overlayOpen) {
        for (let i = 0; i < TAB_SELECT_KEYMAP_IDS.length; i += 1) {
          const id = TAB_SELECT_KEYMAP_IDS[i]
          if (!matchesShortcut(e, overrides, id)) continue
          // These defaults were inserted mid-handler: when the combination is
          // one the user explicitly rebound to another action (checked later
          // in this chain), the rebind wins over the shipped default.
          if (!overrides[id] && eventMatchesUserOverride(e, overrides, id)) continue
          e.preventDefault()
          selectActiveBuffer(state, i + 1)
          return
        }
      }
      // Next / previous tab with Vim on or off (#973), in the same order gt/gT
      // walk. Inserted mid-chain like the digits above, so an explicit rebind
      // of the same combination to a later action still wins.
      if (!overlayOpen) {
        for (const [id, delta] of [
          ['tabs.next', 1],
          ['tabs.previous', -1]
        ] as const) {
          if (!matchesShortcut(e, overrides, id)) continue
          if (!overrides[id] && eventMatchesUserOverride(e, overrides, id)) continue
          e.preventDefault()
          stepActiveTab(state, delta)
          return
        }
      }
      // The template pickers as plain shortcuts, so they no longer need Vim's
      // leader (#847). Same overlay rule as tab selection: a picker opened
      // under Settings or another palette would strand the user behind it.
      if (!overlayOpen && matchesShortcut(e, overrides, 'global.newNoteFromTemplate')) {
        e.preventDefault()
        state.setTemplatePaletteOpen(true)
        return
      }
      if (
        !overlayOpen &&
        state.activeNote &&
        matchesShortcut(e, overrides, 'global.insertTemplate')
      ) {
        e.preventDefault()
        state.openTemplatePaletteForInsert()
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
        if (overlayOpen) return
        e.preventDefault()
        void state.jumpToPreviousNote()
        return
      }
      if (!isMacWordMotion && matchesShortcut(e, overrides, 'global.historyForward')) {
        if (overlayOpen) return
        e.preventDefault()
        void state.jumpToNextNote()
        return
      }
      if (matchesShortcut(e, overrides, 'global.toggleRecentNote')) {
        if (overlayOpen) return
        e.preventDefault()
        void state.toggleRecentNote()
        return
      }
      const closeAction = resolveCloseShortcut(e, state)
      if (closeAction) {
        if (closeAction === 'vim') return
        e.preventDefault()
        if (closeAction === 'close-settings') {
          // The same hand-off as Settings' own Escape and Done (#415).
          state.setSettingsOpen(false)
          focusEditorNormalMode()
        } else if (closeAction === 'close-tab') {
          void state.closeActiveNote()
        } else if (closeAction === 'close-window') {
          window.zen.windowClose()
        }
        return
      }
      if (matchesShortcut(e, overrides, 'global.reopenClosedTab')) {
        if (overlayOpen) return
        e.preventDefault()
        void state.reopenLastClosedTab()
        return
      }
      // A palette closed here hands back the focus the way its own Escape and
      // Cancel do: on a phone, that leaves the keyboard where it was.
      if (e.key === 'Escape' && state.searchOpen) {
        setSearchOpen(false)
        focusEditorAfterPaletteClose()
        return
      }
      if (e.key === 'Escape' && state.vaultTextSearchOpen) {
        setVaultTextSearchOpen(false)
        focusEditorAfterPaletteClose()
        return
      }
      if (e.key === 'Escape' && state.commandPaletteOpen) {
        setCommandPaletteOpen(false)
        focusEditorAfterPaletteClose()
        return
      }
      if (e.key === 'Escape' && state.bufferPaletteOpen) {
        setBufferPaletteOpen(false)
        focusEditorAfterPaletteClose()
        return
      }
      if (e.key === 'Escape' && state.templatePaletteOpen) {
        setTemplatePaletteOpen(false)
        focusEditorAfterPaletteClose()
        return
      }
      if (e.key === 'Escape' && state.embedDrawingPaletteOpen) {
        setEmbedDrawingPaletteOpen(false)
        focusEditorAfterPaletteClose()
        return
      }
      if (e.key === 'Escape' && state.outlinePaletteOpen) {
        setOutlinePaletteOpen(false)
        focusEditorAfterPaletteClose()
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
      // ⌘7: toggle the Timeline panel in the active pane (#1007)
      if (matchesShortcut(e, overrides, 'global.toggleTimelinePanel')) {
        e.preventDefault()
        window.dispatchEvent(new Event('zen:toggle-timeline'))
        return
      }
      // ⌥⌘M — comment the current selection (or line) without the mouse
      if (matchesShortcut(e, overrides, 'global.addComment')) {
        e.preventDefault()
        window.dispatchEvent(new Event('zen:add-comment'))
        return
      }
      // Pane-focus shortcuts (⌥h/j/k/l by default) and the pane-mode
      // shortcuts (⌘4/5/6 by default) are handled by a separate capture-phase
      // listener so a remap onto an editor key still wins over CodeMirror —
      // see focusPaneHandler below. (#124, #579)
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
      // Mod+O — open a single markdown file (#449's deferred Win/Linux half).
      // On macOS the File-menu accelerator swallows ⌘O before the renderer
      // sees it, so this effectively serves the menu-less platforms. Vim keeps
      // every claim it already has on Ctrl+O: the capture-phase jumplist takes
      // normal and visual mode (#488's rule), and insert mode's i_CTRL-O
      // arrives here defaultPrevented by the editor, hence the check. So with
      // Vim on this fires only outside the editor; with Vim off it is simply
      // Ctrl+O. Either side is rebindable in Settings → Keymaps.
      if (
        matchesShortcut(e, overrides, 'global.openFile') &&
        !e.defaultPrevented &&
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsLocalFilesystemPickers &&
        typeof window.zen.openFileDialog === 'function'
      ) {
        e.preventDefault()
        void window.zen.openFileDialog()
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
      // intercept it. (#124) Any dialog the shared Modal shell draws counts
      // too: under the sidebar color picker Alt+L moved focus into the editor
      // behind it, and Mod+N made a note there.
      const overrides = state.keymapOverrides
      const modalOrMenuOpen = isOverlayOrDialogOpen()
      // `global.searchNotes` is deliberately not a toggle. `Mod+P` resolves to
      // `Ctrl+P` on Linux and Windows, which is also the Emacs previous-item
      // chord every palette handles via `isPalettePreviousKey()`. A toggle here
      // ran capture-phase and called `stopImmediatePropagation()`, making that
      // branch unreachable while the palette was open (#938). Escape dismisses.
      // Do not reinstate a toggle above the overlay guard.
      if (
        state.settingsOpen ||
        state.whatsNewOpen ||
        state.searchOpen ||
        state.vaultTextSearchOpen ||
        state.commandPaletteOpen ||
        state.bufferPaletteOpen ||
        state.templatePaletteOpen ||
        state.embedDrawingPaletteOpen ||
        state.outlinePaletteOpen ||
        modalOrMenuOpen ||
        // An open autocomplete popup (slash menu, [[ links, the callout [! type
        // picker) owns the keyboard: its Ctrl+J/Ctrl+K/Ctrl+N/Ctrl+P navigation
        // must win over a focusPane shortcut a user remapped onto those chords,
        // rather than switching panes mid-completion. Mirrors the completion
        // deferral for inline-format shortcuts (#337). Reported by Tornado300.
        document.querySelector('.cm-tooltip-autocomplete')
      ) {
        return
      }
      const paneDir = matchesShortcut(e, overrides, 'global.focusPaneLeft')
        ? 'h'
        : matchesShortcut(e, overrides, 'global.focusPaneDown')
          ? 'j'
          : matchesShortcut(e, overrides, 'global.focusPaneUp')
            ? 'k'
            : matchesShortcut(e, overrides, 'global.focusPaneRight')
              ? 'l'
              : null
      if (paneDir) {
        e.preventDefault()
        e.stopImmediatePropagation()
        focusPaneOrEdgePanel(paneDir)
        return
      }

      // Pane-mode shortcuts need the same capture treatment (#579): remapped
      // onto an editor chord (Ctrl+P, Ctrl+E, …), the bubble-phase handler ran
      // only after CodeMirror had already consumed the key, so the shortcuts
      // went dead exactly when the editor held focus — which split mode
      // guarantees. The defaults (⌘4/5/6) collide with nothing, so for them
      // this is just a phase change.
      const paneMode = matchesShortcut(e, overrides, 'global.modeEdit')
        ? ('edit' as const)
        : matchesShortcut(e, overrides, 'global.modeSplit')
          ? ('split' as const)
          : matchesShortcut(e, overrides, 'global.modePreview')
            ? ('preview' as const)
            : null
      if (paneMode) {
        e.preventDefault()
        e.stopImmediatePropagation()
        requestPaneMode(paneMode)
        return
      }

      // Search Notes (Mod+P) and New Note Here (Mod+N) live here for the same
      // reason (#510). On Linux and Windows Mod is Ctrl, and codemirror-vim
      // aliases <C-p>/<C-n> to k/j and stops propagation of every key it
      // handles, so from a focused editor the bubble-phase handler never saw
      // them: the note search palette could not be opened from the note being
      // edited. The rule this settles, written down in the keymaps help: with
      // Vim mode on, an app shortcut on a Ctrl chord wins over Vim's, except
      // the chords Vim mode reserves on purpose, Ctrl+W (pane prefix), Ctrl+O
      // and Ctrl+I (jumplist, #488) and Ctrl+D / Ctrl+U (half page).
      if (matchesShortcut(e, overrides, 'global.searchNotes')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setBufferPaletteOpen(false)
        setVaultTextSearchOpen(false)
        setSearchOpen(true)
        return
      }
      if (matchesShortcut(e, overrides, 'global.newNoteHere')) {
        // #614
        e.preventDefault()
        e.stopImmediatePropagation()
        void state.createNoteInCurrentFolder()
        return
      }

      // Keys inside a focused panel (the sidebar, the note list, connections,
      // the outline, comments) are VimNav's in both modes: with Vim off it
      // routes them to the same handlers, with the typed Vim keys turned off.
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
    setEmbedDrawingPaletteOpen,
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

  // A window-drag strip belongs to the window, not the page, so a tab or note
  // dragged inside the app may not be able to drop on one (the blank end of a
  // tab strip with the title bar off). Nothing moves the window mid-drag, so
  // the strips stand down until the drag ends.
  useEffect(() => {
    const root = document.documentElement
    const start = (): void => root.classList.add('zn-app-dragging')
    const end = (): void => root.classList.remove('zn-app-dragging')
    window.addEventListener('dragstart', start, true)
    window.addEventListener('dragend', end, true)
    window.addEventListener('drop', end, true)
    return () => {
      window.removeEventListener('dragstart', start, true)
      window.removeEventListener('dragend', end, true)
      window.removeEventListener('drop', end, true)
      end()
    }
  }, [])

  if (!hasCompletedOnboarding) {
    return (
      <div className="zn-app-shell w-screen bg-paper-100 text-ink-900">
        {!zenMode && <TitleBar standalone />}
        <Suspense fallback={<div className="flex-1" />}>
          <OnboardingWizard />
        </Suspense>
        <PromptHost />
        <ConfirmHost />
        <DatePickerHost />
        <PublishNoteHost />
        <ToastHost />
        <ExcalidrawEmbedMenuHost />
        <ServerDirectoryPickerHost />
        <AppUpdateNotice hidden={zenMode} />
      </div>
    )
  }

  if (!vault) {
    return (
      <div className="zn-app-shell w-screen bg-paper-100 text-ink-900">
        {!zenMode && <TitleBar standalone />}
        <Suspense fallback={<div className="flex-1" />}>
          <EmptyVault />
        </Suspense>
        <PromptHost />
        <ConfirmHost />
        <DatePickerHost />
        <PublishNoteHost />
        <ToastHost />
        <ExcalidrawEmbedMenuHost />
        <ServerDirectoryPickerHost />
        <AppUpdateNotice hidden={zenMode} />
      </div>
    )
  }

  return (
    // `data-focused-panel` mirrors the store's focused panel onto the DOM. Panel
    // focus is otherwise invisible for the right-side panels (they don't all take
    // DOM focus), which makes pane navigation impossible to assert from outside
    // the app — this is what the keyboard-navigation smoke checks read. (#477)
    <div
      className="zn-app-shell flex w-screen flex-col bg-paper-100 text-ink-900"
      data-focused-panel={focusedPanel ?? 'none'}
    >
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
      {embedDrawingPaletteOpen && (
        <Suspense fallback={null}>
          <EmbedDrawingPalette />
        </Suspense>
      )}
      {noteCoverPickerPath && (
        <Suspense fallback={null}>
          <NoteCoverPicker key={noteCoverPickerPath} notePath={noteCoverPickerPath} />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      {whatsNewOpen && (
        <Suspense fallback={null}>
          <WhatsNewModal />
        </Suspense>
      )}
      {linkPopoverOpen && (
        <Suspense fallback={null}>
          <LinkPopover />
        </Suspense>
      )}
      <PromptHost />
      <ConfirmHost />
      <DatePickerHost />
      <PublishNoteHost />
      <CloudConflictReviewHost />
      <CloudSettingsConflictHost />
      <ToastHost />
      <ExcalidrawEmbedMenuHost />
      <ServerDirectoryPickerHost />
      <AppUpdateNotice hidden={zenMode || settingsOpen} />
      <Suspense fallback={null}>
        <VimNav />
      </Suspense>
    </div>
  )
}

export default App
