/**
 * Cmd+Shift+P command palette with nested picker modes for themes and
 * vault switching. Theme rows live-preview while vault rows switch
 * workspaces only when explicitly selected.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { buildCommands, type Command } from '../lib/commands'
import { commandLanding } from '../lib/command-landing'
import {
  loadRecentCommandIds,
  recordCommandUse,
  RECENT_COMMAND_COUNT
} from '../lib/command-history'
import { rankItems } from '../lib/fuzzy-score'
import { isPaletteNextKey, isPalettePreviousKey } from '../lib/palette-nav'
import { isImeComposing } from '../lib/ime'
import {
  canReturnToCommandList,
  shouldRefocusEditorAfterCommand
} from '../lib/command-palette-mode'
import { rankThemes, type ThemeFamily, type ThemeMode, type ThemeOption } from '../lib/themes'
import {
  buildVaultSwitcherEntries,
  newWindowVaultRows,
  type BrowseVaultSwitcherEntry,
  type VaultSwitcherEntry
} from '../lib/vault-switcher'
import { runWorkflowById } from '../lib/workflow-trigger'
import type { WorkflowIndexEntry } from '../lib/workflow-index'
import {
  focusEditorAfterPaletteClose,
  focusEditorAfterReadOpen,
  focusEditorNormalMode
} from '../lib/editor-focus'
import { useCloudSyncStatusStore } from '../lib/cloud-auto-sync'
import { getPublishNoteRequest } from '../lib/publish-note-requests'
import { Modal } from './ui/Modal'
import { KeymapRecorderModal } from './KeymapRecorder'
import { isBindableCommandId } from '../lib/command-keymaps'
import { formatKeyToken } from '../lib/keymaps'
import { useToastStore } from '../lib/toast'

type Mode = 'main' | 'theme' | 'vault' | 'workflow'

/** Picker rows: known vaults, plus the synthetic "Browse…" row (new-window mode). */
type VaultRow = VaultSwitcherEntry | BrowseVaultSwitcherEntry

interface ThemeSnapshot {
  id: string
  family: ThemeFamily
  mode: ThemeMode
}

