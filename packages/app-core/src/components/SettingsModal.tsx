import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_DAILY_NOTE_LOCALE,
  DEFAULT_DAILY_NOTE_TITLE_PATTERN,
  DEFAULT_DAILY_NOTES_DIRECTORY,
  DEFAULT_WEEKLY_NOTE_LOCALE,
  DEFAULT_WEEKLY_NOTE_TITLE_PATTERN,
  DEFAULT_WEEKLY_NOTES_DIRECTORY
} from '@shared/ipc'
import type {
  AppUpdateState,
  CliInstallStatus,
  RaycastExtensionStatus,
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
import {
  normalizeDailyNoteLocale,
  normalizeDailyNotesDirectory,
  normalizeDailyNoteTitlePattern,
  normalizeWeeklyNoteLocale,
  normalizeWeeklyNoteTitlePattern,
  normalizeWeeklyNotesDirectory
} from '../lib/vault-layout'
import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'
import { composeTemplateFile, mergeTemplates } from '@shared/template-files'
import { TemplateEditorModal } from './TemplateEditorModal'
import type { NoteTemplate } from '@bridge-contract/templates'
import {
  getSettingsSearchResults,
  type SettingsSearchCategory
} from '../lib/settings-search'
import { useAppUpdateState } from '../lib/app-update-state'
import { getZenBridge } from '@zennotes/bridge-contract/bridge'
import companyLogo from '../assets/lumary-labs-logo.svg'
import { confirmApp } from '../lib/confirm-requests'
import { isImeComposing } from '../lib/ime'
import { RemoteWorkspaceProfileModal } from './RemoteWorkspaceProfileModal'
import { Button } from './ui/Button'

type SettingsCategoryId =
  | 'appearance'
  | 'editor'
  | 'keymaps'
  | 'typography'
  | 'vault'
  | 'templates'
  | 'mcp'
  | 'cli'
  | 'about'

type ResolvedVaultTextSearchBackend = 'builtin' | 'ripgrep' | 'fzf'

type SettingsSectionId = 'look' | 'editing' | 'vault' | 'system'

/** A focused sub-screen within a dense category (e.g. Vault → Location/Folders/Remote). */
interface SettingsSubTab {
  id: string
  title: string
  /** Search-item ids that live on this sub-tab, so search-jump can open the right one. */
  searchIds?: string[]
  content: JSX.Element
}

interface SettingsCategory extends SettingsSearchCategory<SettingsCategoryId> {
  id: SettingsCategoryId
  title: string
  description: string
  keywords: string[]
  /** A category renders either a single `content` pane or a set of `subTabs`. */
  content?: JSX.Element
  subTabs?: SettingsSubTab[]
}

/** Compact stroke icon used in the grouped settings rail. */
function NavIcon({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const SETTINGS_CATEGORY_ICONS: Record<SettingsCategoryId, JSX.Element> = {
  appearance: (
    <NavIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" />
    </NavIcon>
  ),
  typography: (
    <NavIcon>
      <path d="M4 7V5h16v2" />
      <path d="M12 5v14" />
      <path d="M9 19h6" />
    </NavIcon>
  ),
  editor: (
    <NavIcon>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </NavIcon>
  ),
  keymaps: (
    <NavIcon>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </NavIcon>
  ),
  vault: (
    <NavIcon>
      <path d="M12 3 3 7v10l9 4 9-4V7Z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </NavIcon>
  ),
  templates: (
    <NavIcon>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16M9 9v11" />
    </NavIcon>
  ),
  mcp: (
    <NavIcon>
      <path d="M9 7V4M15 7V4M8 7h8v3a4 4 0 0 1-8 0Z" />
      <path d="M12 14v6" />
    </NavIcon>
  ),
  cli: (
    <NavIcon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </NavIcon>
  ),
  about: (
    <NavIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </NavIcon>
  )
}

const SETTINGS_SECTIONS: { id: SettingsSectionId; title: string; categoryIds: SettingsCategoryId[] }[] = [
  { id: 'look', title: 'Look & feel', categoryIds: ['appearance', 'typography'] },
  { id: 'editing', title: 'Editing', categoryIds: ['editor', 'keymaps'] },
  { id: 'vault', title: 'Vault', categoryIds: ['vault', 'templates'] },
  { id: 'system', title: 'System', categoryIds: ['mcp', 'cli', 'about'] }
]

function settingsSearchTargetProps(
  settingId: string | undefined
): { 'data-settings-search-id'?: string } {
  return settingId ? { 'data-settings-search-id': settingId } : {}
}

function findSettingsSearchTarget(root: HTMLElement, targetId: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>('[data-settings-search-id]')) {
    if (element.dataset.settingsSearchId === targetId) return element
  }
  return null
}

function clearSettingsSearchHighlights(root: HTMLElement): void {
  root
    .querySelectorAll<HTMLElement>('[data-settings-search-highlight="true"]')
    .forEach((element) => {
      delete element.dataset.settingsSearchHighlight
    })
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
  const zenBridge = getZenBridge()
  const appInfo = zenBridge.getAppInfo()
  const supportsRemoteWorkspace =
    appInfo.runtime === 'desktop' && zenBridge.getCapabilities().supportsRemoteWorkspace
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const vimMode = useStore((s) => s.vimMode)
  const setVimMode = useStore((s) => s.setVimMode)
  const vimInsertEscape = useStore((s) => s.vimInsertEscape)
  const setVimInsertEscape = useStore((s) => s.setVimInsertEscape)
  const vimYankToClipboard = useStore((s) => s.vimYankToClipboard)
  const setVimYankToClipboard = useStore((s) => s.setVimYankToClipboard)
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
  const renderTablesInLivePreview = useStore((s) => s.renderTablesInLivePreview)
  const setRenderTablesInLivePreview = useStore((s) => s.setRenderTablesInLivePreview)
  const markdownSnippets = useStore((s) => s.markdownSnippets)
  const setMarkdownSnippets = useStore((s) => s.setMarkdownSnippets)
  const tabsEnabled = useStore((s) => s.tabsEnabled)
  const setTabsEnabled = useStore((s) => s.setTabsEnabled)
  const wrapTabs = useStore((s) => s.wrapTabs)
  const setWrapTabs = useStore((s) => s.setWrapTabs)
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
  const openThisWeekWeeklyNote = useStore((s) => s.openThisWeekWeeklyNote)
  const autoCalendarPanel = useStore((s) => s.autoCalendarPanel)
  const setAutoCalendarPanel = useStore((s) => s.setAutoCalendarPanel)
  const calendarWeekStart = useStore((s) => s.calendarWeekStart)
  const setCalendarWeekStart = useStore((s) => s.setCalendarWeekStart)
  const calendarShowWeekNumbers = useStore((s) => s.calendarShowWeekNumbers)
  const setCalendarShowWeekNumbers = useStore((s) => s.setCalendarShowWeekNumbers)
  const customTemplates = useStore((s) => s.customTemplates)
  const deleteCustomTemplate = useStore((s) => s.deleteCustomTemplate)
  const hideBuiltinTemplates = useStore((s) => s.hideBuiltinTemplates)
  const setHideBuiltinTemplates = useStore((s) => s.setHideBuiltinTemplates)
  const allTemplates = useMemo(
    () => mergeTemplates(hideBuiltinTemplates ? [] : BUILTIN_TEMPLATES, customTemplates),
    [customTemplates, hideBuiltinTemplates]
  )
  const supportsCustomTemplates =
    zenBridge.getCapabilities().supportsCustomTemplates && workspaceMode !== 'remote'
  const [templateEditor, setTemplateEditor] = useState<{
    initialRaw?: string
    sourcePath?: string
  } | null>(null)
  const openTemplateEditor = async (template: NoteTemplate): Promise<void> => {
    if (!template.sourcePath) return
    try {
      const raw = await window.zen.readTemplate(template.sourcePath)
      setTemplateEditor({ initialRaw: raw, sourcePath: template.sourcePath })
    } catch (err) {
      console.error('readTemplate failed', err)
    }
  }
  // Editing a built-in forks it into an editable custom file (carrying the
  // built-in's id), which then shadows the built-in everywhere.
  const editBuiltinTemplate = (template: NoteTemplate): void => {
    setTemplateEditor({
      initialRaw: composeTemplateFile({
        name: template.name,
        description: template.description,
        category: template.category,
        titleTemplate: template.titleTemplate,
        targetFolder: template.targetFolder,
        targetSubpath: template.targetSubpath,
        builtinId: template.id,
        body: template.body
      })
    })
  }
  const removeTemplate = async (template: NoteTemplate): Promise<void> => {
    if (!template.sourcePath) return
    const isOverride = !!template.builtinId
    const confirmed = await confirmApp({
      title: isOverride
        ? `Reset “${template.name}” to the built-in?`
        : `Delete template “${template.name}”?`,
      description: isOverride
        ? 'This removes your customizations and restores the built-in template.'
        : 'This removes the template file. Notes already created from it are unaffected.',
      confirmLabel: isOverride ? 'Reset' : 'Delete',
      danger: true
    })
    if (!confirmed) return
    await deleteCustomTemplate(template.sourcePath)
  }
  const toggleBuiltinTemplates = async (): Promise<void> => {
    if (hideBuiltinTemplates) {
      setHideBuiltinTemplates(false)
      return
    }
    const confirmed = await confirmApp({
      title: 'Remove all built-in templates?',
      description:
        'The shipped templates will be hidden from the picker and palette. Your custom templates are unaffected, and you can restore the built-ins anytime.',
      confirmLabel: 'Remove',
      danger: true
    })
    if (!confirmed) return
    setHideBuiltinTemplates(true)
  }
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
  const lineNumberPosition = useStore((s) => s.lineNumberPosition)
  const setLineNumberPosition = useStore((s) => s.setLineNumberPosition)
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
  const appUpdateState = useAppUpdateState()
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
      { id: 'tokyo-night', label: 'Tokyo Night' },
      { id: 'kanagawa', label: 'Kanagawa' },
      { id: 'black-metal', label: 'Black Metal' }
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
      'tokyo-night',
      'black-metal'
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
      'tokyo-night': { light: 'tokyo-night-day', dark: 'tokyo-night-storm' },
      kanagawa: { light: 'kanagawa-lotus', dark: 'kanagawa-wave' },
      'black-metal': { light: 'black-metal-day', dark: 'black-metal' }
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
  const settingsSearchHighlightTimerRef = useRef<number | null>(null)
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>('appearance')
  // Per-category active sub-tab (dense categories split their content into sub-tabs).
  const [activeSubTabByCategory, setActiveSubTabByCategory] = useState<
    Partial<Record<SettingsCategoryId, string>>
  >({})
  const [activeSearchResultId, setActiveSearchResultId] = useState<string | null>(null)
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
      // Don't close Settings on Esc while a nested editor/modal is open —
      // that would discard in-progress work (e.g. a template draft). Those
      // modals handle Esc themselves (Vim normal mode, etc.).
      if (e.key === 'Escape' && !templateEditor && !editingRemoteProfile) {
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen, templateEditor, editingRemoteProfile])

  useEffect(() => {
    return () => {
      if (settingsSearchHighlightTimerRef.current != null) {
        window.clearTimeout(settingsSearchHighlightTimerRef.current)
      }
    }
  }, [])

  const jumpToSettingsSearchTarget = useCallback((targetId: string): void => {
    if (settingsSearchHighlightTimerRef.current != null) {
      window.clearTimeout(settingsSearchHighlightTimerRef.current)
      settingsSearchHighlightTimerRef.current = null
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const root = ref.current
        if (!root) return

        const target = findSettingsSearchTarget(root, targetId)
        if (!target) return

        clearSettingsSearchHighlights(root)
        target.dataset.settingsSearchHighlight = 'true'
        target.scrollIntoView({ block: 'center', behavior: 'smooth' })

        settingsSearchHighlightTimerRef.current = window.setTimeout(() => {
          delete target.dataset.settingsSearchHighlight
          settingsSearchHighlightTimerRef.current = null
        }, 2000)
      })
    })
  }, [])

  const leaderKeyHintsTargetId = vimMode ? 'leader-key-hints' : 'vim-mode'
  const leaderHintBehaviorTargetId =
    vimMode && whichKeyHints ? 'leader-hint-behavior' : leaderKeyHintsTargetId
  const leaderHintDurationTargetId =
    vimMode && whichKeyHints && whichKeyHintMode === 'timed'
      ? 'leader-hint-duration'
      : leaderHintBehaviorTargetId

  const categories: SettingsCategory[] = [
    {
      id: 'appearance',
      title: 'Appearance',
      description: 'Theme family, mode, and chrome surface styling.',
      keywords: ['theme', 'mode', 'variant', 'dark sidebar', 'surface', 'look'],
      searchItems: [
        {
          id: 'theme-family',
          title: 'Theme family',
          description: 'Pick the visual system ZenNotes uses across the app.',
          keywords: ['theme', 'family', 'apple', 'gruvbox', 'catppuccin', 'github', 'solarized', 'nord', 'tokyo night']
        },
        {
          id: 'theme-mode',
          title: 'Theme mode',
          description: 'Choose light, dark, or automatic theme mode.',
          keywords: ['light', 'dark', 'auto', 'mode']
        },
        {
          id: 'theme-variant',
          title: 'Theme variant',
          description: 'Choose a family-specific contrast, flavor, or variant.',
          keywords: ['variant', 'contrast', 'flavor'],
          available: visibleVariants.length > 1
        },
        {
          id: 'dark-sidebar',
          title: 'Dark sidebar',
          description: 'Tint the sidebar one step darker than the canvas so the chrome reads as a separate surface.'
        },
        {
          id: 'sidebar-arrows',
          title: 'Sidebar arrows',
          description: 'Show disclosure arrows for collapsible folders and sidebar sections.',
          keywords: ['chevrons', 'disclosure']
        }
      ],
      content: (
        <div className="space-y-6">
          <Section
            title="Theme"
            description="Pick the visual system ZenNotes uses across the app."
          >
            <div className="flex flex-col gap-5 px-5 py-5">
              <div {...settingsSearchTargetProps('theme-family')}>
                <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-ink-500">
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

              <div {...settingsSearchTargetProps('theme-mode')}>
                <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-ink-500">
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
                <div {...settingsSearchTargetProps('theme-variant')}>
                  <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-ink-500">
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
              settingId="dark-sidebar"
              onChange={setDarkSidebar}
            />
            <ToggleRow
              label="Sidebar arrows"
              description="Show disclosure arrows for collapsible folders and sidebar sections."
              value={showSidebarChevrons}
              settingId="sidebar-arrows"
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
      searchItems: [
        {
          id: 'vim-mode',
          title: 'Vim mode',
          description: 'First-class Vim motions in the markdown editor.',
          keywords: ['vim', 'motions']
        },
        {
          id: 'vim-insert-escape',
          title: 'Exit insert mode with',
          description: 'Map a key sequence like jk or jj to Escape in insert mode.',
          keywords: ['vim', 'jk', 'jj', 'escape', 'insert mode', 'esc']
        },
        {
          id: 'leader-key-hints',
          title: 'Leader key hints',
          description: 'Show a which-key style guide after pressing the Leader key so the next available actions stay visible.',
          keywords: ['leader', 'which-key'],
          targetId: leaderKeyHintsTargetId
        },
        {
          id: 'leader-hint-behavior',
          title: 'Leader hint behavior',
          description: 'Timed auto-hides after a short delay. Sticky keeps the leader overlay open until you dismiss it.',
          keywords: ['leader', 'sticky', 'timed'],
          targetId: leaderHintBehaviorTargetId
        },
        {
          id: 'leader-hint-duration',
          title: 'Leader hint duration',
          description: 'How long the leader overlay stays visible, and how long the pending leader sequence remains armed.',
          keywords: ['leader', 'timeout', 'delay'],
          targetId: leaderHintDurationTargetId
        },
        {
          id: 'vault-text-search-backend',
          title: 'Vault text search backend',
          description: 'Auto prefers fzf when available, then ripgrep, and falls back to the built-in searcher.',
          keywords: ['search', 'backend', 'ripgrep', 'rg', 'fzf', 'built-in']
        },
        {
          id: 'ripgrep-binary-path',
          title: 'ripgrep binary path',
          description: 'Optional. Leave blank to use `rg` from your PATH.',
          keywords: ['search', 'rg', 'path']
        },
        {
          id: 'fzf-binary-path',
          title: 'fzf binary path',
          description: 'Optional. Leave blank to use `fzf` from your PATH.',
          keywords: ['search', 'path']
        },
        {
          id: 'live-preview',
          title: 'Live preview',
          description: 'Hide markdown syntax on lines you are not editing.',
          keywords: ['preview', 'markdown']
        },
        {
          id: 'render-tables',
          title: 'Render tables in live preview',
          description: 'Show Markdown tables as interactive widgets, or keep them as plain editable text.',
          keywords: ['table', 'tables', 'wysiwyg', 'grid', 'vim', 'plain text', 'source']
        },
        {
          id: 'markdown-snippets',
          title: 'Markdown snippets',
          description: 'Auto-close markdown delimiters as you type (** then Space, ``` then Enter).',
          keywords: ['snippets', 'auto close', 'autoclose', 'auto-pair', 'brackets', 'markdown', 'completion']
        },
        {
          id: 'note-tabs',
          title: 'Note tabs',
          description: 'Open notes in tabs and allow split-friendly tab workflows.',
          keywords: ['tabs']
        },
        {
          id: 'wrap-note-tabs',
          title: 'Wrap note tabs',
          description: 'Move overflowing tabs onto additional rows instead of horizontal scrolling.',
          keywords: ['tabs', 'wrap', 'new line', 'overflow']
        },
        {
          id: 'word-wrap',
          title: 'Word wrap',
          description: 'Wrap long lines to the editor width. Turn off to scroll horizontally instead.',
          keywords: ['wrap', 'line wrap']
        },
        {
          id: 'smooth-preview-scroll',
          title: 'Smooth preview scroll',
          description: 'Animate Ctrl+D / Ctrl+U half-page jumps in preview mode.',
          keywords: ['preview', 'scroll']
        },
        {
          id: 'pdfs-in-edit-mode',
          title: 'PDFs in edit mode',
          description: 'Compact keeps the editor focused. Full inlines the PDF viewer under your cursor.',
          keywords: ['pdf', 'embed']
        },
        {
          id: 'date-titled-quick-notes',
          title: 'Date-titled Quick Notes',
          description: 'New Quick Notes use YYYY-MM-DD instead of timestamp-style titles.',
          keywords: ['quick note', 'date', 'title']
        },
        {
          id: 'quick-note-prefix',
          title: 'Quick Note prefix',
          description: 'Used when naming new Quick Notes.',
          keywords: ['quick note', 'prefix']
        },
        {
          id: 'quick-capture-hotkey',
          title: 'Quick capture hotkey',
          description: 'System-wide shortcut to open the floating capture window.',
          keywords: ['quick capture', 'hotkey', 'shortcut']
        }
      ],
      subTabs: [
        {
          id: 'vim',
          title: 'Vim',
          searchIds: [
            'vim-mode',
            'vim-insert-escape',
            'leader-key-hints',
            'leader-hint-behavior',
            'leader-hint-duration'
          ],
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
              settingId="vim-mode"
              onChange={setVimMode}
            />
            {vimMode ? (
              <>
                <TextInputRow
                  label="Exit insert mode with"
                  description="Type this key sequence in insert mode to act as Escape, e.g. jk or jj. Leave empty to disable."
                  value={vimInsertEscape}
                  placeholder="jk"
                  settingId="vim-insert-escape"
                  onChange={(next) => setVimInsertEscape(next ?? '')}
                />
                <ToggleRow
                  label="Yank to system clipboard"
                  description="Copy yanked, deleted, and changed text to the system clipboard (like Vim's clipboard=unnamed), so y/d/c/x are available to paste in other apps."
                  value={vimYankToClipboard}
                  settingId="vim-yank-to-clipboard"
                  onChange={setVimYankToClipboard}
                />
                <ToggleRow
                  label="Leader key hints"
                  description="Show a which-key style guide after pressing the Leader key so the next available actions stay visible."
                  value={whichKeyHints}
                  settingId="leader-key-hints"
                  onChange={setWhichKeyHints}
                />
                {whichKeyHints && (
                  <>
                    <SegmentedRow
                      label="Leader hint behavior"
                      description="Timed auto-hides after a short delay. Sticky keeps the leader overlay open until you dismiss it."
                      value={whichKeyHintMode}
                      settingId="leader-hint-behavior"
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
                        settingId="leader-hint-duration"
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
        </div>
          )
        },
        {
          id: 'search',
          title: 'Search',
          searchIds: ['vault-text-search-backend', 'ripgrep-binary-path', 'fzf-binary-path'],
          content: (
        <div className="space-y-6">
          <Section
            title="Search"
            description="Choose how vault-wide text search is powered."
          >
            <SegmentedRow
              label="Vault text search backend"
              description="Auto prefers fzf when available, then ripgrep, and falls back to the built-in searcher."
              value={vaultTextSearchBackend}
              settingId="vault-text-search-backend"
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
              settingId="ripgrep-binary-path"
              onChange={(next) => setRipgrepBinaryPath(next)}
            />
            <TextInputRow
              label="fzf binary path"
              description="Optional. Leave blank to use `fzf` from your PATH."
              value={fzfBinaryPath ?? ''}
              placeholder="/custom/bin/fzf"
              settingId="fzf-binary-path"
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
        </div>
          )
        },
        {
          id: 'writing',
          title: 'Writing',
          searchIds: [
            'live-preview',
            'render-tables',
            'markdown-snippets',
            'note-tabs',
            'wrap-note-tabs',
            'word-wrap',
            'smooth-preview-scroll',
            'pdfs-in-edit-mode'
          ],
          content: (
        <div className="space-y-6">
          <Section
            title="Writing"
            description="Controls that change how notes render while you work."
          >
            <ToggleRow
              label="Live preview"
              description="Hide markdown syntax on lines you're not editing. Turn off to always see raw #, **, [[…]], and other source text."
              value={livePreview}
              settingId="live-preview"
              onChange={setLivePreview}
            />
            {livePreview && (
              <ToggleRow
                label="Render tables in live preview"
                description="Show Markdown tables as interactive widgets. Turn off to keep tables as plain markdown text, so you can edit them with the keyboard (and Vim motions) like any other line."
                value={renderTablesInLivePreview}
                settingId="render-tables"
                onChange={setRenderTablesInLivePreview}
              />
            )}
            <ToggleRow
              label="Markdown snippets"
              description="Auto-close markdown as you type: ** / __ / ~~ / ` / == / [[ / %% then Space wrap the cursor, and ``` / ~~~ / $$ then Enter expand a fenced block. In Vim mode this only applies in insert mode."
              value={markdownSnippets}
              settingId="markdown-snippets"
              onChange={setMarkdownSnippets}
            />
            <ToggleRow
              label="Note tabs"
              description="Open notes in tabs and allow split-friendly tab workflows. Turn off to keep the simpler single-note behavior."
              value={tabsEnabled}
              settingId="note-tabs"
              onChange={setTabsEnabled}
            />
            <ToggleRow
              label="Wrap note tabs"
              description="Move overflowing tabs onto additional rows instead of using a horizontal scrollbar."
              value={wrapTabs}
              settingId="wrap-note-tabs"
              onChange={setWrapTabs}
            />
            <ToggleRow
              label="Word wrap"
              description="Wrap long lines to the editor width. Turn off to scroll horizontally instead."
              value={wordWrap}
              settingId="word-wrap"
              onChange={setWordWrap}
            />
            <ToggleRow
              label="Smooth preview scroll"
              description="Animate Ctrl+D / Ctrl+U half-page jumps in preview mode. Turn off for an instant snap that keeps position predictable."
              value={previewSmoothScroll}
              settingId="smooth-preview-scroll"
              onChange={setPreviewSmoothScroll}
            />
            <SegmentedRow
              label="PDFs in edit mode"
              description="Compact keeps the editor focused. Full inlines the PDF viewer under your cursor."
              value={pdfEmbedInEditMode}
              settingId="pdfs-in-edit-mode"
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
              settingId="date-titled-quick-notes"
              onChange={setQuickNoteDateTitle}
            />
            <TextInputRow
              label="Quick Note prefix"
              description="Used when naming new Quick Notes. Leave blank for a bare timestamp or date."
              value={quickNoteTitlePrefix ?? ''}
              placeholder="Quick Note"
              settingId="quick-note-prefix"
              onChange={setQuickNoteTitlePrefix}
            />
          </Section>
        </div>
          )
        },
        {
          id: 'quick-capture',
          title: 'Quick capture',
          searchIds: ['date-titled-quick-notes', 'quick-note-prefix', 'quick-capture-hotkey'],
          content: (
        <div className="space-y-6">
          <Section
            title="Quick capture"
            description="Floating capture window for thoughts you want in the vault without leaving whatever you're doing."
          >
            <QuickCaptureHotkeyRow settingId="quick-capture-hotkey" />
          </Section>
        </div>
          )
        }
      ]
    },
    {
      id: 'keymaps',
      title: 'Keymap',
      description: 'Remap global shortcuts, Vim bindings, and view navigation.',
      keywords: ['shortcuts', 'bindings', 'leader', 'vim', 'remap', 'keyboard'],
      searchItems: [
        {
          id: 'shortcut-editor',
          title: 'Shortcut editor',
          description: 'Record a new key or sequence for the app’s keyboard-first actions.',
          keywords: ['shortcuts', 'bindings', 'leader', 'vim', 'remap', 'keyboard']
        }
      ],
      content: (
        <div className="h-full" {...settingsSearchTargetProps('shortcut-editor')}>
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
      searchItems: [
        {
          id: 'interface-font',
          title: 'Interface font',
          description: 'Used for the sidebar, menus, and window chrome.',
          keywords: ['font']
        },
        {
          id: 'text-font',
          title: 'Text font',
          description: 'Used for editing and reading views.',
          keywords: ['font']
        },
        {
          id: 'monospace-font',
          title: 'Monospace font',
          description: 'Used for code blocks, inline code, and frontmatter.',
          keywords: ['font', 'mono', 'code']
        },
        {
          id: 'font-size',
          title: 'Font size',
          description: 'Editor and preview text size.',
          keywords: ['size']
        },
        {
          id: 'line-height',
          title: 'Line height',
          description: 'Editor and preview line spacing.',
          keywords: ['spacing']
        },
        {
          id: 'reading-width',
          title: 'Reading width',
          description: 'Maximum width for preview and split-preview content.',
          keywords: ['width', 'preview']
        },
        {
          id: 'editor-width',
          title: 'Editor width',
          description: 'Caps and centers the editor column so lines do not stretch edge-to-edge on large windows.',
          keywords: ['width']
        },
        {
          id: 'content-alignment',
          title: 'Content alignment',
          description: 'Center note content within the column or left-align it to the pane edge.',
          keywords: ['alignment', 'center', 'left']
        },
        {
          id: 'line-numbers',
          title: 'Line numbers',
          description: 'Show editor gutter numbers.',
          keywords: ['numbers', 'gutter', 'relative', 'absolute']
        },
        {
          id: 'line-number-position',
          title: 'Line number position',
          description: 'Place the line-number gutter next to the text or at the editor edge.',
          keywords: ['numbers', 'gutter', 'position', 'edge', 'text', 'align']
        }
      ],
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
              settingId="interface-font"
              onChange={setInterfaceFont}
            />
            <FontRow
              label="Text font"
              description="Used for editing and reading views."
              value={textFont}
              options={systemFonts}
              settingId="text-font"
              onChange={setTextFont}
            />
            <FontRow
              label="Monospace font"
              description="Used for code blocks, inline code, and frontmatter."
              value={monoFont}
              options={systemFonts}
              settingId="monospace-font"
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
              settingId="font-size"
              onChange={setEditorFontSize}
            />
            <SliderRow
              label="Line height"
              description="Editor and preview line spacing."
              value={editorLineHeight}
              min={1.2}
              max={2.4}
              step={0.05}
              settingId="line-height"
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
              settingId="reading-width"
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
              settingId="editor-width"
              onChange={setEditorMaxWidth}
            />
            <SegmentedRow
              label="Content alignment"
              description="Center note content within the column or left-align it to the pane edge."
              value={contentAlign}
              settingId="content-alignment"
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
              settingId="line-numbers"
              options={[
                { value: 'off', label: 'Off' },
                { value: 'absolute', label: 'Absolute' },
                { value: 'relative', label: 'Relative' }
              ]}
              onChange={(next) => setLineNumberMode(next)}
            />
            {lineNumberMode !== 'off' && (
              <SegmentedRow
                label="Line number position"
                description="With centered content, keep the numbers next to the text column or pin them to the editor's left edge."
                value={lineNumberPosition}
                settingId="line-number-position"
                options={[
                  { value: 'text', label: 'Next to text' },
                  { value: 'edge', label: 'Editor edge' }
                ]}
                onChange={(next) => setLineNumberPosition(next)}
              />
            )}
          </Section>
        </div>
      )
    },
    {
      id: 'vault',
      title: 'Vault',
      description: 'Current vault location and root-folder controls.',
      keywords: ['folder', 'root', 'location', 'open vault', 'change'],
      searchItems: [
        {
          id: 'vault-location',
          title: 'Vault location',
          description: 'ZenNotes reads markdown directly from the selected vault folder.',
          keywords: ['folder', 'root', 'location', 'open vault', 'change']
        },
        {
          id: 'saved-remote-workspaces',
          title: 'Saved Remote Workspaces',
          description: 'Keep multiple ZenNotes servers and vaults ready to reconnect.',
          keywords: ['remote', 'server', 'workspace', 'connect'],
          available: supportsRemoteWorkspace
        },
        {
          id: 'primary-notes-location',
          title: 'Primary notes location',
          description: 'Choose whether ZenNotes treats `inbox/` as the main notes area or uses the vault root directly.',
          keywords: ['primary notes', 'inbox', 'vault root']
        },
        {
          id: 'enable-daily-notes',
          title: 'Enable daily notes',
          description: 'Adds a dedicated daily-notes workflow without changing ordinary note creation.',
          keywords: ['daily notes']
        },
        {
          id: 'daily-notes-directory',
          title: 'Daily notes directory pattern',
          description: 'Stored inside your primary notes area.',
          keywords: ['daily notes', 'directory', 'folder', 'pattern', 'date']
        },
        {
          id: 'daily-note-title-pattern',
          title: 'Daily note naming pattern',
          description: 'Used as the daily note title and filename.',
          keywords: ['daily notes', 'title', 'filename', 'pattern', 'date']
        },
        {
          id: 'daily-note-locale',
          title: 'Daily note locale',
          description: 'Used for localized month and weekday names in daily note patterns.',
          keywords: ['daily notes', 'locale', 'month', 'weekday', 'pattern']
        },
        {
          id: 'daily-note-pattern-support',
          title: 'Supported date note pattern tokens',
          description: 'Reference for supported date tokens, quoted literals, and example outputs.',
          keywords: ['daily notes', 'weekly notes', 'pattern', 'tokens', 'format', 'yyyy', 'mmm', 'weekday', 'week']
        },
        {
          id: 'daily-note-pattern-reset',
          title: 'Reset daily note patterns to defaults',
          description: 'Restore the daily directory, naming, and locale patterns to their defaults.',
          keywords: ['daily notes', 'reset', 'default', 'defaults', 'restore', 'pattern']
        },
        {
          id: 'open-todays-daily-note',
          title: "Open today's daily note",
          description: "Opens today's note if it exists, otherwise creates it.",
          keywords: ['daily notes', 'today']
        },
        {
          id: 'daily-notes-template',
          title: 'Daily note template',
          description: 'Template applied when a daily note is created.',
          keywords: ['daily notes', 'template']
        },
        {
          id: 'enable-weekly-notes',
          title: 'Enable weekly notes',
          description: 'Adds a dedicated weekly-notes workflow alongside daily notes.',
          keywords: ['weekly notes']
        },
        {
          id: 'weekly-notes-directory',
          title: 'Weekly notes directory pattern',
          description: 'Stored inside your primary notes area.',
          keywords: ['weekly notes', 'directory', 'folder', 'pattern', 'date', 'week']
        },
        {
          id: 'weekly-note-title-pattern',
          title: 'Weekly note naming pattern',
          description: 'Used as the weekly note title and filename.',
          keywords: ['weekly notes', 'title', 'filename', 'pattern', 'date', 'week']
        },
        {
          id: 'weekly-note-locale',
          title: 'Weekly note locale',
          description: 'Used for localized month and weekday names in weekly note patterns.',
          keywords: ['weekly notes', 'locale', 'month', 'weekday', 'pattern']
        },
        {
          id: 'weekly-note-pattern-support',
          title: 'Supported date note pattern tokens',
          description: 'Reference for supported date tokens, ISO week tokens, quoted literals, and example outputs.',
          keywords: ['weekly notes', 'pattern', 'tokens', 'format', 'yyyy', 'ww', 'iso week']
        },
        {
          id: 'weekly-note-pattern-reset',
          title: 'Reset weekly note patterns to defaults',
          description: 'Restore the weekly directory, naming, and locale patterns to their defaults.',
          keywords: ['weekly notes', 'reset', 'default', 'defaults', 'restore', 'pattern']
        },
        {
          id: 'weekly-notes-template',
          title: 'Weekly note template',
          description: 'Template applied when a weekly note is created.',
          keywords: ['weekly notes', 'template']
        },
        {
          id: 'open-this-week-note',
          title: "Open this week's note",
          description: "Opens this week's note if it exists, otherwise creates it.",
          keywords: ['weekly notes', 'this week']
        },
        {
          id: 'auto-calendar-panel',
          title: 'Show calendar in daily & weekly notes',
          description: 'Auto-open a calendar panel on the right while viewing a daily or weekly note.',
          keywords: ['calendar', 'daily notes', 'weekly notes', 'date', 'navigate']
        },
        {
          id: 'calendar-week-start',
          title: 'Calendar starts week on',
          description: 'Which weekday the calendar grid begins with.',
          keywords: ['calendar', 'week start', 'monday', 'sunday', 'locale']
        },
        {
          id: 'calendar-week-numbers',
          title: 'Show week numbers',
          description: 'Display the ISO week-number column in the calendar.',
          keywords: ['calendar', 'week numbers', 'iso week', 'weekly notes']
        },
        {
          id: 'inbox-label',
          title: 'Inbox label',
          description: 'Shown in the sidebar, breadcrumbs, commands, and note actions.',
          keywords: ['system folders', 'folder label']
        },
        {
          id: 'quick-notes-label',
          title: 'Quick Notes label',
          description: 'Display name for the quick-capture area.',
          keywords: ['system folders', 'folder label', 'quick']
        },
        {
          id: 'archive-label',
          title: 'Archive label',
          description: 'Display name for cold-storage notes.',
          keywords: ['system folders', 'folder label']
        },
        {
          id: 'trash-label',
          title: 'Trash label',
          description: 'Display name for deleted-note recovery.',
          keywords: ['system folders', 'folder label']
        },
        {
          id: 'tasks-label',
          title: 'Tasks label',
          description: 'Display name for the vault-wide Tasks view.',
          keywords: ['system folders', 'tasks', 'todos', 'goals', 'rename']
        }
      ],
      subTabs: [
        {
          id: 'location',
          title: 'Location',
          searchIds: ['vault-location', 'saved-remote-workspaces'],
          content: (
        <div className="space-y-6">
          <Section
            title="Location"
            description="ZenNotes reads markdown directly from the selected vault folder."
          >
            <div
              className="flex items-center justify-between gap-4 px-5 py-5"
              {...settingsSearchTargetProps('vault-location')}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-900">
                  {workspaceMode === 'remote' ? 'Remote workspace' : 'Vault location'}
                </div>
                <div className="mt-1 truncate text-xs text-ink-500">
                  {vault?.root ?? 'No vault selected'}
                </div>
                {workspaceMode === 'remote' && remoteWorkspaceInfo?.baseUrl && (
                  <div className="mt-1 truncate text-xs text-ink-400">
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
              {supportsRemoteWorkspace && (
                <button
                  onClick={() => void connectRemoteWorkspace()}
                  className="shrink-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-xs font-medium text-ink-800 transition-colors hover:bg-paper-200"
                >
                  Quick Connect…
                </button>
              )}
            </div>
          </Section>

          {supportsRemoteWorkspace && (
            <Section
              title="Saved Remote Workspaces"
              description="Keep multiple ZenNotes servers and vaults ready to reconnect without re-entering URLs or tokens."
              settingId="saved-remote-workspaces"
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
                                <span className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700">
                                  Connected
                                </span>
                              )}
                            </div>
                            <div className="mt-1 truncate text-xs text-ink-500">{profile.baseUrl}</div>
                            <div className="mt-1 truncate text-xs text-ink-400">
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
        </div>
          )
        },
        {
          id: 'notes',
          title: 'Notes',
          searchIds: [
            'primary-notes-location',
            'enable-daily-notes',
            'daily-notes-directory',
            'daily-note-title-pattern',
            'daily-note-locale',
            'daily-note-pattern-support',
            'daily-note-pattern-reset',
            'open-todays-daily-note',
            'daily-notes-template',
            'enable-weekly-notes',
            'weekly-notes-directory',
            'weekly-note-title-pattern',
            'weekly-note-locale',
            'weekly-note-pattern-support',
            'weekly-note-pattern-reset',
            'weekly-notes-template',
            'open-this-week-note',
            'auto-calendar-panel',
            'calendar-week-start',
            'calendar-week-numbers'
          ],
          content: (
        <div className="space-y-6">
          <Section
            title="Primary Notes"
            description="Choose whether ZenNotes treats `inbox/` as the main notes area or uses the vault root directly for Obsidian-style flat vaults."
          >
            <SegmentedRow
              label="Primary notes location"
              description="`Inbox` keeps ZenNotes' original lifecycle structure. `Vault root` surfaces top-level markdown files and folders directly."
              value={vaultSettings.primaryNotesLocation}
              settingId="primary-notes-location"
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
              settingId="enable-daily-notes"
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
              label="Daily notes directory pattern"
              description="Stored inside your primary notes area. The default is `Daily Notes`."
              value={vaultSettings.dailyNotes.directory}
              placeholder={DEFAULT_DAILY_NOTES_DIRECTORY}
              settingId="daily-notes-directory"
              commitOnBlur
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
            <TextInputRow
              label="Daily note naming pattern"
              description="Used as the daily note title and filename. The default is `yyyy-MM-dd`."
              value={vaultSettings.dailyNotes.titlePattern ?? DEFAULT_DAILY_NOTE_TITLE_PATTERN}
              placeholder={DEFAULT_DAILY_NOTE_TITLE_PATTERN}
              settingId="daily-note-title-pattern"
              commitOnBlur
              onChange={(next) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  dailyNotes: {
                    ...vaultSettings.dailyNotes,
                    titlePattern: normalizeDailyNoteTitlePattern(next)
                  }
                })
              }
            />
            <TextInputRow
              label="Daily note locale"
              description="Used for localized month and weekday names. Use `system`, `en-US`, or `pt-BR`."
              value={vaultSettings.dailyNotes.locale ?? DEFAULT_DAILY_NOTE_LOCALE}
              placeholder={DEFAULT_DAILY_NOTE_LOCALE}
              settingId="daily-note-locale"
              commitOnBlur
              onChange={(next) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  dailyNotes: {
                    ...vaultSettings.dailyNotes,
                    locale: normalizeDailyNoteLocale(next)
                  }
                })
              }
            />
            <DateNotePatternResetRow
              kind="daily"
              settingId="daily-note-pattern-reset"
              isDefault={
                vaultSettings.dailyNotes.directory === DEFAULT_DAILY_NOTES_DIRECTORY &&
                (vaultSettings.dailyNotes.titlePattern ?? DEFAULT_DAILY_NOTE_TITLE_PATTERN) ===
                  DEFAULT_DAILY_NOTE_TITLE_PATTERN &&
                (vaultSettings.dailyNotes.locale ?? DEFAULT_DAILY_NOTE_LOCALE) ===
                  DEFAULT_DAILY_NOTE_LOCALE
              }
              onReset={() =>
                void persistVaultSettings({
                  ...vaultSettings,
                  dailyNotes: {
                    ...vaultSettings.dailyNotes,
                    directory: DEFAULT_DAILY_NOTES_DIRECTORY,
                    titlePattern: DEFAULT_DAILY_NOTE_TITLE_PATTERN,
                    locale: DEFAULT_DAILY_NOTE_LOCALE
                  }
                })
              }
            />
            <DateNotePatternSupportRow kind="daily" settingId="daily-note-pattern-support" />
            <TemplateSelectRow
              label="Daily note template"
              description="Applied when a daily note is created. None creates a blank note."
              value={vaultSettings.dailyNotes.templateId}
              templates={allTemplates}
              settingId="daily-notes-template"
              onChange={(templateId) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  dailyNotes: { ...vaultSettings.dailyNotes, templateId }
                })
              }
            />
            <ToggleRow
              label="Tasks are due on the note's date"
              description="A task written inside a daily note appears on the calendar for that day automatically — no need to type a due date. An explicit `due:YYYY-MM-DD` still wins."
              value={vaultSettings.dailyNotes.tasksDueOnNoteDate !== false}
              settingId="daily-notes-tasks-due-on-date"
              onChange={(on) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  dailyNotes: { ...vaultSettings.dailyNotes, tasksDueOnNoteDate: on }
                })
              }
            />
            <ToggleRow
              label="Roll over unfinished tasks to today"
              description="When today's daily note opens, move every unchecked task from previous daily notes into it. Checked tasks stay where they are."
              value={vaultSettings.dailyNotes.rolloverUnfinishedTasks === true}
              settingId="daily-notes-rollover"
              onChange={(on) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  dailyNotes: { ...vaultSettings.dailyNotes, rolloverUnfinishedTasks: on }
                })
              }
            />
            <div
              className="flex items-center justify-between gap-4 px-5 py-4"
              {...settingsSearchTargetProps('open-todays-daily-note')}
            >
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
            title="Weekly Notes"
            description="Create one note per ISO week with a configurable title and keep it in a dedicated directory."
          >
            <ToggleRow
              label="Enable weekly notes"
              description="Adds a dedicated weekly-notes workflow alongside daily notes."
              value={vaultSettings.weeklyNotes.enabled}
              settingId="enable-weekly-notes"
              onChange={(enabled) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  weeklyNotes: {
                    ...vaultSettings.weeklyNotes,
                    enabled
                  }
                })
              }
            />
            <TextInputRow
              label="Weekly notes directory pattern"
              description="Stored inside your primary notes area. The default is `Weekly Notes`."
              value={vaultSettings.weeklyNotes.directory}
              placeholder={DEFAULT_WEEKLY_NOTES_DIRECTORY}
              settingId="weekly-notes-directory"
              commitOnBlur
              onChange={(next) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  weeklyNotes: {
                    ...vaultSettings.weeklyNotes,
                    directory: normalizeWeeklyNotesDirectory(next)
                  }
                })
              }
            />
            <TextInputRow
              label="Weekly note naming pattern"
              description="Used as the weekly note title and filename. The default is `yyyy-'W'ww`."
              value={vaultSettings.weeklyNotes.titlePattern ?? DEFAULT_WEEKLY_NOTE_TITLE_PATTERN}
              placeholder={DEFAULT_WEEKLY_NOTE_TITLE_PATTERN}
              settingId="weekly-note-title-pattern"
              commitOnBlur
              onChange={(next) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  weeklyNotes: {
                    ...vaultSettings.weeklyNotes,
                    titlePattern: normalizeWeeklyNoteTitlePattern(next)
                  }
                })
              }
            />
            <TextInputRow
              label="Weekly note locale"
              description="Used for localized month and weekday names. Use `system`, `en-US`, or `pt-BR`."
              value={vaultSettings.weeklyNotes.locale ?? DEFAULT_WEEKLY_NOTE_LOCALE}
              placeholder={DEFAULT_WEEKLY_NOTE_LOCALE}
              settingId="weekly-note-locale"
              commitOnBlur
              onChange={(next) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  weeklyNotes: {
                    ...vaultSettings.weeklyNotes,
                    locale: normalizeWeeklyNoteLocale(next)
                  }
                })
              }
            />
            <DateNotePatternResetRow
              kind="weekly"
              settingId="weekly-note-pattern-reset"
              isDefault={
                vaultSettings.weeklyNotes.directory === DEFAULT_WEEKLY_NOTES_DIRECTORY &&
                (vaultSettings.weeklyNotes.titlePattern ?? DEFAULT_WEEKLY_NOTE_TITLE_PATTERN) ===
                  DEFAULT_WEEKLY_NOTE_TITLE_PATTERN &&
                (vaultSettings.weeklyNotes.locale ?? DEFAULT_WEEKLY_NOTE_LOCALE) ===
                  DEFAULT_WEEKLY_NOTE_LOCALE
              }
              onReset={() =>
                void persistVaultSettings({
                  ...vaultSettings,
                  weeklyNotes: {
                    ...vaultSettings.weeklyNotes,
                    directory: DEFAULT_WEEKLY_NOTES_DIRECTORY,
                    titlePattern: DEFAULT_WEEKLY_NOTE_TITLE_PATTERN,
                    locale: DEFAULT_WEEKLY_NOTE_LOCALE
                  }
                })
              }
            />
            <DateNotePatternSupportRow kind="weekly" settingId="weekly-note-pattern-support" />
            <TemplateSelectRow
              label="Weekly note template"
              description="Applied when a weekly note is created. None creates a blank note."
              value={vaultSettings.weeklyNotes.templateId}
              templates={allTemplates}
              settingId="weekly-notes-template"
              onChange={(templateId) =>
                void persistVaultSettings({
                  ...vaultSettings,
                  weeklyNotes: { ...vaultSettings.weeklyNotes, templateId }
                })
              }
            />
            <div
              className="flex items-center justify-between gap-4 px-5 py-4"
              {...settingsSearchTargetProps('open-this-week-note')}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-900">Open this week's note</div>
                <div className="mt-1 text-xs leading-5 text-ink-500">
                  Opens this week's note if it exists, otherwise creates it with the configured weekly title pattern.
                </div>
              </div>
              <button
                type="button"
                disabled={!vaultSettings.weeklyNotes.enabled}
                onClick={() => void openThisWeekWeeklyNote()}
                className={[
                  'shrink-0 rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors',
                  vaultSettings.weeklyNotes.enabled
                    ? 'border-paper-300/70 bg-paper-100/80 text-ink-800 hover:bg-paper-200'
                    : 'cursor-not-allowed border-paper-300/60 bg-paper-100/45 text-ink-400'
                ].join(' ')}
              >
                Open this week
              </button>
            </div>
            <ToggleRow
              label="Show calendar in daily & weekly notes"
              description="Auto-open a calendar panel on the right while viewing a daily or weekly note, for jumping between dates. Toggle it anytime with the calendar icon or the leader-c shortcut."
              value={autoCalendarPanel}
              settingId="auto-calendar-panel"
              onChange={setAutoCalendarPanel}
            />
            <SegmentedRow
              label="Calendar starts week on"
              description="Which weekday the calendar grid begins with."
              value={calendarWeekStart}
              settingId="calendar-week-start"
              options={[
                { value: 'monday', label: 'Monday' },
                { value: 'sunday', label: 'Sunday' },
                { value: 'locale', label: 'Locale' }
              ]}
              onChange={setCalendarWeekStart}
            />
            <ToggleRow
              label="Show week numbers"
              description="Display the ISO week-number column in the calendar. Click a week number to open or create its weekly note."
              value={calendarShowWeekNumbers}
              settingId="calendar-week-numbers"
              onChange={setCalendarShowWeekNumbers}
            />
          </Section>
        </div>
          )
        },
        {
          id: 'system',
          title: 'System',
          searchIds: [
            'inbox-label',
            'quick-notes-label',
            'archive-label',
            'trash-label',
            'tasks-label'
          ],
          content: (
        <div className="space-y-6">
          <Section
            title="System Folders"
            description="Customize how the built-in folders and the Tasks view are named in the UI. This changes labels only — the internal folder ids stay `inbox`, `quick`, `archive`, and `trash`, even when primary notes live at the vault root."
          >
            <TextInputRow
              label="Inbox label"
              description="Shown in the sidebar, breadcrumbs, commands, and note actions."
              value={systemFolderLabels.inbox ?? ''}
              placeholder={DEFAULT_SYSTEM_FOLDER_LABELS.inbox}
              settingId="inbox-label"
              onChange={(next) => setSystemFolderLabel('inbox', next)}
            />
            <TextInputRow
              label="Quick Notes label"
              description="Display name for the quick-capture area."
              value={systemFolderLabels.quick ?? ''}
              placeholder={DEFAULT_SYSTEM_FOLDER_LABELS.quick}
              settingId="quick-notes-label"
              onChange={(next) => setSystemFolderLabel('quick', next)}
            />
            <TextInputRow
              label="Archive label"
              description="Display name for cold-storage notes."
              value={systemFolderLabels.archive ?? ''}
              placeholder={DEFAULT_SYSTEM_FOLDER_LABELS.archive}
              settingId="archive-label"
              onChange={(next) => setSystemFolderLabel('archive', next)}
            />
            <TextInputRow
              label="Trash label"
              description="Display name for deleted-note recovery."
              value={systemFolderLabels.trash ?? ''}
              placeholder={DEFAULT_SYSTEM_FOLDER_LABELS.trash}
              settingId="trash-label"
              onChange={(next) => setSystemFolderLabel('trash', next)}
            />
            <TextInputRow
              label="Tasks label"
              description="Display name for the vault-wide Tasks view — sidebar, tab, title bar, and command palette."
              value={systemFolderLabels.tasks ?? ''}
              placeholder={DEFAULT_SYSTEM_FOLDER_LABELS.tasks}
              settingId="tasks-label"
              onChange={(next) => setSystemFolderLabel('tasks', next)}
            />
            <InlineNote>
              Current labels: {getSystemFolderLabel('quick', systemFolderLabels)}, {getSystemFolderLabel('inbox', systemFolderLabels)}, {getSystemFolderLabel('archive', systemFolderLabels)}, {getSystemFolderLabel('trash', systemFolderLabels)}, and {getSystemFolderLabel('tasks', systemFolderLabels)}.
            </InlineNote>
          </Section>
        </div>
          )
        }
      ]
    },
    {
      id: 'templates',
      title: 'Templates',
      description:
        'Built-in templates plus your own. Create a note from any of them with `Space t`, `:template`, or the command palette.',
      keywords: [
        'templates',
        'template',
        'adr',
        'rfc',
        'meeting',
        'daily',
        'weekly',
        'journal',
        'custom',
        'scaffold',
        'boilerplate'
      ],
      searchItems: [
        {
          id: 'templates-list',
          title: 'Template library',
          description: 'Browse built-in templates and manage your custom ones.',
          keywords: ['templates', 'library', 'built-in', 'custom']
        },
        {
          id: 'templates-new',
          title: 'Create a custom template',
          description: 'Author a new template stored in .zennotes/templates.',
          keywords: ['template', 'new', 'create', 'custom'],
          available: supportsCustomTemplates
        }
      ],
      content: (
        <div className="space-y-6">
          <Section
            title="Templates"
            description="Pick any of these from the template picker (`Space t`, `:template`). Built-in templates are read-only; your custom ones can be edited or deleted."
            settingId="templates-list"
          >
            {supportsCustomTemplates ? (
              <div
                className="flex items-center justify-between gap-4 px-5 py-4"
                {...settingsSearchTargetProps('templates-new')}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink-900">Create a custom template</div>
                  <div className="mt-1 text-xs leading-5 text-ink-500">
                    Stored as a markdown file in `.zennotes/templates`.
                  </div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setTemplateEditor({})}
                  className="shrink-0"
                >
                  New template
                </Button>
              </div>
            ) : (
              <InlineNote>
                Custom templates require a local vault. Built-in templates still work here.
              </InlineNote>
            )}
            <div className="flex items-center justify-between gap-4 border-t border-paper-300/40 px-5 py-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-900">
                  {hideBuiltinTemplates ? 'Built-in templates are hidden' : 'Built-in templates'}
                </div>
                <div className="mt-1 text-xs leading-5 text-ink-500">
                  {hideBuiltinTemplates
                    ? 'The shipped templates are hidden from the picker and palette — your custom ones still show. Restore them anytime.'
                    : 'Hide every shipped template from the picker and palette. Your custom templates are unaffected.'}
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void toggleBuiltinTemplates()}
                className="shrink-0"
              >
                {hideBuiltinTemplates ? 'Restore built-in templates' : 'Remove built-in templates'}
              </Button>
            </div>
            {allTemplates.map((template) => (
              <div
                key={template.id}
                className="flex items-center justify-between gap-4 px-5 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink-900">{template.name}</div>
                  <div className="mt-0.5 truncate text-xs text-ink-500">
                    {template.category}
                    {template.description ? ` — ${template.description}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {template.builtin && (
                    <span className="rounded-md bg-paper-200 px-2 py-1 text-xs uppercase tracking-wide text-ink-400">
                      Built-in
                    </span>
                  )}
                  {!template.builtin && template.builtinId && (
                    <span className="rounded-md bg-paper-200 px-2 py-1 text-xs uppercase tracking-wide text-ink-400">
                      Customized
                    </span>
                  )}
                  {template.builtin
                    ? supportsCustomTemplates && (
                        <button
                          type="button"
                          onClick={() => editBuiltinTemplate(template)}
                          className="rounded-lg border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-800 hover:bg-paper-200"
                        >
                          Edit
                        </button>
                      )
                    : (
                      <>
                        <button
                          type="button"
                          onClick={() => void openTemplateEditor(template)}
                          className="rounded-lg border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-800 hover:bg-paper-200"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeTemplate(template)}
                          className="rounded-lg border border-red-500/30 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-[rgb(var(--z-red))] hover:bg-red-500/10"
                        >
                          {template.builtinId ? 'Reset' : 'Delete'}
                        </button>
                      </>
                    )}
                </div>
              </div>
            ))}
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
      searchItems: [
        {
          id: 'mcp-server',
          title: 'MCP server',
          description: 'ZenNotes bundles a local MCP server that connected clients use.',
          keywords: ['mcp', 'server', 'runtime', 'command']
        },
        {
          id: 'mcp-integrations',
          title: 'MCP integrations',
          description: 'Pick the clients you want connected to this vault.',
          keywords: ['mcp', 'claude', 'codex', 'client', 'install', 'uninstall']
        },
        {
          id: 'mcp-instructions',
          title: 'MCP instructions',
          description: 'Edit the system prompt ZenNotes ships to any connected MCP client.',
          keywords: ['mcp', 'prompt', 'instructions', 'system prompt']
        }
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
      searchItems: [
        {
          id: 'zen-command-line-tool',
          title: 'zen command-line tool',
          description: 'Install the `zen` shell command for terminal-based note workflows.',
          keywords: ['cli', 'command line', 'terminal', 'shell', 'zen', 'install', 'path']
        },
        {
          id: 'cli-quick-reference',
          title: 'CLI quick reference',
          description: 'A handful of the most useful `zen` commands.',
          keywords: ['cli', 'help', 'commands', 'reference']
        },
        {
          id: 'raycast-extension',
          title: 'Raycast Extension',
          description: 'Install the ZenNotes Raycast extension locally from this app.',
          keywords: ['raycast', 'launcher', 'extension', 'install']
        }
      ],
      content: <CliSettings />
    },
    {
      id: 'about',
      title: 'About',
      description: 'App identity, version, updater status, and company information.',
      keywords: ['version', 'company', 'lumary', 'about', 'logo', 'updates'],
      searchItems: [
        {
          id: 'zen-notes-version',
          title: 'ZenNotes version',
          description: 'App identity, current version, and product details.',
          keywords: ['about', 'version', 'identity']
        },
        {
          id: 'updates',
          title: 'Updates',
          description: 'Check GitHub releases for a newer ZenNotes build.',
          keywords: ['release', 'download', 'install', 'updater']
        },
        {
          id: 'lumary-labs',
          title: 'Lumary Labs',
          description: 'Company and product details.',
          keywords: ['company', 'lumary', 'logo']
        },
        {
          id: 'config-file',
          title: 'Configuration file',
          description: 'Locate, copy, or open the plain-text config file you sync across machines.',
          keywords: ['config', 'toml', 'dotfiles', 'sync', 'stow', 'chezmoi', 'reveal', 'settings file'],
          available: appInfo.runtime === 'desktop'
        }
      ],
      content: (
        <div className="space-y-6">
        <Section title="ZenNotes" settingId="zen-notes-version">
          <div className="px-5 py-5">
            <div className="min-w-0 text-sm leading-6 text-ink-600">
              <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center">
                <span className="font-medium text-ink-900">ZenNotes</span>
                <span className="text-xs text-ink-500">v{appInfo.version}</span>
              </div>
              <div
                className="mx-auto mt-5 max-w-[44rem] rounded-2xl border border-paper-300/65 bg-paper-50/65 p-4 text-left shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
                {...settingsSearchTargetProps('updates')}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-500">
                      Updates
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span
                        className={[
                          'rounded-full border px-2.5 py-1 text-xs font-medium',
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
              <div
                className="mt-4 flex flex-col items-center gap-1.5 border-t border-paper-300/55 pt-4 text-center"
                {...settingsSearchTargetProps('lumary-labs')}
              >
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-ink-500">
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
        {appInfo.runtime === 'desktop' && <ConfigFileSection />}
        </div>
      )
    }
  ]

  const query = navQuery.trim().toLowerCase()
  const searchResults = getSettingsSearchResults(categories, query)
  const visibleSearchResult =
    searchResults.find((result) => result.id === activeSearchResultId) ??
    searchResults.find((result) => result.category.id === activeCategory) ??
    searchResults[0] ??
    null
  const visibleCategory =
    visibleSearchResult?.category ??
    null

  return (
    <>
      <div
        className="fixed inset-0 z-modal flex items-start justify-center bg-black/45 px-4 pt-[7vh] backdrop-blur-md"
        onClick={() => setSettingsOpen(false)}
      >
        <div
          ref={ref}
          className="grid h-[min(92vh,980px)] w-[min(1120px,96vw)] grid-cols-[252px_minmax(0,1fr)] overflow-hidden rounded-3xl border border-paper-300/70 bg-paper-100 shadow-float"
          onClick={(e) => e.stopPropagation()}
        >
        <aside className="flex min-h-0 flex-col border-r border-paper-300/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))]">
          <div className="border-b border-paper-300/55 px-4 py-4">
            <div className="text-xs font-medium uppercase tracking-[0.22em] text-ink-500">
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
            {query === '' ? (
              <div className="space-y-5">
                {SETTINGS_SECTIONS.map((section) => (
                  <div key={section.id}>
                    <div className="px-3 pb-1 text-2xs font-medium uppercase tracking-[0.18em] text-ink-400">
                      {section.title}
                    </div>
                    <div className="space-y-0.5">
                      {section.categoryIds.map((id) => {
                        const cat = categories.find((c) => c.id === id)
                        if (!cat) return null
                        const selected = activeCategory === id
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => {
                              setActiveCategory(id)
                              setActiveSearchResultId(`${id}:category`)
                            }}
                            className={[
                              'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors',
                              selected
                                ? 'bg-paper-200/85 text-ink-900 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                                : 'text-ink-600 hover:bg-paper-200/45 hover:text-ink-900'
                            ].join(' ')}
                          >
                            <span className={selected ? 'text-accent' : 'text-ink-400'}>
                              {SETTINGS_CATEGORY_ICONS[id]}
                            </span>
                            <span className="truncate font-medium">{cat.title}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <nav className="space-y-1">
              {searchResults.map((result) => {
                const selected = visibleSearchResult?.id === result.id
                return (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => {
                      setActiveCategory(result.category.id)
                      setActiveSearchResultId(result.id)
                      if (result.type === 'setting') {
                        // If the target lives on a sub-tab, open that sub-tab first
                        // so the element is mounted before we scroll to it.
                        const subTabId = result.category.subTabs?.find((tab) =>
                          tab.searchIds?.includes(result.targetId)
                        )?.id
                        if (subTabId) {
                          setActiveSubTabByCategory((prev) => ({
                            ...prev,
                            [result.category.id]: subTabId
                          }))
                        }
                        jumpToSettingsSearchTarget(result.targetId)
                      }
                    }}
                    className={[
                      'w-full rounded-xl px-3 py-2.5 text-left transition-colors',
                      selected
                        ? 'bg-paper-200/85 text-ink-900 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                        : 'text-ink-600 hover:bg-paper-200/45 hover:text-ink-900'
                    ].join(' ')}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium">{result.title}</div>
                      {result.type === 'setting' && (
                        <span className="shrink-0 rounded-full border border-paper-300/60 bg-paper-100/70 px-2 py-0.5 text-2xs font-medium text-ink-500">
                          {result.category.title}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-ink-500">
                      {result.description}
                    </div>
                  </button>
                )
              })}
              {searchResults.length === 0 && (
                <div className="rounded-xl border border-dashed border-paper-300/70 px-3 py-4 text-sm text-ink-500">
                  No settings match your search.
                </div>
              )}
              </nav>
            )}
          </div>

          <div className="border-t border-paper-300/55 px-4 py-3 text-xs leading-5 text-ink-500">
            Settings save automatically on this device.
          </div>
        </aside>

        <div className="flex min-h-0 flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-paper-300/60 px-7 py-5">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.22em] text-ink-500">
                {visibleCategory ? visibleCategory.title : 'Settings'}
              </div>
              <h2 className="mt-1 font-serif text-3xl font-semibold leading-tight text-ink-900">
                {visibleCategory?.title ?? 'Settings'}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-500">
                {visibleCategory?.description ??
                  'Search the navigation on the left to jump to a settings section.'}
              </p>
            </div>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setSettingsOpen(false)}
              className="shrink-0"
            >
              Done
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
            {visibleCategory ? (
              visibleCategory.subTabs ? (
                <CategorySubTabs
                  tabs={visibleCategory.subTabs}
                  activeId={
                    activeSubTabByCategory[visibleCategory.id] ?? visibleCategory.subTabs[0].id
                  }
                  onSelect={(tabId) =>
                    setActiveSubTabByCategory((prev) => ({
                      ...prev,
                      [visibleCategory.id]: tabId
                    }))
                  }
                />
              ) : (
                visibleCategory.content
              )
            ) : (
              <div className="flex h-full min-h-[280px] items-center justify-center rounded-3xl border border-dashed border-paper-300/70 bg-paper-50/35 px-6 text-center text-sm leading-6 text-ink-500">
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
      {templateEditor && (
        <TemplateEditorModal
          initialRaw={templateEditor.initialRaw}
          sourcePath={templateEditor.sourcePath}
          onClose={() => setTemplateEditor(null)}
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
      <div className="flex min-h-0 flex-1 flex-col rounded-3xl border border-paper-300/60 bg-paper-50/45 shadow-[0_14px_36px_rgba(15,23,42,0.04)]">
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
              <div className="px-5 pt-4 text-xs font-medium uppercase tracking-[0.18em] text-ink-500">
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
                            <span className="rounded-full border border-paper-300/70 bg-paper-100/85 px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.14em] text-ink-500">
                              {definition.vimOnly ? 'Vim only' : 'Non-Vim only'}
                            </span>
                          )}
                          {custom && (
                            <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.14em] text-accent">
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
    <div className="fixed inset-0 z-toast flex items-center justify-center bg-black/35 px-4 backdrop-blur-sm">
      <div className="w-[min(440px,92vw)] overflow-hidden rounded-2xl border border-paper-300/70 bg-paper-100 shadow-float">
        <div className="border-b border-paper-300/60 px-5 py-4">
          <div className="text-base font-semibold text-ink-900">{definition.title}</div>
          <div className="mt-1 text-sm text-ink-500">{definition.description}</div>
        </div>
        <div className="px-5 py-4">
          <div className="rounded-xl border border-paper-300/70 bg-paper-50/80 px-4 py-4">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-500">
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
            <Button
              variant="primary"
              size="sm"
              disabled={!binding}
              onClick={() => onSave(binding)}
            >
              Save
            </Button>
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
  settingId,
  children
}: {
  title: string
  description?: string
  settingId?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="space-y-3" {...settingsSearchTargetProps(settingId)}>
      <div>
        <div className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500">
          {title}
        </div>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-500">{description}</p>
        )}
      </div>
      <div className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45 shadow-[0_14px_36px_rgba(15,23,42,0.04)]">
        <div className="divide-y divide-paper-300/45">{children}</div>
      </div>
    </section>
  )
}

/** Renders a dense category as focused sub-tabs (Vault → Location/Folders/Remote, …). */
function CategorySubTabs({
  tabs,
  activeId,
  onSelect
}: {
  tabs: SettingsSubTab[]
  activeId: string
  onSelect: (id: string) => void
}): JSX.Element {
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]
  return (
    <div className="space-y-6">
      <div
        role="tablist"
        className="flex flex-wrap items-center gap-1 rounded-2xl border border-paper-300/60 bg-paper-50/45 p-1"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelect(tab.id)}
              className={[
                'rounded-xl px-3.5 py-1.5 text-sm font-medium transition-colors',
                selected
                  ? 'bg-paper-200/90 text-ink-900 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                  : 'text-ink-500 hover:bg-paper-200/50 hover:text-ink-800'
              ].join(' ')}
            >
              {tab.title}
            </button>
          )
        })}
      </div>
      <div>{active.content}</div>
    </div>
  )
}

function InlineNote({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="px-5 py-4 text-xs leading-5 text-ink-500">{children}</div>
}

/** Desktop-only: surfaces the on-disk config file so users can find, copy, or
 *  open the plain-text TOML they sync across machines (issue #203). */
function ConfigFileSection(): JSX.Element {
  const [configPath, setConfigPath] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void window.zen.getConfigPath().then((p) => {
      if (active) setConfigPath(p)
    })
    return () => {
      active = false
    }
  }, [])

  const platform = window.zen.platformSync()
  const revealLabel =
    platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'File Explorer' : 'file manager'

  return (
    <Section
      title="Configuration file"
      description="Your preferences — theme, editor, vim, keymaps, and more — are mirrored to a plain-text TOML file. Sync it across machines with git, stow, or chezmoi; edit it by hand and changes apply live."
      settingId="config-file"
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void window.zen.revealConfigFile()}>
            Reveal in {revealLabel}
          </Button>
          {configPath && (
            <Button variant="ghost" onClick={() => window.zen.clipboardWriteText(configPath)}>
              Copy path
            </Button>
          )}
        </div>
        {configPath && (
          <code
            className="block truncate rounded-lg border border-paper-300/70 bg-paper-100/70 px-3 py-2 font-mono text-xs text-ink-600"
            title={configPath}
          >
            {configPath}
          </code>
        )}
      </div>
    </Section>
  )
}

const DATE_NOTE_PATTERN_TOKENS = [
  { token: 'yyyy', output: '2026', meaning: 'year; ISO week-year for weekly notes' },
  { token: 'yy', output: '26', meaning: '2-digit year' },
  { token: 'M', output: '6', meaning: 'month' },
  { token: 'MM', output: '06', meaning: 'padded month' },
  { token: 'MMM', output: 'Jun', meaning: 'short month name' },
  { token: 'MMMM', output: 'June', meaning: 'full month name' },
  { token: 'd', output: '9', meaning: 'day of month' },
  { token: 'dd', output: '09', meaning: 'padded day of month' },
  { token: 'EEE', output: 'Tue', meaning: 'short weekday name' },
  { token: 'EEEE', output: 'Tuesday', meaning: 'full weekday name' },
  { token: 'w', output: '24', meaning: 'ISO week number' },
  { token: 'ww', output: '24', meaning: 'padded ISO week number' }
]

function DateNotePatternSupportRow({
  kind,
  settingId
}: {
  kind: 'daily' | 'weekly'
  settingId?: string
}): JSX.Element {
  const example =
    kind === 'daily' ? (
      <>
        <code className="font-mono text-ink-700">yyyy/MM-MMM</code> +{' '}
        <code className="font-mono text-ink-700">yyyy-MM-dd-EEE</code> creates{' '}
        <code className="font-mono text-ink-700">2026/06-Jun/2026-06-09-Tue.md</code>.
      </>
    ) : (
      <>
        <code className="font-mono text-ink-700">yyyy/MM-MMM</code> +{' '}
        <code className="font-mono text-ink-700">yyyy-'W'ww-EEE</code> creates{' '}
        <code className="font-mono text-ink-700">2026/06-Jun/2026-W24-Mon.md</code>.
      </>
    )

  return (
    <div className="px-5 py-4" {...settingsSearchTargetProps(settingId)}>
      <div className="text-sm font-medium text-ink-900">Supported pattern tokens</div>
      <div className="mt-1 text-xs leading-5 text-ink-500">
        Directory and naming patterns support these tokens. Weekly notes render date tokens from
        the ISO week’s Monday. Wrap literal words in single quotes, for example{' '}
        <code className="font-mono text-ink-700">'Daily Notes'/yyyy/MM-MMM</code>.
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
        {DATE_NOTE_PATTERN_TOKENS.map((item) => (
          <div key={item.token} className="grid grid-cols-[5rem_4.5rem_1fr] items-baseline gap-3">
            <dt className="font-mono text-ink-900">{item.token}</dt>
            <dd className="font-mono text-ink-600">{item.output}</dd>
            <dd className="text-ink-500">{item.meaning}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 space-y-1 text-xs leading-5 text-ink-500">
        <div>
          <span className="font-medium text-ink-700">Example:</span> {example}
        </div>
        <div>
          Localized names use the note locale:{' '}
          <code className="font-mono text-ink-700">system</code>,{' '}
          <code className="font-mono text-ink-700">en-US</code>,{' '}
          <code className="font-mono text-ink-700">pt-BR</code>, or another BCP 47 locale.
        </div>
      </div>
    </div>
  )
}

function DateNotePatternResetRow({
  kind,
  isDefault,
  onReset,
  settingId
}: {
  kind: 'daily' | 'weekly'
  isDefault: boolean
  onReset: () => void
  settingId?: string
}): JSX.Element {
  const directory =
    kind === 'daily' ? DEFAULT_DAILY_NOTES_DIRECTORY : DEFAULT_WEEKLY_NOTES_DIRECTORY
  const naming =
    kind === 'daily' ? DEFAULT_DAILY_NOTE_TITLE_PATTERN : DEFAULT_WEEKLY_NOTE_TITLE_PATTERN
  const locale = kind === 'daily' ? DEFAULT_DAILY_NOTE_LOCALE : DEFAULT_WEEKLY_NOTE_LOCALE
  return (
    <div
      className="flex items-center justify-between gap-4 px-5 py-4"
      {...settingsSearchTargetProps(settingId)}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">Reset to defaults</div>
        <div className="mt-1 text-xs leading-5 text-ink-500">
          Restore the directory, naming, and locale to{' '}
          <code className="font-mono text-ink-700">{directory}</code>,{' '}
          <code className="font-mono text-ink-700">{naming}</code>, and{' '}
          <code className="font-mono text-ink-700">{locale}</code>. Notes created with the
          current pattern stay recognized.
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={isDefault}
        onClick={onReset}
        className="shrink-0"
      >
        Reset to defaults
      </Button>
    </div>
  )
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

function QuickCaptureHotkeyRow({ settingId }: { settingId?: string } = {}): JSX.Element {
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
    <div
      className="flex flex-col gap-2 px-5 py-4"
      {...settingsSearchTargetProps(settingId)}
    >
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
  settingId,
  commitOnBlur = false,
  onChange
}: {
  label: string
  description?: string
  value: string
  placeholder?: string
  settingId?: string
  commitOnBlur?: boolean
  onChange: (next: string | null) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!commitOnBlur || !focused) setDraft(value)
  }, [commitOnBlur, focused, value])

  const commit = (raw: string): void => {
    const next = raw.trim()
    if (commitOnBlur && next === value) return
    onChange(next ? next : null)
  }

  return (
    <div
      className="flex items-center justify-between gap-5 px-5 py-4"
      {...settingsSearchTargetProps(settingId)}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="mt-1 text-xs leading-5 text-ink-500">{description}</div>}
      </div>
      <input
        value={commitOnBlur ? draft : value}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          if (commitOnBlur) {
            setDraft(e.target.value)
            return
          }
          commit(e.target.value)
        }}
        onBlur={(e) => {
          if (!commitOnBlur) return
          setFocused(false)
          commit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (!commitOnBlur) return
          if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(value)
            e.currentTarget.blur()
          }
        }}
        placeholder={placeholder}
        className="w-[23rem] max-w-[50vw] shrink-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45"
      />
    </div>
  )
}

function TemplateSelectRow({
  label,
  description,
  value,
  templates,
  settingId,
  onChange
}: {
  label: string
  description?: string
  value: string | undefined
  templates: NoteTemplate[]
  settingId?: string
  onChange: (templateId: string | undefined) => void
}): JSX.Element {
  // A configured template that no longer exists (deleted) shows as missing so
  // the user can pick a replacement; daily/weekly creation falls back to blank.
  const missing = !!value && !templates.some((t) => t.id === value)
  return (
    <div
      className="flex items-center justify-between gap-5 px-5 py-4"
      {...settingsSearchTargetProps(settingId)}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="mt-1 text-xs leading-5 text-ink-500">{description}</div>}
      </div>
      <select
        value={missing ? '__missing__' : value ?? ''}
        onChange={(e) => onChange(e.target.value ? e.target.value : undefined)}
        className="w-[23rem] max-w-[50vw] rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent/45"
      >
        <option value="">None (blank note)</option>
        {missing && (
          <option value="__missing__" disabled>
            [Missing template]
          </option>
        )}
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.category} — {template.name}
          </option>
        ))}
      </select>
    </div>
  )
}

function FontRow({
  label,
  description,
  value,
  options,
  settingId,
  onChange
}: {
  label: string
  description?: string
  value: string | null
  options: string[]
  settingId?: string
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
    // While composing (IME), let the input own Enter/Arrows. (#183)
    if (isImeComposing(e)) return
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
    <div
      className="flex items-center justify-between gap-5 px-5 py-4"
      {...settingsSearchTargetProps(settingId)}
    >
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
            className="fixed z-popover flex max-h-[320px] flex-col overflow-hidden rounded-xl border border-paper-300 bg-paper-100 shadow-float"
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
  settingId,
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
  settingId?: string
  onChange: (next: number) => void
}): JSX.Element {
  const display = (format ? format(value) : String(value)) + (unit && !format ? unit : '')
  return (
    <div
      className="flex items-center justify-between gap-5 px-5 py-4"
      {...settingsSearchTargetProps(settingId)}
    >
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
  settingId,
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
  settingId?: string
  onChange: (next: number) => void
}): JSX.Element {
  const display = (format ? format(value) : String(value)) + (unit ?? '')
  const clamp = (n: number): number => Math.min(max, Math.max(min, n))
  return (
    <div
      className="flex items-center justify-between gap-4 px-6 py-3"
      {...settingsSearchTargetProps(settingId)}
    >
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
  settingId,
  onChange
}: {
  label: string
  description?: string
  value: boolean
  settingId?: string
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <label
      className="flex cursor-pointer items-center justify-between gap-5 px-5 py-4"
      {...settingsSearchTargetProps(settingId)}
    >
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
  settingId,
  onChange
}: {
  label: string
  description?: string
  value: T
  options: { value: T; label: string }[]
  settingId?: string
  onChange: (next: T) => void
}): JSX.Element {
  return (
    <div
      className="flex items-center justify-between gap-5 px-5 py-4"
      {...settingsSearchTargetProps(settingId)}
    >
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
        <Section
          title="Command-Line Tool"
          description="Install the `zen` shell command for terminal-based note workflows."
          settingId="zen-command-line-tool"
        >
          <InlineNote>Checking install status…</InlineNote>
        </Section>
      </div>
    )
  }

  if (!status.supportedPlatform) {
    return (
      <div className="space-y-6">
        <Section
          title="Command-Line Tool"
          description="Install the `zen` shell command for terminal-based note workflows."
          settingId="zen-command-line-tool"
        >
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
        settingId="zen-command-line-tool"
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-ink-900">zen</span>
                <span
                  className={[
                    'rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.14em]',
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
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-ink-700">
                  <div className="font-medium text-amber-600">
                    {status.defaultTarget.replace(/\/[^/]+$/, '')} is not on your PATH.
                  </div>
                  <div className="mt-1 text-ink-500">
                    After install, run this once so your shell can find <code className="font-mono">zen</code>:
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-md bg-paper-100/80 px-2 py-1 font-mono text-xs text-ink-900">
                      {status.pathHint}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(status.pathHint ?? '')}
                      className="shrink-0 rounded-md border border-paper-300/70 bg-paper-100/80 px-2 py-1 text-xs font-medium text-ink-700 hover:bg-paper-200"
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
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void onInstall()}
                  disabled={busy || isUnavailable}
                >
                  {busy ? 'Installing…' : 'Install'}
                </Button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 border-t border-paper-300/45 pt-2 text-xs text-ink-500">
            <span className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-400">
              Path
            </span>
            <code className="min-w-0 flex-1 break-all rounded-md bg-paper-100/80 px-2 py-1 font-mono text-xs text-ink-800">
              {status.installedAt ?? status.defaultTarget}
            </code>
            <button
              type="button"
              onClick={() => copyToClipboard(status.installedAt ?? status.defaultTarget)}
              className="shrink-0 rounded-md border border-paper-300/70 bg-paper-100/80 px-2 py-1 text-xs font-medium text-ink-700 hover:bg-paper-200"
            >
              Copy
            </button>
          </div>
        </div>
      </Section>

      <RaycastExtensionSettings
        cliInstalled={installed}
        copyToClipboard={copyToClipboard}
      />

      <Section
        title="Quick reference"
        description="A handful of the most useful commands. Quote paths with spaces, or pass them with `--path`. Run `zen --help` for the full list."
        settingId="cli-quick-reference"
      >
        <div className="space-y-2 px-5 py-4 font-mono text-xs leading-6 text-ink-800">
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

function RaycastExtensionSettings({
  cliInstalled,
  copyToClipboard
}: {
  cliInstalled: boolean
  copyToClipboard: (text: string) => void
}): JSX.Element {
  const [status, setStatus] = useState<RaycastExtensionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.zen.raycastGetStatus()
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
      const next = await window.zen.raycastInstall()
      setStatus(next)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (status == null) {
    return (
      <Section
        title="Raycast Extension"
        description="Install the ZenNotes Raycast extension locally from this app instead of waiting for the Raycast Store review."
        settingId="raycast-extension"
      >
        <InlineNote>Checking Raycast status…</InlineNote>
      </Section>
    )
  }

  const chip = raycastStatusChip(status, cliInstalled)
  const installDisabled = busy || !cliInstalled || !status.available
  const installLabel = busy
    ? 'Installing…'
    : status.installed
      ? status.upToDate
        ? 'Reinstall'
        : 'Update'
      : 'Install'
  const detail = raycastStatusDetail(status, cliInstalled)
  const toolchainDetail = [
    `Raycast ${status.raycastInstalled ? 'found' : 'missing'}`,
    `Node ${status.nodeVersion ?? 'missing'}`,
    `npm ${status.npmVersion ?? 'missing'}`
  ].join(' · ')

  return (
    <Section
      title="Raycast Extension"
      description="Install the ZenNotes Raycast extension locally from this app instead of waiting for the Raycast Store review."
      settingId="raycast-extension"
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium text-ink-900">ZenNotes for Raycast</span>
              <span
                className={[
                  'rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.14em]',
                  statusChipClass(chip.tone)
                ].join(' ')}
              >
                {chip.label}
              </span>
            </div>
            <div className="mt-1 text-xs leading-5 text-ink-500">{detail}</div>
            <div className="mt-1 text-xs leading-5 text-ink-400">{toolchainDetail}</div>
            {!cliInstalled && (
              <div className="mt-1.5 text-xs leading-5 text-amber-500">
                Install the <code className="font-mono">zen</code> CLI above first. The Raycast
                command calls it to read your local vault.
              </div>
            )}
            {cliInstalled && status.reason && (
              <div className="mt-1.5 text-xs leading-5 text-amber-500">{status.reason}</div>
            )}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void onInstall()}
            disabled={installDisabled}
            className="shrink-0"
          >
            {installLabel}
          </Button>
        </div>

        <div className="flex items-center gap-2 border-t border-paper-300/45 pt-2 text-xs text-ink-500">
          <span className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-400">
            Local copy
          </span>
          <code className="min-w-0 flex-1 break-all rounded-md bg-paper-100/80 px-2 py-1 font-mono text-xs text-ink-800">
            {status.extensionPath}
          </code>
          <button
            type="button"
            onClick={() => copyToClipboard(status.extensionPath)}
            className="shrink-0 rounded-md border border-paper-300/70 bg-paper-100/80 px-2 py-1 text-xs font-medium text-ink-700 hover:bg-paper-200"
          >
            Copy
          </button>
        </div>
      </div>

      {error && (
        <InlineNote>
          <span className="text-ink-900">Something went wrong:</span> {error}
        </InlineNote>
      )}
    </Section>
  )
}

function raycastStatusChip(
  status: RaycastExtensionStatus,
  cliInstalled: boolean
): { label: string; tone: 'ok' | 'warn' | 'off' } {
  if (!status.supportedPlatform) return { label: 'Not supported', tone: 'off' }
  if (status.installed && status.upToDate) return { label: 'Installed', tone: 'ok' }
  if (status.installed && !status.upToDate) return { label: 'Update available', tone: 'warn' }
  if (status.available && cliInstalled) return { label: 'Ready', tone: 'off' }
  return { label: 'Not ready', tone: 'off' }
}

function raycastStatusDetail(
  status: RaycastExtensionStatus,
  cliInstalled: boolean
): string {
  if (!status.supportedPlatform) {
    return status.reason ?? 'Raycast extensions are available on macOS only.'
  }
  if (status.installed && status.upToDate) {
    return 'Installed locally. Search for “Search Notes” in Raycast to use it.'
  }
  if (status.installed) {
    return `A local copy exists from ZenNotes ${status.installedVersion ?? 'an older version'}. Update it to match ${status.bundledVersion}.`
  }
  if (!cliInstalled) {
    return 'The extension can be installed after the local ZenNotes CLI is available.'
  }
  if (!status.available) {
    return status.reason ?? 'Local installation is not available yet.'
  }
  return 'Copies the bundled extension into app data, installs dependencies, builds it, and imports it into Raycast.'
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
        settingId="mcp-server"
      >
        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span
                className={[
                  'rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.14em]',
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
              <code className="min-w-0 flex-1 break-all rounded-lg border border-paper-300/70 bg-paper-50/80 px-3 py-2 font-mono text-xs leading-5 text-ink-900">
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
        settingId="mcp-integrations"
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
      settingId="mcp-instructions"
    >
      <div className="space-y-3 px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-ink-500">
            <span>Prompt</span>
            {payload?.isCustom ? (
              <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-2xs font-medium tracking-[0.14em] text-accent">
                Custom
              </span>
            ) : (
              <span className="rounded-full border border-paper-300/70 bg-paper-100/85 px-2 py-0.5 text-2xs font-medium tracking-[0.14em] text-ink-500">
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
            <Button
              variant="primary"
              size="sm"
              onClick={() => void save()}
              disabled={!dirty || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-[360px] w-full resize-y rounded-xl border border-paper-300/70 bg-paper-50/80 px-3.5 py-3 font-mono text-xs leading-5 text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45"
          placeholder="Loading…"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-500">
          <span>
            Saved at:{' '}
            <code className="font-mono text-xs text-ink-600">
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
                'rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.14em]',
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
            <Button
              variant="primary"
              size="sm"
              onClick={onInstall}
              disabled={busy || entryMissing}
            >
              {busy ? 'Installing…' : 'Install'}
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-paper-300/45 pt-2 text-xs text-ink-500">
        <span className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-400">
          Config
        </span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-xs text-ink-600"
          title={status.configPath}
        >
          {status.configPath}
        </code>
        <button
          type="button"
          onClick={onCopyConfigPath}
          className="shrink-0 rounded-md border border-paper-300/70 bg-paper-100/80 px-2 py-0.5 text-2xs font-medium text-ink-700 transition-colors hover:bg-paper-200"
        >
          Copy
        </button>
      </div>
    </div>
  )
}
