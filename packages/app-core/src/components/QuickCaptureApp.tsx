/**
 * Floating quick-capture window — mounted when the renderer boots
 * with `?quickCapture=1`. Raycast Notes-inspired: a single compact
 * card that defaults to capturing into the Quick folder, but with a
 * proper note picker, vim ex commands, and a command palette so the
 * window feels like a real ZenNotes surface, not a glorified textbox.
 *
 * One surface: you type in the editor only. The first non-empty line is
 * the note's title (it becomes the filename); everything is the body.
 *
 * Modes:
 *   "new"      — empty draft. The first save creates a note in Quick and
 *                the window *adopts* it (→ "existing"), so subsequent
 *                edits update that same file instead of spawning copies.
 *   "existing" — an adopted or picker-loaded note. Saving writes back in
 *                place; for Quick notes, editing the first line renames
 *                the file in place rather than creating a duplicate.
 *
 * Keys:
 *   ⌘↩  / Ctrl+Enter        — save, then hide.
 *   ⌘N  / Ctrl+N            — save the current note and start a new one.
 *   ⌘P  / Ctrl+P            — open the note picker.
 *   ⌘⇧P / Ctrl+Shift+P      — open the command palette.
 *   Esc                      — close the open overlay, else hide window.
 *
 * Vim ex commands (when vim mode is on):
 *   :w           — save without closing.
 *   :q           — hide the window without saving.
 *   :wq / :x     — save, then hide.
 *   :enew        — discard the draft and reset to a fresh capture.
 *   :find        — open the note picker (alias for ⌘P).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder
} from '@codemirror/view'
import { Vim, vim } from '@replit/codemirror-vim'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { resolveCodeLanguage } from '../lib/cm-code-languages'
import { markdownListIndentPlugin } from '../lib/cm-markdown-list-indent'
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { searchKeymap } from '@codemirror/search'
import type { NoteMeta } from '@shared/ipc'
import {
  DEFAULT_THEME_ID,
  THEMES,
  resolveAuto,
  type ThemeFamily,
  type ThemeMode
} from '../lib/themes'
import {
  buildNoteSearchIndex,
  searchNoteIndex
} from '../lib/note-search'
import { deriveTitleFromBody, planQuickCaptureSave } from '../lib/quick-capture-save'
import { applyVimInsertEscape } from '../lib/vim-insert-escape'
import { PinIcon } from './icons'

const PREFS_KEY = 'zen:prefs:v2'

interface QuickCapturePrefs {
  vimMode: boolean
  vimInsertEscape: string
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number
  editorLineHeight: number
  interfaceFont: string | null
  textFont: string | null
  monoFont: string | null
}

function loadPrefs(): QuickCapturePrefs {
  const fallback: QuickCapturePrefs = {
    vimMode: true,
    vimInsertEscape: '',
    themeId: DEFAULT_THEME_ID,
    themeFamily: 'gruvbox',
    themeMode: 'dark',
    editorFontSize: 15,
    editorLineHeight: 1.6,
    interfaceFont: null,
    textFont: null,
    monoFont: null
  }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<QuickCapturePrefs>
    return {
      ...fallback,
      ...parsed,
      themeFamily: (parsed.themeFamily as ThemeFamily) ?? fallback.themeFamily,
      themeMode: (parsed.themeMode as ThemeMode) ?? fallback.themeMode
    }
  } catch {
    return fallback
  }
}

const captureHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'tok-heading1' },
  { tag: t.heading2, class: 'tok-heading2' },
  { tag: t.heading3, class: 'tok-heading3' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.monospace, class: 'tok-monospace' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: t.list, class: 'tok-list' },
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' }
])

function applyTheme(prefs: QuickCapturePrefs): void {
  const html = document.documentElement
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  let id = prefs.themeId
  if (prefs.themeMode === 'auto') id = resolveAuto(prefs.themeFamily, mql.matches, prefs.themeId)
  if (!THEMES.some((t) => t.id === id)) id = DEFAULT_THEME_ID
  html.dataset.theme = id
  html.style.setProperty('--z-editor-font-size', `${prefs.editorFontSize}px`)
  html.style.setProperty('--z-editor-line-height', String(prefs.editorLineHeight))
  const setFont = (name: string, value: string | null, fallback: string): void => {
    if (value) html.style.setProperty(name, `"${value}", ${fallback}`)
    else html.style.removeProperty(name)
  }
  setFont(
    '--z-interface-font',
    prefs.interfaceFont,
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif'
  )
  setFont(
    '--z-text-font',
    prefs.textFont,
    '"SF Mono", "SFMono-Regular", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace'
  )
  setFont(
    '--z-mono-font',
    prefs.monoFont,
    '"SF Mono", "SFMono-Regular", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace'
  )
  html.setAttribute('data-opaque', '')
}

type EditingMode =
  | { kind: 'new' }
  | { kind: 'existing'; note: NoteMeta }

const NEW_MODE: EditingMode = { kind: 'new' }

// Per-window vim ex command bookkeeping. Each Electron window has its
// own renderer process, but we still register-once-per-mount to keep
// HMR re-renders from stacking duplicate handlers.
const vimHandlers: {
  save: null | (() => Promise<boolean>)
  saveAndClose: null | (() => void)
  close: null | (() => void)
  newNote: null | (() => void)
  openPicker: null | (() => void)
} = { save: null, saveAndClose: null, close: null, newNote: null, openPicker: null }

let vimRegistered = false

/** All custom ex callbacks defer their actual work by one tick so
 *  CodeMirror-Vim can finish unwinding the ex command stack before we
 *  mutate the editor or hide the window. Calling `view.dispatch` or
 *  `windowClose` synchronously inside the ex callback occasionally
 *  surfaces as "Object has been destroyed" / dropped saves — exactly
 *  the same hazard documented on the floating-note window. */