export function CommandPalette(): JSX.Element {
  const setOpen = useStore((s) => s.setCommandPaletteOpen)
  const setTheme = useStore((s) => s.setTheme)
  const localVaults = useStore((s) => s.localVaults)
  const remoteWorkspaceProfiles = useStore((s) => s.remoteWorkspaceProfiles)
  const currentVault = useStore((s) => s.vault)
  const workspaceMode = useStore((s) => s.workspaceMode)
  const remoteWorkspaceInfo = useStore((s) => s.remoteWorkspaceInfo)
  const initialMode = useStore((s) => s.commandPaletteInitialMode)
  const workflowIndex = useStore((s) => s.workflowIndex)
  const refreshLocalVaults = useStore((s) => s.refreshLocalVaults)
  const refreshRemoteWorkspaceProfiles = useStore((s) => s.refreshRemoteWorkspaceProfiles)
  const openLocalVault = useStore((s) => s.openLocalVault)
  const connectRemoteWorkspaceProfile = useStore((s) => s.connectRemoteWorkspaceProfile)
  const supportsRemoteWorkspace =
    window.zen.getAppInfo().runtime === 'desktop' &&
    window.zen.getCapabilities().supportsRemoteWorkspace

  const [mode, setMode] = useState<Mode>(initialMode)
  // Whether the vault picker switches the current window or opens a new one (#244).
  const [vaultAction, setVaultAction] = useState<'switch' | 'new-window'>('switch')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [recentIds, setRecentIds] = useState<string[]>(() => loadRecentCommandIds())
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Original theme snapshot captured when entering the theme picker.
  // Used to revert if the user cancels with Escape or clicks outside. A
  // palette opened straight on the theme list (a key bound to Themes…)
  // takes it as it opens.
  const originalThemeRef = useRef<ThemeSnapshot | null>(
    initialMode === 'theme'
      ? {
          id: useStore.getState().themeId,
          family: useStore.getState().themeFamily,
          mode: useStore.getState().themeMode
        }
      : null
  )
  const committedRef = useRef(false)

  const commandKeymaps = useStore((s) => s.commandKeymaps)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const vimMode = useStore((s) => s.vimMode)
  const setCommandKeymapBinding = useStore((s) => s.setCommandKeymapBinding)
  // Alt+Enter on a row records a key for that command right here (#971).
  const [recordingFor, setRecordingFor] = useState<Command | null>(null)

  // Rebuilt when a command gets a key, so its row shows it straight away.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allCommands = useMemo(() => buildCommands(), [commandKeymaps])

  // Recently-used commands surfaced at the top — only with an empty query, in
  // command mode. `allCommands` is already filtered by each command's `when`
  // guard, so unavailable recents are skipped (and the next one fills in).
  const recentCommands = useMemo<Command[]>(() => {
    if (query.trim() || mode !== 'main') return []
    const byId = new Map(allCommands.map((c) => [c.id, c]))
    const out: Command[] = []
    for (const id of recentIds) {
      const cmd = byId.get(id)
      if (cmd) out.push(cmd)
      if (out.length >= RECENT_COMMAND_COUNT) break
    }
    return out
  }, [query, mode, allCommands, recentIds])

  const commandResults = useMemo<Command[]>(() => {
    const ranked = rankItems(allCommands, query, [
      { get: (c) => c.title, weight: 1 },
      { get: (c) => c.keywords, weight: 0.7 },
      { get: (c) => c.category, weight: 0.5 }
    ])
    if (recentCommands.length === 0) return ranked
    // Pull recents to the top; drop their duplicates from the rest.
    const recentSet = new Set(recentCommands.map((c) => c.id))
    return [...recentCommands, ...ranked.filter((c) => !recentSet.has(c.id))]
  }, [allCommands, query, recentCommands])

  const themeResults = useMemo<ThemeOption[]>(() => rankThemes(query), [query])

  const vaultOptions = useMemo<VaultRow[]>(() => {
    const entries = buildVaultSwitcherEntries({
      localVaults,
      remoteProfiles: remoteWorkspaceProfiles,
      currentVault,
      workspaceMode,
      remoteWorkspaceInfo
    })
    // The new-window picker lists known local vaults (most-recent first) plus a
    // "Browse…" fallback to the folder picker. Remote workspaces don't apply.
    if (vaultAction === 'new-window') return newWindowVaultRows(entries)
    return entries
  }, [
    vaultAction,
    currentVault,
    localVaults,
    remoteWorkspaceInfo,
    remoteWorkspaceProfiles,
    workspaceMode
  ])

  const vaultResults = useMemo<VaultRow[]>(
    () =>
      rankItems(vaultOptions, query, [
        { get: (v) => v.name, weight: 1 },
        { get: (v) => v.location, weight: 0.7 },
        { get: (v) => v.kind, weight: 0.4 }
      ]),
    [query, vaultOptions]
  )

  // Only what may run: the picker's promise is that Enter does something, and
  // a draft's answer would be an error toast.
  const workflowOptions = useMemo(
    () => workflowIndex.filter((entry) => entry.status === 'active'),
    [workflowIndex]
  )

  const workflowResults = useMemo(
    () =>
      rankItems(workflowOptions, query, [
        { get: (w) => w.name, weight: 1 },
        { get: (w) => w.description, weight: 0.7 },
        { get: (w) => w.id, weight: 0.5 }
      ]),
    [query, workflowOptions]
  )

  const resultsLength =
    mode === 'main'
      ? commandResults.length
      : mode === 'theme'
        ? themeResults.length
        : mode === 'workflow'
          ? workflowResults.length
          : vaultResults.length

  useEffect(() => {
    inputRef.current?.focus()
    if (initialMode === 'vault') {
      void refreshLocalVaults()
      if (supportsRemoteWorkspace) void refreshRemoteWorkspaceProfiles()
    }
    // The same re-read the picker does when drilled into from the list.
    if (initialMode === 'workflow') void useStore.getState().loadWorkflowIndex()
  }, [initialMode, refreshLocalVaults, refreshRemoteWorkspaceProfiles, supportsRemoteWorkspace])
  // Selection sync:
  //  - Main mode: start at the top of the results on every query change.
  //  - Theme mode: keep the currently-applied theme highlighted as the
  //    filter narrows. If it's filtered out, leave active at -1 (no
  //    row highlighted, no preview churn) until the user arrows.
  useEffect(() => {
    if (mode === 'main') {
      setActive(0)
      return
    }
    if (mode === 'vault') {
      setActive(vaultResults.length > 0 ? 0 : -1)
      return
    }
    if (mode === 'workflow') {
      setActive(workflowResults.length > 0 ? 0 : -1)
      return
    }
    const currentId = useStore.getState().themeId
    const idx = themeResults.findIndex((t) => t.id === currentId)
    setActive(idx)
  }, [query, mode, themeResults, vaultResults.length, workflowResults.length])

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  /* -------- Theme preview on active change -------- */
  // A new filter or mode re-syncs `active` in the effect above, but that lands
  // on the next render: in this one `active` still indexes the previous list
  // (or the command list), and previewing it applied a theme nobody had
  // highlighted (typing `l` from Gruvbox Hard dark switched to Nord Light),
  // which the next re-sync then locked onto. So a preview waits until `active`
  // was set against the list it indexes, including on the first render.
  const previewBasisRef = useRef<{ mode: Mode; results: ThemeOption[] } | null>(null)
  useEffect(() => {
    const basis = previewBasisRef.current
    if (!basis || basis.mode !== mode || basis.results !== themeResults) {
      previewBasisRef.current = { mode, results: themeResults }
      return
    }
    if (mode !== 'theme') return
    if (active < 0) return
    const theme = themeResults[active]
    if (!theme) return
    // No-op preview when the highlighted theme is already active —
    // prevents re-running `setTheme` each time the filter narrows and
    // we re-sync the cursor onto the currently-applied theme.
    const s = useStore.getState()
    if (s.themeId === theme.id) return
    setTheme({ id: theme.id, family: theme.family, mode: theme.mode })
  }, [active, mode, themeResults, setTheme])

  /* -------- Lifecycle: enter / leave theme mode -------- */
  const enterThemeMode = (): void => {
    const s = useStore.getState()
    originalThemeRef.current = {
      id: s.themeId,
      family: s.themeFamily,
      mode: s.themeMode
    }
    committedRef.current = false
    setMode('theme')
    setQuery('')
    // The query/mode/themeResults useEffect below locks `active` onto
    // the currently-applied theme, so no setActive needed here.
  }

  const enterVaultMode = (action: 'switch' | 'new-window' = 'switch'): void => {
    setVaultAction(action)
    setMode('vault')
    setQuery('')
    setActive(0)
    void refreshLocalVaults()
    if (action === 'switch' && supportsRemoteWorkspace) void refreshRemoteWorkspaceProfiles()
    inputRef.current?.focus()
  }

  const enterWorkflowMode = (): void => {
    setMode('workflow')
    setQuery('')
    setActive(0)
    // Same courtesy the vault picker pays: re-read on entry, so a workflow
    // created since the index last loaded is already in the list.
    void useStore.getState().loadWorkflowIndex()
    inputRef.current?.focus()
  }

  const returnToMain = (): void => {
    if (mode === 'theme') revertTheme()
    setMode('main')
    setQuery('')
    setActive(0)
    inputRef.current?.focus()
  }

  const revertTheme = (): void => {
    const snap = originalThemeRef.current
    if (!snap) return
    setTheme(snap)
  }

  /* -------- Close handling -------- */
  const closePalette = (opts: { commit?: boolean } = {}): void => {
    if (mode === 'theme' && !opts.commit && !committedRef.current) {
      revertTheme()
    }
    setOpen(false)
    focusEditorAfterPaletteClose()
  }

  /* -------- Actions -------- */
  const runCommand = async (cmd: Command): Promise<void> => {
    setRecentIds(recordCommandUse(cmd.id))
    if (cmd.id === 'ui.themes') {
      enterThemeMode()
      inputRef.current?.focus()
      return
    }
    if (cmd.id === 'app.vault.switch') {
      enterVaultMode('switch')
      return
    }
    if (cmd.id === 'app.vault.openWindow') {
      enterVaultMode('new-window')
      return
    }
    if (cmd.id === 'workflow.runPicker') {
      enterWorkflowMode()
      return
    }
    setOpen(false)
    // Asked before the run: afterwards today's note exists either way.
    const landing = commandLanding(cmd)
    const panelBefore = useStore.getState().focusedPanel
    try {
      const ran = cmd.run()
      // A command that moves the keyboard to a panel as it runs (Focus
      // Sidebar) is read here, before the await: by then the palette has
      // closed and given the focus back to whatever held it, and when that
      // was the editor, the editor claimed its panel again. Read afterwards,
      // the command looked as if it had landed on the editor, and the refocus
      // below took the keyboard straight back from the sidebar.
      const panelHandedTo = useStore.getState().focusedPanel
      await ran
      const latest = useStore.getState()
      const landedPanel =
        panelHandedTo !== panelBefore && panelHandedTo != null && panelHandedTo !== 'editor'
          ? panelHandedTo
          : latest.focusedPanel
      // A command that opens a note (or otherwise lands on the editor) should
      // move DOM focus there — not just set focusedPanel. Closing the palette
      // otherwise leaves focus on whatever was focused before (e.g. the
      // explorer), and the editor's own focus-on-`focusedPanel` effect is a
      // single, no-retry `view.focus()` that races the palette unmount. Mirror
      // closePalette's focus restore; the retry wins that race. Skipped when the
      // command opened Settings or another palette (search, vault text search,
      // outline, …) so we don't pull focus behind it, and likewise for the Cloud
      // conflict queue, the Cloud settings prompt and the Publish Note dialog,
      // which claim focus themselves and are tracked outside the store, and
      // for a menu the command opened (Set Callout Type…): the menu holds the
      // keyboard, and the letters typed to filter it would land in the note.
      // On a phone the command decides where the keyboard goes
      // (lib/command-landing.ts): a note that was already there is left to
      // read, a command whose point is typing takes the editor, and anything
      // else (a toggle, a view) leaves the focus where it was. On desktop all
      // three focus the editor.
      if (
        shouldRefocusEditorAfterCommand(
          { ...latest, focusedPanel: landedPanel },
          useCloudSyncStatusStore.getState().conflictReviewOpen ||
            useCloudSyncStatusStore.getState().settingsConflictPromptOpen ||
            getPublishNoteRequest() !== null ||
            document.querySelector('[data-ctx-menu]') !== null
        )
      ) {
        if (landing === 'read') focusEditorAfterReadOpen()
        else if (landing === 'edit') focusEditorNormalMode()
        else focusEditorAfterPaletteClose()
      }
    } catch (err) {
      console.error('command failed', cmd.id, err)
    }
  }

  /**
   * Alt+Enter: record a key for the highlighted command without leaving the
   * palette. The recorder opens over it, Enter saves, Escape comes back to
   * the same row and query, and the row shows its new key. Inline rather
   * than a jump to Settings → Keymap, which would drop the query, land on a
   * page of three hundred rows and take two Escapes to come back from; the
   * recorder is the same one Settings uses, conflict checks and all.
   */
  const startRecording = (cmd: Command): void => {
    if (!isBindableCommandId(cmd.id)) {
      useToastStore
        .getState()
        .addToast(
          `${cmd.title} can't take a key: the palette makes it for what is in this vault, so it comes and goes`,
          'info'
        )
      return
    }
    setRecordingFor(cmd)
  }

  const commitTheme = (theme: ThemeOption): void => {
    setTheme({ id: theme.id, family: theme.family, mode: theme.mode })
    committedRef.current = true
    setOpen(false)
    // A theme is a `stay` landing (lib/command-landing.ts): on a phone the
    // keyboard stays down over the note being read.
    focusEditorAfterPaletteClose()
  }

  const runPickedWorkflow = (entry: WorkflowIndexEntry): void => {
    // Close first: the trigger flow opens its own confirmation, and a palette
    // still up behind it would catch the keystrokes meant for the dialog.
    setOpen(false)
    void runWorkflowById(entry.id)
  }

  const switchVault = async (entry: VaultRow): Promise<void> => {
    setOpen(false)
    if (vaultAction === 'new-window') {
      // Open a known vault directly, or fall back to the folder picker.
      if (entry.kind === 'browse') await window.zen.openVaultWindow()
      else if (entry.kind === 'local') await window.zen.openVaultWindow(entry.root)
      return
    }
    if (entry.current) return
    if (entry.kind === 'local') {
      await openLocalVault(entry.root)
      return
    }
    if (entry.kind === 'remote' && entry.id) await connectRemoteWorkspaceProfile(entry.id)
  }

  const inputPlaceholder =
    mode === 'main'
      ? 'Type a command…'
      : mode === 'theme'
        ? 'Pick a color theme'
        : mode === 'workflow'
          ? 'Pick a workflow to run'
          : vaultAction === 'new-window'
            ? 'Open a vault in a new window…'
            : 'Pick a vault'

  return (
    <>
    <Modal size="md" layer="palette" onClose={() => closePalette()} closeOnEsc={false}>
      {canReturnToCommandList(mode, initialMode) && (
          <div className="flex items-center gap-2 border-b border-paper-300/70 bg-paper-200/40 px-4 py-2 text-xs text-ink-500">
            <button
              type="button"
              onClick={returnToMain}
              className="rounded px-1 py-0.5 text-ink-600 transition-colors hover:bg-paper-200 hover:text-ink-900"
              aria-label="Back to commands"
              title="Back to commands"
            >
              ‹ Back
            </button>
            <span className="uppercase tracking-wide">
              {mode === 'theme'
                ? 'Theme preview · ↵ to keep, esc to revert'
                : mode === 'workflow'
                  ? 'Run workflow · ↵ to run, esc to return'
                  : vaultAction === 'new-window'
                    ? 'Open vault in new window · ↵ to open, esc to return'
                    : 'Switch vault · ↵ to open, esc to return'}
            </span>
          </div>
        )}
        <div className="border-b border-paper-300/70 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            placeholder={inputPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // While composing (IME), let the input own Enter/Arrows. (#183)
              if (isImeComposing(e)) return
              if (isPaletteNextKey(e)) {
                e.preventDefault()
                e.stopPropagation()
                setActive((a) => Math.min(resultsLength - 1, a + 1))
              } else if (isPalettePreviousKey(e)) {
                e.preventDefault()
                e.stopPropagation()
                setActive((a) => Math.max(0, a - 1))
              } else if (
                e.key === 'Enter' &&
                e.altKey &&
                !e.metaKey &&
                !e.ctrlKey &&
                mode === 'main'
              ) {
                e.preventDefault()
                const cmd = commandResults[active]
                if (cmd) startRecording(cmd)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (mode === 'main') {
                  const cmd = commandResults[active]
                  if (cmd) void runCommand(cmd)
                } else if (mode === 'theme') {
                  const theme = themeResults[active]
                  if (theme) commitTheme(theme)
                } else if (mode === 'workflow') {
                  const entry = workflowResults[active]
                  if (entry) runPickedWorkflow(entry)
                } else {
                  const vault = vaultResults[active]
                  if (vault) void switchVault(vault)
                }
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                if (canReturnToCommandList(mode, initialMode)) {
                  returnToMain()
                  return
                }
                closePalette()
              }
            }}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
        <div
          ref={listRef}
          className="max-h-[56vh] overflow-x-hidden overflow-y-auto py-1"
        >
          {resultsLength === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-400">
              {mode === 'main'
                ? 'No matching commands.'
                : mode === 'theme'
                  ? 'No matching themes.'
                  : mode === 'workflow'
                    ? 'No active workflows. Activate one in the Workflows view first.'
                    : 'No vaults.'}
            </div>
          ) : mode === 'main' ? (
            commandResults.map((cmd, i) => (
              <Fragment key={cmd.id}>
                {recentCommands.length > 0 && i === 0 && (
                  <div className="px-4 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-ink-400">
                    Recent
                  </div>
                )}
                {recentCommands.length > 0 && i === recentCommands.length && (
                  <div className="mt-1 border-t border-paper-300/60 px-4 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-ink-400">
                    All Commands
                  </div>
                )}
                <button
                  data-cmd-idx={i}
                  onClick={() => void runCommand(cmd)}
                  onMouseMove={() => setActive(i)}
                  className={[
                    'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                    i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                  ].join(' ')}
                >
                  <span className="shrink-0 text-xs uppercase tracking-wide text-ink-400">
                    {cmd.category}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                    {cmd.title}
                  </span>
                  {cmd.shortcut && (
                    <span className="shrink-0 rounded bg-paper-200/80 px-1.5 py-0.5 text-xs text-ink-500">
                      {cmd.shortcut}
                    </span>
                  )}
                </button>
              </Fragment>
            ))
          ) : mode === 'theme' ? (
            themeResults.map((theme, i) => {
              const isOriginal = theme.id === originalThemeRef.current?.id
              const familyTitle =
                theme.family.charAt(0).toUpperCase() + theme.family.slice(1)
              return (
                <button
                  key={theme.id}
                  data-cmd-idx={i}
                  onClick={() => commitTheme(theme)}
                  onMouseMove={() => setActive(i)}
                  className={[
                    'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                    i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                  ].join(' ')}
                >
                  <span className="shrink-0 text-xs uppercase tracking-wide text-ink-400">
                    {familyTitle}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                    {theme.label}
                  </span>
                  <span className="shrink-0 text-xs text-ink-400">
                    {theme.mode}
                  </span>
                  {isOriginal && (
                    <span
                      aria-label="Active before preview"
                      className="shrink-0 text-xs text-accent"
                    >
                      current
                    </span>
                  )}
                </button>
              )
            })
          ) : mode === 'workflow' ? (
            workflowResults.map((entry, i) => (
              <button
                key={entry.id}
                data-cmd-idx={i}
                onClick={() => runPickedWorkflow(entry)}
                onMouseMove={() => setActive(i)}
                className={[
                  'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                  i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                ].join(' ')}
              >
                <span className="shrink-0 text-xs uppercase tracking-wide text-ink-400">
                  Run
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                  {entry.name}
                </span>
                {entry.description !== '' && (
                  <span className="min-w-0 max-w-[45%] truncate text-xs text-ink-400">
                    {entry.description}
                  </span>
                )}
                {entry.mutates && (
                  <span
                    title="This workflow changes notes. Running it asks for confirmation first."
                    className="shrink-0 text-xs text-ink-400"
                  >
                    writes
                  </span>
                )}
              </button>
            ))
          ) : (
            vaultResults.map((entry, i) => (
              <button
                key={`${entry.kind}-${
                  entry.kind === 'local'
                    ? entry.root
                    : entry.kind === 'remote'
                      ? entry.id ?? entry.location
                      : 'browse'
                }`}
                data-cmd-idx={i}
                onClick={() => void switchVault(entry)}
                onMouseMove={() => setActive(i)}
                className={[
                  'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                  i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                ].join(' ')}
              >
                <span className="shrink-0 text-xs uppercase tracking-wide text-ink-400">
                  {entry.kind === 'local' ? 'Local' : entry.kind === 'remote' ? 'Remote' : 'Browse'}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                  {entry.name}
                </span>
                <span className="min-w-0 max-w-[45%] truncate text-xs text-ink-400">
                  {entry.location}
                </span>
                {entry.current && (
                  <span className="shrink-0 text-xs text-accent">
                    current
                  </span>
                )}
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-end gap-4 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-xs text-ink-500">
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd>{' '}
            <kbd className="rounded bg-paper-200 px-1">Ctrl+N/P</kbd> move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd>{' '}
            {mode === 'main' || mode === 'workflow'
              ? 'run'
              : mode === 'theme'
                ? 'keep theme'
                : 'switch'}
          </span>
          {mode === 'main' && (
            <span data-palette-bind-hint="">
              <kbd className="rounded bg-paper-200 px-1">{formatKeyToken('Alt+Enter')}</kbd> set key
            </span>
          )}
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd>{' '}
            {!canReturnToCommandList(mode, initialMode)
              ? 'close'
              : mode === 'theme'
                ? 'revert'
                : 'back'}
          </span>
        </div>
    </Modal>
    {recordingFor && (
      <KeymapRecorderModal
        target={{
          kind: 'command',
          id: recordingFor.id,
          title: recordingFor.bindTitle ?? recordingFor.title,
          category: recordingFor.category,
          builtinShortcut: recordingFor.builtinShortcut || undefined
        }}
        overrides={keymapOverrides}
        commandKeymaps={commandKeymaps}
        vimMode={vimMode}
        onClose={() => setRecordingFor(null)}
        onSave={(binding) => {
          setCommandKeymapBinding(recordingFor.id, binding)
          setRecordingFor(null)
        }}
        onUnbind={() => {
          setCommandKeymapBinding(recordingFor.id, '')
          setRecordingFor(null)
        }}
      />
    )}
    </>
  )
}
