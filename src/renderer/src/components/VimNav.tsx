import { useCallback, useEffect, useRef, useState } from 'react'
import { isTagsViewActive, isTasksViewActive, useStore } from '../store'
import { HintOverlay } from './HintOverlay'
import { WhichKeyOverlay, type WhichKeyItem } from './WhichKeyOverlay'
import {
  getVisiblePanels,
  isEditorInsertMode,
  isEditorFocused,
  resolveNextPanel
} from '../lib/vim-nav'
import { focusPaneInDirection } from '../lib/pane-nav'
import {
  advanceSequence,
  getKeymapBinding,
  getKeymapDisplay,
  getSequenceTokens,
  matchesSequenceToken,
  sequenceTokenFromEvent
} from '../lib/keymaps'

function escapeForAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

/**
 * Global vim-style keyboard navigation layer.
 *
 * Uses refs (not React state) for all internal flags so the capture-phase
 * keydown handler always reads the latest values — no stale closures, no
 * dependency on React re-renders between keystrokes.
 */
export function VimNav(): JSX.Element | null {
  const vimMode = useStore((s) => s.vimMode)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  // All control-flow flags are refs so the handler never stales.
  const ctrlWPending = useRef(false)
  const jumpTopPending = useRef(0)
  const leaderPending = useRef<'leader' | 'leader-l' | null>(null)
  const ctrlWTimer = useRef<ReturnType<typeof setTimeout>>()
  const jumpTopTimer = useRef<ReturnType<typeof setTimeout>>()
  const leaderTimer = useRef<ReturnType<typeof setTimeout>>()

  // Hint mode needs a render (to mount HintOverlay), so it's state.
  const [hintActive, setHintActive] = useState(false)
  const [whichKeyState, setWhichKeyState] = useState<{
    stage: 'leader' | 'leader-l'
    allowEditorActions: boolean
  } | null>(null)
  const hintRef = useRef(false)
  const setHint = useCallback((v: boolean) => {
    hintRef.current = v
    setHintActive(v)
  }, [])
  const exitHints = useCallback(() => setHint(false), [setHint])
  const focusEditor = useCallback(() => {
    const state = useStore.getState()
    state.setFocusedPanel('editor')
    state.editorViewRef?.focus()
  }, [])
  const jumpNoteHistory = useCallback((direction: 'back' | 'forward') => {
    const state = useStore.getState()
    const previewEl = getPreviewScrollElement()
    const activeTarget = document.activeElement as HTMLElement | null
    const keepPreviewFocus = previewEl
      ? isPreviewNavigationActive(previewEl, state, activeTarget)
      : false
    const jump =
      direction === 'back' ? state.jumpToPreviousNote : state.jumpToNextNote
    void jump().then(() => {
      const latest = useStore.getState()
      if (!latest.activeNote) return
      latest.setFocusedPanel('editor')
      requestAnimationFrame(() => {
        if (keepPreviewFocus) {
          getPreviewScrollElement()?.focus()
          return
        }
        useStore.getState().editorViewRef?.focus()
      })
    })
  }, [])
  const cancelHints = useCallback(() => {
    setHint(false)
    focusEditor()
  }, [focusEditor, setHint])
  const whichKeyHintsPref = useStore((s) => s.whichKeyHints)
  const whichKeyHintMode = useStore((s) => s.whichKeyHintMode)
  const whichKeyHintTimeoutMs = useStore((s) => s.whichKeyHintTimeoutMs)
  const whichKeyHintsEnabled = vimMode && whichKeyHintsPref
  const stickyWhichKeyHints = whichKeyHintsEnabled && whichKeyHintMode === 'sticky'
  const resetLeader = useCallback(() => {
    leaderPending.current = null
    if (leaderTimer.current) clearTimeout(leaderTimer.current)
    setWhichKeyState(null)
  }, [])
  const armLeader = useCallback(
    (stage: 'leader' | 'leader-l', allowEditorActions: boolean) => {
      leaderPending.current = stage
      setWhichKeyState({ stage, allowEditorActions })
      if (leaderTimer.current) clearTimeout(leaderTimer.current)
      if (!stickyWhichKeyHints) {
        leaderTimer.current = setTimeout(() => {
          leaderPending.current = null
          setWhichKeyState(null)
        }, whichKeyHintTimeoutMs)
      }
    },
    [stickyWhichKeyHints, whichKeyHintTimeoutMs]
  )

  const whichKeyItems: WhichKeyItem[] = (() => {
    if (!whichKeyState) return []
    if (whichKeyState.stage === 'leader-l') {
      return [
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderFormatNote'),
        label: 'Format note',
        detail: 'Run markdown formatting on the active note.'
      }
      ]
    }

    const items: WhichKeyItem[] = [
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderOpenBuffers'),
        label: 'Open buffers',
        detail: 'Show the active pane’s open buffers in a searchable list.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderSearchNotes'),
        label: 'Search notes',
        detail: 'Open the vault-wide note search palette.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderToggleSidebar'),
        label: 'Toggle sidebar',
        detail: 'Show or hide the left sidebar.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderNoteOutline'),
        label: 'Note outline',
        detail: 'Jump to any heading in the active note.'
      }
    ]
    if (whichKeyState.allowEditorActions) {
      items.push({
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderNoteActions'),
        label: 'Note actions',
        detail: 'Open the note-local leader group. `f` formats the current note.'
      })
    }
    return items
  })()

  useEffect(() => {
    if (vimMode) return
    ctrlWPending.current = false
    jumpTopPending.current = 0
    if (ctrlWTimer.current) clearTimeout(ctrlWTimer.current)
    if (jumpTopTimer.current) clearTimeout(jumpTopTimer.current)
    if (leaderTimer.current) clearTimeout(leaderTimer.current)
    resetLeader()
    setHint(false)
  }, [resetLeader, setHint, vimMode])

  useEffect(() => {
    if (!vimMode) return
    const handler = (e: KeyboardEvent): void => {
      const state = useStore.getState()
      const overrides = state.keymapOverrides
      const leaderToken = getSequenceTokens(overrides, 'vim.leaderPrefix')[0] ?? 'Space'
      const panePrefixToken = getSequenceTokens(overrides, 'vim.panePrefix')[0] ?? 'Ctrl+W'

      // Skip when modals / overlays are open
      if (
        state.searchOpen ||
        state.settingsOpen ||
        state.commandPaletteOpen ||
        state.bufferPaletteOpen
      ) return
      if (document.querySelector('[data-ctx-menu]') || document.querySelector('[data-prompt-modal]')) return

      // Hint mode — handled entirely by HintOverlay's own listener
      if (hintRef.current) return

      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      // Never steal keys from normal text-entry fields such as the
      // inline note title, prompt inputs, or textarea-based controls.
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // CodeMirror's editor surface is contenteditable; keep global
      // hint/navigation bindings working there. Only skip other
      // unrelated contenteditable widgets.
      if (
        target?.isContentEditable &&
        (!state.editorViewRef || !state.editorViewRef.dom.contains(target))
      ) {
        return
      }
      const previewEl = getPreviewScrollElement()
      const hoverPreviewEl = getHoverPreviewScrollElement()

      const wantsJumpBack = matchesSequenceToken(e, overrides, 'vim.historyBack')
      const wantsJumpForward = matchesSequenceToken(e, overrides, 'vim.historyForward')
      if (
        (wantsJumpBack || wantsJumpForward) &&
        !isEditorInsertMode(state.editorViewRef, state.vimMode)
      ) {
        e.preventDefault()
        e.stopImmediatePropagation()
        jumpNoteHistory(wantsJumpBack ? 'back' : 'forward')
        return
      }

      // ------- Ctrl+w pending → resolve panel / pane switch ------------
      if (ctrlWPending.current) {
        e.preventDefault()
        e.stopImmediatePropagation()
        ctrlWPending.current = false
        if (ctrlWTimer.current) clearTimeout(ctrlWTimer.current)

        // <C-w>v / <C-w>s → vim-style splits. Clones the active pane's
        // current tab into a new pane. Works for any tab, including the
        // virtual Tasks tab (no CM editor required to fire `:vs`/`:sp`).
        if (
          matchesSequenceToken(e, overrides, 'vim.paneSplitRight') ||
          matchesSequenceToken(e, overrides, 'vim.paneSplitDown')
        ) {
          const activePath = state.selectedPath
          if (activePath) {
            void state.splitPaneWithTab({
              targetPaneId: state.activePaneId,
              edge: matchesSequenceToken(e, overrides, 'vim.paneSplitRight') ? 'right' : 'bottom',
              path: activePath
            })
          }
          return
        }

        // When focus is in the editor and we have multiple panes in the
        // split tree, try pane-internal navigation first. If a neighbor
        // pane exists in the requested direction, jump to it and stop.
        // Falling through to panel nav only happens at the tree edge.
        const paneDir =
          matchesSequenceToken(e, overrides, 'vim.paneFocusLeft') || e.key === 'ArrowLeft'
            ? 'h'
            : matchesSequenceToken(e, overrides, 'vim.paneFocusRight') || e.key === 'ArrowRight'
              ? 'l'
              : matchesSequenceToken(e, overrides, 'vim.paneFocusDown') || e.key === 'ArrowDown'
                ? 'j'
                : matchesSequenceToken(e, overrides, 'vim.paneFocusUp') || e.key === 'ArrowUp'
                  ? 'k'
                  : null
        if (
          paneDir &&
          (state.focusedPanel === 'editor' || state.focusedPanel === null) &&
          focusPaneInDirection(paneDir)
        ) {
          return
        }

        const panels = getVisiblePanels(
          state.sidebarOpen,
          state.noteListOpen,
          state.unifiedSidebar,
          document.querySelector('[data-connections-panel]') !== null,
          isTasksViewActive(state)
        )
        const direction =
          matchesSequenceToken(e, overrides, 'vim.paneFocusLeft') ||
          matchesSequenceToken(e, overrides, 'vim.paneFocusUp') ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowUp'
            ? 'left'
            : matchesSequenceToken(e, overrides, 'vim.paneFocusRight') ||
                matchesSequenceToken(e, overrides, 'vim.paneFocusDown') ||
                e.key === 'ArrowRight' ||
                e.key === 'ArrowDown'
              ? 'right'
              : null
        const currentPanel = state.focusedPanel === 'hoverpreview' ? 'connections' : state.focusedPanel
        const next = direction ? resolveNextPanel(currentPanel, direction, panels) : null
        if (!next) return

        if (next === 'sidebar' && !state.sidebarOpen) state.toggleSidebar()
        state.setFocusedPanel(next)
        if (next === 'editor') {
          state.editorViewRef?.focus()
        } else if (next === 'tasks') {
          // Tasks panel doesn't own a single focusable element — its
          // keyboard handler fires off window keydown. Just blur whatever
          // had DOM focus so the sidebar/notelist stop intercepting keys.
          ;(document.activeElement as HTMLElement)?.blur()
        } else {
          // Steal focus away from the editor so it stops processing keys
          ;(document.activeElement as HTMLElement)?.blur()
          requestAnimationFrame(() => {
            const selector =
              next === 'sidebar'
                ? '[data-sidebar-idx]'
                : next === 'notelist'
                  ? '[data-notelist-idx]'
                  : '[data-connections-idx]'
            const datasetKey =
              next === 'sidebar'
                ? 'sidebarIdx' as const
                : next === 'notelist'
                  ? 'notelistIdx' as const
                  : 'connectionsIdx' as const
            const cursorIndex =
              next === 'sidebar'
                ? state.sidebarCursorIndex
                : next === 'notelist'
                  ? state.noteListCursorIndex
                  : state.connectionsCursorIndex
            const setIndex =
              next === 'sidebar'
                ? state.setSidebarCursorIndex
                : next === 'notelist'
                  ? state.setNoteListCursorIndex
                  : state.setConnectionsCursorIndex
            const items = getIndexedElements(selector, datasetKey)
            if (items.length > 0) {
              const pos = findPositionByIndex(items, datasetKey, cursorIndex)
              scrollToIndexedElement(items[pos], datasetKey, setIndex)
            }
          })
        }
        return
      }

      // ------- Ctrl+w initiation ----------------------------------------
      if (sequenceTokenFromEvent(e) === panePrefixToken) {
        if (isEditorFocused(state.editorViewRef) && isEditorInsertMode(state.editorViewRef, state.vimMode)) return
        e.preventDefault()
        e.stopImmediatePropagation()
        ctrlWPending.current = true
        if (ctrlWTimer.current) clearTimeout(ctrlWTimer.current)
        ctrlWTimer.current = setTimeout(() => { ctrlWPending.current = false }, 800)
        return
      }

      // ------- Tasks / Tag view active → defer to its own window handler
      // Both panels install capture-phase window keydowns that handle
      // j/k/gg/G/Enter/o/Esc/etc. themselves. We bail here so VimNav
      // doesn't swallow those keys with stale sidebar routing. Exception:
      // let `f` (hint mode) fall through — a global affordance that
      // should still work anywhere, and its handler sits further down.
      if (leaderPending.current && e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        resetLeader()
        return
      }
      if (
        leaderPending.current &&
        sequenceTokenFromEvent(e) === leaderToken
      ) {
        e.preventDefault()
        e.stopImmediatePropagation()
        resetLeader()
        return
      }
      const panelViewActive = isTasksViewActive(state) || isTagsViewActive(state)
      if (panelViewActive && e.key !== 'f') {
        return
      }

      // ------- Global leader handling -----------------------------------
      // Runs before per-panel routing so <Space>-prefixed shortcuts work
      // from any focus context (sidebar, note list, editor, …). Editor-
      // specific leader chains (leader-l-f for format) still require an
      // editor in normal mode; the others are purely UI actions.
      const editorNormalMode =
        isEditorFocused(state.editorViewRef) &&
        !isEditorInsertMode(state.editorViewRef, state.vimMode)
      const editorInsertMode =
        isEditorFocused(state.editorViewRef) &&
        isEditorInsertMode(state.editorViewRef, state.vimMode)

      if (leaderPending.current === 'leader') {
        if (matchesSequenceToken(e, overrides, 'vim.leaderOpenBuffers')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.setBufferPaletteOpen(true)
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderSearchNotes')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.setSearchOpen(true)
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderToggleSidebar')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.toggleSidebar()
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderNoteOutline')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.setOutlinePaletteOpen(true)
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderNoteActions') && editorNormalMode) {
          e.preventDefault()
          e.stopImmediatePropagation()
          armLeader('leader-l', true)
          return
        }
        // Any other key cancels leader and falls through to normal routing.
        resetLeader()
      }

      if (leaderPending.current === 'leader-l') {
        if (matchesSequenceToken(e, overrides, 'vim.leaderFormatNote') && editorNormalMode) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          void state.formatActiveNote()
          return
        }
        resetLeader()
      }

      if (
        sequenceTokenFromEvent(e) === leaderToken &&
        !editorInsertMode
      ) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault()
          e.stopImmediatePropagation()
          armLeader('leader', editorNormalMode)
          return
        }
      }

      // ------- Sidebar navigation (explicit) -----------------------------
      // When focusedPanel is 'sidebar', always handle here — even if the
      // editor still holds stale DOM focus from a previous interaction.
      if (state.focusedPanel === 'sidebar') {
        handleSidebarKey(e, state)
        return
      }

      if (state.focusedPanel === 'connections') {
        handleConnectionsKey(e, state)
        return
      }

      if (hoverPreviewEl && state.focusedPanel === 'hoverpreview') {
        handleHoverPreviewKey(e, hoverPreviewEl, state)
        return
      }

      // ------- Editor focused -------------------------------------------
      if (isEditorFocused(state.editorViewRef)) {
        if (isEditorInsertMode(state.editorViewRef, state.vimMode)) {
          resetLeader()
        }

        if (
          matchesSequenceToken(e, overrides, 'vim.hintMode') &&
          !isEditorInsertMode(state.editorViewRef, state.vimMode)
        ) {
          e.preventDefault()
          e.stopImmediatePropagation()
          setHint(true)
        }
        return
      }

      resetLeader()

      // ------- Preview navigation --------------------------------------
      if (previewEl && isPreviewNavigationActive(previewEl, state, target)) {
        handlePreviewKey(e, previewEl, state)
        return
      }

      // ------- NoteList navigation --------------------------------------
      if (state.focusedPanel === 'notelist') {
        handleNoteListKey(e, state)
        return
      }

      // ------- Sidebar navigation — editor doesn't have DOM focus, so
      //         route to sidebar whenever it's open (regardless of
      //         focusedPanel, which can get stale via focus events) --------
      if (state.sidebarOpen) {
        handleSidebarKey(e, state)
        return
      }

      // ------- No panel focused → f for hints ---------------------------
      if (matchesSequenceToken(e, overrides, 'vim.hintMode')) {
        const tag = (document.activeElement as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        e.stopImmediatePropagation()
        setHint(true)
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
      resetLeader()
    }
  }, [armLeader, jumpNoteHistory, resetLeader, setHint, vimMode]) // ← stable dep, handler never re-registers unnecessarily

  // ---- Key handlers (called from the single persistent handler) --------

  function handleSidebarKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    const overrides = state.keymapOverrides
    if (state.focusedPanel !== 'sidebar') state.setFocusedPanel('sidebar')
    const items = getIndexedElements('[data-sidebar-idx]', 'sidebarIdx')
    const count = items.length
    const max = count - 1
    const currentPos = findPositionByIndex(items, 'sidebarIdx', state.sidebarCursorIndex)
    const wantsContextMenu =
      matchesSequenceToken(e, overrides, 'nav.contextMenu') ||
      key === 'ContextMenu' ||
      (e.shiftKey && key === 'F10')

    // Always consume single-char nav keys when sidebar is focused,
    // even if the sidebar is empty — prevents them leaking to the editor.
    const wantsHandledKey =
      matchesSequenceToken(e, overrides, 'nav.moveDown') ||
      matchesSequenceToken(e, overrides, 'nav.moveUp') ||
      matchesSequenceToken(e, overrides, 'nav.jumpBottom') ||
      sequenceTokenFromEvent(e) === getSequenceTokens(overrides, 'nav.jumpTop')[0] ||
      matchesSequenceToken(e, overrides, 'nav.openSideItem') ||
      matchesSequenceToken(e, overrides, 'nav.back') ||
      matchesSequenceToken(e, overrides, 'nav.toggleFolder') ||
      matchesSequenceToken(e, overrides, 'nav.filter') ||
      matchesSequenceToken(e, overrides, 'vim.hintMode') ||
      key === 'Enter' ||
      key === 'Escape' ||
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight' ||
      wantsContextMenu
    if (wantsHandledKey) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return // not a nav key, let it through
    }

    if (count === 0) return // nothing to navigate

    if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
      scrollToIndexedElement(items[Math.min(currentPos + 1, max)], 'sidebarIdx', state.setSidebarCursorIndex)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
      scrollToIndexedElement(items[Math.max(currentPos - 1, 0)], 'sidebarIdx', state.setSidebarCursorIndex)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
      scrollToIndexedElement(items[max], 'sidebarIdx', state.setSidebarCursorIndex)
      return
    }
    if (
      advanceSequence(
        e,
        getKeymapBinding(overrides, 'nav.jumpTop'),
        jumpTopPending,
        jumpTopTimer,
        () => {
          scrollToIndexedElement(items[0], 'sidebarIdx', state.setSidebarCursorIndex)
        },
        () => {
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        300
      )
    ) {
      return
    }
    if (key === 'Enter' || matchesSequenceToken(e, overrides, 'nav.openSideItem') || key === 'ArrowRight') {
      activateSidebarItem(items[currentPos], state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.back') || key === 'ArrowLeft') {
      collapseSidebarItem(items[currentPos], state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.toggleFolder')) {
      toggleSidebarItem(items[currentPos], state)
      return
    }
    if (key === 'Escape') {
      focusEditor()
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.filter')) {
      state.setSearchOpen(true)
      return
    }
    if (matchesSequenceToken(e, overrides, 'vim.hintMode')) {
      setHint(true)
      return
    }
    if (wantsContextMenu) {
      openContextMenuForIndexedElement(items[currentPos])
      return
    }
  }

  function handleNoteListKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    const overrides = state.keymapOverrides
    const items = getIndexedElements('[data-notelist-idx]', 'notelistIdx')
    const count = items.length
    const max = count - 1
    const currentPos = findPositionByIndex(items, 'notelistIdx', state.noteListCursorIndex)

    const wantsHandledKey =
      matchesSequenceToken(e, overrides, 'nav.moveDown') ||
      matchesSequenceToken(e, overrides, 'nav.moveUp') ||
      matchesSequenceToken(e, overrides, 'nav.jumpBottom') ||
      sequenceTokenFromEvent(e) === getSequenceTokens(overrides, 'nav.jumpTop')[0] ||
      matchesSequenceToken(e, overrides, 'nav.openSideItem') ||
      matchesSequenceToken(e, overrides, 'nav.back') ||
      matchesSequenceToken(e, overrides, 'nav.filter') ||
      matchesSequenceToken(e, overrides, 'vim.hintMode') ||
      key === 'Enter' ||
      key === 'Escape' ||
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight'
    if (wantsHandledKey) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return
    }

    if (count === 0) return

    if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
      scrollToIndexedElement(
        items[Math.min(currentPos + 1, max)],
        'notelistIdx',
        state.setNoteListCursorIndex
      )
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
      scrollToIndexedElement(
        items[Math.max(currentPos - 1, 0)],
        'notelistIdx',
        state.setNoteListCursorIndex
      )
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
      scrollToIndexedElement(items[max], 'notelistIdx', state.setNoteListCursorIndex)
      return
    }
    if (
      advanceSequence(
        e,
        getKeymapBinding(overrides, 'nav.jumpTop'),
        jumpTopPending,
        jumpTopTimer,
        () => {
          scrollToIndexedElement(items[0], 'notelistIdx', state.setNoteListCursorIndex)
        },
        () => {
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        300
      )
    ) {
      return
    }
    if (key === 'Enter' || matchesSequenceToken(e, overrides, 'nav.openSideItem') || key === 'ArrowRight') {
      const el = items[currentPos]
      const path = el?.dataset.notelistPath
      if (path) {
        void state.selectNote(path)
        focusEditor()
      }
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.back') || key === 'ArrowLeft') {
      if (state.sidebarOpen) state.setFocusedPanel('sidebar')
      return
    }
    if (key === 'Escape') {
      focusEditor()
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.filter')) {
      state.setSearchOpen(true)
      return
    }
    if (matchesSequenceToken(e, overrides, 'vim.hintMode')) {
      setHint(true)
      return
    }
  }

  function handleConnectionsKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    const overrides = state.keymapOverrides
    const items = getIndexedElements('[data-connections-idx]', 'connectionsIdx')
    const count = items.length
    const max = count - 1
    const currentPos = findPositionByIndex(items, 'connectionsIdx', state.connectionsCursorIndex)
    const wantsHandledKey =
      matchesSequenceToken(e, overrides, 'nav.moveDown') ||
      matchesSequenceToken(e, overrides, 'nav.moveUp') ||
      matchesSequenceToken(e, overrides, 'nav.jumpBottom') ||
      sequenceTokenFromEvent(e) === getSequenceTokens(overrides, 'nav.jumpTop')[0] ||
      matchesSequenceToken(e, overrides, 'nav.openSideItem') ||
      matchesSequenceToken(e, overrides, 'nav.back') ||
      matchesSequenceToken(e, overrides, 'nav.peekPreview') ||
      key === 'Enter' ||
      key === 'Escape' ||
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight'
    if (wantsHandledKey) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return
    }

    if (count === 0) {
      if (key === 'Escape' || matchesSequenceToken(e, overrides, 'nav.back') || key === 'ArrowLeft') {
        state.setConnectionPreview(null)
        focusEditor()
      }
      return
    }

    if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
      state.setConnectionPreview(null)
      scrollToIndexedElement(
        items[Math.min(currentPos + 1, max)],
        'connectionsIdx',
        state.setConnectionsCursorIndex
      )
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
      state.setConnectionPreview(null)
      scrollToIndexedElement(
        items[Math.max(currentPos - 1, 0)],
        'connectionsIdx',
        state.setConnectionsCursorIndex
      )
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
      state.setConnectionPreview(null)
      scrollToIndexedElement(items[max], 'connectionsIdx', state.setConnectionsCursorIndex)
      return
    }
    if (
      advanceSequence(
        e,
        getKeymapBinding(overrides, 'nav.jumpTop'),
        jumpTopPending,
        jumpTopTimer,
        () => {
          state.setConnectionPreview(null)
          scrollToIndexedElement(items[0], 'connectionsIdx', state.setConnectionsCursorIndex)
        },
        () => {
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        300
      )
    ) {
      return
    }
    if (key === 'Enter' || matchesSequenceToken(e, overrides, 'nav.openSideItem') || key === 'ArrowRight') {
      state.setConnectionPreview(null)
      activateConnectionItem(items[currentPos], state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.peekPreview')) {
      openConnectionPreview(items[currentPos], state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.back') || key === 'ArrowLeft' || key === 'Escape') {
      state.setConnectionPreview(null)
      focusEditor()
      return
    }
  }

  function handleHoverPreviewKey(
    e: KeyboardEvent,
    previewEl: HTMLElement,
    state: ReturnType<typeof useStore.getState>
  ): void {
    if (
      e.key === 'Escape' ||
      matchesSequenceToken(e, state.keymapOverrides, 'nav.back') ||
      e.key === 'ArrowLeft'
    ) {
      e.preventDefault()
      e.stopImmediatePropagation()
      state.setConnectionPreview(null)
      state.setFocusedPanel('connections')
      requestAnimationFrame(() => {
        const items = getIndexedElements('[data-connections-idx]', 'connectionsIdx')
        const pos = findPositionByIndex(items, 'connectionsIdx', state.connectionsCursorIndex)
        scrollToIndexedElement(items[pos], 'connectionsIdx', state.setConnectionsCursorIndex)
      })
      return
    }
    handlePreviewKey(e, previewEl, state, 'hoverpreview')
  }

  function handlePreviewKey(
    e: KeyboardEvent,
    previewEl: HTMLElement,
    state: ReturnType<typeof useStore.getState>,
    panel: 'editor' | 'hoverpreview' = 'editor'
  ): void {
    const key = e.key
    const overrides = state.keymapOverrides
    const navKeys = new Set([
      'ArrowDown',
      'ArrowUp',
      'PageDown',
      'PageUp',
      'Home',
      'End'
    ])
    const wantsHalfPageDown = matchesSequenceToken(e, overrides, 'nav.halfPageDown')
    const wantsHalfPageUp = matchesSequenceToken(e, overrides, 'nav.halfPageUp')

    if (
      navKeys.has(key) ||
      wantsHalfPageDown ||
      wantsHalfPageUp ||
      matchesSequenceToken(e, overrides, 'nav.moveDown') ||
      matchesSequenceToken(e, overrides, 'nav.moveUp') ||
      matchesSequenceToken(e, overrides, 'nav.jumpBottom') ||
      sequenceTokenFromEvent(e) === getSequenceTokens(overrides, 'nav.jumpTop')[0] ||
      matchesSequenceToken(e, overrides, 'vim.hintMode') ||
      matchesSequenceToken(e, overrides, 'nav.filter')
    ) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return
    }

    if (state.focusedPanel !== panel) state.setFocusedPanel(panel)

    if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
      scrollPreviewBy(previewEl, getPreviewLineStep(previewEl))
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
      scrollPreviewBy(previewEl, -getPreviewLineStep(previewEl))
      return
    }
    if (key === 'PageDown' || wantsHalfPageDown) {
      scrollPreviewBy(previewEl, getPreviewPageStep(previewEl))
      return
    }
    if (key === 'PageUp' || wantsHalfPageUp) {
      scrollPreviewBy(previewEl, -getPreviewPageStep(previewEl))
      return
    }
    if (key === 'Home') {
      scrollPreviewTo(previewEl, 0)
      return
    }
    if (key === 'End' || matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
      scrollPreviewTo(previewEl, previewEl.scrollHeight)
      return
    }
    if (
      advanceSequence(
        e,
        getKeymapBinding(overrides, 'nav.jumpTop'),
        jumpTopPending,
        jumpTopTimer,
        () => {
          scrollPreviewTo(previewEl, 0)
        },
        () => {
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        300
      )
    ) {
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.filter')) {
      state.setSearchOpen(true)
      return
    }
    if (matchesSequenceToken(e, overrides, 'vim.hintMode')) {
      setHint(true)
    }
  }

  // ---- Helpers ---------------------------------------------------------

  function getPreviewScrollElement(): HTMLElement | null {
    return [...document.querySelectorAll<HTMLElement>('[data-preview-scroll]')].find(
      (el) => el.getClientRects().length > 0
    ) ?? null
  }

  function getHoverPreviewScrollElement(): HTMLElement | null {
    return [...document.querySelectorAll<HTMLElement>('[data-hover-preview-scroll]')].find(
      (el) => el.getClientRects().length > 0
    ) ?? null
  }

  function isPreviewNavigationActive(
    previewEl: HTMLElement,
    state: ReturnType<typeof useStore.getState>,
    target: HTMLElement | null
  ): boolean {
    if (isEditorFocused(state.editorViewRef)) return false
    if (target && previewEl.contains(target)) return true
    const active = document.activeElement as HTMLElement | null
    if (active && previewEl.contains(active)) return true
    return state.focusedPanel === 'editor'
  }

  function getPreviewLineStep(previewEl: HTMLElement): number {
    const content = previewEl.querySelector<HTMLElement>('[data-preview-content]')
    const style = window.getComputedStyle(content ?? previewEl)
    const lineHeight = Number.parseFloat(style.lineHeight)
    if (Number.isFinite(lineHeight)) return Math.max(20, lineHeight)
    const fontSize = Number.parseFloat(style.fontSize)
    if (Number.isFinite(fontSize)) return Math.max(20, fontSize * 1.6)
    return 28
  }

  function getPreviewPageStep(previewEl: HTMLElement): number {
    return Math.max(96, Math.round(previewEl.clientHeight * 0.5))
  }

  function scrollPreviewBy(previewEl: HTMLElement, delta: number): void {
    previewEl.scrollBy({ top: delta, behavior: 'auto' })
  }

  function scrollPreviewTo(previewEl: HTMLElement, top: number): void {
    previewEl.scrollTo({ top, behavior: 'auto' })
  }

  function getIndexedElements(
    selector: string,
    datasetKey: 'sidebarIdx' | 'notelistIdx' | 'connectionsIdx'
  ): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => el.getClientRects().length > 0)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect()
        const bRect = b.getBoundingClientRect()
        const rowDelta = aRect.top - bRect.top

        // Follow the actual rendered row order first, then fall back
        // to the assigned index for stable ordering within the same row.
        if (Math.abs(rowDelta) > 2) return rowDelta

        const colDelta = aRect.left - bRect.left
        if (Math.abs(colDelta) > 2) return colDelta

        return getIndexedValue(a, datasetKey) - getIndexedValue(b, datasetKey)
      })
  }

  function getIndexedValue(
    el: HTMLElement | null,
    datasetKey: 'sidebarIdx' | 'notelistIdx' | 'connectionsIdx'
  ): number {
    const value = Number(el?.dataset[datasetKey] ?? -1)
    return Number.isFinite(value) ? value : -1
  }

  /** Find position in sorted items array by stored cursor index (no DOM focus dependency). */
  function findPositionByIndex(
    items: HTMLElement[],
    datasetKey: 'sidebarIdx' | 'notelistIdx' | 'connectionsIdx',
    cursorIndex: number
  ): number {
    const exact = items.findIndex((item) => getIndexedValue(item, datasetKey) === cursorIndex)
    if (exact >= 0) return exact
    // Index not found (e.g. collapsed parent removed children) — clamp to valid range
    return items.length === 0 ? 0 : Math.max(0, Math.min(cursorIndex, items.length - 1))
  }

  /** Update the cursor index and scroll the element into view. */
  function scrollToIndexedElement(
    el: HTMLElement | undefined,
    datasetKey: 'sidebarIdx' | 'notelistIdx' | 'connectionsIdx',
    setIndex: (idx: number) => void
  ): void {
    if (!el) return
    const idx = getIndexedValue(el, datasetKey)
    if (idx < 0) return
    setIndex(idx)
    el.scrollIntoView({ block: 'nearest' })
  }

  function openContextMenuForIndexedElement(el: HTMLElement | undefined): void {
    if (!el) return
    const rect = el.getBoundingClientRect()
    const clientX = Math.min(
      window.innerWidth - 12,
      Math.max(12, rect.left + Math.min(28, Math.max(12, rect.width * 0.25)))
    )
    const clientY = Math.min(window.innerHeight - 12, Math.max(12, rect.top + rect.height / 2))
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        buttons: 2,
        clientX,
        clientY
      })
    )
  }

  function activateSidebarItem(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): void {
    if (!el) return
    const itemType = el.dataset.sidebarType
    if (itemType === 'folder') {
      const folder = el.dataset.sidebarFolder as 'inbox' | 'quick' | 'archive' | 'trash'
      const subpath = el.dataset.sidebarSubpath ?? ''
      state.setView({ kind: 'folder', folder, subpath })
      const collapseKey = el.dataset.sidebarKey
      if (collapseKey && state.collapsedFolders.includes(collapseKey)) {
        state.toggleCollapseFolder(collapseKey)
      }
    } else if (itemType === 'note') {
      const path = el.dataset.sidebarPath
      if (path) {
        state.setFocusedPanel('editor')
        void state.selectNote(path).then(() => {
          // Focus after the note loads and the editor becomes visible
          requestAnimationFrame(() => {
            useStore.getState().editorViewRef?.focus()
          })
        })
      }
    } else if (itemType === 'tag') {
      const tag = el.dataset.sidebarTag
      if (tag) void state.openTagView(tag)
    } else if (itemType === 'tasks') {
      // Tasks is a top-level sidebar row that opens the vault-wide Tasks
      // tab in the active pane. Matches clicking the row.
      void state.openTasksView()
    } else if (itemType === 'help') {
      void state.openHelpView()
    } else if (itemType === 'settings') {
      state.setSettingsOpen(true)
    } else if (itemType === 'archive') {
      void state.openArchiveView()
    } else if (itemType === 'trash') {
      void state.openTrashView()
    }
  }

  function activateConnectionItem(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): void {
    if (!el) return
    const type = el.dataset.connectionsType
    if (type === 'note') {
      const path = el.dataset.connectionsPath
      if (!path) return
      state.setConnectionPreview(null)
      state.setFocusedPanel('editor')
      void state.selectNote(path).then(() => {
        requestAnimationFrame(() => {
          useStore.getState().editorViewRef?.focus()
        })
      })
      return
    }
    if (type === 'missing') {
      el.click()
    }
  }

  function openConnectionPreview(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): void {
    if (!el || el.dataset.connectionsType !== 'note') return
    const path = el.dataset.connectionsPath
    if (!path) return
    const note = state.notes.find((item) => item.path === path)
    if (!note) return
    const rect = el.getBoundingClientRect()
    state.setConnectionPreview({
      path: note.path,
      title: note.title,
      anchorRect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      }
    })
    state.setFocusedPanel('hoverpreview')
    requestAnimationFrame(() => {
      const previewEl = getHoverPreviewScrollElement()
      if (previewEl) {
        previewEl.focus({ preventScroll: true })
        return
      }
      requestAnimationFrame(() => {
        getHoverPreviewScrollElement()?.focus({ preventScroll: true })
      })
    })
  }

  function collapseSidebarItem(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): void {
    if (!el) return

    const collapseFolder = (folderEl: HTMLElement | null): void => {
      if (!folderEl) return
      const collapseKey = folderEl.dataset.sidebarKey
      const focusFolderRow = (): void => {
        const freshFolderEl = collapseKey
          ? document.querySelector<HTMLElement>(
              `[data-sidebar-type="folder"][data-sidebar-key="${escapeForAttr(collapseKey)}"]`
            )
          : folderEl
        if (!freshFolderEl) return
        scrollToIndexedElement(freshFolderEl, 'sidebarIdx', state.setSidebarCursorIndex)
      }

      if (collapseKey && !state.collapsedFolders.includes(collapseKey)) {
        state.toggleCollapseFolder(collapseKey)
        requestAnimationFrame(() => {
          focusFolderRow()
        })
        return
      }

      focusFolderRow()
    }

    if (el.dataset.sidebarType === 'folder') {
      collapseFolder(el)
      return
    }

    if (el.dataset.sidebarType !== 'note') return
    const path = el.dataset.sidebarPath
    if (!path) return

    const parts = path.split('/')
    const folder = parts[0]
    const subpath = parts.slice(1, -1).join('/')
    const parentFolderEl = document.querySelector<HTMLElement>(
      `[data-sidebar-type="folder"][data-sidebar-folder="${folder}"][data-sidebar-subpath="${escapeForAttr(subpath)}"]`
    )
    collapseFolder(parentFolderEl)
  }

  function toggleSidebarItem(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): void {
    if (!el || el.dataset.sidebarType !== 'folder') return
    const collapseKey = el.dataset.sidebarKey
    if (collapseKey) state.toggleCollapseFolder(collapseKey)
  }

  if (!vimMode) return null

  if (hintActive) {
    return <HintOverlay onActivate={exitHints} onCancel={cancelHints} />
  }

  if (whichKeyHintsEnabled && whichKeyState) {
    const leaderDisplay = getKeymapDisplay(keymapOverrides, 'vim.leaderPrefix')
    const noteActionsDisplay = getKeymapDisplay(keymapOverrides, 'vim.leaderNoteActions')
    return (
      <WhichKeyOverlay
        prefix={whichKeyState.stage === 'leader' ? leaderDisplay : `${leaderDisplay} ${noteActionsDisplay}`}
        title={whichKeyState.stage === 'leader' ? 'Leader' : 'Leader · Note Actions'}
        detail={
          stickyWhichKeyHints
            ? `Press a key to continue. Press ${leaderDisplay} again or Esc to close.`
            : 'Press a key to continue or Esc to cancel.'
        }
        items={whichKeyItems}
      />
    )
  }

  return null
}
