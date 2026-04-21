/**
 * Single pane of the editor split view. Each leaf in the pane-layout
 * tree renders an `EditorPane` — owning its own CodeMirror view, tab
 * strip, breadcrumb + toolbar, preview surface, and drag-drop zones.
 *
 * The store keeps per-path note content (`noteContents`) shared across
 * all panes, so the same note open in two panes stays in sync on edit.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  type Transaction
} from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  tooltips
} from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import type { NoteFolder } from '@shared/ipc'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  selectAll,
  undo
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { resolveCodeLanguage } from '../lib/cm-code-languages'
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from '@codemirror/language'
import { headingFolding } from '../lib/cm-heading-fold'
import { tags as t } from '@lezer/highlight'
import { searchKeymap } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { useStore } from '../store'
import type { LineNumberMode } from '../store'
import type { PaneEdge, PaneLeaf } from '../lib/pane-layout'
import { findLeaf, inferPaneDropEdge } from '../lib/pane-layout'
import { livePreviewPlugin } from '../lib/cm-live-preview'
import { slashCommandSource, slashCommandRender } from '../lib/cm-slash-commands'
import { dateShortcutSource } from '../lib/cm-date-shortcuts'
import { wikilinkSource } from '../lib/cm-wikilinks'
import { Preview } from './Preview'
import { ConnectionsPanel } from './ConnectionsPanel'
import { OutlinePanel } from './OutlinePanel'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { TasksView } from './TasksView'
import { TagView } from './TagView'
import { HelpView } from './HelpView'
import { ArchiveView } from './ArchiveView'
import { TrashView } from './TrashView'
import { QuickNotesView } from './QuickNotesView'
import { isTasksTabPath } from '@shared/tasks'
import { isTagsTabPath } from '@shared/tags'
import { isHelpTabPath } from '@shared/help'
import { isArchiveTabPath } from '@shared/archive'
import { isTrashTabPath } from '@shared/trash'
import { isQuickNotesTabPath } from '@shared/quick-notes'
import { hasZenItem, readDragPayload, setDragPayload, type DragPayload } from '../lib/dnd'
import {
  getImageBlockDropPlacement,
  hasImageBlockDragPayload,
  moveImageBlockInEditor,
  readImageBlockDragPayload
} from '../lib/image-block-dnd'
import { useSettledMarkdown } from '../lib/use-rendered-markdown'
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CheckSquareIcon,
  CloseIcon,
  DocumentIcon,
  ListTreeIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PinIcon,
  TagIcon,
  TrashIcon,
  ZapIcon
} from './icons'
import { focusEditorNormalMode } from '../lib/editor-focus'
import {
  getSystemFolderLabel,
  resolveSystemFolderLabels
} from '../lib/system-folder-labels'
import {
  isPrimaryNotesAtRoot,
  noteFolderSubpath
} from '../lib/vault-layout'
import {
  droppedPathsFromTransfer,
  hasDroppedFiles
} from '../lib/editor-drops'
import { ZEN_SET_PANE_MODE_EVENT, type PaneMode } from '../lib/pane-mode'

const paperHighlight = HighlightStyle.define([
  // Markdown-level tokens
  { tag: t.heading1, class: 'tok-heading1' },
  { tag: t.heading2, class: 'tok-heading2' },
  { tag: t.heading3, class: 'tok-heading3' },
  { tag: t.heading4, class: 'tok-heading4' },
  { tag: t.heading5, class: 'tok-heading5' },
  { tag: t.heading6, class: 'tok-heading6' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.monospace, class: 'tok-monospace' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: t.list, class: 'tok-list' },
  { tag: t.meta, class: 'tok-meta' },
  // Code-syntax tokens (JS/TS/Python/Go/…) inside fenced blocks.
  // Keep this roster broad so minority grammars (Python module/builtin
  // keywords, Go package names, Rust lifetimes) don't fall back to an
  // unstyled default.
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.controlKeyword, class: 'tok-keyword' },
  { tag: t.definitionKeyword, class: 'tok-keyword' },
  { tag: t.moduleKeyword, class: 'tok-keyword' },
  { tag: t.modifier, class: 'tok-keyword' },
  { tag: t.operatorKeyword, class: 'tok-keyword' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.special(t.string), class: 'tok-string' },
  { tag: t.regexp, class: 'tok-string' },
  { tag: t.character, class: 'tok-string' },
  { tag: t.escape, class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.lineComment, class: 'tok-comment' },
  { tag: t.blockComment, class: 'tok-comment' },
  { tag: t.docComment, class: 'tok-comment' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.integer, class: 'tok-number' },
  { tag: t.float, class: 'tok-number' },
  { tag: t.bool, class: 'tok-atom' },
  { tag: t.atom, class: 'tok-atom' },
  { tag: t.null, class: 'tok-atom' },
  { tag: t.self, class: 'tok-atom' },
  { tag: t.special(t.variableName), class: 'tok-atom' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.logicOperator, class: 'tok-operator' },
  { tag: t.arithmeticOperator, class: 'tok-operator' },
  { tag: t.bitwiseOperator, class: 'tok-operator' },
  { tag: t.compareOperator, class: 'tok-operator' },
  { tag: t.updateOperator, class: 'tok-operator' },
  { tag: t.definitionOperator, class: 'tok-operator' },
  { tag: t.typeOperator, class: 'tok-operator' },
  { tag: t.controlOperator, class: 'tok-keyword' },
  { tag: t.typeName, class: 'tok-type' },
  { tag: t.className, class: 'tok-type' },
  { tag: t.namespace, class: 'tok-type' },
  { tag: t.standard(t.variableName), class: 'tok-type' },
  { tag: t.function(t.variableName), class: 'tok-function' },
  { tag: t.function(t.definition(t.variableName)), class: 'tok-function' },
  { tag: t.function(t.propertyName), class: 'tok-function' },
  { tag: t.definition(t.variableName), class: 'tok-variable-def' },
  { tag: t.definition(t.propertyName), class: 'tok-variable-def' },
  { tag: t.variableName, class: 'tok-variable' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.labelName, class: 'tok-label' },
  { tag: t.punctuation, class: 'tok-punct' },
  { tag: t.separator, class: 'tok-punct' },
  { tag: t.bracket, class: 'tok-bracket' },
  { tag: t.paren, class: 'tok-bracket' },
  { tag: t.brace, class: 'tok-bracket' },
  { tag: t.squareBracket, class: 'tok-bracket' },
  { tag: t.angleBracket, class: 'tok-bracket' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: t.attributeName, class: 'tok-attr' },
  { tag: t.attributeValue, class: 'tok-string' },
  { tag: t.annotation, class: 'tok-meta-code' },
  { tag: t.processingInstruction, class: 'tok-meta-code' },
  { tag: t.invalid, class: 'tok-invalid' }
])

/** Annotation marking programmatic doc replacements (external sync / note
 *  switch) so the update listener skips the save schedule. */
const programmatic = Annotation.define<boolean>()
const OUTLINE_JUMP_TOP_MARGIN = 24

function lineNumberExtension(mode: LineNumberMode): Extension {
  if (mode === 'off') return []
  return [
    lineNumbers({
      formatNumber: (lineNo, state) => {
        if (mode === 'absolute') return String(lineNo)
        const activeLine = state.doc.lineAt(state.selection.main.head).number
        return lineNo === activeLine ? String(lineNo) : String(Math.abs(lineNo - activeLine))
      }
    }),
    highlightActiveLineGutter()
  ]
}

type TabDropIndicator = { path: string; position: 'before' | 'after' } | null

