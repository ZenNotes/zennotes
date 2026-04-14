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
import { useStore } from '../store'
import type { PaneLayout, PaneSplit } from '../lib/pane-layout'
import {
  parseCreateNotePath,
  resolveWikilinkTarget,
  suggestCreateNotePath
} from '../lib/wikilinks'
import { promptApp } from './PromptHost'
import { StatusBar } from './StatusBar'
import { EditorPane } from './EditorPane'
import { focusPaneInDirection } from '../lib/pane-nav'

let vimCommandsRegistered = false

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
  const mdRe = /\[([^\]]*)\]\(([^)]+)\)/g
  while ((m = mdRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[2]
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

  // Vim-style pane navigation: <C-w> followed by h/j/k/l focuses the
  // neighbor pane in that direction. Works only when CodeMirror is in
  // normal mode; App.tsx handles the same chord for focus outside CM.
  Vim.defineAction('focusPaneLeft', () => {
    focusPaneInDirection('h')
  })
  Vim.defineAction('focusPaneDown', () => {
    focusPaneInDirection('j')
  })
  Vim.defineAction('focusPaneUp', () => {
    focusPaneInDirection('k')
  })
  Vim.defineAction('focusPaneRight', () => {
    focusPaneInDirection('l')
  })
  Vim.mapCommand('<C-w>h', 'action', 'focusPaneLeft', {}, { context: 'normal' })
  Vim.mapCommand('<C-w>j', 'action', 'focusPaneDown', {}, { context: 'normal' })
  Vim.mapCommand('<C-w>k', 'action', 'focusPaneUp', {}, { context: 'normal' })
  Vim.mapCommand('<C-w>l', 'action', 'focusPaneRight', {}, { context: 'normal' })
  Vim.mapCommand('<C-w><C-h>', 'action', 'focusPaneLeft', {}, { context: 'normal' })
  Vim.mapCommand('<C-w><C-j>', 'action', 'focusPaneDown', {}, { context: 'normal' })
  Vim.mapCommand('<C-w><C-k>', 'action', 'focusPaneUp', {}, { context: 'normal' })
  Vim.mapCommand('<C-w><C-l>', 'action', 'focusPaneRight', {}, { context: 'normal' })
}

export function Editor(): JSX.Element {
  const paneLayout = useStore((s) => s.paneLayout)
  const activeNote = useStore((s) => s.activeNote)

  useEffect(() => {
    registerVimCommands()
  }, [])

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
        <PaneTreeView node={paneLayout} />
      </div>
      {activeNote && <StatusBar note={activeNote} />}
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
