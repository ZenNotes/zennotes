/**
 * Always-visible side panel that shows a single companion note — a
 * "reference pane" writers and researchers can keep open while drafting
 * in the main editor. Lives outside the regular pane-layout tree so
 * pinning / unpinning doesn't interact with split behaviour.
 *
 * Content is shared via the store's path-keyed `noteContents`, so an
 * edit here propagates to any main-pane view on the same path (and
 * vice versa) via the same sync-effect used by `EditorPane`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { vim } from '@replit/codemirror-vim'
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
import { CloseIcon, PanelLeftIcon, PinIcon } from './icons'

const PINNED_REF_PANE_ID = 'pinned-ref'
export const pinnedRefPaneId = PINNED_REF_PANE_ID

const programmatic = Annotation.define<boolean>()

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
  { tag: t.meta, class: 'tok-meta' },
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.controlKeyword, class: 'tok-keyword' },
  { tag: t.definitionKeyword, class: 'tok-keyword' },
  { tag: t.modifier, class: 'tok-keyword' },
  { tag: t.operatorKeyword, class: 'tok-keyword' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.special(t.string), class: 'tok-string' },
  { tag: t.regexp, class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.lineComment, class: 'tok-comment' },
  { tag: t.blockComment, class: 'tok-comment' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.bool, class: 'tok-atom' },
  { tag: t.atom, class: 'tok-atom' },
  { tag: t.null, class: 'tok-atom' },
  { tag: t.self, class: 'tok-atom' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.typeName, class: 'tok-type' },
  { tag: t.className, class: 'tok-type' },
  { tag: t.namespace, class: 'tok-type' },
  { tag: t.function(t.variableName), class: 'tok-function' },
  { tag: t.function(t.definition(t.variableName)), class: 'tok-function' },
  { tag: t.definition(t.variableName), class: 'tok-variable-def' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.labelName, class: 'tok-label' },
  { tag: t.punctuation, class: 'tok-punct' },
  { tag: t.bracket, class: 'tok-bracket' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: t.attributeName, class: 'tok-attr' }
])

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

export function PinnedReferencePane(): JSX.Element | null {
  const pinnedRefPath = useStore((s) => s.pinnedRefPath)
  const pinnedRefVisible = useStore((s) => s.pinnedRefVisible)
  const pinnedRefWidth = useStore((s) => s.pinnedRefWidth)
  const pinnedRefMode = useStore((s) => s.pinnedRefMode)
  const unpinReference = useStore((s) => s.unpinReference)
  const togglePinnedRefVisible = useStore((s) => s.togglePinnedRefVisible)
  const setPinnedRefWidth = useStore((s) => s.setPinnedRefWidth)
  const setPinnedRefMode = useStore((s) => s.setPinnedRefMode)
  const content = useStore((s) =>
    pinnedRefPath ? s.noteContents[pinnedRefPath] ?? null : null
  )
  const isDirty = useStore((s) =>
    pinnedRefPath ? s.noteDirty[pinnedRefPath] ?? false : false
  )
  const updateNoteBody = useStore((s) => s.updateNoteBody)
  const persistNote = useStore((s) => s.persistNote)
  const vimMode = useStore((s) => s.vimMode)
  const livePreview = useStore((s) => s.livePreview)
  const lineNumberMode = useStore((s) => s.lineNumberMode)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const textFont = useStore((s) => s.textFont)
  const setView = useStore((s) => s.setView)

  const viewRef = useRef<EditorView | null>(null)
  const viewPathRef = useRef<string | null>(null)
  const vimCompartmentRef = useRef<Compartment | null>(null)
  const livePreviewCompartmentRef = useRef<Compartment | null>(null)
  const lineNumbersCompartmentRef = useRef<Compartment | null>(null)

  const [resizing, setResizing] = useState(false)

  /* -------- Mount CodeMirror view -------- */
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        viewRef.current?.destroy()
        viewRef.current = null
        viewPathRef.current = null
        return
      }
      if (viewRef.current) return
      const vimCompartment = new Compartment()
      const livePreviewCompartment = new Compartment()
      const lineNumbersCompartment = new Compartment()
      vimCompartmentRef.current = vimCompartment
      livePreviewCompartmentRef.current = livePreviewCompartment
      lineNumbersCompartmentRef.current = lineNumbersCompartment
      const s0 = useStore.getState()
      const initialPath = s0.pinnedRefPath
      const initialContent = initialPath ? s0.noteContents[initialPath] ?? null : null
      const state = EditorState.create({
        doc: initialContent?.body ?? '',
        extensions: [
          vimCompartment.of(s0.vimMode ? vim() : []),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
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
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap
          ]),
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
    },
    [updateNoteBody]
  )

  /* -------- Sync external content changes into the CM doc -------- */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const nextPath = content?.path ?? null
    const nextBody = content?.body ?? ''
    const pathChanged = viewPathRef.current !== nextPath
    const bodyChanged = view.state.doc.toString() !== nextBody
    if (!pathChanged && !bodyChanged) return
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

  /* -------- Compartment reconfigures tracking prefs -------- */
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

  /* -------- Re-measure on font changes -------- */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const raf = requestAnimationFrame(() => view.requestMeasure())
    return () => cancelAnimationFrame(raf)
  }, [editorFontSize, editorLineHeight, lineNumberMode, textFont, pinnedRefWidth, pinnedRefMode])

  /* -------- Flush pending save on unmount -------- */
  const pathRef = useRef<string | null>(pinnedRefPath)
  pathRef.current = pinnedRefPath
  useEffect(() => {
    return () => {
      const path = pathRef.current
      if (!path) return
      if (useStore.getState().noteDirty[path]) void persistNote(path)
    }
  }, [persistNote])

  /* -------- Resize handle on the left edge -------- */
  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = pinnedRefWidth
      setResizing(true)
      const onMove = (ev: MouseEvent): void => {
        // Dragging left grows the pane, dragging right shrinks it.
        setPinnedRefWidth(startWidth + (startX - ev.clientX))
      }
      const onUp = (): void => {
        setResizing(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [pinnedRefWidth, setPinnedRefWidth]
  )

  if (!pinnedRefPath || !pinnedRefVisible) return null

  const title =
    content?.title ??
    pinnedRefPath.split('/').pop()?.replace(/\.md$/i, '') ??
    pinnedRefPath

  const showEditor = pinnedRefMode === 'edit'

  return (
    <section
      data-pane-id={PINNED_REF_PANE_ID}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/40"
      style={{ width: pinnedRefWidth }}
    >
      {/* Resize handle on the left edge. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startResize}
        className={[
          'group absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize select-none',
          resizing ? 'bg-accent/60' : 'hover:bg-accent/40'
        ].join(' ')}
      >
        <div className="absolute -left-1 top-0 h-full w-[9px]" />
      </div>

      <header className="glass-header flex h-12 shrink-0 items-center justify-between gap-2 border-b border-paper-300/70 px-3">
        <button
          type="button"
          title={`Reveal ${title} in the sidebar`}
          onClick={() => {
            const parts = pinnedRefPath.split('/')
            const top = parts[0] as 'inbox' | 'archive' | 'trash'
            const subpath = parts.slice(1, -1).join('/')
            setView({ kind: 'folder', folder: top, subpath })
          }}
          className="flex min-w-0 flex-1 items-center gap-2 truncate text-left text-sm font-semibold text-ink-900 hover:text-ink-700"
        >
          <PinIcon width={14} height={14} className="shrink-0 text-accent" />
          <span className="truncate">{title}</span>
          {isDirty && (
            <span
              aria-label="Unsaved changes"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/80"
            />
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex items-center gap-1 rounded-md bg-paper-200/70 p-0.5 text-[11px]">
            {(['edit', 'preview'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setPinnedRefMode(m)}
                className={[
                  'rounded px-1.5 py-0.5 capitalize transition-colors',
                  pinnedRefMode === m
                    ? 'bg-paper-50 text-ink-900 shadow-sm'
                    : 'text-ink-500 hover:text-ink-800'
                ].join(' ')}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            type="button"
            title="Hide reference pane (pin stays)"
            onClick={togglePinnedRefVisible}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-paper-200 hover:text-ink-900"
          >
            <PanelLeftIcon width={14} height={14} />
          </button>
          <button
            type="button"
            title="Unpin reference"
            onClick={unpinReference}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-paper-200 hover:text-ink-900"
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className="relative min-h-0 min-w-0 flex-1"
          style={{ display: showEditor ? 'flex' : 'none' }}
        >
          <div ref={setContainerRef} className="min-h-0 min-w-0 flex-1" />
        </div>
        {!showEditor && content && (
          <div
            data-preview-scroll
            className="min-h-0 min-w-0 flex-1 overflow-y-auto"
          >
            <Preview markdown={content.body} notePath={content.path} />
          </div>
        )}
      </div>
    </section>
  )
}