function registerCaptureVimCommands(): void {
  if (vimRegistered) return
  vimRegistered = true

  Vim.defineEx('write', 'w', () => {
    setTimeout(() => {
      void vimHandlers.save?.()
    }, 0)
  })
  Vim.defineEx('quit', 'q', () => {
    setTimeout(() => vimHandlers.close?.(), 0)
  })
  // `:wq` and `:x` both save-and-hide through the same path as ⌘↩/Esc
  // (`saveAndClose`), so a fresh capture clears for the next dump while
  // an opened note is left intact. Routing through one handler keeps
  // every "save then leave" gesture behaving identically.
  Vim.defineEx('wq', 'wq', () => {
    setTimeout(() => vimHandlers.saveAndClose?.(), 0)
  })
  Vim.defineEx('x', 'x', () => {
    setTimeout(() => vimHandlers.saveAndClose?.(), 0)
  })
  // `:enew` (rather than `:new`) so we don't shadow vim's built-in
  // `:new` (open horizontal split with empty buffer). Semantics match
  // vim's `:enew` — discard the current buffer, start fresh.
  Vim.defineEx('enew', 'ene', () => {
    setTimeout(() => vimHandlers.newNote?.(), 0)
  })
  // `:find` (and `:fin`) open the note picker. Vim's `:find` finds a
  // file in 'path' — the picker is the conceptual analogue here.
  Vim.defineEx('find', 'fin', () => {
    setTimeout(() => vimHandlers.openPicker?.(), 0)
  })
}

