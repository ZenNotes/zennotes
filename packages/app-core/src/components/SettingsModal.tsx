import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_DAILY_NOTES_DIRECTORY } from '@shared/ipc'
import type {
  AppUpdateState,
  CliInstallStatus,
  RemoteWorkspaceProfile,
  RemoteWorkspaceProfileInput,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchToolPaths
} from '@shared/ipc'
import {
  MCP_CLIENTS,
  type McpClientId,
  type McpClientStatus,
  type McpInstructionsPayload,
  type McpServerRuntime
} from '@shared/mcp-clients'
import { useStore } from '../store'
import type { LineNumberMode, WhichKeyHintMode } from '../store'
import type { KeymapDefinition, KeymapId, KeymapOverrides } from '../lib/keymaps'
import {
  formatKeymapBinding,
  getKeymapBinding,
  getKeymapDefinitionsByGroup,
  getKeymapDisplay,
  isMacPlatform,
  sequenceTokenFromEvent,
  shortcutBindingFromEvent
} from '../lib/keymaps'
import { resolveAuto, THEMES, type ThemeFamily, type ThemeMode } from '../lib/themes'
import { hasSystemFontAccess, listSystemFonts } from '../lib/system-fonts'
import {
  DEFAULT_SYSTEM_FOLDER_LABELS,
  getSystemFolderLabel
} from '../lib/system-folder-labels'
import { normalizeDailyNotesDirectory } from '../lib/vault-layout'
import { getZenBridge } from '@zennotes/bridge-contract/bridge'
import companyLogo from '../assets/lumary-labs-logo.svg'
import { confirmApp } from './ConfirmHost'
import { RemoteWorkspaceProfileModal } from './RemoteWorkspaceProfileModal'

type SettingsCategoryId =
  | 'appearance'
  | 'editor'
  | 'keymaps'
  | 'typography'
  | 'vault'
  | 'mcp'
  | 'cli'
  | 'about'

type ResolvedVaultTextSearchBackend = 'builtin' | 'ripgrep' | 'fzf'

interface SettingsCategory {
  id: SettingsCategoryId
  title: string
  description: string
  keywords: string[]
  content: JSX.Element
}

function resolveVaultTextSearchBackend(
  preferred: VaultTextSearchBackendPreference,
  capabilities: VaultTextSearchCapabilities | null
): ResolvedVaultTextSearchBackend | null {
  if (!capabilities) return null
  if (preferred === 'builtin') return 'builtin'
  if (preferred === 'ripgrep') return capabilities.ripgrep ? 'ripgrep' : 'builtin'
  if (preferred === 'fzf') return capabilities.fzf ? 'fzf' : 'builtin'
  if (capabilities.fzf) return 'fzf'
  if (capabilities.ripgrep) return 'ripgrep'
  return 'builtin'
}

function resolvedVaultTextSearchBackendLabel(
  backend: ResolvedVaultTextSearchBackend | null
): string {
  if (backend === 'ripgrep') return 'ripgrep'
  if (backend === 'fzf') return 'fzf'
  if (backend === 'builtin') return 'Built-in'
  return 'Checking…'
}

function formatUpdatePhaseLabel(phase: AppUpdateState['phase']): string {
  switch (phase) {
    case 'unsupported':
      return 'Unavailable'
    case 'checking':
      return 'Checking'
    case 'available':
      return 'Update available'
    case 'not-available':
      return 'Up to date'
    case 'downloading':
      return 'Downloading'
    case 'downloaded':
      return 'Ready to install'
    case 'error':
      return 'Update error'
    case 'idle':
    default:
      return 'Manual check'
  }
}

function updatePhaseBadgeClass(phase: AppUpdateState['phase']): string {
  switch (phase) {
    case 'available':
    case 'downloaded':
      return 'border-accent/30 bg-accent/10 text-accent'
    case 'checking':
    case 'downloading':
      return 'border-paper-300/70 bg-paper-100/85 text-ink-700'
    case 'error':
      return 'border-red-400/25 bg-red-500/10 text-red-700'
    case 'not-available':
      return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-700'
    case 'unsupported':
      return 'border-paper-300/70 bg-paper-100/80 text-ink-500'
    case 'idle':
    default:
      return 'border-paper-300/70 bg-paper-100/80 text-ink-600'
  }
}

function formatBytes(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024
    unit = units[i]
  }
  const rounded = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
  return `${rounded} ${unit}`
}

function formatReleaseNotesForDisplay(notes: string | null): string | null {
  if (!notes) return null
  const trimmed = notes.trim()
  if (!trimmed) return null
  if (!/[<&]/.test(trimmed)) return trimmed

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(trimmed, 'text/html')
    const text = (doc.body.innerText || doc.body.textContent || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return text || trimmed
  } catch {
    return trimmed
  }
}