export function EditorPane({ pane }: { pane: PaneLeaf }): JSX.Element {
  const paneId = pane.id
  const isActive = useStore((s) => s.activePaneId === paneId)
  const tabs = pane.tabs
  const pinnedTabs = pane.pinnedTabs
  const activeTab = pane.activeTab

  const content = useStore((s) => (activeTab ? s.noteContents[activeTab] ?? null : null))
  const isDirty = useStore((s) => (activeTab ? s.noteDirty[activeTab] ?? false : false))
  const notes = useStore((s) => s.notes)
  const vault = useStore((s) => s.vault)
  const refreshNotes = useStore((s) => s.refreshNotes)
  const loading = useStore((s) => s.loadingNote && isActive)

  const setActivePane = useStore((s) => s.setActivePane)
  const focusTabInPane = useStore((s) => s.focusTabInPane)
  const closeTabInPane = useStore((s) => s.closeTabInPane)
  const reorderTabInPane = useStore((s) => s.reorderTabInPane)
  const movePaneTab = useStore((s) => s.movePaneTab)
  const splitPaneWithTab = useStore((s) => s.splitPaneWithTab)
  const openNoteInPane = useStore((s) => s.openNoteInPane)
  const toggleTabPin = useStore((s) => s.toggleTabPin)
  const unpinTabInPane = useStore((s) => s.unpinTabInPane)
  const updateNoteBody = useStore((s) => s.updateNoteBody)
  const persistNote = useStore((s) => s.persistNote)
  const trashActive = useStore((s) => s.trashActive)
  const archiveActive = useStore((s) => s.archiveActive)
  const restoreActive = useStore((s) => s.restoreActive)
  const unarchiveActive = useStore((s) => s.unarchiveActive)
  const renameActive = useStore((s) => s.renameActive)

  const setEditorViewRef = useStore((s) => s.setEditorViewRef)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const zenMode = useStore((s) => s.zenMode)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const setConnectionPreview = useStore((s) => s.setConnectionPreview)
  const pendingTitleFocusPath = useStore((s) => s.pendingTitleFocusPath)
  const clearPendingTitleFocus = useStore((s) => s.clearPendingTitleFocus)
  const pendingJumpLocation = useStore((s) => s.pendingJumpLocation)
  const clearPendingJumpLocation = useStore((s) => s.clearPendingJumpLocation)
  const vimMode = useStore((s) => s.vimMode)
  const livePreview = useStore((s) => s.livePreview)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const lineNumberMode = useStore((s) => s.lineNumberMode)
  const textFont = useStore((s) => s.textFont)
  const tabsEnabled = useStore((s) => s.tabsEnabled)
  const workspaceMode = useStore((s) => s.workspaceMode)
  const wordWrap = useStore((s) => s.wordWrap)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const folderLabels = resolveSystemFolderLabels(systemFolderLabels)

  const [mode, setMode] = useState<PaneMode>('edit')
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [paneDropEdge, setPaneDropEdge] = useState<PaneEdge | null>(null)
  const [tabDropIndicator, setTabDropIndicator] = useState<TabDropIndicator>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  // Right-click menu for editor text (Copy/Cut/Paste/Select All/Undo/Redo).
  // Null when closed. Captures selection state at click time so menu items
  // reflect what was actually selected.
  const [editorMenu, setEditorMenu] = useState<{
    x: number
    y: number
    hasSelection: boolean
  } | null>(null)
  const [assetDropActive, setAssetDropActive] = useState(false)
  const [imageDropIndicatorTop, setImageDropIndicatorTop] = useState<number | null>(null)

  const viewRef = useRef<EditorView | null>(null)
  const paneRootRef = useRef<HTMLDivElement | null>(null)
  const paneBodyRef = useRef<HTMLDivElement | null>(null)
  const editorSurfaceRef = useRef<HTMLDivElement | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)
  const vimCompartmentRef = useRef<Compartment | null>(null)
  const livePreviewCompartmentRef = useRef<Compartment | null>(null)
  const lineNumbersCompartmentRef = useRef<Compartment | null>(null)
  const wordWrapCompartmentRef = useRef<Compartment | null>(null)
  const ignoreEditorScrollRef = useRef(false)
  const ignorePreviewScrollRef = useRef(false)
  const pendingOutlineJumpLineRef = useRef<number | null>(null)
  /**
   * Path currently rendered in this pane's CodeMirror view. The CM update
   * listener writes through to `noteContents[viewPathRef.current]`; the
   * sync effect updates it whenever we swap the view's document.
   */
  const viewPathRef = useRef<string | null>(null)

  const toggleConnectionsPanel = useCallback(() => {
    setConnectionsOpen((open) => {
      const next = !open
      if (!next) {
        setConnectionPreview(null)
        if (focusedPanel === 'connections' || focusedPanel === 'hoverpreview') {
          setFocusedPanel('editor')
        }
      }
      return next
    })
  }, [focusedPanel, setConnectionPreview, setFocusedPanel])

  // ⌘2 toggles the connections panel — only the active pane responds so
  // the shortcut targets the pane the user is currently working in.
  useEffect(() => {
    if (!isActive) return
    const handler = (): void => {
      toggleConnectionsPanel()
    }
    window.addEventListener('zen:toggle-connections', handler)
    return () => window.removeEventListener('zen:toggle-connections', handler)
  }, [isActive, toggleConnectionsPanel])

  const toggleOutlinePanel = useCallback(() => {
    setOutlineOpen((open) => !open)
  }, [])

  const applyPaneMode = useCallback((nextMode: PaneMode) => {
    setMode(nextMode)
    setActivePane(paneId)
    setFocusedPanel('editor')
    requestAnimationFrame(() => {
      if (nextMode === 'preview') {
        previewScrollRef.current?.focus()
        return
      }
      focusEditorNormalMode()
    })
  }, [paneId, setActivePane, setFocusedPanel])

  // `zen:toggle-outline` — routed only to the active pane, same pattern
  // as the connections toggle.
  useEffect(() => {
    if (!isActive) return
    const handler = (): void => {
      toggleOutlinePanel()
    }
    window.addEventListener('zen:toggle-outline', handler)
    return () => window.removeEventListener('zen:toggle-outline', handler)
  }, [isActive, toggleOutlinePanel])

  // `zen:set-pane-mode` — active-pane-only route for command palette and
  // vim ex commands that switch the current note between Edit / Split /
  // Preview without touching the toolbar.
  useEffect(() => {
    if (!isActive) return
    const handler = (event: Event): void => {
      const nextMode = (event as CustomEvent<{ mode?: PaneMode }>).detail?.mode
      if (nextMode !== 'edit' && nextMode !== 'split' && nextMode !== 'preview') return
      applyPaneMode(nextMode)
    }
    window.addEventListener(ZEN_SET_PANE_MODE_EVENT, handler)
    return () => window.removeEventListener(ZEN_SET_PANE_MODE_EVENT, handler)
  }, [applyPaneMode, isActive])

  const commitOutlineJump = useCallback((line: number) => {
    const view = viewRef.current
    if (!view) return false
    const safeLine = Math.min(Math.max(1, line), view.state.doc.lines)
    const pos = view.state.doc.line(safeLine).from
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, {
        y: 'start',
        yMargin: OUTLINE_JUMP_TOP_MARGIN
      })
    })
    setFocusedPanel('editor')
    view.focus()
    return true
  }, [setFocusedPanel])

  const jumpToOutlineLine = useCallback((line: number) => {
    pendingOutlineJumpLineRef.current = line
    setActivePane(paneId)
    setFocusedPanel('editor')
    if (mode === 'preview' || !viewRef.current) {
      applyPaneMode('edit')
      return
    }
    if (commitOutlineJump(line)) {
      pendingOutlineJumpLineRef.current = null
    }
  }, [applyPaneMode, commitOutlineJump, mode, paneId, setActivePane, setFocusedPanel])

  useEffect(() => {
    const pendingLine = pendingOutlineJumpLineRef.current
    if (pendingLine == null) return
    if (!isActive || mode === 'preview' || !content) return
    const raf = requestAnimationFrame(() => {
      if (commitOutlineJump(pendingLine)) {
        pendingOutlineJumpLineRef.current = null
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [commitOutlineJump, content?.path, isActive, mode])

  // `zen:outline-jump` lets global UI like the searchable outline
  // overlay route the jump through the active pane, which can switch
  // out of preview mode before placing the caret.
  useEffect(() => {
    if (!isActive) return
    const handler = (event: Event): void => {
      const line = (event as CustomEvent<{ line?: number }>).detail?.line
      if (typeof line !== 'number') return
      jumpToOutlineLine(line)
    }
    window.addEventListener('zen:outline-jump', handler)
    return () => window.removeEventListener('zen:outline-jump', handler)
  }, [isActive, jumpToOutlineLine])

  // Mount / unmount the CodeMirror view via a callback ref on the host
  // div. The callback identity is stable so React only invokes it on
  // mount / unmount — `content` is read from `useStore.getState()` at
  // creation time and kept in sync afterward via the effect below.
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        const existingView = viewRef.current
        if (
          existingView &&
          useStore.getState().editorViewRef === existingView
        ) {
          setEditorViewRef(null)
        }
        existingView?.destroy()
        viewRef.current = null
        return
      }
      if (viewRef.current) return
      const vimCompartment = new Compartment()
      const livePreviewCompartment = new Compartment()
      const lineNumbersCompartment = new Compartment()
      const wordWrapCompartment = new Compartment()
      vimCompartmentRef.current = vimCompartment
      livePreviewCompartmentRef.current = livePreviewCompartment
      lineNumbersCompartmentRef.current = lineNumbersCompartment
      wordWrapCompartmentRef.current = wordWrapCompartment
      const s0 = useStore.getState()
      const initialPath = findLeaf(s0.paneLayout, paneId)?.activeTab ?? null
      const initialContent = initialPath ? s0.noteContents[initialPath] ?? null : null
      const state = EditorState.create({
        doc: initialContent?.body ?? '',
        extensions: [
          vimCompartment.of(s0.vimMode ? vim() : []),
          history(),
          drawSelection(),
          highlightActiveLine(),
          wordWrapCompartment.of(s0.wordWrap ? EditorView.lineWrapping : []),
          markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage, addKeymap: true }),
          headingFolding(),
          syntaxHighlighting(paperHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          livePreviewCompartment.of(s0.livePreview ? livePreviewPlugin : []),
          lineNumbersCompartment.of(lineNumberExtension(s0.lineNumberMode)),
          tooltips({ parent: document.body }),
          autocompletion({
            override: [slashCommandSource, dateShortcutSource, wikilinkSource],
            addToOptions: [{ render: slashCommandRender.render, position: 0 }],
            icons: false,
            optionClass: (completion) =>
              (completion as { _kind?: string })._kind === 'wikilink'
                ? 'wikilink-cmd-option'
                : 'slash-cmd-option'
          }),
          keymap.of([
            {
              key: 'Mod-f',
              run: () => {
                const state = useStore.getState()
                if (state.vimMode) return false
                state.setSearchOpen(true)
                return true
              }
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap
          ]),
          EditorView.domEventHandlers({
            keydown: (event, view) => {
              if (event.key !== 'Escape') return false
              const state = useStore.getState()
              if (!state.vimMode) return false
              const cm = getCM(view)
              if (!cm?.state.vim?.insertMode) return false
              event.preventDefault()
              event.stopPropagation()
              Vim.exitInsertMode(cm as Parameters<typeof Vim.exitInsertMode>[0], true)
              return true
            }
          }),
          EditorView.updateListener.of((upd) => {
            if (!upd.docChanged) return
            if (upd.transactions.some((tr: Transaction) => tr.annotation(programmatic))) return
            const path = viewPathRef.current
            if (!path) return
            updateNoteBody(path, upd.state.doc.toString())
          })
        ]
      })
      const view = new EditorView({ state, parent: el })
      viewRef.current = view
      viewPathRef.current = initialPath
      if (useStore.getState().activePaneId === paneId) {
        setEditorViewRef(view)
      }
    },
    [paneId, setEditorViewRef, updateNoteBody]
  )

  // Register our view as the focused editor whenever our pane is active.
  useEffect(() => {
    if (!isActive) return
    const view = viewRef.current
    if (!view) return
    setEditorViewRef(view)
  }, [isActive, setEditorViewRef, activeTab])

  // Sync CM doc to external content changes (file watcher, peer panes, tab switch).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const nextPath = content?.path ?? null
    const nextBody = content?.body ?? ''
    const pathChanged = viewPathRef.current !== nextPath
    const bodyChanged = view.state.doc.toString() !== nextBody
    if (!pathChanged && !bodyChanged) return
    // Preserve selection on in-place body changes (peer pane edits,
    // external file watcher); jump to the start when switching tabs.
    const sel = view.state.selection.main
    const clampedAnchor = Math.min(sel.anchor, nextBody.length)
    const clampedHead = Math.min(sel.head, nextBody.length)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: nextBody },
      annotations: programmatic.of(true),
      selection: pathChanged ? { anchor: 0 } : { anchor: clampedAnchor, head: clampedHead }
    })
    viewPathRef.current = nextPath
  }, [content?.body, content?.path])

  // Toggle Vim / live-preview / line-numbers via compartments.
  useEffect(() => {
    const view = viewRef.current
    const comp = vimCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({ effects: comp.reconfigure(vimMode ? vim() : []) })
  }, [vimMode])
  useEffect(() => {
    const view = viewRef.current
    const comp = livePreviewCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({ effects: comp.reconfigure(livePreview ? livePreviewPlugin : []) })
  }, [livePreview])
  useEffect(() => {
    const view = viewRef.current
    const comp = lineNumbersCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({ effects: comp.reconfigure(lineNumberExtension(lineNumberMode)) })
  }, [lineNumberMode])
  useEffect(() => {
    const view = viewRef.current
    const comp = wordWrapCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({
      effects: comp.reconfigure(wordWrap ? EditorView.lineWrapping : [])
    })
  }, [wordWrap])

  // Re-measure CM on prefs that change line geometry.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const raf = requestAnimationFrame(() => view.requestMeasure())
    return () => cancelAnimationFrame(raf)
  }, [editorFontSize, editorLineHeight, lineNumberMode, textFont, mode, connectionsOpen])

  // Scroll sync between editor + preview when split mode is on.
  useEffect(() => {
    if (mode !== 'split' || !content) return
    const editorEl = viewRef.current?.scrollDOM
    const previewEl = previewScrollRef.current
    if (!editorEl || !previewEl) return

    const getScrollRatio = (el: HTMLElement): number => {
      const max = el.scrollHeight - el.clientHeight
      if (max <= 0) return 0
      return Math.max(0, Math.min(1, el.scrollTop / max))
    }
    const syncByRatio = (
      source: HTMLElement,
      target: HTMLElement,
      targetKind: 'editor' | 'preview'
    ): void => {
      const targetMax = target.scrollHeight - target.clientHeight
      const nextTop = targetMax <= 0 ? 0 : getScrollRatio(source) * targetMax
      if (Math.abs(target.scrollTop - nextTop) < 1) return
      if (targetKind === 'editor') ignoreEditorScrollRef.current = true
      else ignorePreviewScrollRef.current = true
      target.scrollTop = nextTop
    }
    const onEditorScroll = (): void => {
      if (ignoreEditorScrollRef.current) {
        ignoreEditorScrollRef.current = false
        return
      }
      syncByRatio(editorEl, previewEl, 'preview')
    }
    const onPreviewScroll = (): void => {
      if (ignorePreviewScrollRef.current) {
        ignorePreviewScrollRef.current = false
        return
      }
      syncByRatio(previewEl, editorEl, 'editor')
    }
    editorEl.addEventListener('scroll', onEditorScroll, { passive: true })
    previewEl.addEventListener('scroll', onPreviewScroll, { passive: true })
    const raf = requestAnimationFrame(() => syncByRatio(editorEl, previewEl, 'preview'))
    return () => {
      cancelAnimationFrame(raf)
      editorEl.removeEventListener('scroll', onEditorScroll)
      previewEl.removeEventListener('scroll', onPreviewScroll)
      ignoreEditorScrollRef.current = false
      ignorePreviewScrollRef.current = false
    }
  }, [content?.path, mode])

  // Apply pendingJumpLocation — only for the active pane.
  useEffect(() => {
    if (!isActive) return
    if (!content || !pendingJumpLocation || pendingJumpLocation.path !== content.path) return
    const raf = requestAnimationFrame(() => {
      const view = viewRef.current
      if (!view) return
      const docLength = view.state.doc.length
      const anchor = Math.max(0, Math.min(docLength, pendingJumpLocation.editorSelectionAnchor))
      const head = Math.max(0, Math.min(docLength, pendingJumpLocation.editorSelectionHead))
      const scrollMode = pendingJumpLocation.editorScrollMode ?? 'preserve'
      if (scrollMode === 'preserve') {
        view.dispatch({ selection: { anchor, head } })
        view.scrollDOM.scrollTop = pendingJumpLocation.editorScrollTop
      } else {
        view.dispatch({
          selection: { anchor, head },
          effects: EditorView.scrollIntoView(anchor, {
            y: scrollMode,
            yMargin: scrollMode === 'start' ? OUTLINE_JUMP_TOP_MARGIN : 0
          })
        })
      }
      previewScrollRef.current?.scrollTo({
        top: pendingJumpLocation.previewScrollTop,
        behavior: 'auto'
      })
      clearPendingJumpLocation()
    })
    return () => cancelAnimationFrame(raf)
  }, [isActive, content?.path, clearPendingJumpLocation, pendingJumpLocation])

  // Focus the CM view when activePane → this pane AND focusedPanel === 'editor'.
  useEffect(() => {
    if (!isActive) return
    if (focusedPanel !== 'editor') return
    viewRef.current?.focus()
  }, [isActive, focusedPanel])

  // Flush save on unmount for whatever tab we currently hold. Tracking
  // `activeTab` in a ref keeps the cleanup reading the latest value
  // even though it only runs when the pane unmounts.
  const activeTabRef = useRef<string | null>(activeTab)
  activeTabRef.current = activeTab
  useEffect(() => {
    return () => {
      const path = activeTabRef.current
      if (!path) return
      if (useStore.getState().noteDirty[path]) {
        void persistNote(path)
      }
    }
  }, [persistNote])

  /* ---------- Tab strip DnD ---------- */
  const getTabDropInfo = useCallback(
    (
      payload: DragPayload | null,
      targetPath: string,
      targetEl: HTMLElement,
      clientX: number
    ): { dragPath: string; sourcePaneId?: string; targetPath: string; position: 'before' | 'after' } | null => {
      if (!payload || payload.kind !== 'note') return null
      if (payload.path === targetPath && payload.sourcePaneId === paneId) return null
      const rect = targetEl.getBoundingClientRect()
      return {
        dragPath: payload.path,
        sourcePaneId: payload.sourcePaneId,
        targetPath,
        position: clientX < rect.left + rect.width / 2 ? 'before' : 'after'
      }
    },
    [paneId]
  )

  /* ---------- Pane body DnD ---------- */
  const computePaneEdge = useCallback((clientX: number, clientY: number): PaneEdge => {
    const rect = paneBodyRef.current?.getBoundingClientRect()
    if (!rect) return 'center'
    return inferPaneDropEdge(rect, clientX, clientY)
  }, [])

  const handlePaneBodyDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (hasZenItem(e)) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setPaneDropEdge(tabsEnabled ? computePaneEdge(e.clientX, e.clientY) : 'center')
        setTabDropIndicator(null)
        return
      }
      if (hasImageBlockDragPayload(e.dataTransfer)) {
        const imageBlock = readImageBlockDragPayload(e.dataTransfer)
        const view = viewRef.current
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (imageBlock && view && editorSurfaceRef.current) {
          const placement = getImageBlockDropPlacement(view, imageBlock, {
            x: e.clientX,
            y: e.clientY
          })
          const indicatorRect = placement ? view.coordsAtPos(placement.indicatorPos) : null
          const surfaceRect = editorSurfaceRef.current.getBoundingClientRect()
          setImageDropIndicatorTop(
            indicatorRect ? Math.max(0, indicatorRect.top - surfaceRect.top) : null
          )
        } else {
          setImageDropIndicatorTop(null)
        }
        setPaneDropEdge(null)
        return
      }
      if (!hasDroppedFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setAssetDropActive(true)
      setPaneDropEdge(null)
      setImageDropIndicatorTop(null)
    },
    [computePaneEdge, tabsEnabled]
  )

  const importDroppedFiles = useCallback(
    async (sourcePaths: string[], coords?: { x: number; y: number }) => {
      if (!content || !vault || sourcePaths.length === 0) return
      try {
        const imported = await window.zen.importFilesToNote(content.path, sourcePaths)
        if (imported.length === 0) return
        const view = viewRef.current
        if (!view) return
        let insertAt = view.state.selection.main.head
        if (coords) insertAt = view.posAtCoords(coords) ?? insertAt
        let insert = imported.map((asset) => asset.markdown).join('\n\n')
        const doc = view.state.doc
        const before = insertAt > 0 ? doc.sliceString(insertAt - 1, insertAt) : ''
        const after = insertAt < doc.length ? doc.sliceString(insertAt, insertAt + 1) : ''
        const wantsStandalonePreview = imported.some(
          (asset) =>
            asset.kind === 'image' ||
            asset.kind === 'pdf' ||
            asset.kind === 'audio' ||
            asset.kind === 'video'
        )
        if (wantsStandalonePreview) {
          if (before && before !== '\n') insert = `\n\n${insert}`
          insert = `${insert.replace(/\n*$/, '')}\n\n`
        } else {
          if (before && before !== '\n') insert = `\n${insert}`
          if (after && after !== '\n') insert = `${insert}\n`
        }
        view.dispatch({
          changes: { from: insertAt, to: insertAt, insert },
          selection: { anchor: insertAt + insert.length }
        })
        await refreshNotes()
        setFocusedPanel('editor')
        view.focus()
      } catch (err) {
        window.alert((err as Error).message)
      }
    },
    [content, refreshNotes, setFocusedPanel, vault]
  )

  const handlePaneBodyDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (hasZenItem(e)) {
        const payload = readDragPayload(e)
        // With tabs disabled the user explicitly wants single-pane
        // mode — treat every drop as a center drop so splits can't
        // sneak back in through the drag layer.
        const rawEdge = computePaneEdge(e.clientX, e.clientY)
        const edge: PaneEdge = tabsEnabled ? rawEdge : 'center'
        setPaneDropEdge(null)
        if (!payload || payload.kind !== 'note') return
        e.preventDefault()
        e.stopPropagation()
        if (edge === 'center') {
          if (payload.sourcePaneId && payload.sourcePaneId !== paneId) {
            void movePaneTab({
              sourcePaneId: payload.sourcePaneId,
              targetPaneId: paneId,
              path: payload.path
            })
          } else {
            void openNoteInPane(paneId, payload.path)
          }
        } else {
          void splitPaneWithTab({
            targetPaneId: paneId,
            edge,
            path: payload.path,
            sourcePaneId: payload.sourcePaneId
          })
        }
        return
      }
      const imageBlock = readImageBlockDragPayload(e.dataTransfer)
      if (imageBlock) {
        e.preventDefault()
        e.stopPropagation()
        setImageDropIndicatorTop(null)
        if (!content || imageBlock.notePath !== content.path) return
        const view = viewRef.current
        if (!view) return
        moveImageBlockInEditor(view, imageBlock, { x: e.clientX, y: e.clientY })
        return
      }
      const fileDrop = hasDroppedFiles(e.dataTransfer)
      const sourcePaths = droppedPathsFromTransfer(e.dataTransfer)
      setAssetDropActive(false)
      setImageDropIndicatorTop(null)
      if (fileDrop) e.preventDefault()
      if (sourcePaths.length === 0) {
        if (fileDrop) {
          window.alert('Could not read the dropped file path. Restart the app and try again.')
        }
        return
      }
      e.stopPropagation()
      void importDroppedFiles(sourcePaths, { x: e.clientX, y: e.clientY })
    },
    [
      computePaneEdge,
      content,
      importDroppedFiles,
      movePaneTab,
      openNoteInPane,
      paneId,
      splitPaneWithTab,
      tabsEnabled
    ]
  )

  const handlePaneBodyDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setPaneDropEdge(null)
    setAssetDropActive(false)
    setImageDropIndicatorTop(null)
  }, [])

  useEffect(() => {
    const clear = (): void => {
      setPaneDropEdge(null)
      setTabDropIndicator(null)
      setAssetDropActive(false)
      setImageDropIndicatorTop(null)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  /* ---------- Tab strip drop-on-strip handler (for dropping onto empty area) ---------- */
  const handleTabStripDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!hasZenItem(e)) return
      const payload = readDragPayload(e)
      if (!payload || payload.kind !== 'note') return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
    },
    []
  )
  const handleTabStripDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!hasZenItem(e)) return
      const payload = readDragPayload(e)
      if (!payload || payload.kind !== 'note') return
      e.preventDefault()
      e.stopPropagation()
      setTabDropIndicator(null)
      if (payload.sourcePaneId && payload.sourcePaneId !== paneId) {
        void movePaneTab({
          sourcePaneId: payload.sourcePaneId,
          targetPaneId: paneId,
          path: payload.path
        })
      } else if (!payload.sourcePaneId) {
        void openNoteInPane(paneId, payload.path)
      }
    },
    [movePaneTab, openNoteInPane, paneId]
  )

  /* ---------- Tab rendering ---------- */
  const tabItems = useMemo(
    () => {
      const pinnedSet = new Set(pinnedTabs)
      return tabs.map((path) => {
        if (isTasksTabPath(path)) {
          return {
            path,
            title: 'Tasks',
            pinned: pinnedSet.has(path),
            isQuick: false,
            isTasks: true,
            isTag: false,
            isHelp: false,
            isArchive: false,
            isTrash: false
          }
        }
        if (isQuickNotesTabPath(path)) {
          return {
            path,
            title: folderLabels.quick,
            pinned: pinnedSet.has(path),
            isQuick: true,
            isTasks: false,
            isTag: false,
            isHelp: false,
            isArchive: false,
            isTrash: false
          }
        }
        if (isTagsTabPath(path)) {
          return {
            path,
            title: 'Tags',
            pinned: pinnedSet.has(path),
            isQuick: false,
            isTasks: false,
            isTag: true,
            isHelp: false,
            isArchive: false,
            isTrash: false
          }
        }
        if (isHelpTabPath(path)) {
          return {
            path,
            title: 'Help',
            pinned: pinnedSet.has(path),
            isQuick: false,
            isTasks: false,
            isTag: false,
            isHelp: true,
            isArchive: false,
            isTrash: false
          }
        }
        if (isArchiveTabPath(path)) {
          return {
            path,
            title: folderLabels.archive,
            pinned: pinnedSet.has(path),
            isQuick: false,
            isTasks: false,
            isTag: false,
            isHelp: false,
            isArchive: true,
            isTrash: false
          }
        }
        if (isTrashTabPath(path)) {
          return {
            path,
            title: folderLabels.trash,
            pinned: pinnedSet.has(path),
            isQuick: false,
            isTasks: false,
            isTag: false,
            isHelp: false,
            isArchive: false,
            isTrash: true
          }
        }
        const meta = path === content?.path ? content : notes.find((n) => n.path === path)
        const title = meta?.title ?? path.split('/').pop()?.replace(/\.md$/i, '') ?? path
        return {
          path,
          title,
          pinned: pinnedSet.has(path),
          isQuick: false,
          isTasks: false,
          isTag: false,
          isHelp: false,
          isArchive: false,
          isTrash: false
        }
      })
    },
    [tabs, pinnedTabs, content, notes, folderLabels.quick, folderLabels.archive, folderLabels.trash]
  )

  const tabMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!tabMenu) return []
    const path = tabMenu.path
    const tabIndex = tabs.indexOf(path)
    const isPinned = pinnedTabs.includes(path)
    const pinnedSet = new Set(pinnedTabs)
    // Closable tabs (everything that isn't pinned) that sit strictly
    // after this tab in the strip.
    const closableRight = tabs
      .slice(tabIndex + 1)
      .filter((t) => !pinnedSet.has(t))
    // Everything that could be closed by "Close Others" — every tab
    // except this one AND any pinned tabs.
    const closableOthers = tabs.filter((t) => t !== path && !pinnedSet.has(t))

    // Tasks tab gets a trimmed menu — no "Pin as Reference", "Reveal in
    // Finder", or floating-window since those only make sense for notes.
    if (isTasksTabPath(path)) {
      return [
        { label: 'Close', onSelect: async () => closeTabInPane(paneId, path) },
        {
          label: 'Close Others',
          disabled: closableOthers.length === 0,
          onSelect: async () => {
            for (const t of closableOthers) await closeTabInPane(paneId, t)
          }
        },
        {
          label: 'Close Tabs to Right',
          disabled: closableRight.length === 0,
          onSelect: async () => {
            for (const t of closableRight) await closeTabInPane(paneId, t)
          }
        },
        { kind: 'separator' },
        {
          label: 'Split Right',
          onSelect: async () =>
            splitPaneWithTab({ targetPaneId: paneId, edge: 'right', path })
        },
        {
          label: 'Split Down',
          onSelect: async () =>
            splitPaneWithTab({ targetPaneId: paneId, edge: 'bottom', path })
        },
        { kind: 'separator' },
        {
          label: 'Refresh',
          onSelect: async () => {
            await useStore.getState().refreshTasks()
          }
        }
      ]
    }

    // Quick Notes, Tags, Help, Archive, and Trash tabs share the same virtual-tab menu shape:
    // close, close relatives, or split them into another pane.
    if (
      isQuickNotesTabPath(path) ||
      isTagsTabPath(path) ||
      isHelpTabPath(path) ||
      isArchiveTabPath(path) ||
      isTrashTabPath(path)
    ) {
      return [
        { label: 'Close', onSelect: async () => closeTabInPane(paneId, path) },
        {
          label: 'Close Others',
          disabled: closableOthers.length === 0,
          onSelect: async () => {
            for (const t of closableOthers) await closeTabInPane(paneId, t)
          }
        },
        {
          label: 'Close Tabs to Right',
          disabled: closableRight.length === 0,
          onSelect: async () => {
            for (const t of closableRight) await closeTabInPane(paneId, t)
          }
        },
        { kind: 'separator' },
        {
          label: 'Split Right',
          onSelect: async () =>
            splitPaneWithTab({ targetPaneId: paneId, edge: 'right', path })
        },
        {
          label: 'Split Down',
          onSelect: async () =>
            splitPaneWithTab({ targetPaneId: paneId, edge: 'bottom', path })
        }
      ]
    }

    const items: ContextMenuItem[] = [
      { label: 'Close', onSelect: async () => closeTabInPane(paneId, path) },
      {
        label: 'Close Others',
        disabled: closableOthers.length === 0,
        onSelect: async () => {
          for (const t of closableOthers) await closeTabInPane(paneId, t)
        }
      },
      {
        label: 'Close Tabs to Right',
        disabled: closableRight.length === 0,
        onSelect: async () => {
          for (const t of closableRight) await closeTabInPane(paneId, t)
        }
      },
      { kind: 'separator' },
      {
        label: isPinned ? 'Unpin Tab' : 'Pin Tab',
        onSelect: async () => {
          toggleTabPin(paneId, path)
        }
      },
      { kind: 'separator' },
      {
        // Clone the tab into a new split to the right — both panes
        // continue to show the note. Omitting sourcePaneId is what
        // tells the store to skip the move-out step.
        label: 'Split Right',
        onSelect: async () =>
          splitPaneWithTab({ targetPaneId: paneId, edge: 'right', path })
      },
      {
        label: 'Split Down',
        onSelect: async () =>
          splitPaneWithTab({ targetPaneId: paneId, edge: 'bottom', path })
      },
      { kind: 'separator' },
      {
        label: 'Pin as Reference',
        onSelect: async () => {
          await useStore.getState().pinReference(path)
        }
      },
      {
        label: 'Open in Floating Window',
        onSelect: async () => {
          await window.zen.openNoteWindow(path)
        }
      }
    ]
    if (window.zen.getAppInfo().runtime === 'desktop' && workspaceMode !== 'remote') {
      items.push({
        label: 'Reveal in File Manager',
        onSelect: async () => window.zen.revealNote(path)
      })
    }
    return items
  }, [tabMenu, tabs, pinnedTabs, paneId, closeTabInPane, splitPaneWithTab, toggleTabPin, workspaceMode])

  const renderTab = useCallback(
    (tab: {
      path: string
      title: string
      pinned: boolean
      isQuick: boolean
      isTasks: boolean
      isTag: boolean
      isHelp: boolean
      isArchive: boolean
      isTrash: boolean
    }) => {
      const active = tab.path === activeTab
      const isVirtual =
        tab.isQuick || tab.isTasks || tab.isTag || tab.isHelp || tab.isArchive || tab.isTrash
      return (
        <div
          key={tab.path}
          data-tab-menu-target="true"
          data-tab-pane-id={paneId}
          data-tab-path={tab.path}
          data-tab-active={active ? 'true' : undefined}
          className="relative"
          draggable={!isVirtual}
          onDragStart={(e) => {
            if (isVirtual) {
              e.preventDefault()
              return
            }
            setDragPayload(e, { kind: 'note', path: tab.path, sourcePaneId: paneId })
          }}
          onDragOver={(e) => {
            // Chromium masks `dataTransfer.getData()` for custom MIMEs
            // during dragover, so we can't parse the payload here —
            // fall back to `hasZenItem()` which only reads `types`.
            if (!hasZenItem(e)) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            const rect = e.currentTarget.getBoundingClientRect()
            const position: 'before' | 'after' =
              e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
            setTabDropIndicator({ path: tab.path, position })
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            setTabDropIndicator((cur) => (cur?.path === tab.path ? null : cur))
          }}
          onDrop={(e) => {
            const info = getTabDropInfo(readDragPayload(e), tab.path, e.currentTarget, e.clientX)
            setTabDropIndicator(null)
            if (!info) return
            e.preventDefault()
            e.stopPropagation()
            if (info.sourcePaneId === paneId) {
              reorderTabInPane(paneId, info.dragPath, info.targetPath, info.position)
            } else if (info.sourcePaneId) {
              const insertIndex =
                info.position === 'after'
                  ? tabs.indexOf(info.targetPath) + 1
                  : tabs.indexOf(info.targetPath)
              void movePaneTab({
                sourcePaneId: info.sourcePaneId,
                targetPaneId: paneId,
                path: info.dragPath,
                insertIndex
              })
            } else {
              const insertIndex =
                info.position === 'after'
                  ? tabs.indexOf(info.targetPath) + 1
                  : tabs.indexOf(info.targetPath)
              void openNoteInPane(paneId, info.dragPath, insertIndex)
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setTabMenu({ x: e.clientX, y: e.clientY, path: tab.path })
          }}
        >
          {tabDropIndicator?.path === tab.path && (
            <div
              className={[
                'pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded-full bg-accent',
                tabDropIndicator.position === 'before' ? '-left-0.5' : '-right-0.5'
              ].join(' ')}
            />
          )}
          <div
            className={[
              'group flex h-8 min-w-0 items-center gap-1 rounded-t-lg border border-b-0 px-1.5 text-sm transition-colors',
              tab.pinned ? 'max-w-[140px]' : 'max-w-[220px]',
              active && isActive
                ? focusedPanel === 'tabs'
                  ? 'border-accent/70 bg-paper-100 text-ink-900 ring-1 ring-inset ring-accent/60'
                  : 'border-paper-300/80 bg-paper-100 text-ink-900'
                : active
                  ? 'border-paper-300/60 bg-paper-100/70 text-ink-800'
                  : 'border-transparent bg-paper-200/45 text-ink-500 hover:bg-paper-200/70 hover:text-ink-900'
            ].join(' ')}
          >
            {tab.pinned && (
              <button
                type="button"
                aria-label={`Unpin ${tab.title}`}
                title="Unpin tab"
                onClick={() => unpinTabInPane(paneId, tab.path)}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-accent transition-colors hover:bg-paper-200"
              >
                <PinIcon width={11} height={11} />
              </button>
            )}
            <button
              onClick={() => void focusTabInPane(paneId, tab.path)}
              className="flex min-w-0 flex-1 items-center gap-1.5 truncate px-1.5 text-left"
            >
              {tab.isTasks && (
                <CheckSquareIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isQuick && (
                <ZapIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isTag && (
                <TagIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isHelp && (
                <DocumentIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isArchive && (
                <ArchiveIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isTrash && (
                <TrashIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={() => void closeTabInPane(paneId, tab.path)}
              className={[
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition-colors',
                active
                  ? 'text-ink-500 hover:bg-paper-200 hover:text-ink-900'
                  : 'hover:bg-paper-300/70'
              ].join(' ')}
            >
              <CloseIcon width={12} height={12} />
            </button>
          </div>
        </div>
      )
    },
    [
      activeTab,
      closeTabInPane,
      focusTabInPane,
      focusedPanel,
      getTabDropInfo,
      isActive,
      movePaneTab,
      openNoteInPane,
      paneId,
      reorderTabInPane,
      tabDropIndicator,
      tabs,
      unpinTabInPane
    ]
  )

  const toolbar = useMemo(() => {
    if (!content) return null
    const folder = content.folder
    return (
      <div className="flex items-center gap-1 text-ink-500">
        <ToggleGroup mode={mode} onChange={applyPaneMode} />
        <div className="mx-2 h-4 w-px bg-paper-300" />
        <IconBtn
          title={connectionsOpen ? 'Hide connections' : 'Show connections'}
          active={connectionsOpen}
          onClick={toggleConnectionsPanel}
        >
          <PanelRightIcon />
        </IconBtn>
        <IconBtn
          title={outlineOpen ? 'Hide outline' : 'Show outline'}
          active={outlineOpen}
          onClick={toggleOutlinePanel}
        >
          <ListTreeIcon />
        </IconBtn>
        {folder === 'trash' ? (
          <IconBtn title="Restore" onClick={() => void restoreActive()}>
            <ArrowUpRightIcon />
          </IconBtn>
        ) : folder === 'archive' ? (
          <IconBtn title="Unarchive" onClick={() => void unarchiveActive()}>
            <ArrowUpRightIcon />
          </IconBtn>
        ) : (
          <IconBtn title={folderLabels.archive} onClick={() => void archiveActive()}>
            <ArchiveIcon />
          </IconBtn>
        )}
        <IconBtn title={`Move to ${folderLabels.trash.toLowerCase()}`} onClick={() => void trashActive()}>
          <TrashIcon />
        </IconBtn>
        <IconBtn
          title="Close note (⌘W / :q)"
          onClick={() => {
            if (activeTab) void closeTabInPane(paneId, activeTab)
          }}
        >
          <CloseIcon />
        </IconBtn>
      </div>
    )
  }, [
    content,
    mode,
    connectionsOpen,
    toggleConnectionsPanel,
    outlineOpen,
    toggleOutlinePanel,
    trashActive,
    archiveActive,
    restoreActive,
    unarchiveActive,
    closeTabInPane,
    activeTab,
    paneId
  ])

  const showEditor = !!content && mode !== 'preview'
  const showPreview = !!content && mode !== 'edit'
  const splitMode = mode === 'split'
  const hasTabs = !zenMode && tabsEnabled && tabs.length > 0
  const { settledMarkdown: previewMarkdown } = useSettledMarkdown(
    content?.body ?? '',
    splitMode ? 75 : 0
  )

  const handlePreviewRequestEdit = useCallback(() => {
    if (mode === 'preview') {
      applyPaneMode('edit')
      return
    }
    focusEditorNormalMode()
  }, [applyPaneMode, mode])

  const paneFrameClass = [
    'relative flex min-h-0 min-w-0 flex-1 flex-col',
    isActive ? '' : 'opacity-[0.98]'
  ].join(' ')

  return (
    <section
      ref={paneRootRef}
      data-pane-id={paneId}
      className={paneFrameClass}
      onMouseDownCapture={() => {
        setActivePane(paneId)
        setFocusedPanel('editor')
      }}
      onFocusCapture={() => {
        setActivePane(paneId)
        setFocusedPanel('editor')
      }}
    >
      {hasTabs && (
        <div
          className="glass-header flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-paper-300/70 px-3 pt-2"
          onDragOver={handleTabStripDragOver}
          onDrop={handleTabStripDrop}
        >
          {tabItems.map((tab, i) => {
            // Draw a subtle vertical separator between the last pinned
            // tab and the first unpinned one (VSCode convention). The
            // separator is a flex sibling, not a wrapper, so drag hit-
            // detection on the tab itself is unchanged.
            const prevPinned = i > 0 ? tabItems[i - 1].pinned : false
            const needsSeparator = prevPinned && !tab.pinned
            return (
              <Fragment key={tab.path}>
                {needsSeparator && (
                  <div
                    aria-hidden
                    className="mx-0.5 h-5 shrink-0 self-center border-l border-paper-300/70"
                  />
                )}
                {renderTab(tab)}
              </Fragment>
            )
          })}
        </div>
      )}
      {content && !zenMode && (
        <header className="glass-header flex h-12 shrink-0 items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {!sidebarOpen && isActive && (
              <IconBtn title="Show sidebar (⌘1)" onClick={toggleSidebar}>
                <PanelLeftIcon />
              </IconBtn>
            )}
            <Breadcrumb
              note={content}
              autoFocus={isActive && pendingTitleFocusPath === content.path}
              onAutoFocusHandled={clearPendingTitleFocus}
              onRename={(next) => {
                if (next && next !== content.title) void renameActive(next)
              }}
            />
            {isDirty && (
              <span
                aria-label="Unsaved changes"
                title="Unsaved changes"
                className="ml-2 h-2 w-2 rounded-full bg-accent/80"
              />
            )}
          </div>
          {toolbar}
        </header>
      )}
      <div className="min-h-0 min-w-0 flex flex-1">
        <div
          ref={paneBodyRef}
          className={[
            'relative flex min-h-0 min-w-0 flex-1 flex-col',
            paneDropEdge && paneDropEdge !== 'center' ? 'bg-accent/4' : ''
          ].join(' ')}
          onDragOver={handlePaneBodyDragOver}
          onDragLeave={handlePaneBodyDragLeave}
          onDrop={handlePaneBodyDrop}
        >
          {paneDropEdge && <PaneDropOverlay edge={paneDropEdge} />}
          {assetDropActive && (
            <div className="pointer-events-none absolute inset-3 z-20 rounded-xl border-2 border-dashed border-accent/55 bg-accent/8" />
          )}
          {isTasksTabPath(activeTab) ? (
            <TasksView />
          ) : isQuickNotesTabPath(activeTab) ? (
            <QuickNotesView />
          ) : isTagsTabPath(activeTab) ? (
            <TagView />
          ) : isHelpTabPath(activeTab) ? (
            <HelpView />
          ) : isArchiveTabPath(activeTab) ? (
            <ArchiveView />
          ) : isTrashTabPath(activeTab) ? (
            <TrashView />
          ) : content ? (
            <div
              className={[
                'min-h-0 min-w-0 flex-1 overflow-hidden',
                splitMode ? 'flex flex-row' : 'flex flex-col'
              ].join(' ')}
            >
              <div
                ref={editorSurfaceRef}
                className={[
                  'relative min-h-0 min-w-0',
                  splitMode
                    ? 'flex min-w-0 flex-[1.05] flex-col border-r border-paper-300/70'
                    : 'flex flex-1 flex-col'
                ].join(' ')}
                style={{ display: showEditor ? 'flex' : 'none' }}
                onContextMenu={(e) => {
                  // Native browser context menu in Electron is threadbare
                  // (no Copy/Cut/Paste unless dev tools are open), so we
                  // roll our own using CodeMirror's selection state.
                  const view = viewRef.current
                  if (!view) return
                  e.preventDefault()
                  view.focus()
                  const sel = view.state.selection.main
                  setEditorMenu({
                    x: e.clientX,
                    y: e.clientY,
                    hasSelection: !sel.empty
                  })
                }}
              >
                {imageDropIndicatorTop != null && (
                  <div
                    className="pointer-events-none absolute inset-x-4 z-20"
                    style={{ top: imageDropIndicatorTop }}
                  >
                    <div className="relative h-0.5 rounded-full bg-accent shadow-[0_0_0_1px_rgb(var(--z-accent)/0.18)]">
                      <div className="absolute -left-1.5 -top-1 h-2.5 w-2.5 rounded-full border border-paper-50/70 bg-accent" />
                    </div>
                  </div>
                )}
                <div ref={setContainerRef} className="min-h-0 min-w-0 flex-1" />
              </div>
              {showPreview && (
                <div
                  ref={previewScrollRef}
                  data-preview-scroll
                  tabIndex={0}
                  aria-label="Note preview"
                  className={[
                    'min-h-0 min-w-0 overflow-y-auto outline-none focus:outline-none focus-visible:outline-none',
                    splitMode
                      ? 'flex min-w-0 flex-1 flex-col bg-paper-50/10'
                      : 'flex-1'
                  ].join(' ')}
                >
                  <Preview
                    markdown={previewMarkdown}
                    notePath={content.path}
                    onRequestEdit={handlePreviewRequestEdit}
                  />
                </div>
              )}
            </div>
          ) : loading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-400">
              Loading…
            </div>
          ) : (
            <EmptyPaneState
              sidebarOpen={sidebarOpen}
              zenMode={zenMode}
              onShowSidebar={() => {
                toggleSidebar()
                setFocusedPanel('sidebar')
              }}
            />
          )}
        </div>
        {content && connectionsOpen && isActive && !zenMode && <ConnectionsPanel note={content} />}
        {content && outlineOpen && !zenMode && (
          <OutlinePanel note={content} onJump={jumpToOutlineLine} />
        )}
      </div>
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems}
          onClose={() => setTabMenu(null)}
        />
      )}
      {editorMenu && (
        <ContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          items={buildEditorContextItems(viewRef.current, editorMenu.hasSelection)}
          onClose={() => setEditorMenu(null)}
        />
      )}
    </section>
  )
}

/**
 * Build the right-click menu shown over the editor text. Uses the live
 * CodeMirror view for clipboard / undo / redo / select-all commands.
 */
function buildEditorContextItems(
  view: EditorView | null,
  hasSelection: boolean
): ContextMenuItem[] {
  if (!view) return []

  const copy = async (): Promise<void> => {
    const sel = view.state.selection.main
    if (sel.empty) return
    const text = view.state.sliceDoc(sel.from, sel.to)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* clipboard may be blocked */
    }
  }

  const cut = async (): Promise<void> => {
    const sel = view.state.selection.main
    if (sel.empty) return
    await copy()
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: '' },
      selection: { anchor: sel.from }
    })
    view.focus()
  }

  const paste = async (): Promise<void> => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    if (!text) return
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length }
    })
    view.focus()
  }

  return [
    { label: 'Cut', hint: '⌘X', disabled: !hasSelection, onSelect: cut },
    { label: 'Copy', hint: '⌘C', disabled: !hasSelection, onSelect: copy },
    { label: 'Paste', hint: '⌘V', onSelect: paste },
    { kind: 'separator' },
    {
      label: 'Select All',
      hint: '⌘A',
      onSelect: async () => {
        selectAll(view)
        view.focus()
      }
    },
    { kind: 'separator' },
    {
      label: 'Undo',
      hint: '⌘Z',
      onSelect: async () => {
        undo(view)
        view.focus()
      }
    },
    {
      label: 'Redo',
      hint: '⇧⌘Z',
      onSelect: async () => {
        redo(view)
        view.focus()
      }
    }
  ]
}