export function QuickCaptureApp(): JSX.Element {
  const prefs = useMemo(() => loadPrefs(), [])
  // `docTitle` is the live title derived from the editor's first line —
  // pure display, the body is the single place to type. '' means the
  // buffer is empty / has no usable first line yet.
  const [docTitle, setDocTitle] = useState('')
  const [mode, setMode] = useState<EditingMode>(NEW_MODE)
  const [charCount, setCharCount] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [overlay, setOverlay] = useState<'none' | 'search' | 'command'>('none')
  const editorRef = useRef<EditorView | null>(null)

  // Apply theme + font CSS vars before paint.
  useEffect(() => {
    applyTheme(prefs)
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    if (prefs.themeMode === 'auto') {
      const onChange = (): void => applyTheme(prefs)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    return undefined
  }, [prefs])

  // Initial notes fetch + live refresh from the vault watcher so the
  // picker stays current as files are created or renamed elsewhere.
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void window.zen.listNotes().then((all) => {
        if (!alive) return
        setNotes(all.filter((n) => n.folder !== 'trash'))
      })
    }
    refresh()
    const off = window.zen.onVaultChange(() => refresh())
    return () => {
      alive = false
      off()
    }
  }, [])

  // When the OS window regains focus, drop the cursor back into the
  // editor. The renderer process stays alive between hide/show, so any
  // draft or open existing note is still here.
  useEffect(() => {
    const onFocus = (): void => {
      if (overlay !== 'none') return
      requestAnimationFrame(() => editorRef.current?.focus())
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [overlay])

  // Programmatic replace; the editor's updateListener picks up the
  // resulting docChange and refreshes charCount + docTitle.
  const setEditorContent = useCallback((next: string) => {
    const view = editorRef.current
    if (!view) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next }
    })
  }, [])

  const resetToNew = useCallback(() => {
    setMode(NEW_MODE)
    setDocTitle('')
    setCharCount(0)
    setEditorContent('')
    setError(null)
    requestAnimationFrame(() => editorRef.current?.focus())
  }, [setEditorContent])

  const loadNote = useCallback(
    async (note: NoteMeta) => {
      try {
        const content = await window.zen.readNote(note.path)
        setMode({ kind: 'existing', note })
        setEditorContent(content.body)
        setError(null)
        setOverlay('none')
        requestAnimationFrame(() => editorRef.current?.focus())
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [setEditorContent]
  )

  const save = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<boolean> => {
      if (submitting) return false
      const view = editorRef.current
      if (!view) return false
      const plan = planQuickCaptureSave(mode, view.state.doc.toString())
      if (plan.op === 'noop') {
        if (!opts.silent) setError('Nothing to save yet — start writing.')
        return false
      }
      setSubmitting(true)
      setError(null)
      try {
        if (plan.op === 'create') {
          const meta = await window.zen.createNote('quick', plan.title)
          await window.zen.writeNote(meta.path, plan.body)
          // Adopt the note we just created. Without this the window stays
          // in "new" mode and the next save creates ANOTHER file — the
          // duplicate-on-rename bug. Now further edits update in place.
          setMode({ kind: 'existing', note: meta })
        } else if (plan.op === 'rename') {
          // First line changed → rename the Quick note in place. On a
          // title clash, keep the old filename but still write the body
          // so no keystrokes are lost.
          let target = plan.path
          try {
            const meta = await window.zen.renameNote(plan.path, plan.title)
            target = meta.path
            setMode({ kind: 'existing', note: meta })
          } catch (err) {
            if (!opts.silent) setError(err instanceof Error ? err.message : String(err))
          }
          await window.zen.writeNote(target, plan.body)
        } else {
          await window.zen.writeNote(plan.path, plan.body)
        }
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        setSubmitting(false)
      }
    },
    [mode, submitting]
  )

  /** Save the buffer (if there's anything to save) and hide the window.
   *  Used by both ⌘↩ and Esc — Esc no longer drops a draft on the floor.
   *  An empty buffer hides silently (no nag); a save error keeps the
   *  window up so the user can recover. */
  const submitAndClose = useCallback(async () => {
    const view = editorRef.current
    if (!view) {
      window.zen.windowClose()
      return
    }
    if (!view.state.doc.toString().trim()) {
      // Empty buffer — just hide. No nag, nothing to persist.
      window.zen.windowClose()
      return
    }
    // `save` flips a fresh capture into "existing" mode, so record the
    // intent up front instead of reading `mode` after the await.
    const startedFresh = mode.kind === 'new'
    const ok = await save({ silent: true })
    if (!ok) return
    // Fresh captures: reset to a blank canvas so the next open is a clean
    // dump. Edited existing notes: leave the buffer intact — re-opening
    // should pick up where the user left off.
    if (startedFresh) resetToNew()
    window.zen.windowClose()
  }, [mode, save, resetToNew])

  /** Commit the current note (if it has any content) and open a fresh
   *  blank capture, without hiding the window — the ⌘N path for banging
   *  out several notes in a row. Saving first means starting a new note
   *  never discards what you were writing; if the save fails we keep the
   *  buffer so nothing is lost. (Vim's `:enew` is the explicit discard.) */
  const newNote = useCallback(async () => {
    const view = editorRef.current
    if (view && view.state.doc.toString().trim()) {
      const ok = await save({ silent: true })
      if (!ok) return
    }
    resetToNew()
  }, [save, resetToNew])

  // Mount CodeMirror once.
  const setEditorContainer = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        editorRef.current?.destroy()
        editorRef.current = null
        return
      }
      if (editorRef.current) return
      const state = EditorState.create({
        doc: '',
        extensions: [
          new Compartment().of(prefs.vimMode ? vim() : []),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage, addKeymap: true }),
          markdownListIndentPlugin,
          syntaxHighlighting(captureHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          placeholder('Start writing…'),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((upd) => {
            if (!upd.docChanged) return
            const doc = upd.state.doc.toString()
            setCharCount(doc.length)
            setDocTitle(doc.trim() ? deriveTitleFromBody(doc) : '')
            setError(null)
          })
        ]
      })
      editorRef.current = new EditorView({ state, parent: el })
      requestAnimationFrame(() => editorRef.current?.focus())
    },
    [prefs.vimMode]
  )

  // Wire vim ex commands. Re-run on every render so the closures see
  // the latest `save` / `resetToNew` etc., but keep the actual Vim
  // registration one-shot via `vimRegistered` to avoid duplicates.
  useEffect(() => {
    vimHandlers.save = save
    vimHandlers.saveAndClose = () => void submitAndClose()
    vimHandlers.close = () => window.zen.windowClose()
    vimHandlers.newNote = resetToNew
    vimHandlers.openPicker = () => setOverlay('search')
    registerCaptureVimCommands()
    applyVimInsertEscape(prefs.vimInsertEscape)
  }, [resetToNew, save, submitAndClose, prefs.vimInsertEscape])

  // Window-level chord handlers. We attach the listener exactly once
  // and read state through refs so the handler is never operating on a
  // stale closure — if `overlay` is read from a captured render, an Esc
  // typed in a freshly-opened picker can race ahead of the next render
  // commit and incorrectly fall into the "no overlay" branch.
  const overlayRef = useRef(overlay)
  useEffect(() => {
    overlayRef.current = overlay
  }, [overlay])
  const submitAndCloseRef = useRef(submitAndClose)
  useEffect(() => {
    submitAndCloseRef.current = submitAndClose
  }, [submitAndClose])
  const newNoteRef = useRef(newNote)
  useEffect(() => {
    newNoteRef.current = newNote
  }, [newNote])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'Enter') {
        e.preventDefault()
        void submitAndCloseRef.current()
        return
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newNoteRef.current()
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setOverlay((current) => (current === 'command' ? 'none' : 'command'))
        return
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setOverlay((current) => (current === 'search' ? 'none' : 'search'))
        return
      }
      if (e.key === 'Escape') {
        if (overlayRef.current !== 'none') {
          // Overlay open — first Esc just dismisses it. The overlay's
          // own input handler also stops propagation, so this branch
          // is a fallback for Esc fired while the overlay's input
          // somehow isn't focused.
          e.preventDefault()
          setOverlay('none')
          requestAnimationFrame(() => editorRef.current?.focus())
          return
        }
        e.preventDefault()
        void submitAndCloseRef.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const isMacPlatform = useMemo(() => {
    try {
      return window.zen.platformSync() === 'darwin'
    } catch {
      return false
    }
  }, [])
  const modKey = isMacPlatform ? '⌘' : 'Ctrl'

  // Pin state — when on, the window stays on top of all windows and no longer
  // auto-hides on blur, so it behaves like a floating sticky note.
  const [pinned, setPinned] = useState(false)
  useEffect(() => {
    let active = true
    void window.zen.getQuickCapturePinned().then((value) => {
      if (active) setPinned(value)
    })
    return () => {
      active = false
    }
  }, [])
  const togglePinned = useCallback(() => {
    setPinned((prev) => {
      const next = !prev
      void window.zen.setQuickCapturePinned(next)
      return next
    })
  }, [])

  const targetLabel =
    mode.kind === 'existing' ? `Editing ${mode.note.title}` : 'New note in Quick'

  // The title the note will be saved under. Live first-line title for
  // fresh captures and Quick notes; the fixed filename for notes opened
  // from other folders (the capture window never renames those).
  const headerTitle =
    mode.kind === 'existing'
      ? mode.note.folder === 'quick'
        ? docTitle || mode.note.title
        : mode.note.title
      : docTitle

  return (
    <div
      className="flex h-screen w-screen flex-col bg-paper-100 text-ink-900"
      data-quick-capture
    >
      <header
        className="glass-header flex shrink-0 items-center gap-2 border-b border-paper-300/70 px-4 py-2.5 pl-20"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Read-only title derived from the first line. The whole bar is
            the drag handle — there's no <input> here to steal the region
            (inputs are forced -webkit-app-region: no-drag globally, which
            is what previously left the window impossible to move). */}
        <span
          className={[
            'min-w-0 flex-1 truncate text-sm font-medium',
            headerTitle ? 'text-ink-900' : 'text-ink-400'
          ].join(' ')}
          title={mode.kind === 'existing' ? mode.note.path : undefined}
        >
          {headerTitle || 'New note'}
        </span>
        {mode.kind === 'existing' && (
          <span
            className="shrink-0 rounded-md bg-paper-200/80 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-ink-500"
            title={mode.note.path}
          >
            {mode.note.folder}
          </span>
        )}
        <button
          type="button"
          onClick={togglePinned}
          title={pinned ? 'Unpin — auto-hide when it loses focus' : 'Pin on top of all windows'}
          aria-label={pinned ? 'Unpin quick capture' : 'Pin quick capture on top'}
          aria-pressed={pinned}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className={[
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
            pinned
              ? 'bg-accent/15 text-accent'
              : 'text-ink-400 hover:bg-paper-200 hover:text-ink-700'
          ].join(' ')}
        >
          <PinIcon width={15} height={15} />
        </button>
      </header>

      <div className="relative min-h-0 min-w-0 flex-1">
        <div ref={setEditorContainer} className="absolute inset-0 overflow-hidden" />

        {overlay === 'search' && (
          <NotePickerOverlay
            notes={notes}
            onPick={(note) => void loadNote(note)}
            onCancel={() => {
              setOverlay('none')
              requestAnimationFrame(() => editorRef.current?.focus())
            }}
          />
        )}

        {overlay === 'command' && (
          <CommandOverlay
            modKey={modKey}
            mode={mode}
            onCancel={() => {
              setOverlay('none')
              requestAnimationFrame(() => editorRef.current?.focus())
            }}
            onAction={(action) => {
              setOverlay('none')
              if (action === 'save') void submitAndClose()
              else if (action === 'save-no-close') void save()
              else if (action === 'new') void newNote()
              else if (action === 'open') setOverlay('search')
            }}
          />
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-paper-300/70 px-4 py-1.5 text-xs text-ink-500">
        <span className="truncate">
          {error ? (
            <span className="text-red-500">{error}</span>
          ) : (
            <>
              {charCount} character{charCount === 1 ? '' : 's'} · {targetLabel}
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span>
            <kbd className="rounded bg-paper-200 px-1">{modKey}↩</kbd> save
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">{modKey}N</kbd> new
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">{modKey}P</kbd> notes
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">{modKey}⇧P</kbd> cmd
          </span>
        </span>
      </footer>
    </div>
  )
}

interface OverlayShellProps {
  children: React.ReactNode
}

function OverlayShell({ children }: OverlayShellProps): JSX.Element {
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-paper-100/95 backdrop-blur-sm">
      {children}
    </div>
  )
}

interface NotePickerOverlayProps {
  notes: NoteMeta[]
  onPick: (note: NoteMeta) => void
  onCancel: () => void
}

function NotePickerOverlay({ notes, onPick, onCancel }: NotePickerOverlayProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const searchIndex = useMemo(() => buildNoteSearchIndex(notes), [notes])

  const results = useMemo(() => {
    return searchNoteIndex(searchIndex, query, {
      limit: 30,
      defaultOrder: 'quick-first-recent'
    })
  }, [query, searchIndex])

  useEffect(() => setActive(0), [query])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
      e.preventDefault()
      setActive((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = results[active]
      if (picked) onPick(picked)
    } else if (e.key === 'Escape') {
      // Stop the native event so the window-level Esc listener doesn't
      // also run and try to save+hide the underlying buffer.
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      onCancel()
    }
  }

  return (
    <OverlayShell>
      <div className="border-b border-paper-300/70 px-4 py-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Search notes — type, or use #tag filters"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-400"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <div className="px-4 py-3 text-xs text-ink-500">
            No notes match. Esc to dismiss.
          </div>
        ) : (
          results.map((note, idx) => {
            const isActive = idx === active
            return (
              <button
                key={note.path}
                type="button"
                onMouseEnter={() => setActive(idx)}
                onClick={() => onPick(note)}
                className={[
                  'flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm',
                  isActive ? 'bg-paper-200 text-ink-900' : 'text-ink-700 hover:bg-paper-200/60'
                ].join(' ')}
              >
                <span className="shrink-0 text-2xs uppercase tracking-wide text-ink-400">
                  {note.folder}
                </span>
                <span className="truncate">{note.title}</span>
                <span className="ml-auto truncate text-2xs text-ink-400">{note.path}</span>
              </button>
            )
          })
        )}
      </div>
    </OverlayShell>
  )
}

