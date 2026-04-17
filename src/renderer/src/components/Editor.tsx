/**
 * Top-level editor surface. Renders the pane-layout tree recursively:
 * every leaf becomes an `EditorPane`; every split becomes a flex
 * container with resize handles between its children.
 *
 * Global concerns (vim command registration, the bottom StatusBar,
 * app-level keyboard shortcuts) live here. Per-pane concerns (CM view,
 * tabs, toolbar, drag-drop zones) live in `EditorPane.tsx`.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { EditorView } from '@codemirror/view'
import { Vim, getCM } from '@replit/codemirror-vim'
import { foldAll, unfoldAll, foldCode, unfoldCode } from '@codemirror/language'
import { isTagsViewActive, isTasksViewActive, useStore } from '../store'
import { buildCommands, type Command } from '../lib/commands'
import { rankItems } from '../lib/fuzzy-score'
import type { PaneLayout, PaneSplit } from '../lib/pane-layout'
import {
  parseCreateNotePath,
  resolveWikilinkTarget,
  suggestCreateNotePath
} from '../lib/wikilinks'
import { classifyLocalAssetHref, resolveAssetVaultRelativePath } from '../lib/local-assets'
import {
  buildMoveNotePrompt,
  parseMoveNoteTarget,
  validateMoveNoteTarget
} from '../lib/move-note'
import { promptApp } from './PromptHost'
import { StatusBar } from './StatusBar'
import { EditorPane } from './EditorPane'
import { focusPaneOrEdgePanel } from '../lib/pane-nav'
import { requestPaneMode } from '../lib/pane-mode'
import {
  getKeymapBinding,
  getSequenceTokens,
  type KeymapId,
  type KeymapOverrides
} from '../lib/keymaps'

let vimCommandsRegistered = false
let syncedVimBindings: Partial<Record<KeymapId, string[]>> = {}

const DEFAULT_VIM_MAPPINGS_TO_CLEAR = [
  'gd',
  '<C-w>h',
  '<C-w>j',
  '<C-w>k',
  '<C-w>l',
  '<C-w><C-h>',
  '<C-w><C-j>',
  '<C-w><C-k>',
  '<C-w><C-l>',
  'zc',
  'zo',
  'zM',
  'zR'
]

function clearKnownVimMappings(): void {
  for (const binding of DEFAULT_VIM_MAPPINGS_TO_CLEAR) {
    try {
      Vim.unmap(binding, 'normal')
    } catch {
      /* ignore */
    }
  }
}

function toVimKeyName(base: string): string {
  if (base === 'Space') return 'Space'
  if (base === 'Enter') return 'CR'
  if (base === 'Esc' || base === 'Escape') return 'Esc'
  if (base === 'Tab') return 'Tab'
  if (base === 'ArrowUp') return 'Up'
  if (base === 'ArrowDown') return 'Down'
  if (base === 'ArrowLeft') return 'Left'
  if (base === 'ArrowRight') return 'Right'
  return base
}

function toVimSequenceToken(token: string): string | null {
  const parts = token
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const base = parts.pop()
  if (!base) return null
  const keyName = toVimKeyName(base)
  if (parts.length === 0) {
    if (base.length === 1) return base
    return `<${keyName}>`
  }
  const modifiers = parts
    .map((part) => {
      if (part === 'Ctrl') return 'C'
      if (part === 'Alt') return 'A'
      if (part === 'Shift') return 'S'
      if (part === 'Meta' || part === 'Mod') return 'D'
      return null
    })
    .filter(Boolean) as string[]
  const normalizedKey = base.length === 1 ? base.toLowerCase() : keyName
  return `<${[...modifiers, normalizedKey].join('-')}>`
}

function toVimSequence(binding: string): string | null {
  const tokens = binding
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => toVimSequenceToken(token))
  if (tokens.length === 0 || tokens.some((token) => !token)) return null
  return tokens.join('')
}

function paneMapBindings(overrides: KeymapOverrides, actionId: KeymapId): string[] {
  const prefixBinding = toVimSequence(getKeymapBinding(overrides, 'vim.panePrefix'))
  const actionBinding = toVimSequence(getKeymapBinding(overrides, actionId))
  if (!prefixBinding || !actionBinding) return []
  const bindings = [`${prefixBinding}${actionBinding}`]
  const prefixTokens = getSequenceTokens(overrides, 'vim.panePrefix')
  const actionTokens = getSequenceTokens(overrides, actionId)
  if (
    prefixTokens.length === 1 &&
    prefixTokens[0] === 'Ctrl+W' &&
    actionTokens.length === 1 &&
    /^[hjkl]$/i.test(actionTokens[0])
  ) {
    bindings.push(`${prefixBinding}<C-${actionTokens[0].toLowerCase()}>`)
  }
  return [...new Set(bindings)]
}

