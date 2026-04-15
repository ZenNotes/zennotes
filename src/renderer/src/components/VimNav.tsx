import { useCallback, useEffect, useRef, useState } from 'react'
import { isTagsViewActive, isTasksViewActive, useStore } from '../store'
import { HintOverlay } from './HintOverlay'
import {
  getVisiblePanels,
  isEditorInsertMode,
  isEditorFocused,
  resolveNextPanel
} from '../lib/vim-nav'
import { focusPaneInDirection } from '../lib/pane-nav'

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
  // All control-flow flags are refs so the handler never stales.
  const ctrlWPending = useRef(false)
  const gPending = useRef(false)
  const leaderPending = useRef<'leader' | 'leader-l' | null>(null)
  const ctrlWTimer = useRef<ReturnType<typeof setTimeout>>()
  const gTimer = useRef<ReturnType<typeof setTimeout>>()
  const leaderTimer = useRef<ReturnType<typeof setTimeout>>()

  // Hint mode needs a render (to mount HintOverlay), so it's state.
  const [hintActive, setHintActive] = useState(false)
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
  const resetLeader = useCallback(() => {
    leaderPending.current = null
    if (leaderTimer.current) clearTimeout(leaderTimer.current)
  }, [])
  const armLeader = useCallback((stage: 'leader' | 'leader-l') => {
    leaderPending.current = stage
    if (leaderTimer.current) clearTimeout(leaderTimer.current)
    leaderTimer.current = setTimeout(() => {
      leaderPending.current = null
    }, 900)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const state = useStore.getState()

      // Skip when modals / overlays are open
      if (state.searchOpen || state.settingsOpen || state.commandPaletteOpen) return
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

      const wantsJumpBack =
        e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === 'o'
      const wantsJumpForward =
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === 'i' || e.key === 'Tab')
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
        if (e.key === 'v' || e.key === 's') {
          const activePath = state.selectedPath
          if (activePath) {
            void state.splitPaneWithTab({
              targetPaneId: state.activePaneId,
              edge: e.key === 'v' ? 'right' : 'bottom',
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
          e.key === 'h' || e.key === 'ArrowLeft'
            ? 'h'
            : e.key === 'l' || e.key === 'ArrowRight'
              ? 'l'
              : e.key === 'j' || e.key === 'ArrowDown'
                ? 'j'
                : e.key === 'k' || e.key === 'ArrowUp'
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
          e.key === 'h' || e.key === 'k' || e.key === 'ArrowLeft' || e.key === 'ArrowUp'
            ? 'left'
            : e.key === 'l' || e.key === 'j' || e.key === 'ArrowRight' || e.key === 'ArrowDown'
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
      if (e.ctrlKey && e.key === 'w' && !e.metaKey && !e.altKey && !e.shiftKey) {
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
      const panelViewActive = isTasksViewActive(state) || isTagsViewActive(state)
      if (panelViewActive && e.key !== 'f') {
        return
      }

      // ------- g-g pending (jump to top) --------------------------------
      if (gPending.current) {
        gPending.current = false
        if (gTimer.current) clearTimeout(gTimer.current)
        if (e.key === 'g') {
          e.preventDefault()
          e.stopImmediatePropagation()
          if (state.focusedPanel === 'sidebar') {
            scrollToIndexedElement(
              getIndexedElements('[data-sidebar-idx]', 'sidebarIdx')[0],
              'sidebarIdx',
              state.setSidebarCursorIndex
            )
          } else if (state.focusedPanel === 'notelist') {
            scrollToIndexedElement(
              getIndexedElements('[data-notelist-idx]', 'notelistIdx')[0],
              'notelistIdx',
              state.setNoteListCursorIndex
            )
          } else if (state.focusedPanel === 'connections') {
            scrollToIndexedElement(
              getIndexedElements('[data-connections-idx]', 'connectionsIdx')[0],
              'connectionsIdx',
              state.setConnectionsCursorIndex
            )
          } else if (state.focusedPanel === 'hoverpreview' && hoverPreviewEl) {
            scrollPreviewTo(hoverPreviewEl, 0)
          } else if (previewEl && isPreviewNavigationActive(previewEl, state, target)) {
            scrollPreviewTo(previewEl, 0)
          }
        }
        return
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
        if (!isEditorInsertMode(state.editorViewRef, state.vimMode)) {
          if (leaderPending.current) {
            e.preventDefault()
            e.stopImmediatePropagation()
            if (leaderPending.current === 'leader' && e.key === 'l') {
              armLeader('leader-l')
              return
            }
            if (leaderPending.current === 'leader-l' && e.key === 'f') {
              resetLeader()
              void state.formatActiveNote()
              return
            }
            resetLeader()
            return
          }

          if (e.key === ' ') {
            e.preventDefault()
            e.stopImmediatePropagation()
            armLeader('leader')
            return
          }
        } else {
          resetLeader()
        }

        if (
          e.key === 'f' &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
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
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
  }, [armLeader, jumpNoteHistory, resetLeader, setHint]) // ← stable dep, handler never re-registers unnecessarily

  // ---- Key handlers (called from the single persistent handler) --------

  function handleSidebarKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    if (state.focusedPanel !== 'sidebar') state.setFocusedPanel('sidebar')
    const items = getIndexedElements('[data-sidebar-idx]', 'sidebarIdx')
    const count = items.length
    const max = count - 1
    const currentPos = findPositionByIndex(items, 'sidebarIdx', state.sidebarCursorIndex)
    const wantsContextMenu =
      key === 'm' || key === 'ContextMenu' || (e.shiftKey && key === 'F10')

    // Always consume single-char nav keys when sidebar is focused,
    // even if the sidebar is empty — prevents them leaking to the editor.
    const navKeys = new Set([
      'j', 'k', 'h', 'l', 'o', 'g', 'G', 'f', '/',
      'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'
    ])
    if (navKeys.has(key) || key === 'Enter' || key === 'Escape' || wantsContextMenu) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return // not a nav key, let it through
    }

    if (count === 0) return // nothing to navigate

    if (key === 'j' || key === 'ArrowDown') {
      scrollToIndexedElement(items[Math.min(currentPos + 1, max)], 'sidebarIdx', state.setSidebarCursorIndex)
      return
    }
    if (key === 'k' || key === 'ArrowUp') {
      scrollToIndexedElement(items[Math.max(currentPos - 1, 0)], 'sidebarIdx', state.setSidebarCursorIndex)
      return
    }
    if (key === 'G') {
      scrollToIndexedElement(items[max], 'sidebarIdx', state.setSidebarCursorIndex)
      return
    }
    if (key === 'g') {
      gPending.current = true
      if (gTimer.current) clearTimeout(gTimer.current)
      gTimer.current = setTimeout(() => { gPending.current = false }, 300)
      return
    }
    if (key === 'Enter' || key === 'l' || key === 'ArrowRight') {
      activateSidebarItem(items[currentPos], state)
      return
    }
    if (key === 'h' || key === 'ArrowLeft') {
      collapseSidebarItem(items[currentPos], state)
      return
    }
    if (key === 'o') {
      toggleSidebarItem(items[currentPos], state)
      return
    }
    if (key === 'Escape') {
      focusEditor()
      return
    }
    if (key === '/') {
      state.setSearchOpen(true)
      return
    }
    if (key === 'f') {
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
    const items = getIndexedElements('[data-notelist-idx]', 'notelistIdx')
    const count = items.length
    const max = count - 1
    const currentPos = findPositionByIndex(items, 'notelistIdx', state.noteListCursorIndex)

    const navKeys = new Set([
      'j', 'k', 'h', 'l', 'g', 'G', 'f', '/',
      'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'
    ])
    if (navKeys.has(key) || key === 'Enter' || key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return
    }

    if (count === 0) return

    if (key === 'j' || key === 'ArrowDown') {
      scrollToIndexedElement(
        items[Math.min(currentPos + 1, max)],
        'notelistIdx',
        state.setNoteListCursorIndex
      )
      return
    }
    if (key === 'k' || key === 'ArrowUp') {
      scrollToIndexedElement(
        items[Math.max(currentPos - 1, 0)],
        'notelistIdx',
        state.setNoteListCursorIndex
      )
      return
    }
    if (key === 'G') {
      scrollToIndexedElement(items[max], 'notelistIdx', state.setNoteListCursorIndex)
      return
    }
    if (key === 'g') {
      gPending.current = true
      if (gTimer.current) clearTimeout(gTimer.current)
      gTimer.current = setTimeout(() => { gPending.current = false }, 300)
      return
    }
    if (key === 'Enter' || key === 'l' || key === 'ArrowRight') {
      const el = items[currentPos]
      const path = el?.dataset.notelistPath
      if (path) {
        void state.selectNote(path)
        focusEditor()
      }
      return
    }
    if (key === 'h' || key === 'ArrowLeft') {
      if (state.sidebarOpen) state.setFocusedPanel('sidebar')
      return
    }
    if (key === 'Escape') {
      focusEditor()
      return
    }
    if (key === '/') {
      state.setSearchOpen(true)
      return
    }
    if (key === 'f') {
      setHint(true)
      return
    }
  }

  function handleConnectionsKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    const items = getIndexedElements('[data-connections-idx]', 'connectionsIdx')
    const count = items.length
    const max = count - 1
    const currentPos = findPositionByIndex(items, 'connectionsIdx', state.connectionsCursorIndex)
    const navKeys = new Set([
      'j', 'k', 'h', 'l', 'g', 'G', 'p',
      'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'
    ])
    if (navKeys.has(key) || key === 'Enter' || key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return
    }

    if (count === 0) {
      if (key === 'Escape' || key === 'h' || key === 'ArrowLeft') {
        state.setConnectionPreview(null)
        focusEditor()
      }
      return
    }

    if (key === 'j' || key === 'ArrowDown') {
      state.setConnectionPreview(null)
      scrollToIndexedElement(
        items[Math.min(currentPos + 1, max)],
        'connectionsIdx',
        state.setConnectionsCursorIndex
      )
      return
    }
    if (key === 'k' || key === 'ArrowUp') {
      state.setConnectionPreview(null)
      scrollToIndexedElement(
        items[Math.max(currentPos - 1, 0)],
        'connectionsIdx',
        state.setConnectionsCursorIndex
      )
      return
    }
    if (key === 'G') {
      state.setConnectionPreview(null)
      scrollToIndexedElement(items[max], 'connectionsIdx', state.setConnectionsCursorIndex)
      return
    }
    if (key === 'g') {
      state.setConnectionPreview(null)
      gPending.current = true
      if (gTimer.current) clearTimeout(gTimer.current)
      gTimer.current = setTimeout(() => { gPending.current = false }, 300)
      return
    }
    if (key === 'Enter' || key === 'l' || key === 'ArrowRight') {
      state.setConnectionPreview(null)
      activateConnectionItem(items[currentPos], state)
      return
    }
    if (key === 'p') {
      openConnectionPreview(items[currentPos], state)
      return
    }
    if (key === 'h' || key === 'ArrowLeft' || key === 'Escape') {
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
    if (e.key === 'Escape' || e.key === 'h' || e.key === 'ArrowLeft') {
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
    const navKeys = new Set([
      'j',
      'k',
      'g',
      'G',
      'f',
      '/',
      'ArrowDown',
      'ArrowUp',
      'PageDown',
      'PageUp',
      'Home',
      'End'
    ])
    const wantsHalfPageDown =
      e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'd'
    const wantsHalfPageUp =
      e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'u'

    if (navKeys.has(key) || wantsHalfPageDown || wantsHalfPageUp) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return
    }

    if (state.focusedPanel !== panel) state.setFocusedPanel(panel)

    if (key === 'j' || key === 'ArrowDown') {
      scrollPreviewBy(previewEl, getPreviewLineStep(previewEl))
      return
    }
    if (key === 'k' || key === 'ArrowUp') {
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
    if (key === 'End' || key === 'G') {
      scrollPreviewTo(previewEl, previewEl.scrollHeight)
      return
    }
    if (key === 'g') {
      gPending.current = true
      if (gTimer.current) clearTimeout(gTimer.current)
      gTimer.current = setTimeout(() => {
        gPending.current = false
      }, 300)
      return
    }
    if (key === '/') {
      state.setSearchOpen(true)
      return
    }
    if (key === 'f') {
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
    } else if (itemType === 'trash') {
      state.setView({ kind: 'folder', folder: 'trash', subpath: '' })
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

  if (hintActive) {
    return <HintOverlay onActivate={exitHints} onCancel={cancelHints} />
  }

  return null
}