export function SettingsModal(): JSX.Element {
  const appInfo = getZenBridge().getAppInfo()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const vimMode = useStore((s) => s.vimMode)
  const setVimMode = useStore((s) => s.setVimMode)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const setKeymapBinding = useStore((s) => s.setKeymapBinding)
  const resetAllKeymaps = useStore((s) => s.resetAllKeymaps)
  const whichKeyHints = useStore((s) => s.whichKeyHints)
  const setWhichKeyHints = useStore((s) => s.setWhichKeyHints)
  const whichKeyHintMode = useStore((s) => s.whichKeyHintMode)
  const setWhichKeyHintMode = useStore((s) => s.setWhichKeyHintMode)
  const whichKeyHintTimeoutMs = useStore((s) => s.whichKeyHintTimeoutMs)
  const setWhichKeyHintTimeoutMs = useStore((s) => s.setWhichKeyHintTimeoutMs)
  const vaultTextSearchBackend = useStore((s) => s.vaultTextSearchBackend)
  const setVaultTextSearchBackend = useStore((s) => s.setVaultTextSearchBackend)
  const ripgrepBinaryPath = useStore((s) => s.ripgrepBinaryPath)
  const setRipgrepBinaryPath = useStore((s) => s.setRipgrepBinaryPath)
  const fzfBinaryPath = useStore((s) => s.fzfBinaryPath)
  const setFzfBinaryPath = useStore((s) => s.setFzfBinaryPath)
  const livePreview = useStore((s) => s.livePreview)
  const setLivePreview = useStore((s) => s.setLivePreview)
  const tabsEnabled = useStore((s) => s.tabsEnabled)
  const setTabsEnabled = useStore((s) => s.setTabsEnabled)
  const quickNoteDateTitle = useStore((s) => s.quickNoteDateTitle)
  const setQuickNoteDateTitle = useStore((s) => s.setQuickNoteDateTitle)
  const quickNoteTitlePrefix = useStore((s) => s.quickNoteTitlePrefix)
  const setQuickNoteTitlePrefix = useStore((s) => s.setQuickNoteTitlePrefix)
  const wordWrap = useStore((s) => s.wordWrap)
  const setWordWrap = useStore((s) => s.setWordWrap)
  const previewSmoothScroll = useStore((s) => s.previewSmoothScroll)
  const setPreviewSmoothScroll = useStore((s) => s.setPreviewSmoothScroll)
  const editorMaxWidth = useStore((s) => s.editorMaxWidth)
  const setEditorMaxWidth = useStore((s) => s.setEditorMaxWidth)
  const pdfEmbedInEditMode = useStore((s) => s.pdfEmbedInEditMode)
  const setPdfEmbedInEditMode = useStore((s) => s.setPdfEmbedInEditMode)
  const contentAlign = useStore((s) => s.contentAlign)
  const setContentAlign = useStore((s) => s.setContentAlign)
  const vault = useStore((s) => s.vault)
  const workspaceMode = useStore((s) => s.workspaceMode)
  const remoteWorkspaceInfo = useStore((s) => s.remoteWorkspaceInfo)
  const remoteWorkspaceProfiles = useStore((s) => s.remoteWorkspaceProfiles)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const persistVaultSettings = useStore((s) => s.setVaultSettings)
  const openVaultPicker = useStore((s) => s.openVaultPicker)
  const connectRemoteWorkspace = useStore((s) => s.connectRemoteWorkspace)
  const connectRemoteWorkspaceProfile = useStore((s) => s.connectRemoteWorkspaceProfile)
  const changeRemoteWorkspaceVaultPath = useStore((s) => s.changeRemoteWorkspaceVaultPath)
  const disconnectRemoteWorkspace = useStore((s) => s.disconnectRemoteWorkspace)
  const saveRemoteWorkspaceProfile = useStore((s) => s.saveRemoteWorkspaceProfile)
  const deleteRemoteWorkspaceProfile = useStore((s) => s.deleteRemoteWorkspaceProfile)
  const openTodayDailyNote = useStore((s) => s.openTodayDailyNote)
  const themeId = useStore((s) => s.themeId)
  const themeFamily = useStore((s) => s.themeFamily)
  const themeMode = useStore((s) => s.themeMode)
  const setTheme = useStore((s) => s.setTheme)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const setEditorFontSize = useStore((s) => s.setEditorFontSize)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const setEditorLineHeight = useStore((s) => s.setEditorLineHeight)
  const previewMaxWidth = useStore((s) => s.previewMaxWidth)
  const setPreviewMaxWidth = useStore((s) => s.setPreviewMaxWidth)
  const lineNumberMode = useStore((s) => s.lineNumberMode)
  const setLineNumberMode = useStore((s) => s.setLineNumberMode)
  const interfaceFont = useStore((s) => s.interfaceFont)
  const setInterfaceFont = useStore((s) => s.setInterfaceFont)
  const textFont = useStore((s) => s.textFont)
  const setTextFont = useStore((s) => s.setTextFont)
  const monoFont = useStore((s) => s.monoFont)
  const setMonoFont = useStore((s) => s.setMonoFont)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const setSystemFolderLabel = useStore((s) => s.setSystemFolderLabel)
  const darkSidebar = useStore((s) => s.darkSidebar)
  const setDarkSidebar = useStore((s) => s.setDarkSidebar)
  const showSidebarChevrons = useStore((s) => s.showSidebarChevrons)
  const setShowSidebarChevrons = useStore((s) => s.setShowSidebarChevrons)
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null)
  const [editingRemoteProfile, setEditingRemoteProfile] = useState<{
    mode: 'create' | 'edit'
    value?: RemoteWorkspaceProfileInput
    hasStoredCredential?: boolean
  } | null>(null)

  // Lazy-load the system font list on mount. Retried on every mount
  // when the list comes back empty (IPC failure / no fonts yet).
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  const [vaultTextSearchCapabilities, setVaultTextSearchCapabilities] =
    useState<VaultTextSearchCapabilities | null>(null)
  const searchToolPaths = useMemo<VaultTextSearchToolPaths>(
    () => ({
      ripgrepPath: ripgrepBinaryPath,
      fzfPath: fzfBinaryPath
    }),
    [fzfBinaryPath, ripgrepBinaryPath]
  )
  useEffect(() => {
    let cancelled = false
    void listSystemFonts().then((fonts) => {
      if (!cancelled) setSystemFonts(fonts)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (typeof window.zen.getVaultTextSearchCapabilities !== 'function') {
      setVaultTextSearchCapabilities({ ripgrep: false, fzf: false })
      return () => {
        cancelled = true
      }
    }
    void window.zen.getVaultTextSearchCapabilities(searchToolPaths).then(
      (capabilities) => {
        if (!cancelled) setVaultTextSearchCapabilities(capabilities)
      },
      () => {
        if (!cancelled) setVaultTextSearchCapabilities({ ripgrep: false, fzf: false })
      }
    )
    return () => {
      cancelled = true
    }
  }, [searchToolPaths])

  useEffect(() => {
    let cancelled = false
    void window.zen.getAppUpdateState().then((state) => {
      if (!cancelled) setAppUpdateState(state)
    })
    const unsubscribe = window.zen.onAppUpdateState((state) => {
      if (!cancelled) setAppUpdateState(state)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const triggerUpdateCheck = useCallback(() => {
    void window.zen.checkForAppUpdates().then(
      (state) => {
        if (state.phase === 'available') {
          window.alert(
            `ZenNotes ${state.availableVersion ?? ''} is available. Use “Download Update” to fetch it.`
          )
          return
        }
        if (state.phase === 'not-available') {
          window.alert(state.message)
          return
        }
        if (state.phase === 'unsupported' || state.phase === 'error') {
          window.alert(state.message)
        }
      },
      (error) => {
        const message =
          error instanceof Error ? error.message : 'Could not check for updates.'
        window.alert(message)
      }
    )
  }, [])

  const triggerUpdateDownload = useCallback(() => {
    void window.zen.downloadAppUpdate()
  }, [])

  const triggerUpdateInstall = useCallback(() => {
    void window.zen.installAppUpdate()
  }, [])

  const currentRemoteProfileId =
    workspaceMode === 'remote' ? remoteWorkspaceInfo?.profileId ?? null : null

  const openCreateRemoteProfile = useCallback(() => {
    setEditingRemoteProfile({
      mode: 'create',
      value: {
        name: '',
        baseUrl: remoteWorkspaceInfo?.baseUrl ?? 'http://localhost:7878',
        authToken: null,
        vaultPath: workspaceMode === 'remote' ? vault?.root ?? null : null
      },
      hasStoredCredential: false
    })
  }, [remoteWorkspaceInfo?.baseUrl, vault?.root, workspaceMode])

  const openEditRemoteProfile = useCallback((profile: RemoteWorkspaceProfile) => {
    setEditingRemoteProfile({
      mode: 'edit',
      value: {
        id: profile.id,
        name: profile.name,
        baseUrl: profile.baseUrl,
        vaultPath: profile.vaultPath
      },
      hasStoredCredential: profile.hasCredential
    })
  }, [])

  const submitRemoteProfile = useCallback(
    async (input: RemoteWorkspaceProfileInput) => {
      await saveRemoteWorkspaceProfile(input)
      setEditingRemoteProfile(null)
    },
    [saveRemoteWorkspaceProfile]
  )

  const removeRemoteProfile = useCallback(
    async (profile: RemoteWorkspaceProfile) => {
      const confirmed = await confirmApp({
        title: `Remove “${profile.name}”?`,
        description: 'This only removes the saved connection from ZenNotes. It does not delete anything on the server.',
        confirmLabel: 'Remove',
        danger: true
      })
      if (!confirmed) return
      await deleteRemoteWorkspaceProfile(profile.id)
    },
    [deleteRemoteWorkspaceProfile]
  )

  const displayedReleaseNotes = useMemo(
    () => formatReleaseNotesForDisplay(appUpdateState?.releaseNotes ?? null),
    [appUpdateState?.releaseNotes]
  )

  // Family list — Apple is the default, followed by the other families.
  const familyOptions = useMemo<{ id: ThemeFamily; label: string }[]>(
    () => [
      { id: 'apple', label: 'Apple' },
      { id: 'gruvbox', label: 'Gruvbox Material' },
      { id: 'catppuccin', label: 'Catppuccin' },
      { id: 'github', label: 'GitHub' },
      { id: 'solarized', label: 'Solarized' },
      { id: 'one', label: 'One' },
      { id: 'nord', label: 'Nord' },
      { id: 'tokyo-night', label: 'Tokyo Night' }
    ],
    []
  )

  // Variants to show in the variant picker.
  //  - Gruvbox ships paired light/dark variants per contrast level, so
  //    we scope to the effective mode (hard+light / hard+dark / …).
  //  - Apple has only two variants (light / dark), which the Mode
  //    selector already handles — the variant picker stays hidden.
  //  - Catppuccin and GitHub each ship variants that ARE the theme
  //    choice (Latte, Frappé, Macchiato, Mocha / Dark, Dark Dimmed,
  //    Dark HC, Light, Light HC, …). Show them all regardless of mode
  //    so users can pick any variant and have the mode auto-align.
  // Track `prefers-color-scheme` so the picker reflects what the user
  // actually sees while in Auto mode. Without this, the contrast row
  // falls back to whatever mode the *stored* themeId belongs to — which
  // can drift away from the rendered theme (resolveAuto picks based on
  // family + system) and makes clicking a contrast variant feel like
  // it's flipping the whole theme to the wrong mode.
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  )
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setPrefersDark(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  /** What mode the app is *actually rendering* right now. */
  const effectiveMode: 'light' | 'dark' = useMemo(() => {
    if (themeMode === 'auto') return prefersDark ? 'dark' : 'light'
    return themeMode
  }, [themeMode, prefersDark])

  /** Variant id to compare against when highlighting selection. In Auto
   *  mode this is whatever `resolveAuto` produced, since the stored
   *  themeId may not match what's painted on screen. */
  const renderedThemeId = useMemo(
    () =>
      themeMode === 'auto' ? resolveAuto(themeFamily, prefersDark, themeId) : themeId,
    [themeId, themeFamily, themeMode, prefersDark]
  )

  const visibleVariants = useMemo(() => {
    if (themeFamily === 'gruvbox') {
      return THEMES.filter(
        (t) => t.family === 'gruvbox' && t.mode === effectiveMode
      )
    }
    // Families with only a light/dark pair don't need a variant picker —
    // the Mode selector above already handles the toggle.
    const simpleFamilies: ThemeFamily[] = [
      'apple',
      'solarized',
      'one',
      'nord',
      'tokyo-night'
    ]
    if (simpleFamilies.includes(themeFamily)) return []
    return THEMES.filter((t) => t.family === themeFamily)
  }, [themeFamily, effectiveMode])

  const pickFamily = (family: ThemeFamily): void => {
    // When family changes, keep the mode the same and pick the canonical
    // first variant in that family (medium for gruvbox, default for
    // catppuccin/github).
    const preferred: Record<ThemeFamily, { light: string; dark: string }> = {
      apple: { light: 'apple-light', dark: 'apple-dark' },
      gruvbox: { light: 'light-medium', dark: 'dark-medium' },
      catppuccin: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
      github: { light: 'github-light', dark: 'github-dark' },
      solarized: { light: 'solarized-light', dark: 'solarized-dark' },
      one: { light: 'one-light', dark: 'one-dark' },
      nord: { light: 'nord-light', dark: 'nord-dark' },
      'tokyo-night': { light: 'tokyo-night-day', dark: 'tokyo-night-storm' }
    }
    const targetId = preferred[family][effectiveMode]
    setTheme({ id: targetId, family, mode: themeMode })
  }

  const pickMode = (mode: ThemeMode): void => {
    if (mode === 'auto') {
      setTheme({ id: themeId, family: themeFamily, mode: 'auto' })
      return
    }
    // Flip to the mode-equivalent variant in the same family. For
    // Gruvbox we also try to preserve the user's chosen contrast.
    const currentVariant = THEMES.find((t) => t.id === themeId)?.variant
    const candidate =
      THEMES.find(
        (t) =>
          t.family === themeFamily &&
          t.mode === mode &&
          t.variant === currentVariant
      ) ?? THEMES.find((t) => t.family === themeFamily && t.mode === mode)
    if (candidate) setTheme({ id: candidate.id, family: themeFamily, mode })
  }

  const pickVariant = (id: string): void => {
    const t = THEMES.find((x) => x.id === id)
    if (!t) return
    // Preserve the user's mode toggle. In Auto we keep the mode auto and
    // store the picked variant — `resolveAuto` will carry the variant
    // forward when the system flips light/dark. In an explicit mode the
    // variant's native mode already matches because the picker filtered
    // by `effectiveMode`.
    const nextMode: ThemeMode = themeMode === 'auto' ? 'auto' : t.mode
    setTheme({ id: t.id, family: t.family, mode: nextMode })
  }

  const ref = useRef<HTMLDivElement | null>(null)
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>('appearance')
  const [navQuery, setNavQuery] = useState('')
  const availableVaultTextSearchTools = [
    vaultTextSearchCapabilities?.ripgrep ? 'ripgrep' : null,
    vaultTextSearchCapabilities?.fzf ? 'fzf' : null
  ].filter((value): value is string => !!value)
  const resolvedVaultTextSearchBackend = useMemo(
    () =>
      resolveVaultTextSearchBackend(
        vaultTextSearchBackend,
        vaultTextSearchCapabilities
      ),
    [vaultTextSearchBackend, vaultTextSearchCapabilities]
  )
  const resolvedVaultTextSearchMessage = useMemo(() => {
    if (!vaultTextSearchCapabilities) return 'Checking configured search tools…'
    if (vaultTextSearchBackend === 'builtin') {
      return 'Current runtime backend: Built-in, by explicit choice.'
    }
    if (vaultTextSearchBackend === 'ripgrep') {
      return vaultTextSearchCapabilities.ripgrep
        ? 'Current runtime backend: ripgrep.'
        : 'Current runtime backend: Built-in fallback, because ripgrep is not available from the configured path or PATH.'
    }
    if (vaultTextSearchBackend === 'fzf') {
      return vaultTextSearchCapabilities.fzf
        ? 'Current runtime backend: fzf.'
        : 'Current runtime backend: Built-in fallback, because fzf is not available from the configured path or PATH.'
    }
    if (vaultTextSearchCapabilities.fzf) {
      return 'Current runtime backend: fzf, selected automatically.'
    }
    if (vaultTextSearchCapabilities.ripgrep) {
      return 'Current runtime backend: ripgrep, selected automatically.'
    }
    return 'Current runtime backend: Built-in, because no external search tool is available.'
  }, [vaultTextSearchBackend, vaultTextSearchCapabilities])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen])

  const categories: SettingsCategory[] = [
    {
      id: 'appearance',
      title: 'Appearance',
      description: 'Theme family, mode, and chrome surface styling.',
      keywords: ['theme', 'mode', 'variant', 'dark sidebar', 'surface', 'look'],
      content: (
        <div className="space-y-6">
          <Section
            title="Theme"
            description="Pick the visual system ZenNotes uses across the app."
          >
            <div className="flex flex-col gap-5 px-5 py-5">
              <div>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-500">
                  Family
                </div>
                <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                  {familyOptions.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => pickFamily(f.id)}
                      className={[
                        'rounded-xl border px-3 py-2.5 text-left text-sm transition-colors',
                        themeFamily === f.id
                          ? 'border-accent/45 bg-accent/10 text-ink-900'
                          : 'border-paper-300/70 bg-paper-100/70 text-ink-700 hover:bg-paper-200/80'
                      ].join(' ')}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-500">
                  Mode
                </div>
                <div className="inline-flex rounded-xl border border-paper-300/70 bg-paper-100/75 p-1">
                  {(['light', 'dark', 'auto'] as ThemeMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => pickMode(m)}
                      className={[
                        'rounded-lg px-3 py-1.5 text-xs capitalize transition-colors',
                        themeMode === m
                          ? 'bg-paper-50 text-ink-900 shadow-sm'
                          : 'text-ink-600 hover:text-ink-900'
                      ].join(' ')}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              {visibleVariants.length > 1 && (
                <div>
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-500">
                    {themeFamily === 'gruvbox'
                      ? 'Contrast'
                      : themeFamily === 'catppuccin'
                        ? 'Flavor'
                        : 'Variant'}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {visibleVariants.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => pickVariant(v.id)}
                        className={[
                          'rounded-xl border px-3 py-1.5 text-xs transition-colors',
                          renderedThemeId === v.id
                            ? 'border-accent/45 bg-accent/10 text-ink-900'
                            : 'border-paper-300/70 bg-paper-100/70 text-ink-700 hover:bg-paper-200/80'
                        ].join(' ')}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>

          <Section
            title="Chrome"
            description="Small visual adjustments that change how the shell feels."
          >
            <ToggleRow
              label="Dark sidebar"
              description="Tint the sidebar one step darker than the canvas so the chrome reads as a separate surface."
              value={darkSidebar}
              onChange={setDarkSidebar}
            />
            <ToggleRow
              label="Sidebar arrows"
              description="Show disclosure arrows for collapsible folders and sidebar sections."
              value={showSidebarChevrons}
              onChange={setShowSidebarChevrons}
            />
          </Section>
        </div>
      )
    },
    {
      id: 'editor',
      title: 'Editor',
      description: 'Vim, leader hints, live preview, tabs, and writing behavior.',
      keywords: ['vim', 'leader', 'preview', 'tabs', 'wrap', 'pdf', 'quick note', 'quick capture', 'hotkey', 'shortcut', 'task', 'tasks'],
      content: (
        <div className="space-y-6">
          <Section
            title="Vim"
            description="Keyboard-first editing behavior and leader guidance."
          >
            <ToggleRow
              label="Vim mode"
              description="First-class Vim motions in the markdown editor."
              value={vimMode}
              onChange={setVimMode}
            />
            {vimMode ? (
              <>
                <ToggleRow
                  label="Leader key hints"
                  description="Show a which-key style guide after pressing the Leader key so the next available actions stay visible."
                  value={whichKeyHints}
                  onChange={setWhichKeyHints}
                />
                {whichKeyHints && (
                  <>
                    <SegmentedRow
                      label="Leader hint behavior"
                      description="Timed auto-hides after a short delay. Sticky keeps the leader overlay open until you dismiss it."
                      value={whichKeyHintMode}
                      options={[
                        { value: 'timed', label: 'Timed' },
                        { value: 'sticky', label: 'Sticky' }
                      ]}
                      onChange={(next) => setWhichKeyHintMode(next as WhichKeyHintMode)}
                    />
                    {whichKeyHintMode === 'timed' && (
                      <SliderRow
                        label="Leader hint duration"
                        description="How long the leader overlay stays visible, and how long the pending leader sequence remains armed."
                        value={whichKeyHintTimeoutMs}
                        min={400}
                        max={3000}
                        step={100}
                        format={(v) => `${(v / 1000).toFixed(1)}s`}
                        onChange={setWhichKeyHintTimeoutMs}
                      />
                    )}
                  </>
                )}
              </>
            ) : (
              <InlineNote>
                Leader key hints are only available while Vim mode is enabled.
              </InlineNote>
            )}
          </Section>

          <Section
            title="Search"
            description="Choose how vault-wide text search is powered."
          >
            <SegmentedRow
              label="Vault text search backend"
              description="Auto prefers fzf when available, then ripgrep, and falls back to the built-in searcher."
              value={vaultTextSearchBackend}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'builtin', label: 'Built-in' },
                { value: 'ripgrep', label: 'ripgrep' },
                { value: 'fzf', label: 'fzf' }
              ]}
              onChange={(next) => setVaultTextSearchBackend(next as VaultTextSearchBackendPreference)}
            />
            <TextInputRow
              label="ripgrep binary path"
              description="Optional. Leave blank to use `rg` from your PATH."
              value={ripgrepBinaryPath ?? ''}
              placeholder="/custom/bin/rg"
              onChange={(next) => setRipgrepBinaryPath(next)}
            />
            <TextInputRow
              label="fzf binary path"
              description="Optional. Leave blank to use `fzf` from your PATH."
              value={fzfBinaryPath ?? ''}
              placeholder="/custom/bin/fzf"
              onChange={(next) => setFzfBinaryPath(next)}
            />
            <InlineNote>
              Runtime backend: {resolvedVaultTextSearchBackendLabel(resolvedVaultTextSearchBackend)}
            </InlineNote>
            <InlineNote>
              {resolvedVaultTextSearchMessage}
            </InlineNote>
            <InlineNote>
              {vaultTextSearchCapabilities == null
                ? 'Checking configured search tools…'
                : availableVaultTextSearchTools.length > 0
                  ? `Available with the current paths: ${availableVaultTextSearchTools.join(', ')}.`
                  : 'No usable ripgrep or fzf binary was detected from the configured paths or PATH. ZenNotes will use the built-in search backend.'}
            </InlineNote>
          </Section>

          <Section
            title="Writing"
            description="Controls that change how notes render while you work."
          >
            <ToggleRow
              label="Live preview"
              description="Hide markdown syntax on lines you're not editing. Turn off to always see raw #, **, [[…]], and other source text."
              value={livePreview}
              onChange={setLivePreview}
            />
            <ToggleRow
              label="Note tabs"
              description="Open notes in tabs and allow split-friendly tab workflows. Turn off to keep the simpler single-note behavior."
              value={tabsEnabled}
              onChange={setTabsEnabled}
            />
            <ToggleRow
              label="Word wrap"
              description="Wrap long lines to the editor width. Turn off to scroll horizontally instead."
              value={wordWrap}
              onChange={setWordWrap}
            />
            <ToggleRow
              label="Smooth preview scroll"
              description="Animate Ctrl+D / Ctrl+U half-page jumps in preview mode. Turn off for an instant snap that keeps position predictable."
              value={previewSmoothScroll}
              onChange={setPreviewSmoothScroll}
            />
            <SegmentedRow
              label="PDFs in edit mode"
              description="Compact keeps the editor focused. Full inlines the PDF viewer under your cursor."
              value={pdfEmbedInEditMode}
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'full', label: 'Full' }
              ]}
              onChange={(next) => setPdfEmbedInEditMode(next)}
            />
            <ToggleRow
              label="Date-titled Quick Notes"
              description="New Quick Notes use YYYY-MM-DD instead of timestamp-style titles."
              value={quickNoteDateTitle}
              onChange={setQuickNoteDateTitle}
            />
            <TextInputRow
              label="Quick Note prefix"
              description="Used when naming new Quick Notes. Leave blank for a bare timestamp or date."
              value={quickNoteTitlePrefix ?? ''}
              placeholder="Quick Note"
              onChange={setQuickNoteTitlePrefix}
            />
          </Section>

          <Section
            title="Quick capture"
            description="Floating capture window for thoughts you want in the vault without leaving whatever you're doing."
          >
            <QuickCaptureHotkeyRow />
          </Section>
        </div>
      )
    },
    {
      id: 'keymaps',
      title: 'Keymap',
      description: 'Remap global shortcuts, Vim bindings, and view navigation.',
      keywords: ['shortcuts', 'bindings', 'leader', 'vim', 'remap', 'keyboard'],
      content: (
        <div className="h-full">
          <KeymapSettings
            vimMode={vimMode}
            overrides={keymapOverrides}
            onSetBinding={(id, binding) => setKeymapBinding(id, binding)}
            onResetAll={resetAllKeymaps}
          />
        </div>
      )
    },
    {
      id: 'typography',
      title: 'Typography',
      description: 'Fonts, line height, reading width, alignment, and line numbers.',
      keywords: ['font', 'size', 'line height', 'width', 'alignment', 'numbers'],
      content: (
        <div className="space-y-6">
          <Section
            title="Fonts"
            description="Separate the app chrome, reading text, and code treatment."
          >
            <FontRow
              label="Interface font"
              description="Used for the sidebar, menus, and window chrome."
              value={interfaceFont}
              options={systemFonts}
              onChange={setInterfaceFont}
            />
            <FontRow
              label="Text font"
              description="Used for editing and reading views."
              value={textFont}
              options={systemFonts}
              onChange={setTextFont}
            />
            <FontRow
              label="Monospace font"
              description="Used for code blocks, inline code, and frontmatter."
              value={monoFont}
              options={systemFonts}
              onChange={setMonoFont}
            />
          </Section>

          <Section
            title="Layout"
            description="Tune reading density and how notes sit in the pane."
          >
            <SliderRow
              label="Font size"
              description="Editor and preview text size."
              value={editorFontSize}
              min={12}
              max={32}
              step={1}
              unit="px"
              onChange={setEditorFontSize}
            />
            <SliderRow
              label="Line height"
              description="Editor and preview line spacing."
              value={editorLineHeight}
              min={1.2}
              max={2.4}
              step={0.05}
              onChange={setEditorLineHeight}
              format={(v) => v.toFixed(2)}
            />
            <SliderRow
              label="Reading width"
              description="Maximum width for preview and split-preview content."
              value={previewMaxWidth}
              min={640}
              max={1400}
              step={20}
              unit="px"
              onChange={setPreviewMaxWidth}
            />
            <SliderRow
              label="Editor width"
              description="Caps and centers the editor column so lines do not stretch edge-to-edge on large windows."
              value={editorMaxWidth}
              min={640}
              max={1600}
              step={20}
              unit="px"
              onChange={setEditorMaxWidth}
            />
            <SegmentedRow
              label="Content alignment"
              description="Center note content within the column or left-align it to the pane edge."
              value={contentAlign}
              options={[
                { value: 'center', label: 'Center' },
                { value: 'left', label: 'Left' }
              ]}
              onChange={(next) => setContentAlign(next)}
            />
            <SegmentedRow
              label="Line numbers"
              description="Show editor gutter numbers. Relative uses Vim-style numbering with the current line shown normally."
              value={lineNumberMode}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'absolute', label: 'Absolute' },
                { value: 'relative', label: 'Relative' }
              ]}
              onChange={(next) => setLineNumberMode(next)}
            />
          </Section>
        </div>
      )
    },
    {
      id: 'vault',
      title: 'Vault',
      description: 'Current vault location and root-folder controls.',
      keywords: ['folder', 'root', 'location', 'open vault', 'change'],
      content: (
        <div className="space-y-6">
          <Section
            title="Location"
            description="ZenNotes reads markdown directly from the selected vault folder."
          >
            <div className="flex items-center justify-between gap-4 px-5 py-5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-900">
                  {workspaceMode === 'remote' ? 'Remote workspace' : 'Vault location'}
                </div>
                <div className="mt-1 truncate text-xs text-ink-500">
                  {vault?.root ?? 'No vault selected'}
                </div>
                {workspaceMode === 'remote' && remoteWorkspaceInfo?.baseUrl && (
                  <div className="mt-1 truncate text-[11px] text-ink-400">
                    Connected to {remoteWorkspaceInfo.baseUrl}
                  </div>
                )}
              </div>
              <button
                onClick={() =>
                  void (workspaceMode === 'remote'
                    ? changeRemoteWorkspaceVaultPath()
                    : openVaultPicker())
                }
                className="shrink-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
              >
                {workspaceMode === 'remote' ? 'Change Remote Vault…' : 'Change…'}
              </button>
              {workspaceMode === 'remote' && (
                <button
                  onClick={() => void disconnectRemoteWorkspace()}
                  className="shrink-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
                >
                  Return to Local Vault
                </button>
              )}
              {workspaceMode === 'remote' && (
                <button
                  onClick={() => void openVaultPicker()}
                  className="shrink-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
                >
                  Open Local Vault…
                </button>
              )}
              {appInfo.runtime === 'desktop' && getZenBridge().getCapabilities().supportsRemoteWorkspace && (
                <button
                  onClick={() => void connectRemoteWorkspace()}
                  className="shrink-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
                >
                  Quick Connect…
                </button>
              )}
            </div>
          </Section>

          {appInfo.runtime === 'desktop' && getZenBridge().getCapabilities().supportsRemoteWorkspace && (
            <Section
              title="Saved Remote Workspaces"
              description="Keep multiple ZenNotes servers and vaults ready to reconnect without re-entering URLs or tokens."
            >
              <div className="space-y-3 px-5 py-5">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-xs text-ink-500">
                    Saved connections can point at different servers or different vaults on the same server.
                  </div>
                  <button
                    type="button"
                    onClick={openCreateRemoteProfile}
                    className="shrink-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
                  >
                    New Remote…
                  </button>
                </div>
                {remoteWorkspaceProfiles.length === 0 ? (
                  <div className="rounded-xl border border-paper-300/60 bg-paper-50/60 px-4 py-4 text-sm text-ink-500">
                    No saved remote workspaces yet. Use <span className="font-medium text-ink-700">Quick Connect…</span> once and ZenNotes will remember it here.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {remoteWorkspaceProfiles.map((profile) => {
                      const isCurrent = currentRemoteProfileId === profile.id
                      return (
                        <div
                          key={profile.id}
                          className="flex items-center justify-between gap-4 rounded-xl border border-paper-300/60 bg-paper-50/70 px-4 py-4"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="truncate text-sm font-medium text-ink-900">
                                {profile.name}
                              </div>
                              {isCurrent && (
                                <span className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700">
                                  Connected
                                </span>
                              )}
                            </div>
                            <div className="mt-1 truncate text-xs text-ink-500">{profile.baseUrl}</div>
                            <div className="mt-1 truncate text-[11px] text-ink-400">
                              {profile.vaultPath ? profile.vaultPath : 'Vault picked when connecting'}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {!isCurrent && (
                              <button
                                type="button"
                                onClick={() => void connectRemoteWorkspaceProfile(profile.id)}
                                className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
                              >
                                Connect
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openEditRemoteProfile(profile)}
                              className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeRemoteProfile(profile)}
                              className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </Section>
          )}

          <Section
            title="Primary Notes"
            description="Choose whether ZenNotes treats `inbox/` as the main notes area or uses the vault root directly for Obsidian-style flat vaults."
          >
            <SegmentedRow
              label="Primary notes location"
              description="`Inbox` keeps ZenNotes' original lifecycle structure. `Vault root` surfaces top-level markdown files and folders directly."
              value={vaultSettings.primaryNotesLocation}
              options={[
                { value: 'inbox', label: 'Inbox' },
                { value: 'root', label: 'Vault root' }
              ]}
              onChange={(primaryNotesLocation) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  primaryNotesLocation
                })
              }
            />
          </Section>

          <Section
            title="Daily Notes"
            description="Create one note per day with a simple date title and keep them in a dedicated directory."
          >
            <ToggleRow
              label="Enable daily notes"
              description="Adds a dedicated daily-notes workflow without changing ordinary note creation."
              value={vaultSettings.dailyNotes.enabled}
              onChange={(enabled) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  dailyNotes: {
                    ...vaultSettings.dailyNotes,
                    enabled
                  }
                })
              }
            />
            <TextInputRow
              label="Daily notes directory"
              description="Stored inside your primary notes area. The default is `Daily Notes`."
              value={vaultSettings.dailyNotes.directory}
              placeholder={DEFAULT_DAILY_NOTES_DIRECTORY}
              onChange={(next) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  dailyNotes: {
                    ...vaultSettings.dailyNotes,
                    directory: normalizeDailyNotesDirectory(next)
                  }
                })
              }
            />
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-900">Open today's daily note</div>
                <div className="mt-1 text-xs leading-5 text-ink-500">
                  Opens today's note if it exists, otherwise creates it with a YYYY-MM-DD title.
                </div>
              </div>
              <button
                type="button"
                disabled={!vaultSettings.dailyNotes.enabled}
                onClick={() => void openTodayDailyNote()}
                className={[
                  'shrink-0 rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors',
                  vaultSettings.dailyNotes.enabled
                    ? 'border-paper-300/70 bg-paper-100/80 text-ink-800 hover:bg-paper-200'
                    : 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
                ].join(' ')}
              >
                Open today
              </button>
            </div>
          </Section>

          <Section
            title="System Folders"
            description="Customize how the built-in folders are named in the UI. This changes labels only; the internal folder ids stay `inbox`, `quick`, `archive`, and `trash`, even when primary notes live at the vault root."
          >
            <TextInputRow
              label="Inbox label"
              description="Shown in the sidebar, breadcrumbs, commands, and note actions."
              value={systemFolderLabels.inbox ?? ''}
              placeholder={DEFAULT_SYSTEM_FOLDER_LABELS.inbox}
              onChange={(next) => setSystemFolderLabel('inbox', next)}
            />
            <TextInputRow
              label="Quick Notes label"
              description="Display name for the quick-capture area."
              value={systemFolderLabels.quick ?? ''}
              placeholder={DEFAULT_SYSTEM_FOLDER_LABELS.quick}
              onChange={(next) => setSystemFolderLabel('quick', next)}
            />
            <TextInputRow
              label="Archive label"
              description="Display name for cold-storage notes."
              value={systemFolderLabels.archive ?? ''}
              placeholder={DEFAULT_SYSTEM_FOLDER_LABELS.archive}
              onChange={(next) => setSystemFolderLabel('archive', next)}
            />
            <TextInputRow
              label="Trash label"
              description="Display name for deleted-note recovery."
              value={systemFolderLabels.trash ?? ''}
              placeholder={DEFAULT_SYSTEM_FOLDER_LABELS.trash}
              onChange={(next) => setSystemFolderLabel('trash', next)}
            />
            <InlineNote>
              Current labels: {getSystemFolderLabel('quick', systemFolderLabels)}, {getSystemFolderLabel('inbox', systemFolderLabels)}, {getSystemFolderLabel('archive', systemFolderLabels)}, and {getSystemFolderLabel('trash', systemFolderLabels)}.
            </InlineNote>
          </Section>
        </div>
      )
    },
    {
      id: 'mcp',
      title: 'MCP',
      description:
        'Expose your vault to Claude Code, Claude Desktop, and Codex via the Model Context Protocol.',
      keywords: [
        'mcp',
        'claude',
        'claude code',
        'claude desktop',
        'codex',
        'anthropic',
        'openai',
        'integration',
        'agent',
        'model context protocol'
      ],
      content: <McpSettings />
    },
    {
      id: 'cli',
      title: 'CLI',
      description:
        'Install the `zen` command-line tool for terminal workflows, MCP, and launcher integrations like Raycast.',
      keywords: [
        'cli',
        'command line',
        'terminal',
        'shell',
        'zen',
        'raycast',
        'launcher',
        'script',
        'automation',
        'pipe',
        'capture',
        'developer'
      ],
      content: <CliSettings />
    },
    {
      id: 'about',
      title: 'About',
      description: 'App identity, version, updater status, and company information.',
      keywords: ['version', 'company', 'lumary', 'about', 'logo', 'updates'],
      content: (
        <Section title="ZenNotes">
          <div className="px-5 py-5">
            <div className="min-w-0 text-sm leading-6 text-ink-600">
              <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center">
                <span className="font-medium text-ink-900">ZenNotes</span>
                <span className="text-xs text-ink-500">v{appInfo.version}</span>
              </div>
              <div className="mx-auto mt-5 max-w-[44rem] rounded-2xl border border-paper-300/65 bg-paper-50/65 p-4 text-left shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-500">
                      Updates
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span
                        className={[
                          'rounded-full border px-2.5 py-1 text-[11px] font-medium',
                          updatePhaseBadgeClass(appUpdateState?.phase ?? 'idle')
                        ].join(' ')}
                      >
                        {formatUpdatePhaseLabel(appUpdateState?.phase ?? 'idle')}
                      </span>
                      {appUpdateState?.availableVersion && (
                        <span className="text-xs text-ink-500">
                          Latest: v{appUpdateState.availableVersion}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {appUpdateState?.phase === 'available' ? (
                      <button
                        onClick={triggerUpdateDownload}
                        className="rounded-xl border border-accent/30 bg-accent/10 px-3.5 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent/15"
                      >
                        Download Update
                      </button>
                    ) : appUpdateState?.phase === 'downloaded' ? (
                      <button
                        onClick={triggerUpdateInstall}
                        className="rounded-xl border border-accent/30 bg-accent/10 px-3.5 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent/15"
                      >
                        Install and Relaunch
                      </button>
                    ) : (
                      <button
                        onClick={triggerUpdateCheck}
                        disabled={
                          appUpdateState?.phase === 'checking' ||
                          appUpdateState?.phase === 'downloading'
                        }
                        className={[
                          'rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors',
                          appUpdateState?.phase === 'checking' ||
                          appUpdateState?.phase === 'downloading'
                            ? 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
                            : 'border-paper-300/70 bg-paper-100/80 text-ink-800 hover:bg-paper-200'
                        ].join(' ')}
                      >
                        Check for Updates
                      </button>
                    )}
                    <a
                      href={appInfo.homepage ?? 'https://github.com/ZenNotes/zennotes/releases/latest'}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-xs font-medium text-ink-700 transition-colors hover:bg-paper-200"
                    >
                      View Release
                    </a>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-6 text-ink-600">
                  {appUpdateState?.message ?? 'Check GitHub releases for a newer ZenNotes build.'}
                </p>
                {appUpdateState?.phase === 'downloading' && (
                  <div className="mt-3">
                    <div className="h-2 overflow-hidden rounded-full bg-paper-200/90">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-200"
                        style={{ width: `${Math.max(0, Math.min(100, appUpdateState.progressPercent ?? 0))}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                      <span>{Math.round(appUpdateState.progressPercent ?? 0)}%</span>
                      {formatBytes(appUpdateState.transferredBytes) && formatBytes(appUpdateState.totalBytes) && (
                        <span>
                          {formatBytes(appUpdateState.transferredBytes)} / {formatBytes(appUpdateState.totalBytes)}
                        </span>
                      )}
                      {formatBytes(appUpdateState.bytesPerSecond) && (
                        <span>{formatBytes(appUpdateState.bytesPerSecond)}/s</span>
                      )}
                    </div>
                  </div>
                )}
                {displayedReleaseNotes && (
                  <details className="mt-3 rounded-xl border border-paper-300/60 bg-paper-100/60 px-3 py-2.5">
                    <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.16em] text-ink-500">
                      Release notes
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-6 text-ink-600">
                      {displayedReleaseNotes}
                    </pre>
                  </details>
                )}
                <div className="mt-3 text-xs leading-5 text-ink-500">
                  In-app updates use the published GitHub release feed. For general users, that feed must be publicly reachable.
                </div>
              </div>
              <p className="mx-auto mt-2 max-w-[44rem] text-center">
                {appInfo.description}. Visit{' '}
                <a
                  href="https://lumarylabs.com"
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink-900 underline decoration-paper-400 underline-offset-2 hover:text-accent"
                >
                  lumarylabs.com
                </a>{' '}
                for company and product details.
              </p>
              <div className="mt-4 flex flex-col items-center gap-1.5 border-t border-paper-300/55 pt-4 text-center">
                <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-500">
                  Built by
                </span>
                <a
                  href="https://lumarylabs.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center justify-center px-2 py-1 transition-transform hover:-translate-y-px hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                >
                  <span
                    aria-label="Lumary Labs"
                    className="block h-12 w-[10.5rem] bg-ink-900"
                    style={{
                      WebkitMaskImage: `url(${companyLogo})`,
                      maskImage: `url(${companyLogo})`,
                      WebkitMaskRepeat: 'no-repeat',
                      maskRepeat: 'no-repeat',
                      WebkitMaskPosition: 'center',
                      maskPosition: 'center',
                      WebkitMaskSize: 'contain',
                      maskSize: 'contain'
                    }}
                  />
                </a>
              </div>
            </div>
          </div>
        </Section>
      )
    }
  ]

  const query = navQuery.trim().toLowerCase()
  const filteredCategories = query
    ? categories.filter((category) =>
        [category.title, category.description, ...category.keywords].some((value) =>
          value.toLowerCase().includes(query)
        )
      )
    : categories
  const visibleCategory =
    filteredCategories.find((category) => category.id === activeCategory) ??
    filteredCategories[0] ??
    null

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[7vh] backdrop-blur-md"
        onClick={() => setSettingsOpen(false)}
      >
        <div
          ref={ref}
          className="grid h-[min(92vh,980px)] w-[min(1120px,96vw)] grid-cols-[252px_minmax(0,1fr)] overflow-hidden rounded-[26px] border border-paper-300/70 bg-paper-100 shadow-float"
          onClick={(e) => e.stopPropagation()}
        >
        <aside className="flex min-h-0 flex-col border-r border-paper-300/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))]">
          <div className="border-b border-paper-300/55 px-4 py-4">
            <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-500">
              Settings
            </div>
            <div className="mt-3">
              <label className="relative block">
                <input
                  value={navQuery}
                  onChange={(e) => setNavQuery(e.target.value)}
                  placeholder="Search settings…"
                  className="w-full rounded-xl border border-paper-300/70 bg-paper-50/75 px-3 py-2.5 pl-9 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45"
                />
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-400">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                </span>
              </label>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <nav className="space-y-1">
              {filteredCategories.map((category) => {
                const selected = visibleCategory?.id === category.id
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setActiveCategory(category.id)}
                    className={[
                      'w-full rounded-xl px-3 py-2.5 text-left transition-colors',
                      selected
                        ? 'bg-paper-200/85 text-ink-900 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                        : 'text-ink-600 hover:bg-paper-200/45 hover:text-ink-900'
                    ].join(' ')}
                  >
                    <div className="text-sm font-medium">{category.title}</div>
                    <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-ink-500">
                      {category.description}
                    </div>
                  </button>
                )
              })}
              {filteredCategories.length === 0 && (
                <div className="rounded-xl border border-dashed border-paper-300/70 px-3 py-4 text-sm text-ink-500">
                  No settings sections match your search.
                </div>
              )}
            </nav>
          </div>

          <div className="border-t border-paper-300/55 px-4 py-3 text-[11px] leading-5 text-ink-500">
            Settings save automatically on this device.
          </div>
        </aside>

        <div className="flex min-h-0 flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-paper-300/60 px-7 py-5">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-500">
                {visibleCategory ? visibleCategory.title : 'Settings'}
              </div>
              <h2 className="mt-1 font-serif text-[28px] font-semibold leading-tight text-ink-900">
                {visibleCategory?.title ?? 'Settings'}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-500">
                {visibleCategory?.description ??
                  'Search the navigation on the left to jump to a settings section.'}
              </p>
            </div>
            <button
              onClick={() => setSettingsOpen(false)}
              className="shrink-0 rounded-xl border border-paper-300/70 bg-paper-50/80 px-4 py-2 text-sm font-medium text-ink-900 transition-colors hover:bg-paper-200"
            >
              Done
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
            {visibleCategory ? (
              visibleCategory.content
            ) : (
              <div className="flex h-full min-h-[280px] items-center justify-center rounded-[24px] border border-dashed border-paper-300/70 bg-paper-50/35 px-6 text-center text-sm leading-6 text-ink-500">
                Try a broader search term, or clear the search field to browse every settings section.
              </div>
            )}
          </div>
          </div>
        </div>
      </div>
      {editingRemoteProfile && (
        <RemoteWorkspaceProfileModal
          options={{
            title:
              editingRemoteProfile.mode === 'edit'
                ? 'Edit Remote Workspace'
                : 'New Remote Workspace',
            description:
              editingRemoteProfile.mode === 'edit'
                ? 'Update this saved server and vault connection.'
                : 'Save a ZenNotes server so you can reconnect without re-entering the details.',
            initialValue: editingRemoteProfile.value,
            hasStoredCredential: editingRemoteProfile.hasStoredCredential,
            submitLabel: editingRemoteProfile.mode === 'edit' ? 'Save Changes' : 'Save Remote'
          }}
          onSubmit={submitRemoteProfile}
          onCancel={() => setEditingRemoteProfile(null)}
        />
      )}
    </>
  )
}

function KeymapSettings({
  vimMode,
  overrides,
  onSetBinding,
  onResetAll
}: {
  vimMode: boolean
  overrides: KeymapOverrides
  onSetBinding: (id: KeymapId, binding: string | null) => void
  onResetAll: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<KeymapDefinition | null>(null)

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return getKeymapDefinitionsByGroup()
      .map((group) => {
        const items = group.items.filter((definition) => {
          if (definition.vimOnly && !vimMode && definition.id !== 'global.searchNotesNonVim') {
            // Keep Vim-only bindings visible so users can prep their layout
            // before turning Vim mode back on, but still let the filter work.
          }
          if (!q) return true
          return (
            definition.title.toLowerCase().includes(q) ||
            definition.description.toLowerCase().includes(q) ||
            getKeymapDisplay(overrides, definition.id).toLowerCase().includes(q)
          )
        })
        return items.length > 0 ? { ...group, items } : null
      })
      .filter((group): group is ReturnType<typeof getKeymapDefinitionsByGroup>[number] => !!group)
  }, [overrides, query, vimMode])

  const hasOverrides = Object.keys(overrides).length > 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col rounded-[22px] border border-paper-300/60 bg-paper-50/45 shadow-[0_14px_36px_rgba(15,23,42,0.04)]">
        <div className="sticky top-0 z-10 rounded-t-[22px] border-b border-paper-300/55 bg-paper-50/95 px-5 py-4 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink-900">Shortcut editor</div>
            <div className="mt-1 text-xs leading-5 text-ink-500">
              Record a new key or sequence for the app’s keyboard-first actions. Standard
              accessibility fallbacks like arrows, Enter, and Escape still work.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter keymaps…"
              className="w-72 rounded-xl border border-paper-300/70 bg-paper-100/80 px-4 py-2.5 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45"
            />
            <button
              type="button"
              disabled={!hasOverrides}
              onClick={onResetAll}
              className={[
                'rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors',
                hasOverrides
                  ? 'border-paper-300/70 bg-paper-100/80 text-ink-800 hover:bg-paper-200'
                  : 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
              ].join(' ')}
            >
              Reset all
            </button>
          </div>
        </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-paper-300/45">
          {groups.map((group) => (
            <div key={group.group}>
              <div className="px-5 pt-4 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-500">
                {group.label}
              </div>
              <div className="pb-4">
                {group.items.map((definition) => {
                  const current = getKeymapBinding(overrides, definition.id)
                  const custom = !!overrides[definition.id]
                  const inactive =
                    (definition.vimOnly && !vimMode) ||
                    (definition.nonVimOnly && vimMode)
                  return (
                    <div
                      key={definition.id}
                      className="flex items-center justify-between gap-4 px-5 py-4"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-sm font-medium text-ink-900">
                            {definition.title}
                          </span>
                          {inactive && (
                            <span className="rounded-full border border-paper-300/70 bg-paper-100/85 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-500">
                              {definition.vimOnly ? 'Vim only' : 'Non-Vim only'}
                            </span>
                          )}
                          {custom && (
                            <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-accent">
                              Custom
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs leading-5 text-ink-500">{definition.description}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded-xl border border-paper-300/70 bg-paper-100/85 px-3 py-1.5 text-xs font-medium text-ink-900">
                          {formatKeymapBinding(current, definition.kind)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setRecording(definition)}
                          className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
                        >
                          Change…
                        </button>
                        <button
                          type="button"
                          disabled={!custom}
                          onClick={() => onSetBinding(definition.id, null)}
                          className={[
                            'rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors',
                            custom
                              ? 'border-paper-300/70 bg-paper-100/80 text-ink-700 hover:bg-paper-200'
                              : 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
                          ].join(' ')}
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-ink-500">
              No keymaps match your filter.
            </div>
          )}
        </div>
      </div>

      {recording && (
        <KeymapRecorderModal
          definition={recording}
          currentBinding={getKeymapBinding(overrides, recording.id)}
          onClose={() => setRecording(null)}
          onSave={(binding) => {
            onSetBinding(recording.id, binding === recording.defaultBinding ? null : binding)
            setRecording(null)
          }}
        />
      )}
    </div>
  )
}

function KeymapRecorderModal({
  definition,
  currentBinding,
  onClose,
  onSave
}: {
  definition: KeymapDefinition
  currentBinding: string
  onClose: () => void
  onSave: (binding: string) => void
}): JSX.Element {
  const [binding, setBinding] = useState(currentBinding)
  const mac = isMacPlatform()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const key = event.key
      if (key === 'Backspace' || key === 'Delete') {
        event.preventDefault()
        event.stopPropagation()
        if (definition.kind === 'shortcut') {
          setBinding('')
          return
        }
        setBinding((current) => {
          const tokens = current.split(/\s+/).filter(Boolean)
          tokens.pop()
          return tokens.join(' ')
        })
        return
      }

      const next =
        definition.kind === 'shortcut'
          ? shortcutBindingFromEvent(event)
          : sequenceTokenFromEvent(event)
      if (!next) return

      event.preventDefault()
      event.stopPropagation()

      if (definition.kind === 'shortcut') {
        setBinding(next)
        return
      }

      setBinding((current) => {
        const limit = definition.maxTokens ?? 2
        const tokens = current.split(/\s+/).filter(Boolean)
        if (limit <= 1) return next
        if (tokens.length >= limit) return next
        return [...tokens, next].join(' ')
      })
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [definition])

  const display = binding
    ? formatKeymapBinding(binding, definition.kind)
    : 'Press a key…'

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 px-4 backdrop-blur-sm">
      <div className="w-[min(440px,92vw)] overflow-hidden rounded-2xl border border-paper-300/70 bg-paper-100 shadow-float">
        <div className="border-b border-paper-300/60 px-5 py-4">
          <div className="text-base font-semibold text-ink-900">{definition.title}</div>
          <div className="mt-1 text-sm text-ink-500">{definition.description}</div>
        </div>
        <div className="px-5 py-4">
          <div className="rounded-xl border border-paper-300/70 bg-paper-50/80 px-4 py-4">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-500">
              Recording
            </div>
            <div className="mt-2 text-2xl font-semibold text-ink-900">{display}</div>
            <div className="mt-2 text-xs leading-5 text-ink-500">
              {definition.kind === 'shortcut'
                ? `Press the shortcut you want. ${mac ? 'Command' : 'Ctrl'}-style chords are saved in the app’s cross-platform format.`
                : `Press the sequence you want. Backspace removes the last token, and multi-step sequences stop at ${definition.maxTokens ?? 2} key${(definition.maxTokens ?? 2) === 1 ? '' : 's'}.`}
            </div>
          </div>
          <div className="mt-3 text-xs text-ink-500">
            Current: {formatKeymapBinding(currentBinding, definition.kind)}
          </div>
          <div className="mt-1 text-xs text-ink-500">
            Default: {formatKeymapBinding(definition.defaultBinding, definition.kind)}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-paper-300/60 px-5 py-3">
          <button
            type="button"
            onClick={() => setBinding('')}
            className="rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-paper-200"
          >
            Clear
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-paper-200"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!binding}
              onClick={() => onSave(binding)}
              className={[
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                binding
                  ? 'bg-ink-900 text-paper-50 hover:bg-ink-800'
                  : 'cursor-not-allowed bg-paper-300 text-ink-500'
              ].join(' ')}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

function Section({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="space-y-3">
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-ink-500">
          {title}
        </div>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-500">{description}</p>
        )}
      </div>
      <div className="overflow-hidden rounded-[22px] border border-paper-300/60 bg-paper-50/45 shadow-[0_14px_36px_rgba(15,23,42,0.04)]">
        <div className="divide-y divide-paper-300/45">{children}</div>
      </div>
    </section>
  )
}

function InlineNote({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="px-5 py-4 text-xs leading-5 text-ink-500">{children}</div>
}

const DEFAULT_QUICK_CAPTURE_HOTKEY = 'CommandOrControl+Shift+Space'

function toElectronAccelerator(binding: string): string {
  return binding
    .split('+')
    .map((part) => (part === 'Mod' ? 'CommandOrControl' : part))
    .join('+')
}

function formatAcceleratorForDisplay(accelerator: string): string {
  if (!accelerator) return 'Disabled'
  const mac = isMacPlatform()
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'CommandOrControl' || part === 'CmdOrCtrl') return mac ? '⌘' : 'Ctrl'
      if (part === 'Command' || part === 'Cmd' || part === 'Meta') return mac ? '⌘' : 'Meta'
      if (part === 'Control' || part === 'Ctrl') return mac ? '⌃' : 'Ctrl'
      if (part === 'Alt' || part === 'Option') return mac ? '⌥' : 'Alt'
      if (part === 'Shift') return mac ? '⇧' : 'Shift'
      if (part === 'Space') return 'Space'
      return part
    })
    .join(mac ? '' : '+')
}

function QuickCaptureHotkeyRow(): JSX.Element {
  const [current, setCurrent] = useState<string>('')
  const [recording, setRecording] = useState(false)
  const [draft, setDraft] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.zen.getQuickCaptureHotkey().then((next) => setCurrent(next))
  }, [])

  // Capture the next chord while recording. We swallow the keystroke
  // rather than letting it bubble so e.g. Cmd+W doesn't close the modal
  // while the user is binding their hotkey.
  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        setDraft('')
        return
      }
      const captured = shortcutBindingFromEvent(event)
      if (!captured) return
      // Drop bindings without any modifier. globalShortcut will register
      // them but they hijack the literal key system-wide, which is rarely
      // what the user wants.
      if (!/[+]/.test(captured)) return
      setDraft(toElectronAccelerator(captured))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  const apply = async (next: string): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const result = await window.zen.setQuickCaptureHotkey(next)
      if (result.ok) {
        setCurrent(result.hotkey)
        setDraft('')
        setRecording(false)
      } else {
        setError(result.error ?? `Could not register "${next}"`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const display = draft || current
  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <div className="flex items-center justify-between gap-5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900">Quick capture hotkey</div>
          <div className="mt-1 text-xs leading-5 text-ink-500">
            System-wide shortcut to open the floating capture window. Works even when
            ZenNotes is hidden or another app is focused. Click Record, then press the
            chord; Esc cancels.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setRecording(true)
              setDraft('')
              setError(null)
            }}
            className={[
              'rounded-xl border px-3 py-1.5 text-sm tabular-nums',
              recording
                ? 'border-accent/60 bg-accent/10 text-accent'
                : 'border-paper-300/70 bg-paper-100/80 text-ink-900 hover:border-paper-300'
            ].join(' ')}
          >
            {recording
              ? draft
                ? formatAcceleratorForDisplay(draft)
                : 'Press a chord…'
              : formatAcceleratorForDisplay(display)}
          </button>
          {recording ? (
            <>
              <button
                type="button"
                disabled={!draft || saving}
                onClick={() => void apply(draft)}
                className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-sm text-ink-900 hover:border-paper-300 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setRecording(false)
                  setDraft('')
                }}
                className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-sm text-ink-900 hover:border-paper-300"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={current === '' || saving}
                onClick={() => void apply('')}
                className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-sm text-ink-900 hover:border-paper-300 disabled:opacity-50"
              >
                Disable
              </button>
              <button
                type="button"
                disabled={current === DEFAULT_QUICK_CAPTURE_HOTKEY || saving}
                onClick={() => void apply(DEFAULT_QUICK_CAPTURE_HOTKEY)}
                className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-sm text-ink-900 hover:border-paper-300 disabled:opacity-50"
              >
                Reset
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <div className="text-xs text-red-500">{error}</div>
      )}
    </div>
  )
}


function TextInputRow({
  label,
  description,
  value,
  placeholder,
  onChange
}: {
  label: string
  description?: string
  value: string
  placeholder?: string
  onChange: (next: string | null) => void
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-5 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="mt-1 text-xs leading-5 text-ink-500">{description}</div>}
      </div>
      <input
        value={value}
        onChange={(e) => {
          const next = e.target.value.trim()
          onChange(next ? next : null)
        }}
        placeholder={placeholder}
        className="w-[23rem] max-w-[50vw] rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45"
      />
    </div>
  )
}

function FontRow({
  label,
  description,
  value,
  options,
  onChange
}: {
  label: string
  description?: string
  value: string | null
  options: string[]
  onChange: (next: string | null) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(
    null
  )

  // Reset the search box whenever the popover opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      setTimeout(() => searchRef.current?.focus(), 0)
    }
  }, [open])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      const portalRoot = document.getElementById('zen-font-portal')
      if (portalRoot?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Position the popover below the button; reposition on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return
    const update = (): void => {
      const el = buttonRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setRect({ left: r.left, top: r.bottom + 4, width: Math.max(260, r.width) })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q
      ? options.filter((o) => o.toLowerCase().includes(q))
      : options
    return base.slice(0, 120)
  }, [query, options])

  // Virtual item list: entry 0 is the "Default" reset, then every filtered
  // font. A single index tracks which row is keyboard-highlighted.
  // `null` represents the default / reset row.
  const items: Array<string | null> = useMemo(() => [null, ...filtered], [filtered])

  // Clamp the active index whenever the filter narrows/widens.
  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, items.length - 1)))
  }, [items.length])

  // Scroll the keyboard-selected row into view.
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  const commit = (next: string | null): void => {
    onChange(next)
    setOpen(false)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => (i + 1 >= items.length ? items.length - 1 : i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[activeIdx]
      commit(item ?? null)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIdx(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIdx(items.length - 1)
    }
  }

  return (
    <div className="flex items-center justify-between gap-5 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="mt-1 text-xs leading-5 text-ink-500">{description}</div>}
      </div>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-[236px] shrink-0 items-center justify-between gap-2 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-left text-sm text-ink-900 transition-colors hover:bg-paper-200"
      >
        <span
          className="truncate"
          style={{ fontFamily: value ? `"${value}", ui-monospace, monospace` : undefined }}
        >
          {value ?? 'Default'}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-ink-500"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            id="zen-font-portal"
            className="fixed z-[80] flex max-h-[320px] flex-col overflow-hidden rounded-xl border border-paper-300 bg-paper-100 shadow-float"
            style={{ left: rect.left, top: rect.top, width: rect.width }}
          >
            <div className="border-b border-paper-300/60 p-2">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Search fonts…"
                className="w-full rounded-lg bg-paper-200 px-2.5 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400"
              />
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
              <button
                type="button"
                data-idx={0}
                onClick={() => commit(null)}
                onMouseMove={() => setActiveIdx(0)}
                className={[
                  'flex w-full items-center px-3 py-1.5 text-left text-sm',
                  activeIdx === 0
                    ? 'bg-paper-200 text-ink-900'
                    : value === null
                      ? 'text-ink-900'
                      : 'text-ink-700'
                ].join(' ')}
              >
                Default
              </button>
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-ink-400">
                  {options.length === 0
                    ? 'No fonts available'
                    : 'No fonts match your search'}
                </div>
              ) : (
                filtered.map((f, i) => {
                  const idx = i + 1
                  const isActive = activeIdx === idx
                  return (
                    <button
                      key={f}
                      type="button"
                      data-idx={idx}
                      onClick={() => commit(f)}
                      onMouseMove={() => setActiveIdx(idx)}
                      className={[
                        'flex w-full items-center px-3 py-1.5 text-left text-sm',
                        isActive
                          ? 'bg-paper-200 text-ink-900'
                          : value === f
                            ? 'text-ink-900'
                            : 'text-ink-800'
                      ].join(' ')}
                      style={{ fontFamily: `"${f}", ui-monospace, monospace` }}
                    >
                      {f}
                    </button>
                  )
                })
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

function SliderRow({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  format,
  onChange
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
  onChange: (next: number) => void
}): JSX.Element {
  const display = (format ? format(value) : String(value)) + (unit && !format ? unit : '')
  return (
    <div className="flex items-center justify-between gap-5 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="mt-1 text-xs leading-5 text-ink-500">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="zen-slider h-1 w-[140px] cursor-pointer appearance-none rounded-full"
        />
        <div className="min-w-[54px] text-right text-sm tabular-nums text-ink-800">
          {display}
        </div>
      </div>
    </div>
  )
}

function NumberRow({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  format,
  onChange
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
  onChange: (next: number) => void
}): JSX.Element {
  const display = (format ? format(value) : String(value)) + (unit ?? '')
  const clamp = (n: number): number => Math.min(max, Math.max(min, n))
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="text-xs text-ink-500">{description}</div>}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(clamp(+(value - step).toFixed(2)))}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-paper-300 bg-paper-50 text-ink-700 hover:bg-paper-200"
        >
          −
        </button>
        <div className="min-w-[56px] text-center text-sm tabular-nums text-ink-800">
          {display}
        </div>
        <button
          type="button"
          onClick={() => onChange(clamp(+(value + step).toFixed(2)))}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-paper-300 bg-paper-50 text-ink-700 hover:bg-paper-200"
        >
          +
        </button>
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  description,
  value,
  onChange
}: {
  label: string
  description?: string
  value: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-5 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="mt-1 text-xs leading-5 text-ink-500">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={[
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          value ? 'bg-accent' : 'bg-paper-300'
        ].join(' ')}
      >
        <span
          className={[
            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
            value ? 'translate-x-4' : 'translate-x-0.5'
          ].join(' ')}
        />
      </button>
    </label>
  )
}

function SegmentedRow<T extends string>({
  label,
  description,
  value,
  options,
  onChange
}: {
  label: string
  description?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-5 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="mt-1 text-xs leading-5 text-ink-500">{description}</div>}
      </div>
      <div className="inline-flex shrink-0 rounded-xl border border-paper-300/70 bg-paper-100/75 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={[
              'rounded-lg px-3 py-1.5 text-xs transition-colors',
              value === option.value
                ? 'bg-paper-50 text-ink-900 shadow-sm'
                : 'text-ink-600 hover:text-ink-900'
            ].join(' ')}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function CliSettings(): JSX.Element {
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.zen.cliGetStatus()
      setStatus(next)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onInstall = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.zen.cliInstall()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onUninstall = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.zen.cliUninstall()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copyToClipboard = (text: string): void => {
    window.zen.clipboardWriteText(text)
  }

  if (status == null) {
    return (
      <div className="space-y-6">
        <Section title="Command-Line Tool" description="Install the `zen` shell command for terminal-based note workflows.">
          <InlineNote>Checking install status…</InlineNote>
        </Section>
      </div>
    )
  }

  if (!status.supportedPlatform) {
    return (
      <div className="space-y-6">
        <Section title="Command-Line Tool" description="Install the `zen` shell command for terminal-based note workflows.">
          <InlineNote>{status.reason ?? 'Not supported on this platform yet.'}</InlineNote>
        </Section>
      </div>
    )
  }

  const installed = status.installedAt != null
  const ours = status.installedByThisApp
  const chip = installed
    ? ours
      ? { label: 'Installed', tone: 'ok' as const }
      : { label: 'External install', tone: 'warn' as const }
    : { label: 'Not installed', tone: 'off' as const }

  const isUnavailable = !status.available

  return (
    <div className="space-y-6">
      <Section
        title="Command-Line Tool"
        description="The `zen` CLI talks to your vault directly from any terminal — perfect for scripts, cron jobs, editor plugins, shell pipelines, MCP, and launcher integrations like Raycast. Once installed, try `zen --help` or pipe text in: `pbpaste | zen capture`."
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-ink-900">zen</span>
                <span
                  className={[
                    'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]',
                    statusChipClass(chip.tone)
                  ].join(' ')}
                >
                  {chip.label}
                </span>
              </div>
              <div className="mt-1 text-xs leading-5 text-ink-500">
                {installed && ours
                  ? `Active. Run \`zen --help\` from any terminal.`
                  : installed && !ours
                    ? `An unmanaged \`zen\` already exists at this path. Remove it before installing if you want ZenNotes to take over.`
                    : status.requiresSudo
                      ? `Symlinks ${status.defaultTarget} to ZenNotes' bundled wrapper. macOS will prompt for admin once because no user-writable directory was found on your PATH.`
                      : `Symlinks ${status.defaultTarget} to ZenNotes' bundled wrapper.`}
              </div>
              {status.reason && (
                <div className="mt-1.5 text-xs leading-5 text-amber-500">{status.reason}</div>
              )}
              {!installed && status.pathHint && (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-ink-700">
                  <div className="font-medium text-amber-600">
                    {status.defaultTarget.replace(/\/[^/]+$/, '')} is not on your PATH.
                  </div>
                  <div className="mt-1 text-ink-500">
                    After install, run this once so your shell can find <code className="font-mono">zen</code>:
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-md bg-paper-100/80 px-2 py-1 font-mono text-[11px] text-ink-900">
                      {status.pathHint}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(status.pathHint ?? '')}
                      className="shrink-0 rounded-md border border-paper-300/70 bg-paper-100/80 px-2 py-1 text-[11px] font-medium text-ink-700 hover:bg-paper-200"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {installed ? (
                <button
                  type="button"
                  onClick={() => void onUninstall()}
                  disabled={busy || (installed && !ours)}
                  className={[
                    'rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors',
                    busy || (installed && !ours)
                      ? 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
                      : 'border-paper-300/70 bg-paper-100/80 text-ink-700 hover:bg-paper-200'
                  ].join(' ')}
                >
                  {busy ? 'Working…' : 'Uninstall'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void onInstall()}
                  disabled={busy || isUnavailable}
                  className={[
                    'rounded-xl px-3.5 py-1.5 text-xs font-medium transition-colors',
                    busy || isUnavailable
                      ? 'cursor-not-allowed bg-paper-300 text-ink-500'
                      : 'bg-ink-900 text-paper-50 hover:bg-ink-800'
                  ].join(' ')}
                >
                  {busy ? 'Installing…' : 'Install'}
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 border-t border-paper-300/45 pt-2 text-[11px] text-ink-500">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-400">
              Path
            </span>
            <code className="min-w-0 flex-1 break-all rounded-md bg-paper-100/80 px-2 py-1 font-mono text-[11px] text-ink-800">
              {status.installedAt ?? status.defaultTarget}
            </code>
            <button
              type="button"
              onClick={() => copyToClipboard(status.installedAt ?? status.defaultTarget)}
              className="shrink-0 rounded-md border border-paper-300/70 bg-paper-100/80 px-2 py-1 text-[11px] font-medium text-ink-700 hover:bg-paper-200"
            >
              Copy
            </button>
          </div>
        </div>
      </Section>

      <Section
        title="Quick reference"
        description="A handful of the most useful commands. Quote paths with spaces, or pass them with `--path`. Run `zen --help` for the full list."
      >
        <div className="space-y-2 px-5 py-4 font-mono text-[12px] leading-6 text-ink-800">
          <div>zen list --tag idea</div>
          <div>zen read "inbox/Project.md"</div>
          <div>zen read --path "hellointerview/system design.md"</div>
          <div>echo "hello" | zen capture</div>
          <div>zen append daily.md --body "- talked to alice"</div>
          <div>zen search "deadline" --json | jq .</div>
          <div>zen mcp           # used by Claude Code/Desktop/Codex</div>
        </div>
      </Section>

      {error && (
        <InlineNote>
          <span className="text-ink-900">Something went wrong:</span> {error}
        </InlineNote>
      )}
    </div>
  )
}


function McpSettings(): JSX.Element {
  const [statuses, setStatuses] = useState<McpClientStatus[] | null>(null)
  const [runtime, setRuntime] = useState<McpServerRuntime | null>(null)
  const [busyId, setBusyId] = useState<McpClientId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCommand, setShowCommand] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, r] = await Promise.all([
        window.zen.mcpGetStatuses(),
        window.zen.mcpGetRuntime()
      ])
      setStatuses(s)
      setRuntime(r)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onInstall = async (id: McpClientId): Promise<void> => {
    setBusyId(id)
    try {
      await window.zen.mcpInstall(id)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const onUninstall = async (id: McpClientId): Promise<void> => {
    setBusyId(id)
    try {
      await window.zen.mcpUninstall(id)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const copy = (text: string): void => {
    window.zen.clipboardWriteText(text)
  }

  const commandPreview = runtime
    ? `${runtime.command} ${runtime.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
    : '—'
  const entryMissing = runtime !== null && runtime.entryPath == null

  const serverStatusLabel = runtime == null
    ? 'Checking\u2026'
    : entryMissing
      ? 'Not built'
      : 'Ready'
  const serverStatusTone = runtime == null
    ? 'off'
    : entryMissing
      ? 'warn'
      : 'ok'
  const serverStatusClass = statusChipClass(serverStatusTone)

  return (
    <div className="space-y-6">
      <Section
        title="Server"
        description="ZenNotes bundles a local MCP server that every client below connects to. It uses the packaged Electron binary in plain-Node mode, so no separate Node install is required."
      >
        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span
                className={[
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]',
                  serverStatusClass
                ].join(' ')}
              >
                {serverStatusLabel}
              </span>
              <span className="text-xs text-ink-500">
                {runtime == null
                  ? 'Querying runtime\u2026'
                  : entryMissing
                    ? 'Run npm run build so installers have an entry script to register.'
                    : 'Entry script compiled. Install a client below to connect it.'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowCommand((open) => !open)}
              className="rounded-lg border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
            >
              {showCommand ? 'Hide command' : 'Show command'}
            </button>
          </div>
          {showCommand && (
            <div className="mt-3 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg border border-paper-300/70 bg-paper-50/80 px-3 py-2 font-mono text-[11px] leading-5 text-ink-900">
                {commandPreview}
              </code>
              <button
                type="button"
                onClick={() => copy(commandPreview)}
                className="shrink-0 rounded-lg border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
              >
                Copy
              </button>
            </div>
          )}
        </div>
      </Section>

      <Section
        title="Integrations"
        description={"Pick the clients you want connected to this vault. Install writes a managed ZenNotes entry into that client\u2019s config; Uninstall removes just that entry."}
      >
        {statuses == null ? (
          <InlineNote>{'Checking integration status\u2026'}</InlineNote>
        ) : (
          <div className="divide-y divide-paper-300/45">
            {MCP_CLIENTS.map((descriptor) => {
              const status = statuses.find((s) => s.id === descriptor.id)
              if (!status) return null
              return (
                <McpClientRow
                  key={descriptor.id}
                  title={descriptor.label}
                  description={descriptor.description}
                  status={status}
                  busy={busyId === descriptor.id}
                  entryMissing={entryMissing}
                  onInstall={() => void onInstall(descriptor.id)}
                  onUninstall={() => void onUninstall(descriptor.id)}
                  onCopyConfigPath={() => copy(status.configPath)}
                />
              )
            })}
          </div>
        )}
        {error && (
          <InlineNote>
            <span className="text-ink-900">Something went wrong:</span> {error}
          </InlineNote>
        )}
      </Section>

      <McpInstructionsEditor />
    </div>
  )
}

function McpInstructionsEditor(): JSX.Element {
  const [payload, setPayload] = useState<McpInstructionsPayload | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.zen.mcpGetInstructions()
      setPayload(next)
      setDraft(next.current)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = payload != null && draft !== payload.current
  const matchesDefault = payload != null && draft === payload.defaultValue

  const save = async (): Promise<void> => {
    if (payload == null) return
    setSaving(true)
    try {
      // Writing the default string clears the override (null) — users
      // who hit "Reset" and then Save get the cleanest possible state.
      const next = matchesDefault ? null : draft
      const res = await window.zen.mcpSetInstructions(next)
      setPayload(res)
      setDraft(res.current)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const resetToDefault = (): void => {
    if (!payload) return
    setDraft(payload.defaultValue)
  }

  const revert = (): void => {
    if (!payload) return
    setDraft(payload.current)
  }

  return (
    <Section
      title="Instructions"
      description="The system prompt ZenNotes ships to any connected MCP client. Edit it to change how the AI writes, structures, and styles your notes. Changes take effect on the next MCP session."
    >
      <div className="space-y-3 px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-ink-500">
            <span>Prompt</span>
            {payload?.isCustom ? (
              <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-medium tracking-[0.14em] text-accent">
                Custom
              </span>
            ) : (
              <span className="rounded-full border border-paper-300/70 bg-paper-100/85 px-2 py-0.5 text-[10px] font-medium tracking-[0.14em] text-ink-500">
                Default
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resetToDefault}
              disabled={payload == null || draft === payload.defaultValue}
              className={[
                'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                payload != null && draft !== payload.defaultValue
                  ? 'border-paper-300/70 bg-paper-100/80 text-ink-800 hover:bg-paper-200'
                  : 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
              ].join(' ')}
            >
              Reset to default
            </button>
            <button
              type="button"
              onClick={revert}
              disabled={!dirty}
              className={[
                'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                dirty
                  ? 'border-paper-300/70 bg-paper-100/80 text-ink-800 hover:bg-paper-200'
                  : 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
              ].join(' ')}
            >
              Revert
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className={[
                'rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors',
                dirty && !saving
                  ? 'bg-ink-900 text-paper-50 hover:bg-ink-800'
                  : 'cursor-not-allowed bg-paper-300 text-ink-500'
              ].join(' ')}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-[360px] w-full resize-y rounded-xl border border-paper-300/70 bg-paper-50/80 px-3.5 py-3 font-mono text-[12px] leading-5 text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45"
          placeholder="Loading…"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-500">
          <span>
            Saved at:{' '}
            <code className="font-mono text-[11px] text-ink-600">
              {payload?.filePath ?? '—'}
            </code>
          </span>
          <span>
            {draft.length.toLocaleString()} chars · {draft.split(/\r?\n/).length} lines
          </span>
        </div>
        {error && (
          <InlineNote>
            <span className="text-ink-900">Something went wrong:</span> {error}
          </InlineNote>
        )}
      </div>
    </Section>
  )
}

function statusChipClass(tone: 'ok' | 'warn' | 'off'): string {
  if (tone === 'ok') return 'border-accent/25 bg-accent/10 text-accent'
  if (tone === 'warn') return 'border-amber-500/30 bg-amber-500/10 text-amber-500'
  return 'border-paper-300/70 bg-paper-100/85 text-ink-500'
}

function McpClientRow({
  title,
  description,
  status,
  busy,
  entryMissing,
  onInstall,
  onUninstall,
  onCopyConfigPath
}: {
  title: string
  description: string
  status: McpClientStatus
  busy: boolean
  entryMissing: boolean
  onInstall: () => void
  onUninstall: () => void
  onCopyConfigPath: () => void
}): JSX.Element {
  const chip = status.installed
    ? status.upToDate
      ? { label: 'Installed', tone: 'ok' as const }
      : { label: 'Needs update', tone: 'warn' as const }
    : { label: 'Not installed', tone: 'off' as const }

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-ink-900">{title}</span>
            <span
              className={[
                'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]',
                statusChipClass(chip.tone)
              ].join(' ')}
            >
              {chip.label}
            </span>
          </div>
          <div className="mt-1 text-xs leading-5 text-ink-500">{description}</div>
          {status.note && <div className="mt-1.5 text-xs leading-5 text-ink-500">{status.note}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status.installed ? (
            <>
              {!status.upToDate && (
                <button
                  type="button"
                  onClick={onInstall}
                  disabled={busy || entryMissing}
                  className={[
                    'rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors',
                    busy || entryMissing
                      ? 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
                      : 'border-accent/30 bg-accent/15 text-accent hover:bg-accent/25'
                  ].join(' ')}
                >
                  Update
                </button>
              )}
              <button
                type="button"
                onClick={onUninstall}
                disabled={busy}
                className={[
                  'rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors',
                  busy
                    ? 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
                    : 'border-paper-300/70 bg-paper-100/80 text-ink-700 hover:bg-paper-200'
                ].join(' ')}
              >
                Uninstall
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onInstall}
              disabled={busy || entryMissing}
              className={[
                'rounded-xl px-3.5 py-1.5 text-xs font-medium transition-colors',
                busy || entryMissing
                  ? 'cursor-not-allowed bg-paper-300 text-ink-500'
                  : 'bg-ink-900 text-paper-50 hover:bg-ink-800'
              ].join(' ')}
            >
              {busy ? 'Installing…' : 'Install'}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-paper-300/45 pt-2 text-[11px] text-ink-500">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-400">
          Config
        </span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-600"
          title={status.configPath}
        >
          {status.configPath}
        </code>
        <button
          type="button"
          onClick={onCopyConfigPath}
          className="shrink-0 rounded-md border border-paper-300/70 bg-paper-100/80 px-2 py-0.5 text-[10px] font-medium text-ink-700 transition-colors hover:bg-paper-200"
        >
          Copy
        </button>
      </div>
    </div>
  )
}