type CommandAction = 'save' | 'save-no-close' | 'new' | 'open'

interface CommandOverlayProps {
  modKey: string
  mode: EditingMode
  onAction: (action: CommandAction) => void
  onCancel: () => void
}

function CommandOverlay({ modKey, mode, onAction, onCancel }: CommandOverlayProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const all = useMemo(
    () => [
      {
        id: 'save' as CommandAction,
        label: mode.kind === 'existing' ? 'Save and hide' : 'Save to Quick and hide',
        hint: `${modKey}↩`,
        keywords: 'save submit commit hide close write'
      },
      {
        id: 'save-no-close' as CommandAction,
        label: 'Save without hiding',
        hint: ':w',
        keywords: 'save write keep open'
      },
      {
        id: 'new' as CommandAction,
        label: 'Save and start a new note',
        hint: `${modKey}N`,
        keywords: 'new fresh next another note save'
      },
      {
        id: 'open' as CommandAction,
        label: 'Open another note…',
        hint: `${modKey}P`,
        keywords: 'open switch picker find search note'
      }
    ],
    [mode.kind, modKey]
  )

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (cmd) => cmd.label.toLowerCase().includes(q) || cmd.keywords.includes(q)
    )
  }, [all, query])

  useEffect(() => setActive(0), [query])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
      e.preventDefault()
      setActive((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = results[active]
      if (picked) onAction(picked.id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      onCancel()
    }
  }

  return (
    <OverlayShell>
      <div className="border-b border-paper-300/70 px-4 py-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Run a command…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-400"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <div className="px-4 py-3 text-xs text-ink-500">No commands match.</div>
        ) : (
          results.map((cmd, idx) => {
            const isActive = idx === active
            return (
              <button
                key={cmd.id}
                type="button"
                onMouseEnter={() => setActive(idx)}
                onClick={() => onAction(cmd.id)}
                className={[
                  'flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm',
                  isActive ? 'bg-paper-200 text-ink-900' : 'text-ink-700 hover:bg-paper-200/60'
                ].join(' ')}
              >
                <span className="truncate">{cmd.label}</span>
                <kbd className="ml-auto rounded bg-paper-200 px-1.5 py-0.5 text-2xs text-ink-500">
                  {cmd.hint}
                </kbd>
              </button>
            )
          })
        )}
      </div>
    </OverlayShell>
  )
}
