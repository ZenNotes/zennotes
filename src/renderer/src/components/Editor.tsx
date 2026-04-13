import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Vim, vim, getCM } from '@replit/codemirror-vim'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { searchKeymap } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { useStore } from '../store'
import type { LineNumberMode } from '../store'
import { livePreviewPlugin } from '../lib/cm-live-preview'
import { slashCommandSource, slashCommandRender } from '../lib/cm-slash-commands'
import { dateShortcutSource } from '../lib/cm-date-shortcuts'
import { wikilinkSource } from '../lib/cm-wikilinks'
import { Preview } from './Preview'
import { StatusBar } from './StatusBar'
import { ConnectionsPanel } from './ConnectionsPanel'
import { promptApp } from './PromptHost'
import { hasZenItem, readDragPayload } from '../lib/dnd'
import {
  parseCreateNotePath,
  resolveWikilinkTarget,
  suggestCreateNotePath
} from '../lib/wikilinks'
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CloseIcon,
  PanelLeftIcon,
  PanelRightIcon,
  TrashIcon
} from './icons'

const paperHighlight = HighlightStyle.define([
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
  { tag: t.meta, class: 'tok-meta' }
])

/** Annotation to mark programmatic doc replacements (note switching)
 *  so the update listener skips saving. */
const programmatic = Annotation.define<boolean>()



type Mode = 'edit' | 'preview' | 'split'

const EDITOR_MODE_KEY = 'zen:editor-mode:v1'
const CONNECTIONS_PANEL_KEY = 'zen:connections-panel:v1'

let vimCommandsRegistered = false

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

/** Extract a link target from the text around a cursor position.
 *  Returns the URL/path, or null if the cursor isn't on a link. */