function syncVimKeymaps(overrides: KeymapOverrides): void {
  const mappings: Array<{ id: KeymapId; action: string; bindings: string[] }> = [
    {
      id: 'vim.goToDefinition',
      action: 'goToDefinition',
      bindings: [toVimSequence(getKeymapBinding(overrides, 'vim.goToDefinition'))].filter(
        (binding): binding is string => !!binding
      )
    },
    {
      id: 'vim.paneFocusLeft',
      action: 'focusPaneLeft',
      bindings: paneMapBindings(overrides, 'vim.paneFocusLeft')
    },
    {
      id: 'vim.paneFocusDown',
      action: 'focusPaneDown',
      bindings: paneMapBindings(overrides, 'vim.paneFocusDown')
    },
    {
      id: 'vim.paneFocusUp',
      action: 'focusPaneUp',
      bindings: paneMapBindings(overrides, 'vim.paneFocusUp')
    },
    {
      id: 'vim.paneFocusRight',
      action: 'focusPaneRight',
      bindings: paneMapBindings(overrides, 'vim.paneFocusRight')
    },
    {
      id: 'vim.foldCurrent',
      action: 'foldHeadingAtCursor',
      bindings: [toVimSequence(getKeymapBinding(overrides, 'vim.foldCurrent'))].filter(
        (binding): binding is string => !!binding
      )
    },
    {
      id: 'vim.unfoldCurrent',
      action: 'unfoldHeadingAtCursor',
      bindings: [toVimSequence(getKeymapBinding(overrides, 'vim.unfoldCurrent'))].filter(
        (binding): binding is string => !!binding
      )
    },
    {
      id: 'vim.foldAll',
      action: 'foldAllHeadings',
      bindings: [toVimSequence(getKeymapBinding(overrides, 'vim.foldAll'))].filter(
        (binding): binding is string => !!binding
      )
    },
    {
      id: 'vim.unfoldAll',
      action: 'unfoldAllHeadings',
      bindings: [toVimSequence(getKeymapBinding(overrides, 'vim.unfoldAll'))].filter(
        (binding): binding is string => !!binding
      )
    }
  ]

  for (const mapping of mappings) {
    for (const binding of syncedVimBindings[mapping.id] ?? []) {
      try {
        Vim.unmap(binding, 'normal')
      } catch {
        /* ignore */
      }
    }
    for (const binding of mapping.bindings) {
      Vim.mapCommand(binding, 'action', mapping.action, {}, { context: 'normal' })
    }
    syncedVimBindings[mapping.id] = mapping.bindings
  }
}

function unwrapMdUrl(url: string): string {
  // Markdown wraps URLs with spaces in angle brackets: `[x](<a b.pdf>)`.
  const trimmed = url.trim()
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1)
  return trimmed
}

function extractLinkAtCursor(doc: string, pos: number): string | null {
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = doc.indexOf('\n', pos)
  const line = doc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
  const col = pos - lineStart
  const wikiRe = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = wikiRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[1]
  }
  // Angle-bracketed URLs can contain `)` so match them specifically first.
  const mdAngleRe = /\[([^\]]*)\]\(<([^>]+)>\)/g
  while ((m = mdAngleRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[2]
  }
  const mdRe = /\[([^\]]*)\]\(([^)]+)\)/g
  while ((m = mdRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return unwrapMdUrl(m[2])
  }
  const urlRe = /https?:\/\/[^\s)>\]]+/g
  while ((m = urlRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[0]
  }
  return null
}