function PaneDropOverlay({ edge }: { edge: PaneEdge }): JSX.Element {
  const classByEdge: Record<PaneEdge, string> = {
    center:
      'inset-3 rounded-xl border-2 border-dashed border-accent/65 bg-accent/10 shadow-[inset_0_0_0_1px_rgb(var(--z-accent)/0.22)]',
    left: 'left-3 top-3 bottom-3 w-1/3 rounded-xl border border-accent/55 bg-accent/10',
    right: 'right-3 top-3 bottom-3 w-1/3 rounded-xl border border-accent/55 bg-accent/10',
    top: 'left-3 right-3 top-3 h-1/3 rounded-xl border border-accent/55 bg-accent/10',
    bottom: 'left-3 right-3 bottom-3 h-1/3 rounded-xl border border-accent/55 bg-accent/10'
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className={['absolute', classByEdge[edge]].join(' ')} />
    </div>
  )
}

function EmptyPaneState({
  sidebarOpen,
  zenMode,
  onShowSidebar
}: {
  sidebarOpen: boolean
  zenMode: boolean
  onShowSidebar: () => void
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-md rounded-3xl border border-paper-300/70 bg-paper-50/35 px-6 py-6 text-center shadow-[0_18px_48px_rgba(15,23,42,0.08)] backdrop-blur-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-paper-300/70 bg-paper-100/80 text-ink-600">
          <PanelLeftIcon width={20} height={20} />
        </div>
        <h2 className="mt-4 text-base font-medium text-ink-900">
          {zenMode ? 'Zen mode is on' : sidebarOpen ? 'No note selected' : 'Sidebar hidden'}
        </h2>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          {zenMode
            ? 'Leave Zen mode with ⌘. to bring the rest of the app chrome back.'
            : sidebarOpen
            ? 'Select a note from the sidebar, or create a new one to start writing.'
            : 'Bring the sidebar back to browse your notes, folders, and shortcuts.'}
        </p>
        {!zenMode && !sidebarOpen && (
          <div className="mt-5 flex items-center justify-center">
            <button
              type="button"
              onClick={onShowSidebar}
              className="inline-flex items-center gap-2 rounded-xl border border-paper-300 bg-paper-100 px-3.5 py-2 text-sm font-medium text-ink-900 transition-colors hover:bg-paper-200"
            >
              <PanelLeftIcon width={16} height={16} />
              <span>Show sidebar</span>
              <span className="rounded-md border border-paper-300/80 bg-paper-50/80 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">
                ⌘1
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  active = false
}: {
  children: JSX.Element
  onClick: () => void
  title: string
  active?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={[
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-paper-200 text-ink-900'
          : 'text-ink-500 hover:bg-paper-200 hover:text-ink-900'
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function ToggleGroup({
  mode,
  onChange
}: {
  mode: PaneMode
  onChange: (m: PaneMode) => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-1 rounded-md bg-paper-200/70 p-0.5 text-xs">
      {(['edit', 'split', 'preview'] as PaneMode[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={[
            'rounded px-2 py-1 transition-colors',
            mode === m ? 'bg-paper-50 text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800'
          ].join(' ')}
        >
          {m === 'edit' ? 'Edit' : m === 'split' ? 'Split' : 'Preview'}
        </button>
      ))}
    </div>
  )
}

const INVALID_FILENAME_CHARS = /[/\\:*?"<>|#^\[\]]/

function Breadcrumb({
  note,
  autoFocus,
  onAutoFocusHandled,
  onRename
}: {
  note: { path: string; title: string; folder: NoteFolder }
  autoFocus: boolean
  onAutoFocusHandled: () => void
  onRename: (next: string) => void
}): JSX.Element {
  const setView = useStore((s) => s.setView)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(note.title)
  const [warning, setWarning] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const editingNow = editing || autoFocus

  useEffect(() => setValue(note.title), [note.title])
  useEffect(() => setWarning(''), [note.path])
  useEffect(() => {
    setEditing(autoFocus)
  }, [autoFocus, note.path])
  useEffect(() => {
    if (!editingNow) return
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
      if (autoFocus) onAutoFocusHandled()
    })
    return () => cancelAnimationFrame(raf)
  }, [autoFocus, editingNow, onAutoFocusHandled])

  const topFolder = note.folder
  const segments = noteFolderSubpath(note, vaultSettings)
    .split('/')
    .filter(Boolean)
  const ancestors: { label: string; onClick: () => void }[] = []
  if (!(topFolder === 'inbox' && isPrimaryNotesAtRoot(vaultSettings))) {
    ancestors.push({
      label: getSystemFolderLabel(topFolder, systemFolderLabels),
      onClick: () => setView({ kind: 'folder', folder: topFolder, subpath: '' })
    })
  }
  let acc = ''
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg
    const subpath = acc
    ancestors.push({
      label: seg,
      onClick: () => setView({ kind: 'folder', folder: topFolder, subpath })
    })
  }

  const commitRename = (rawValue = value): boolean => {
    setWarning('')
    const trimmed = rawValue.trim()
    if (!trimmed || trimmed === note.title) {
      setValue(note.title)
      return true
    }
    if (INVALID_FILENAME_CHARS.test(trimmed)) {
      setWarning('Invalid characters: # ^ [ ] | \\ : * ? " < >')
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
      return false
    }
    onRename(trimmed)
    return true
  }

  return (
    <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden text-sm text-ink-500">
      {ancestors.map((c, i) => (
        <span key={i} className="flex shrink-0 items-center gap-1">
          <button
            onClick={c.onClick}
            className="truncate rounded px-1 hover:bg-paper-200/70 hover:text-ink-800"
            title={`Go to ${c.label}`}
          >
            {c.label}
          </button>
          <span className="text-ink-400">›</span>
        </span>
      ))}
      {editingNow ? (
        <input
          ref={inputRef}
          spellCheck={false}
          value={value}
          placeholder="Untitled"
          onFocus={() => useStore.getState().setFocusedPanel('editor')}
          onChange={(e) => {
            setValue(e.target.value)
            setWarning('')
          }}
          onBlur={() => {
            if (commitRename()) setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              if (!commitRename()) return
              setEditing(false)
              focusEditorNormalMode()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setValue(note.title)
              setWarning('')
              setEditing(false)
              focusEditorNormalMode()
            }
          }}
          title={warning || 'Rename note'}
          aria-invalid={warning ? 'true' : 'false'}
          className={[
            'min-w-[88px] max-w-[360px] rounded px-1.5 py-0.5 text-sm font-semibold text-ink-900 outline-none',
            warning ? 'bg-red-500/12 ring-1 ring-red-500/60' : 'bg-paper-200/60'
          ].join(' ')}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Rename note"
          className="truncate rounded px-1.5 py-0.5 text-sm font-semibold text-ink-900 hover:bg-paper-200/70"
        >
          {note.title || 'Untitled'}
        </button>
      )}
    </div>
  )
}