function extractLinkAtCursor(doc: string, pos: number): string | null {
  // Find the line containing the cursor
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = doc.indexOf('\n', pos)
  const line = doc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
  const col = pos - lineStart

  // Wiki-link: [[target]] or [[target|label]]
  const wikiRe = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = wikiRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[1]
  }

  // Markdown link: [text](url)
  const mdRe = /\[([^\]]*)\]\(([^)]+)\)/g
  while ((m = mdRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[2]
  }

  // Bare URL: https://... or http://...
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

  Vim.defineEx('write', 'w', () => {
    void useStore.getState().persistActive()
  })
  Vim.defineEx('format', 'format', () => {
    void useStore.getState().formatActiveNote()
  })
  Vim.defineEx('quit', 'q', () => {
    void useStore.getState().closeActiveNote()
  })
  Vim.defineEx('wq', 'wq', () => {
    void useStore.getState().closeActiveNote()
  })

  // gd — go to definition: follow link under cursor
  Vim.defineAction('goToDefinition', (cm: ReturnType<typeof getCM>) => {
    const view = (cm as any).cm6 as EditorView | undefined
    if (!view) return
    const pos = view.state.selection.main.head
    const doc = view.state.doc.toString()
    const target = extractLinkAtCursor(doc, pos)
    if (!target) return

    // External URL → open in browser
    if (/^https?:\/\//i.test(target)) {
      window.open(target, '_blank')
      return
    }

    // Note reference → resolve and open
    const state = useStore.getState()
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

  Vim.mapCommand('gd', 'action', 'goToDefinition', {}, { context: 'normal' })
}

function droppedFilePaths(files: FileList | File[]): string[] {
  const getPathForFile =
    typeof (window.zen as { getPathForFile?: (file: File) => string | null }).getPathForFile ===
    'function'
      ? (window.zen as { getPathForFile: (file: File) => string | null }).getPathForFile
      : null
  return Array.from(files)
    .map((file) => {
      const bridged = getPathForFile?.(file) ?? null
      if (bridged) return bridged
      const legacy = (file as File & { path?: string }).path
      return typeof legacy === 'string' && legacy.length > 0 ? legacy : null
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function parseDroppedPathCandidate(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'))
  if (!firstLine) return null
  if (firstLine.startsWith('file://')) {
    try {
      const url = new URL(firstLine)
      if (url.protocol !== 'file:') return null
      return decodeURIComponent(url.pathname)
    } catch {
      return null
    }
  }
  if (firstLine.startsWith('/')) return firstLine
  return null
}

function hasDroppedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  if (dataTransfer.files.length > 0) return true
  if (Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')) return true
  const types = new Set(Array.from(dataTransfer.types ?? []))
  return (
    types.has('Files') ||
    types.has('text/uri-list') ||
    types.has('public.file-url') ||
    types.has('text/plain')
  )
}

function droppedFilesFromTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  if (dataTransfer.files.length > 0) return Array.from(dataTransfer.files)
  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file)
}

function droppedPathsFromTransfer(dataTransfer: DataTransfer | null): string[] {
  const direct = droppedFilePaths(droppedFilesFromTransfer(dataTransfer))
  if (direct.length > 0) return direct
  if (!dataTransfer) return []
  const fallbacks = [
    dataTransfer.getData('text/uri-list'),
    dataTransfer.getData('public.file-url'),
    dataTransfer.getData('text/plain')
  ]
  const seen = new Set<string>()
  for (const raw of fallbacks) {
    const parsed = parseDroppedPathCandidate(raw)
    if (parsed) seen.add(parsed)
  }
  return [...seen]
}

export function Editor(): JSX.Element {
  const activeNote = useStore((s) => s.activeNote)
  const loading = useStore((s) => s.loadingNote)
  const vault = useStore((s) => s.vault)
  const notes = useStore((s) => s.notes)
  const updateActiveBody = useStore((s) => s.updateActiveBody)
  const persistActive = useStore((s) => s.persistActive)
  const closeActiveNote = useStore((s) => s.closeActiveNote)
  const closeTab = useStore((s) => s.closeTab)
  const trashActive = useStore((s) => s.trashActive)
  const archiveActive = useStore((s) => s.archiveActive)
  const restoreActive = useStore((s) => s.restoreActive)
  const unarchiveActive = useStore((s) => s.unarchiveActive)
  const renameActive = useStore((s) => s.renameActive)
  const openTabs = useStore((s) => s.openTabs)
  const splitNote = useStore((s) => s.splitNote)
  const tabsEnabled = useStore((s) => s.tabsEnabled)
  const openNoteInSplit = useStore((s) => s.openNoteInSplit)
  const closeSplitNote = useStore((s) => s.closeSplitNote)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const vimMode = useStore((s) => s.vimMode)
  const livePreview = useStore((s) => s.livePreview)
  const setEditorViewRef = useStore((s) => s.setEditorViewRef)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const setConnectionPreview = useStore((s) => s.setConnectionPreview)
  const pendingTitleFocusPath = useStore((s) => s.pendingTitleFocusPath)
  const clearPendingTitleFocus = useStore((s) => s.clearPendingTitleFocus)
  const pendingJumpLocation = useStore((s) => s.pendingJumpLocation)
  const clearPendingJumpLocation = useStore((s) => s.clearPendingJumpLocation)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const lineNumberMode = useStore((s) => s.lineNumberMode)
  const textFont = useStore((s) => s.textFont)

  const [mode, setMode] = useState<Mode>(() => {
    try {
      const raw = localStorage.getItem(EDITOR_MODE_KEY)
      if (raw === 'edit' || raw === 'preview' || raw === 'split') return raw
    } catch {
      /* ignore */
    }
    return 'edit'
  })
  const [connectionsOpen, setConnectionsOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CONNECTIONS_PANEL_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [assetDropActive, setAssetDropActive] = useState(false)
  const [noteSplitDropActive, setNoteSplitDropActive] = useState(false)
  const viewRef = useRef<EditorView | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)
  const vimCompartmentRef = useRef<Compartment | null>(null)
  const livePreviewCompartmentRef = useRef<Compartment | null>(null)
  const lineNumbersCompartmentRef = useRef<Compartment | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    registerVimCommands()
  }, [])

  const toggleConnectionsPanel = useCallback(() => {
    setConnectionsOpen((open) => {
      const next = !open
      if (!next) {
        setConnectionPreview(null)
        const state = useStore.getState()
        if (state.focusedPanel === 'connections' || state.focusedPanel === 'hoverpreview') {
          state.setFocusedPanel('editor')
        }
      }
      return next
    })
  }, [setConnectionPreview])

  useEffect(() => {
    const handleToggleConnections = (): void => {
      toggleConnectionsPanel()
    }
    window.addEventListener('zen:toggle-connections', handleToggleConnections as EventListener)
    return () => {
      window.removeEventListener('zen:toggle-connections', handleToggleConnections as EventListener)
    }
  }, [toggleConnectionsPanel])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void persistActive()
    }, 350)
  }, [persistActive])

  const importDroppedFiles = useCallback(
    async (sourcePaths: string[], coords?: { x: number; y: number }) => {
      if (!activeNote || !vault || sourcePaths.length === 0) return
      try {
        const imported = await window.zen.importFilesToNote(activeNote.path, sourcePaths)
        if (imported.length === 0) return
        const view = viewRef.current
        if (!view) return

        let insertAt = view.state.selection.main.head
        if (coords) {
          insertAt = view.posAtCoords(coords) ?? insertAt
        }

        let insert = imported.map((asset) => asset.markdown).join('\n\n')
        const doc = view.state.doc
        const before = insertAt > 0 ? doc.sliceString(insertAt - 1, insertAt) : ''
        const after = insertAt < doc.length ? doc.sliceString(insertAt, insertAt + 1) : ''
        const wantsStandalonePreview = imported.some((asset) =>
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
        setFocusedPanel('editor')
        view.focus()
      } catch (err) {
        window.alert((err as Error).message)
      }
    },
    [activeNote, setFocusedPanel, vault]
  )

  const handleEditorDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!activeNote) return
    if (hasZenItem(e)) return
    if (!hasDroppedFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setAssetDropActive(true)
  }, [activeNote])

  const handleEditorDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!activeNote) return
    if (hasZenItem(e)) return
    const fileDrop = hasDroppedFiles(e.dataTransfer)
    const sourcePaths = droppedPathsFromTransfer(e.dataTransfer)
    setAssetDropActive(false)
    if (fileDrop) {
      e.preventDefault()
      e.stopPropagation()
    }
    if (sourcePaths.length === 0) {
      if (fileDrop) {
        window.alert('Could not read the dropped file path. Restart the app and try again.')
      }
      return
    }
    e.stopPropagation()
    void importDroppedFiles(sourcePaths, { x: e.clientX, y: e.clientY })
  }, [activeNote, importDroppedFiles])

  const handleEditorDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setAssetDropActive(false)
  }, [])

  const handleWorkspaceDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!activeNote) return
    if (hasZenItem(e)) {
      if (!tabsEnabled) return
      const payload = readDragPayload(e)
      if (!payload || payload.kind !== 'note' || payload.path === activeNote.path) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setNoteSplitDropActive(true)
      return
    }
    if (!hasDroppedFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setAssetDropActive(true)
  }, [activeNote, tabsEnabled])

  const handleWorkspaceDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!activeNote) return
    setNoteSplitDropActive(false)
    setAssetDropActive(false)
    if (hasZenItem(e)) {
      if (!tabsEnabled) return
      const payload = readDragPayload(e)
      if (!payload || payload.kind !== 'note' || payload.path === activeNote.path) return
      e.preventDefault()
      void openNoteInSplit(payload.path)
      return
    }
    const fileDrop = hasDroppedFiles(e.dataTransfer)
    const sourcePaths = droppedPathsFromTransfer(e.dataTransfer)
    if (fileDrop) e.preventDefault()
    if (sourcePaths.length === 0) {
      if (fileDrop) {
        window.alert('Could not read the dropped file path. Restart the app and try again.')
      }
      return
    }
    void importDroppedFiles(sourcePaths, { x: e.clientX, y: e.clientY })
  }, [activeNote, importDroppedFiles, openNoteInSplit, tabsEnabled])

  const handleWorkspaceDragLeave = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setNoteSplitDropActive(false)
    setAssetDropActive(false)
  }, [])

  useEffect(() => {
    const clearDragState = (): void => {
      setAssetDropActive(false)
      setNoteSplitDropActive(false)
    }
    window.addEventListener('dragend', clearDragState)
    window.addEventListener('drop', clearDragState)
    return () => {
      window.removeEventListener('dragend', clearDragState)
      window.removeEventListener('drop', clearDragState)
    }
  }, [])

  // Callback ref: create the CodeMirror view the moment the host div mounts,
  // and destroy it when the div detaches. This avoids the gotcha where a
  // useEffect gated on a ref runs before the ref is attached on first render.
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        viewRef.current?.destroy()
        viewRef.current = null
        useStore.getState().setEditorViewRef(null)
        return
      }
      if (viewRef.current) return
      // Vim and live-preview each live in their own Compartment so
      // toggling them at runtime just dispatches a reconfigure effect —
      // no view teardown, no lost state. Vim must be placed BEFORE the
      // default keymap so its bindings win.
      const vimCompartment = new Compartment()
      const livePreviewCompartment = new Compartment()
      const lineNumbersCompartment = new Compartment()
      vimCompartmentRef.current = vimCompartment
      livePreviewCompartmentRef.current = livePreviewCompartment
      lineNumbersCompartmentRef.current = lineNumbersCompartment
      const currentVim = useStore.getState().vimMode
      const currentLive = useStore.getState().livePreview
      const currentLineNumbers = useStore.getState().lineNumberMode
      const state = EditorState.create({
        doc: '',
        extensions: [
          vimCompartment.of(currentVim ? vim() : []),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
          syntaxHighlighting(paperHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          livePreviewCompartment.of(currentLive ? livePreviewPlugin : []),
          lineNumbersCompartment.of(lineNumberExtension(currentLineNumbers)),
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
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap
          ]),
          EditorView.updateListener.of((upd) => {
            if (!upd.docChanged) return
            // Skip save for programmatic doc replacements (note switching)
            if (upd.transactions.some((tr: Transaction) => tr.annotation(programmatic))) return
            const text = upd.state.doc.toString()
            updateActiveBody(text)
            scheduleSave()
          })
        ]
      })
      const view = new EditorView({ state, parent: el })
      viewRef.current = view
      useStore.getState().setEditorViewRef(view)
    },
    [scheduleSave, updateActiveBody]
  )

  // Auto-focus editor when focusedPanel transitions to 'editor'
  useEffect(() => {
    if (focusedPanel === 'editor') {
      viewRef.current?.focus()
    }
  }, [focusedPanel])

  // Toggle Vim extension without rebuilding the view.
  useEffect(() => {
    const view = viewRef.current
    const comp = vimCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({
      effects: comp.reconfigure(vimMode ? vim() : [])
    })
  }, [vimMode])

  // Toggle live-preview decoration plugin.
  useEffect(() => {
    const view = viewRef.current
    const comp = livePreviewCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({
      effects: comp.reconfigure(livePreview ? livePreviewPlugin : [])
    })
  }, [livePreview])

  useEffect(() => {
    const view = viewRef.current
    const comp = lineNumbersCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({
      effects: comp.reconfigure(lineNumberExtension(lineNumberMode))
    })
  }, [lineNumberMode])

  // Font / line-height / font-family changes: CM caches line geometry
  // from the DOM, so a pure CSS change doesn't invalidate the cached
  // measurements. Nudge it on the next frame whenever these prefs move.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const raf = requestAnimationFrame(() => {
      view.requestMeasure()
    })
    return () => cancelAnimationFrame(raf)
  }, [editorFontSize, editorLineHeight, lineNumberMode, textFont])

  // Layout changes also affect CodeMirror's geometry.
  useEffect(() => {
    const view = viewRef.current
    try {
      localStorage.setItem(EDITOR_MODE_KEY, mode)
    } catch {
      /* ignore */
    }
    try {
      localStorage.setItem(CONNECTIONS_PANEL_KEY, String(connectionsOpen))
    } catch {
      /* ignore */
    }
    if (!view) return
    const raf = requestAnimationFrame(() => {
      view.requestMeasure()
    })
    return () => cancelAnimationFrame(raf)
  }, [connectionsOpen, mode])

  // When switching notes, replace the document wholesale (no history merge).
  // Only react to path changes — body changes from typing are already in
  // the editor and must NOT trigger a replacement (which resets the cursor).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const next = activeNote?.body ?? ''
    if (view.state.doc.toString() === next) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      annotations: programmatic.of(true)
    })
  }, [activeNote?.body, activeNote?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeNote || !pendingJumpLocation || pendingJumpLocation.path !== activeNote.path) return
    const raf = requestAnimationFrame(() => {
      const currentView = viewRef.current
      if (!currentView) return
      const docLength = currentView.state.doc.length
      const anchor = Math.max(0, Math.min(docLength, pendingJumpLocation.editorSelectionAnchor))
      const head = Math.max(0, Math.min(docLength, pendingJumpLocation.editorSelectionHead))
      currentView.dispatch({
        selection: { anchor, head }
      })
      currentView.scrollDOM.scrollTop = pendingJumpLocation.editorScrollTop
      previewScrollRef.current?.scrollTo({ top: pendingJumpLocation.previewScrollTop, behavior: 'auto' })
      clearPendingJumpLocation()
    })
    return () => cancelAnimationFrame(raf)
  }, [activeNote?.path, clearPendingJumpLocation, pendingJumpLocation])

  // Flush pending save on unmount / when navigating away.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        void persistActive()
      }
    }
  }, [persistActive])

  const toolbar = useMemo(() => {
    if (!activeNote) return null
    const folder = activeNote.folder
    return (
      <div className="flex items-center gap-1 text-ink-500">
        <ToggleGroup mode={mode} onChange={setMode} />
        <div className="mx-2 h-4 w-px bg-paper-300" />
        <IconBtn
          title={connectionsOpen ? 'Hide connections' : 'Show connections'}
          active={connectionsOpen}
          onClick={toggleConnectionsPanel}
        >
          <PanelRightIcon />
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
          <IconBtn title="Archive" onClick={() => void archiveActive()}>
            <ArchiveIcon />
          </IconBtn>
        )}
        <IconBtn title="Move to trash" onClick={() => void trashActive()}>
          <TrashIcon />
        </IconBtn>
        <IconBtn title="Close note (⌘W / :q)" onClick={() => void closeActiveNote()}>
          <CloseIcon />
        </IconBtn>
      </div>
    )
  }, [
    activeNote,
    mode,
    connectionsOpen,
    toggleConnectionsPanel,
    trashActive,
    archiveActive,
    restoreActive,
    unarchiveActive,
    closeActiveNote
  ])

  // Always mount the CodeMirror host so the view is created on first render,
  // even before a note is selected. Empty state is an overlay.
  const showEditor = !!activeNote && mode !== 'preview'
  const showPreview = !!activeNote && mode !== 'edit'
  const splitMode = mode === 'split'
  const requestEditFromPreview = useCallback(() => {
    if (mode === 'preview') setMode('edit')
    focusEditorNormalMode()
  }, [mode])
  const tabItems = useMemo(
    () =>
      openTabs.map((path) => {
        const meta = path === activeNote?.path ? activeNote : notes.find((note) => note.path === path)
        return {
          path,
          title: meta?.title ?? path.split('/').slice(-1)[0]?.replace(/\.md$/i, '') ?? path
        }
      }),
    [activeNote, notes, openTabs]
  )

  return (
    <section
      className="flex min-w-0 flex-1 flex-col"
      onDragOver={handleWorkspaceDragOver}
      onDragLeave={handleWorkspaceDragLeave}
      onDrop={handleWorkspaceDrop}
      onMouseDownCapture={() => setFocusedPanel('editor')}
      onFocusCapture={() => setFocusedPanel('editor')}
    >
      {tabsEnabled && tabItems.length > 0 && (
        <div className="glass-header flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-paper-300/70 px-3 pt-2">
          {tabItems.map((tab) => {
            const active = tab.path === activeNote?.path
            return (
              <div
                key={tab.path}
                className={[
                  'group flex h-8 min-w-0 max-w-[220px] items-center gap-1 rounded-t-lg border border-b-0 px-1.5 text-sm transition-colors',
                  active
                    ? 'border-paper-300/80 bg-paper-100 text-ink-900'
                    : 'border-transparent bg-paper-200/45 text-ink-500 hover:bg-paper-200/70 hover:text-ink-900'
                ].join(' ')}
              >
                <button
                  onClick={() => void useStore.getState().selectNote(tab.path)}
                  className="min-w-0 flex-1 truncate px-1.5 text-left"
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => void closeTab(tab.path)}
                  className={[
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition-colors',
                    active ? 'text-ink-500 hover:bg-paper-200 hover:text-ink-900' : 'hover:bg-paper-300/70'
                  ].join(' ')}
                >
                  <CloseIcon width={12} height={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {activeNote && (
        <header className="glass-header flex h-12 shrink-0 items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {!sidebarOpen && (
              <IconBtn title="Show sidebar (⌘1)" onClick={toggleSidebar}>
                <PanelLeftIcon />
              </IconBtn>
            )}
            <Breadcrumb
              note={activeNote}
              autoFocus={pendingTitleFocusPath === activeNote.path}
              onAutoFocusHandled={clearPendingTitleFocus}
              onRename={(next) => {
                if (next && next !== activeNote.title) void renameActive(next)
              }}
            />
          </div>
          {toolbar}
        </header>
      )}
      <div className="min-h-0 min-w-0 flex flex-1">
        <div
          className={[
            'relative flex min-h-0 min-w-0 flex-1 flex-col',
            noteSplitDropActive ? 'bg-accent/4' : ''
          ].join(' ')}
        >
          {activeNote && (
            <div
              className={[
                'min-h-0 min-w-0 flex-1',
                splitMode ? 'flex flex-row gap-0 overflow-hidden' : 'flex flex-col'
              ].join(' ')}
            >
              {/*
                Always mounted so the callback ref fires on first render. When not
                in an editor-visible mode, we hide via display:none — the view stays
                alive and keeps its cursor/history.
               */}
              <div
                className={[
                  'min-h-0 min-w-0',
                  splitMode
                    ? 'flex min-w-0 flex-[1.05] flex-col border-r border-paper-300/70'
                    : 'flex flex-1 flex-col'
                ].join(' ')}
                style={{ display: showEditor ? 'flex' : 'none' }}
                onDragOver={handleEditorDragOver}
                onDragLeave={handleEditorDragLeave}
                onDrop={handleEditorDrop}
              >
                <div
                  ref={setContainerRef}
                  className="min-h-0 min-w-0 flex-1"
                />
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
                    markdown={activeNote.body}
                    notePath={activeNote.path}
                    onRequestEdit={requestEditFromPreview}
                  />
                </div>
              )}
            </div>
          )}
          {!activeNote && (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-400">
              {loading ? 'Loading…' : 'Select or create a note to start writing.'}
            </div>
          )}
        </div>
        {activeNote && connectionsOpen && <ConnectionsPanel note={activeNote} />}
        {tabsEnabled && splitNote && (
          <SplitNotePane note={splitNote} onClose={closeSplitNote} />
        )}
      </div>
      {activeNote && <StatusBar note={activeNote} />}
    </section>
  )
}

const INVALID_FILENAME_CHARS = /[/\\:*?"<>|#^\[\]]/

function focusEditorNormalMode(): void {
  requestAnimationFrame(() => {
    const state = useStore.getState()
    const view = state.editorViewRef
    state.setFocusedPanel('editor')
    if (!view) return
    view.focus()
    if (state.vimMode) {
      const cm = getCM(view)
      if (cm?.state.vim?.insertMode) {
        Vim.exitInsertMode(cm as Parameters<typeof Vim.exitInsertMode>[0], true)
      }
    }
  })
}

function ToggleGroup({
  mode,
  onChange
}: {
  mode: Mode
  onChange: (m: Mode) => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-1 rounded-md bg-paper-200/70 p-0.5 text-xs">
      {(['edit', 'split', 'preview'] as Mode[]).map((m) => (
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

function SplitNotePane({
  note,
  onClose
}: {
  note: { path: string; title: string; body: string }
  onClose: () => void
}): JSX.Element {
  return (
    <aside className="flex min-h-0 w-[min(42vw,560px)] shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/16">
      <div className="glass-header flex h-12 shrink-0 items-center justify-between gap-3 px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink-900">{note.title}</div>
          <div className="truncate text-[11px] text-ink-500">{note.path}</div>
        </div>
        <IconBtn title="Close split note" onClick={onClose}>
          <CloseIcon />
        </IconBtn>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Preview markdown={note.body} notePath={note.path} />
      </div>
    </aside>
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

function Breadcrumb({
  note,
  autoFocus,
  onAutoFocusHandled,
  onRename
}: {
  note: { path: string; title: string; folder: string }
  autoFocus: boolean
  onAutoFocusHandled: () => void
  onRename: (next: string) => void
}): JSX.Element {
  const setView = useStore((s) => s.setView)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(note.title)
  const [warning, setWarning] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => setValue(note.title), [note.title])
  useEffect(() => setWarning(''), [note.path])
  useEffect(() => setEditing(false), [note.path])
  useEffect(() => {
    if (!autoFocus) return
    setEditing(true)
  }, [autoFocus, note.path])
  useEffect(() => {
    if (!editing) return
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
      if (autoFocus) onAutoFocusHandled()
    })
    return () => cancelAnimationFrame(raf)
  }, [autoFocus, editing, onAutoFocusHandled])

  // `note.path` is vault-relative like "inbox/Work/Research/foo.md".
  // We render the trail of ancestor folders + the title as the last
  // segment. Every segment is the same `text-sm`, only the last is
  // bold — matching Obsidian's breadcrumb style.
  const parts = note.path.split('/')
  const topFolder = parts[0] as 'inbox' | 'archive' | 'trash'
  const segments = parts.slice(1, -1)

  const ancestors: { label: string; onClick: () => void }[] = [
    {
      label: topFolder.charAt(0).toUpperCase() + topFolder.slice(1),
      onClick: () => setView({ kind: 'folder', folder: topFolder, subpath: '' })
    }
  ]
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
      {editing ? (
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
            warning
              ? 'bg-red-500/12 ring-1 ring-red-500/60'
              : 'bg-paper-200/60'
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