function registerVimCommands(): void {
  if (vimCommandsRegistered) return
  vimCommandsRegistered = true

  // HMR can leave old custom mappings alive in CodeMirror-Vim's global
  // map table. Explicitly remove the temporary `x` close-note binding
  // so normal-mode `x` keeps its default delete-char behavior.
  try {
    Vim.unmap('x', 'normal')
  } catch {
    /* ignore */
  }
  clearKnownVimMappings()

  Vim.defineEx('write', 'w', () => {
    void useStore.getState().persistActive()
  })
  Vim.defineEx('format', 'format', () => {
    void useStore.getState().formatActiveNote()
  })
  Vim.defineEx('quit', 'q', () => {
    const state = useStore.getState()
    if (isTasksViewActive(state)) {
      state.closeTasksView()
      return
    }
    if (isTagsViewActive(state)) {
      state.closeTagView()
      return
    }
    void state.closeActiveNote()
  })
  Vim.defineEx('wq', 'wq', () => {
    const state = useStore.getState()
    if (isTasksViewActive(state)) {
      state.closeTasksView()
      return
    }
    if (isTagsViewActive(state)) {
      state.closeTagView()
      return
    }
    void state.closeActiveNote()
  })

  // Vault-wide task view. Opens the full-surface Tasks panel that parses
  // `- [ ]` across every note and groups them by Today/Upcoming/Waiting/Done.
  // `:q` above knows to close the panel instead of closing a note.
  Vim.defineEx('tasks', 'tasks', () => {
    void useStore.getState().openTasksView()
  })

  // `:tag foo` starts (or updates) the Tags view with `foo` selected.
  // `:tag foo bar baz` replaces the selection set wholesale. `:tag`
  // alone opens the Tags tab with whatever's currently selected (if
  // nothing is, the view shows a hint to pick tags).
  Vim.defineEx(
    'tag',
    'tag',
    (_cm: unknown, params: { argString?: string } | undefined) => {
      const args = (params?.argString ?? '')
        .split(/\s+/)
        .map((t) => t.trim().replace(/^#/, ''))
        .filter(Boolean)
      const state = useStore.getState()
      if (args.length === 0) {
        void state.openTagView()
        return
      }
      state.setSelectedTags(args)
      void state.openTagView()
    }
  )

  // Vim-style window splits. `:split` clones the current tab into a
  // new pane below; `:vsplit` clones it into a new pane to the right.
  // Both commands accept their usual abbreviations (`:sp`, `:vs`).
  Vim.defineEx('split', 'sp', () => {
    const state = useStore.getState()
    const path = state.selectedPath
    if (!path) return
    void state.splitPaneWithTab({
      targetPaneId: state.activePaneId,
      edge: 'bottom',
      path
    })
  })
  Vim.defineEx('vsplit', 'vs', () => {
    const state = useStore.getState()
    const path = state.selectedPath
    if (!path) return
    void state.splitPaneWithTab({
      targetPaneId: state.activePaneId,
      edge: 'right',
      path
    })
  })

  Vim.defineAction('goToDefinition', (cm: ReturnType<typeof getCM>) => {
    const view = (cm as unknown as { cm6?: EditorView }).cm6
    if (!view) return
    const pos = view.state.selection.main.head
    const doc = view.state.doc.toString()
    const target = extractLinkAtCursor(doc, pos)
    if (!target) return

    if (/^https?:\/\//i.test(target)) {
      window.open(target, '_blank')
      return
    }

    const state = useStore.getState()

    // PDF links: pin the asset in the reference pane for this note
    // instead of prompting to create a note.
    if (classifyLocalAssetHref(target) === 'pdf') {
      const activePath = state.selectedPath
      const vaultRoot = state.vault?.root
      if (activePath && vaultRoot) {
        const abs = resolveAssetVaultRelativePath(vaultRoot, activePath, target)
        if (abs) {
          state.pinAssetReferenceForNote(activePath, abs)
          return
        }
      }
    }

    const notes = state.notes
    const resolved = resolveWikilinkTarget(notes, target)
    if (resolved) {
      void state.selectNote(resolved.path).then(() => {
        state.setFocusedPanel('editor')
        requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
      })
      return
    }

    void promptApp({
      title: `Create note for "${target}"?`,
      description:
        'No matching note exists. Use /my/path/note.md for Inbox-relative paths, or inbox/my/path/note.md for an explicit top folder.',
      initialValue: suggestCreateNotePath(target),
      placeholder: '/my/path/note.md',
      okLabel: 'Create',
      validate: (value) => {
        try {
          parseCreateNotePath(value)
          return null
        } catch (err) {
          return (err as Error).message
        }
      }
    }).then(async (value) => {
      if (!value) return
      try {
        const parsed = parseCreateNotePath(value)
        const existing = state.notes.find(
          (note) => note.folder !== 'trash' && note.path.toLowerCase() === parsed.relPath.toLowerCase()
        )
        if (existing) {
          await state.selectNote(existing.path)
          state.setFocusedPanel('editor')
          requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
          return
        }
        await state.createAndOpen(parsed.folder, parsed.subpath, { title: parsed.title })
        state.setFocusedPanel('editor')
        requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
      } catch (err) {
        window.alert((err as Error).message)
      }
    })
  })

  // Vim-style pane navigation actions are registered here, but their
  // actual key bindings are synced from the configurable keymap registry.
  Vim.defineAction('focusPaneLeft', () => {
    focusPaneOrEdgePanel('h')
  })
  Vim.defineAction('focusPaneDown', () => {
    focusPaneOrEdgePanel('j')
  })
  Vim.defineAction('focusPaneUp', () => {
    focusPaneOrEdgePanel('k')
  })
  Vim.defineAction('focusPaneRight', () => {
    focusPaneOrEdgePanel('l')
  })

  registerVimNoteCommands()
  registerCommandPaletteEx()
}

/**
 * Vim-muscle-memory ex commands for buffer (tab) / file operations. These
 * sit above the auto-registered palette commands so their short names
 * (`:e`, `:bn`, `:bd`) are reserved and not overwritten.
 *
 * - `:e[dit] <path>`     open a note by vault-relative path, create if missing
 * - `:new <path>`        create a new note at an explicit path
 * - `:mv`, `:move`       move the active note to another Inbox/Archive path
 * - `:bn[ext]`           next tab in the active pane
 * - `:bp[rev]`           previous tab in the active pane
 * - `:bd[elete]`, `:bc`  close the active tab (alias for `:q` on notes)
 * - `:buffers`, `:ls`    open the buffer switcher
 * - `:outline`            open the heading outline palette
 * - `:trash`              open the Trash view
 * - `:only`              close every other tab in the active pane
 * - `:qa[ll]`            close every tab, everywhere
 * - `:h[elp]`            open the built-in Help manual
 */
function registerVimNoteCommands(): void {
  const getActiveLeaf = (): { id: string; tabs: string[]; activeTab: string | null } | null => {
    const s = useStore.getState()
    const leaves = allLeavesFlat(s.paneLayout)
    return leaves.find((l) => l.id === s.activePaneId) ?? null
  }

  const openOrCreateByPath = async (raw: string): Promise<void> => {
    const value = raw.trim()
    if (!value) return
    let parsed: ReturnType<typeof parseCreateNotePath>
    try {
      parsed = parseCreateNotePath(value)
    } catch (err) {
      window.alert((err as Error).message)
      return
    }
    const state = useStore.getState()
    // If something already resolves to that target (wiki-style + case-
    // insensitive), open it instead of creating a duplicate.
    const existing = state.notes.find(
      (n) =>
        n.folder !== 'trash' &&
        n.path.toLowerCase() === parsed.relPath.toLowerCase()
    )
    if (existing) {
      await state.selectNote(existing.path)
      state.setFocusedPanel('editor')
      requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
      return
    }
    await state.createAndOpen(parsed.folder, parsed.subpath, {
      title: parsed.title
    })
    state.setFocusedPanel('editor')
    requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
  }

  Vim.defineEx(
    'edit',
    'e',
    (_cm: unknown, params: { argString?: string } | undefined) => {
      void openOrCreateByPath(params?.argString ?? '')
    }
  )

  // `:new` shadows vim's "horizontal split empty buffer" — for a notes
  // app, creating a new note at a path is what the user actually wants.
  Vim.defineEx(
    'new',
    'new',
    (_cm: unknown, params: { argString?: string } | undefined) => {
      const arg = (params?.argString ?? '').trim()
      if (!arg) {
        void useStore.getState().createAndOpen('inbox', '', { focusTitle: true })
        return
      }
      void openOrCreateByPath(arg)
    }
  )

  const moveActiveNote = async (raw: string): Promise<void> => {
    const state = useStore.getState()
    const active = state.activeNote
    if (!active) return

    const value = raw.trim()
    let target = value
    if (!target) {
      target = (await promptApp(buildMoveNotePrompt(active, state.folders))) ?? ''
      if (!target) return
    }

    const error = validateMoveNoteTarget(target)
    if (error) {
      window.alert(error)
      return
    }
    const dest = parseMoveNoteTarget(target)
    await state.moveNote(active.path, dest.folder, dest.subpath)
  }

  const runMoveEx = (_cm: unknown, params: { argString?: string } | undefined): void => {
    void moveActiveNote(params?.argString ?? '')
  }

  Vim.defineEx('move', 'move', runMoveEx)
  Vim.defineEx('mv', 'mv', runMoveEx)

  const shiftTab = (delta: 1 | -1): void => {
    const state = useStore.getState()
    const leaf = getActiveLeaf()
    if (!leaf) return
    const current = leaf.activeTab

    // Build a traversal list. Start with every unique tab path across
    // every pane — vim-style "buffer list". If there's only one (or
    // none), fall back to every live note in the vault ordered by
    // recency, so `:bn` / `:bp` always has somewhere to go in a fresh
    // session where only one note is open.
    const seen = new Set<string>()
    const order: string[] = []
    for (const l of allLeavesFlat(state.paneLayout)) {
      for (const path of l.tabs) {
        if (!seen.has(path)) {
          seen.add(path)
          order.push(path)
        }
      }
    }
    if (order.length < 2) {
      const fallback = state.notes
        .filter((n) => n.folder !== 'trash')
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
      for (const n of fallback) {
        if (!seen.has(n.path)) {
          seen.add(n.path)
          order.push(n.path)
        }
      }
    }
    if (order.length < 2) {
      // Genuinely nothing else to switch to — create a quick note so
      // the command still feels responsive in an empty vault.
      void state.createAndOpen('quick', '', { focusTitle: true })
      return
    }

    const baseIdx = current ? order.indexOf(current) : -1
    const startIdx = baseIdx >= 0 ? baseIdx : 0
    const nextIdx = (startIdx + delta + order.length) % order.length
    const nextPath = order[nextIdx]

    // If another pane already has this tab open, focus THAT pane rather
    // than duplicating the tab — closer to vim's "buffer is visible in
    // another window, jump there" behavior.
    const owningLeaf = allLeavesFlat(state.paneLayout).find((l) =>
      l.tabs.includes(nextPath)
    )
    if (owningLeaf && owningLeaf.id !== leaf.id) {
      void state.focusTabInPane(owningLeaf.id, nextPath)
      return
    }
    if (leaf.tabs.includes(nextPath)) {
      void state.focusTabInPane(leaf.id, nextPath)
    } else {
      void state.openNoteInPane(leaf.id, nextPath)
    }
  }

  Vim.defineEx('bnext', 'bn', () => shiftTab(1))
  Vim.defineEx('bprev', 'bp', () => shiftTab(-1))
  // Vim aliases: :bNext and :bfirst/:blast — rare, skipped.

  const closeActiveTabLikeQuit = (): void => {
    const state = useStore.getState()
    if (isTasksViewActive(state)) {
      state.closeTasksView()
      return
    }
    if (isTagsViewActive(state)) {
      state.closeTagView()
      return
    }
    void state.closeActiveNote()
  }
  Vim.defineEx('bdelete', 'bd', closeActiveTabLikeQuit)
  Vim.defineEx('bclose', 'bc', closeActiveTabLikeQuit)
  const openBufferSwitcher = (): void => {
    requestAnimationFrame(() => {
      useStore.getState().setBufferPaletteOpen(true)
    })
  }
  Vim.defineEx('buffers', 'buffers', openBufferSwitcher)
  Vim.defineEx('ls', 'ls', openBufferSwitcher)
  const openOutline = (): void => {
    requestAnimationFrame(() => {
      useStore.getState().setOutlinePaletteOpen(true)
    })
  }
  Vim.defineEx('outline', 'outline', openOutline)
  const setZenMode = (next: 'toggle' | 'on' | 'off'): void => {
    requestAnimationFrame(() => {
      const state = useStore.getState()
      if (next === 'on') {
        state.setFocusMode(true)
        return
      }
      if (next === 'off') {
        state.setFocusMode(false)
        return
      }
      state.setFocusMode(!state.zenMode)
    })
  }
  const setPaneMode = (mode: 'edit' | 'split' | 'preview'): void => {
    requestAnimationFrame(() => {
      requestPaneMode(mode)
    })
  }
  Vim.defineEx('view', 'view', (_cm: unknown, params: { argString?: string } | undefined) => {
    const nextMode = (params?.argString ?? '').trim().toLowerCase()
    if (nextMode === 'edit' || nextMode === 'split' || nextMode === 'preview') {
      setPaneMode(nextMode)
    }
  })
  Vim.defineEx('zen', 'zen', (_cm: unknown, params: { argString?: string } | undefined) => {
    const nextMode = (params?.argString ?? '').trim().toLowerCase()
    if (!nextMode || nextMode === 'toggle') {
      setZenMode('toggle')
      return
    }
    if (nextMode === 'on' || nextMode === 'off') {
      setZenMode(nextMode)
    }
  })
  Vim.defineEx('zenmode', 'zenmode', () => setZenMode('toggle'))
  Vim.defineEx('editmode', 'editmode', () => setPaneMode('edit'))
  Vim.defineEx('splitmode', 'splitmode', () => setPaneMode('split'))
  Vim.defineEx('previewmode', 'previewmode', () => setPaneMode('preview'))

  Vim.defineEx('only', 'only', () => {
    const leaf = getActiveLeaf()
    if (!leaf || !leaf.activeTab) return
    const state = useStore.getState()
    // Snapshot the list — closing tabs mutates leaf.tabs concurrently.
    const toClose = leaf.tabs.filter((p) => p !== leaf.activeTab)
    for (const p of toClose) void state.closeTabInPane(leaf.id, p)
  })

  const closeEveryTab = (): void => {
    const state = useStore.getState()
    for (const leaf of allLeavesFlat(state.paneLayout)) {
      const snapshot = [...leaf.tabs]
      for (const p of snapshot) void state.closeTabInPane(leaf.id, p)
    }
  }
  Vim.defineEx('qall', 'qa', closeEveryTab)
  Vim.defineEx('quitall', 'quitall', closeEveryTab)
  // :xa / :wa are just aliases for qall in this context (nothing to flush
  // that autosave doesn't already handle).
  Vim.defineEx('xall', 'xa', closeEveryTab)
  Vim.defineEx('wall', 'wa', closeEveryTab)

  Vim.defineEx('help', 'h', () => {
    void useStore.getState().openHelpView()
  })

  Vim.defineEx('trash', 'trash', () => {
    void useStore.getState().openTrashView()
  })

  // Heading fold helpers — wrap CodeMirror's commands so they work on
  // whichever pane currently owns the editor. `:fold` / `:unfold` act
  // on the current heading; `:foldall` / `:unfoldall` cover the whole
  // note. We map vim's `zc` / `zo` / `zM` / `zR` keys explicitly so the
  // advertised fold chords work regardless of what CM-Vim ships by default.
  const runFold = (cmd: (view: { state: unknown; dispatch: unknown }) => boolean): void => {
    const view = useStore.getState().editorViewRef
    if (!view) return
    cmd(view as unknown as Parameters<typeof foldCode>[0])
    view.focus()
  }
  Vim.defineAction('foldHeadingAtCursor', () => runFold(foldCode as never))
  Vim.defineAction('unfoldHeadingAtCursor', () => runFold(unfoldCode as never))
  Vim.defineAction('foldAllHeadings', () => runFold(foldAll as never))
  Vim.defineAction('unfoldAllHeadings', () => runFold(unfoldAll as never))
  Vim.defineEx('fold', 'fold', () => runFold(foldCode as never))
  Vim.defineEx('unfold', 'unfold', () => runFold(unfoldCode as never))
  Vim.defineEx('foldall', 'foldall', () => runFold(foldAll as never))
  Vim.defineEx('unfoldall', 'unfoldall', () => runFold(unfoldAll as never))
}

/** Flatten the pane tree to a list of leaves, independent of the store's
 *  `allLeaves` helper (which lives in `lib/pane-layout`). Duplicated
 *  locally to avoid a new import chain. */
function allLeavesFlat(
  node: PaneLayout
): Array<{ id: string; tabs: string[]; activeTab: string | null }> {
  if (node.kind === 'leaf') {
    return [{ id: node.id, tabs: node.tabs, activeTab: node.activeTab }]
  }
  const out: Array<{ id: string; tabs: string[]; activeTab: string | null }> = []
  for (const child of node.children) out.push(...allLeavesFlat(child))
  return out
}

// Names we register manually above. Keeping a block-list avoids double-
// registering when an auto-generated name would collide with a curated
// vim-style shortcut (`:w`, `:q`, `:tasks`, …).
const MANUAL_EX_NAMES = new Set([
  'write',
  'w',
  'quit',
  'q',
  'wq',
  'format',
  'tasks',
  'tag',
  'split',
  'sp',
  'vsplit',
  'vs',
  // Added by `registerVimNoteCommands`
  'edit',
  'e',
  'new',
  'move',
  'mv',
  'bnext',
  'bn',
  'bprev',
  'bp',
  'bdelete',
  'bd',
  'bclose',
  'bc',
  'buffers',
  'ls',
  'outline',
  'view',
  'zen',
  'zenmode',
  'editmode',
  'splitmode',
  'previewmode',
  'trash',
  'fold',
  'unfold',
  'foldall',
  'unfoldall',
  'only',
  'qall',
  'qa',
  'quitall',
  'xall',
  'xa',
  'wall',
  'wa',
  'help',
  'h'
])

function commandIdToExName(id: string): string {
  // CM-Vim's ex parser only reads word characters (`\w+` = `[A-Za-z0-9_]`)
  // for the command name. Any non-word char — dot, dash, etc. — ends the
  // name early. Collapse them all to underscores so `note.copy-wikilink`
  // → `note_copy_wikilink` is recognized as a single token.
  return id.replace(/[^A-Za-z0-9]+/g, '_')
}

/** Names of every ex command we register. Captured during init so the
 *  tab-completion handler can match against the full set without re-
 *  crawling buildCommands() on every keystroke. */
const registeredExNames: string[] = []

/**
 * Bridge every command from the palette registry into the `:` ex line so
 * the keyboard-first experience is comprehensive — any action the palette
 * exposes can be invoked directly by typing its kebab-cased id. Plus a
 * catch-all `:cmd <query>` that fuzzy-matches against title/keywords and
 * runs the top match (opens the full palette when the query is empty).
 */
function registerCommandPaletteEx(): void {
  const runCommand = (cmd: Command): void => {
    // Re-check `when` at invocation time so `:note-save` doesn't silently
    // fire when nothing is selected, for example.
    if (cmd.when && !cmd.when()) return
    void cmd.run()
  }

  const names = new Set<string>(MANUAL_EX_NAMES)
  for (const cmd of buildCommands()) {
    const name = commandIdToExName(cmd.id)
    if (names.has(name)) continue
    names.add(name)
    try {
      Vim.defineEx(name, name, () => runCommand(cmd))
    } catch {
      /* ignore duplicate registrations across HMR cycles */
    }
  }

  // `:cmd` — fuzzy fallback. With a query, runs the best match directly.
  // Without, opens the command palette so the user can browse.
  Vim.defineEx(
    'cmd',
    'cmd',
    (_cm: unknown, params: { argString?: string } | undefined) => {
      const query = (params?.argString ?? '').trim()
      if (!query) {
        useStore.getState().setCommandPaletteOpen(true)
        return
      }
      const commands = buildCommands()
      const ranked = rankItems(commands, query, [
        { get: (c) => c.title, weight: 1 },
        { get: (c) => c.keywords ?? '', weight: 0.6 },
        { get: (c) => c.category, weight: 0.4 }
      ])
      const first = ranked.find((c) => !c.when || c.when())
      if (first) runCommand(first)
    }
  )
  names.add('cmd')

  // `:commands` — alias that always opens the palette (no implicit run).
  Vim.defineEx('commands', 'commands', () => {
    useStore.getState().setCommandPaletteOpen(true)
  })
  names.add('commands')

  registeredExNames.splice(0, registeredExNames.length, ...names)
  registeredExNames.sort()
  installExTabCompletion()
}

let exTabListenerInstalled = false

// ---------------------------------------------------------------------------
// Wildmenu popup — shown above the ex prompt while Tab completion is active
// ---------------------------------------------------------------------------

interface Wildmenu {
  root: HTMLDivElement
  list: HTMLDivElement
  /** Max number of rows to render — keeps the popup from taking over the
   *  screen when the prefix is empty and every command matches. */
  maxRows: number
}

let wildmenu: Wildmenu | null = null

function ensureWildmenu(): Wildmenu {
  if (wildmenu) return wildmenu
  const root = document.createElement('div')
  root.className = 'zen-ex-wildmenu'
  root.setAttribute('role', 'listbox')
  root.style.cssText = [
    'position: fixed',
    'z-index: 60',
    'display: none',
    'max-width: min(520px, 90vw)',
    'max-height: 40vh',
    'overflow-y: auto',
    'border-radius: 10px',
    'padding: 4px',
    'background: rgb(var(--z-bg-softer) / 0.98)',
    'border: 1px solid rgb(var(--z-bg-3) / 0.6)',
    'box-shadow: 0 10px 30px rgba(0,0,0,0.35)',
    'font: 12px/1.4 var(--z-mono-font, ui-monospace, Menlo, monospace)',
    'color: rgb(var(--z-fg))',
    'backdrop-filter: blur(6px)'
  ].join(';')

  const list = document.createElement('div')
  list.style.cssText = 'display: flex; flex-direction: column; gap: 1px'
  root.appendChild(list)
  document.body.appendChild(root)

  wildmenu = { root, list, maxRows: 200 }
  return wildmenu
}

function hideWildmenu(): void {
  if (wildmenu) wildmenu.root.style.display = 'none'
}

function positionWildmenu(anchor: HTMLElement): void {
  if (!wildmenu) return
  const panel = anchor.closest('.cm-vim-panel') as HTMLElement | null
  const target = panel ?? anchor
  const rect = target.getBoundingClientRect()
  wildmenu.root.style.left = `${Math.max(8, Math.round(rect.left))}px`
  // Anchor above the ex panel (vim wildmenu convention). Keep at least 8px
  // from the top edge so it doesn't bump into the title bar.
  const bottom = Math.max(8, Math.round(window.innerHeight - rect.top) + 6)
  wildmenu.root.style.bottom = `${bottom}px`
  wildmenu.root.style.right = ''
  wildmenu.root.style.top = ''
}

interface ExCompletionMatch {
  label: string
  apply: string
}

function renderWildmenu(matches: ExCompletionMatch[], cycleIdx: number, anchor: HTMLElement): void {
  const menu = ensureWildmenu()
  if (matches.length === 0) {
    menu.root.style.display = 'none'
    return
  }
  // Defensive cap — `:` + Tab with empty prefix matches every registered
  // command (90+ of them). Rendering them all is fine, but we still cap
  // to avoid a pathological case if the registry balloons later.
  const slice = matches.slice(0, menu.maxRows)

  menu.list.innerHTML = ''
  slice.forEach((match, i) => {
    const row = document.createElement('div')
    row.textContent = match.label
    row.dataset.idx = String(i)
    const isActive = i === cycleIdx
    row.style.cssText = [
      'padding: 3px 8px',
      'border-radius: 6px',
      'white-space: nowrap',
      isActive
        ? 'background: rgb(var(--z-accent) / 0.85); color: white'
        : 'color: rgb(var(--z-fg))'
    ].join(';')
    menu.list.appendChild(row)
  })
  // Surface a small footer when we had to truncate — lets the user know
  // they should type more to filter rather than keep tabbing forever.
  if (matches.length > slice.length) {
    const more = document.createElement('div')
    more.textContent = `+${matches.length - slice.length} more — type to filter`
    more.style.cssText =
      'padding: 4px 8px 2px; font-size: 10px; opacity: 0.6; color: rgb(var(--z-fg))'
    menu.list.appendChild(more)
  }
  menu.root.style.display = 'block'
  positionWildmenu(anchor)

  const activeRow = menu.list.querySelector<HTMLDivElement>(
    `[data-idx="${cycleIdx}"]`
  )
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' })
}

/**
 * Per-session tab-completion state. Keyed on the current ex-prompt input
 * element — a fresh cycle starts every time the user mutates the value
 * by typing (non-Tab keys reset), or whenever a different input element
 * takes over (new pane, re-opened prompt).
 */
interface ExTabCycle {
  input: HTMLInputElement
  /** The user-typed text that seeded the current cycle. `null` signals
   *  "cycle expired, next Tab starts fresh" (so an empty-string base
   *  prefix — valid when the user presses Tab with nothing typed — is
   *  not accidentally treated as expired). */
  basePrefix: string | null
  matches: ExCompletionMatch[]
  cycleIdx: number
}

let exCycle: ExTabCycle | null = null

function completeCommandArgs(
  input: string,
  command: string,
  options: string[]
): ExCompletionMatch[] | null {
  const match = input.match(/^([A-Za-z0-9_]+)(\s+)([^ ]*)$/)
  if (!match) return null
  const [, commandName, whitespace, argPrefix] = match
  if (commandName.toLowerCase() !== command) return null
  const filtered = argPrefix
    ? options.filter((option) => option.startsWith(argPrefix.toLowerCase()))
    : options
  return filtered.map((option) => ({
    label: option,
    apply: `${commandName}${whitespace}${option}`
  }))
}

function computeExMatches(prefix: string): ExCompletionMatch[] {
  const argMatches =
    completeCommandArgs(prefix, 'view', ['edit', 'split', 'preview']) ??
    completeCommandArgs(prefix, 'zen', ['toggle', 'on', 'off'])
  if (argMatches) return argMatches
  if (!prefix) {
    return registeredExNames.map((name) => ({ label: name, apply: name }))
  }
  return registeredExNames
    .filter((n) => n.startsWith(prefix))
    .map((name) => ({ label: name, apply: name }))
}

/**
 * Global capture-phase Tab interceptor for the CodeMirror-Vim ex prompt.
 *
 * Keystrokes on the prompt input bubble up like any DOM event, but CM-Vim
 * also registers its own keydown listener on the same input. When two
 * listeners share a target, they fire in registration order — meaning
 * CM-Vim's fires first and can call `stopImmediatePropagation` to hide
 * Shift+Tab from us. Installing at `window` with `capture: true` hoists
 * us to the document-wide capture phase, which runs BEFORE any target-
 * level listener. We then opt into the events whose target matches the
 * ex-prompt input (checked via a CSS selector) and leave everything else
 * alone.
 *
 * Tab advances through commands matching the current prefix; Shift+Tab
 * walks back; any other key resets the cycle. First-Tab lands on the
 * first match, first-Shift-Tab on the last — matches vim's wildmenu.
 */
function installExTabCompletion(): void {
  if (exTabListenerInstalled) return
  exTabListenerInstalled = true
  if (typeof window === 'undefined') return

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab') {
        // Reset cycle state when the user types anything else — but only
        // if the event target IS the ex prompt input. Keys elsewhere in
        // the app shouldn't clobber our state (modifier keys fire even
        // when the input is focused too, so we ignore those explicitly
        // instead of resetting on them).
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
          return
        }
        const target = e.target as HTMLElement | null
        if (target && target instanceof HTMLInputElement) {
          if (target.closest('.cm-vim-panel')) {
            // Mark the cycle as expired so the next Tab re-seeds from
            // the freshly-typed prefix. `null` means "no cycle in
            // progress" — an empty-string prefix would look identical
            // to the legitimate "Tab with no input" case.
            if (exCycle && exCycle.input === target) exCycle.basePrefix = null
            // Enter / Escape / navigation keys dismiss the popup. Plain
            // character input also hides it — we want a clean slate on
            // the next Tab so the popup reflects the new prefix.
            hideWildmenu()
          }
        }
        return
      }

      const target = e.target as HTMLElement | null
      if (!target || !(target instanceof HTMLInputElement)) return
      if (!target.closest('.cm-vim-panel')) return

      // This is our prompt — take over Tab handling entirely.
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()

      const step = e.shiftKey ? -1 : 1
      const fresh = !exCycle || exCycle.input !== target || exCycle.basePrefix === null

      if (fresh) {
        exCycle = {
          input: target,
          // Seed from whatever the user typed. `target.value` is the
          // current content of the prompt, which on a fresh cycle is
          // exactly the prefix we want to filter by.
          basePrefix: target.value,
          matches: computeExMatches(target.value),
          cycleIdx: step === 1 ? 0 : -1 // sentinel; normalized below
        }
      } else if (exCycle) {
        exCycle.cycleIdx += step
      }

      const cycle = exCycle
      if (!cycle || cycle.matches.length === 0) {
        hideWildmenu()
        return
      }
      const n = cycle.matches.length
      const idx = ((cycle.cycleIdx % n) + n) % n
      cycle.cycleIdx = idx
      const match = cycle.matches[idx]
      // Mutate the input value directly. We deliberately DO NOT dispatch
      // a synthetic input event here: CM6's panel StateField reacts to
      // input events by re-evaluating the panel provider, which tears
      // down and re-creates the `.cm-vim-panel` DOM — including a fresh
      // `<input>`. That would invalidate exCycle.input on the very next
      // Tab, restarting the cycle at match 0. Submission reads
      // `inp.value` directly, so skipping the event is safe.
      target.value = match.apply
      target.focus()
      target.setSelectionRange(match.apply.length, match.apply.length)
      // Render / refresh the wildmenu with the highlighted match.
      renderWildmenu(cycle.matches, idx, target)
    },
    true
  )

  // Hide the wildmenu when the ex prompt's own input is detached from
  // the document. Checking `isConnected` sidesteps false positives from
  // CodeMirror re-parenting unrelated DOM around the panel (which would
  // otherwise null `exCycle` mid-completion and reset the cycle every
  // Tab press).
  const observer = new MutationObserver(() => {
    if (exCycle && !exCycle.input.isConnected) {
      exCycle = null
      hideWildmenu()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // Keep the wildmenu positioned correctly if the window resizes mid-
  // completion (e.g. user toggles sidebar while the prompt is open).
  window.addEventListener('resize', () => {
    if (exCycle && wildmenu?.root.style.display === 'block') {
      positionWildmenu(exCycle.input)
    }
  })
}

export function Editor(): JSX.Element {
  const paneLayout = useStore((s) => s.paneLayout)
  const activeNote = useStore((s) => s.activeNote)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const zenMode = useStore((s) => s.zenMode)

  useEffect(() => {
    registerVimCommands()
  }, [])

  useEffect(() => {
    registerVimCommands()
    syncVimKeymaps(keymapOverrides)
  }, [keymapOverrides])

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
        <PaneTreeView node={paneLayout} />
      </div>
      {!zenMode && activeNote && <StatusBar note={activeNote} />}
    </section>
  )
}

function PaneTreeView({ node }: { node: PaneLayout }): JSX.Element {
  if (node.kind === 'leaf') {
    return <EditorPane pane={node} />
  }
  return <PaneSplitView split={node} />
}

function PaneSplitView({ split }: { split: PaneSplit }): JSX.Element {
  const resizeSplit = useStore((s) => s.resizeSplit)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isRow = split.direction === 'row'

  const dragState = useRef<{
    index: number
    startClient: number
    startSizes: number[]
    totalPx: number
  } | null>(null)

  const onHandleMouseDown = useCallback(
    (handleIndex: number) => (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current) return
      e.preventDefault()
      const rect = containerRef.current.getBoundingClientRect()
      const totalPx = isRow ? rect.width : rect.height
      dragState.current = {
        index: handleIndex,
        startClient: isRow ? e.clientX : e.clientY,
        startSizes: split.sizes.slice(),
        totalPx
      }
      const onMove = (ev: MouseEvent): void => {
        const st = dragState.current
        if (!st) return
        const delta = (isRow ? ev.clientX : ev.clientY) - st.startClient
        const deltaRatio = st.totalPx > 0 ? delta / st.totalPx : 0
        const next = st.startSizes.slice()
        const min = 0.08
        const a = next[st.index]
        const b = next[st.index + 1]
        const sum = a + b
        let newA = a + deltaRatio
        let newB = b - deltaRatio
        if (newA < min) {
          newA = min
          newB = sum - min
        }
        if (newB < min) {
          newB = min
          newA = sum - min
        }
        next[st.index] = newA
        next[st.index + 1] = newB
        resizeSplit(split.id, next)
      }
      const onUp = (): void => {
        dragState.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.cursor = isRow ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [isRow, resizeSplit, split.id, split.sizes]
  )

  const nodes = useMemo(() => {
    const out: JSX.Element[] = []
    split.children.forEach((child, i) => {
      const basis = split.sizes[i] ?? 1 / split.children.length
      out.push(
        <div
          key={child.id}
          className={['flex min-h-0 min-w-0', isRow ? '' : 'flex-col'].join(' ')}
          style={{ flex: `${basis} 1 0`, minWidth: 0, minHeight: 0 }}
        >
          <PaneTreeView node={child} />
        </div>
      )
      if (i < split.children.length - 1) {
        out.push(
          <ResizeDivider
            key={`handle-${child.id}`}
            orientation={isRow ? 'vertical' : 'horizontal'}
            onMouseDown={onHandleMouseDown(i)}
          />
        )
      }
    })
    return out
  }, [isRow, onHandleMouseDown, split.children, split.sizes])

  return (
    <div
      ref={containerRef}
      className={['flex min-h-0 min-w-0 flex-1', isRow ? 'flex-row' : 'flex-col'].join(' ')}
    >
      {nodes}
    </div>
  )
}

/**
 * Draggable divider between pane-split children. The element itself is
 * 1 logical pixel and positions its own wider hit zone via a pseudo
 * overlay so dragging feels forgiving without stealing real layout space.
 */
function ResizeDivider({
  orientation,
  onMouseDown
}: {
  orientation: 'vertical' | 'horizontal'
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
}): JSX.Element {
  const isVertical = orientation === 'vertical'
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      onMouseDown={onMouseDown}
      className={[
        'group relative z-10 shrink-0 select-none bg-paper-300/70 transition-colors hover:bg-accent/60 active:bg-accent',
        isVertical
          ? 'w-px cursor-col-resize'
          : 'h-px cursor-row-resize'
      ].join(' ')}
    >
      {/* Wider hit zone centered on the divider line. */}
      <div
        className={[
          'absolute',
          isVertical
            ? 'top-0 bottom-0 -left-1 w-[9px]'
            : 'left-0 right-0 -top-1 h-[9px]'
        ].join(' ')}
      />
    </div>
  )
}
