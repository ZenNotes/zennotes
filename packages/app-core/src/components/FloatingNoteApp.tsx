/**
 * Single-note window mounted when the renderer boots with
 * `?floating=1&note=<path>`. Spawned by the main process via
 * `window.zen.openNoteWindow(path)`.
 *
 * No sidebar / tabs / splits — just a header with the title + an
 * edit/preview toggle, and a CodeMirror editor / Preview surface.
 * Content is read from disk on mount; edits are saved through the
 * normal `writeNote` IPC. The vault watcher broadcasts to every
 * window, so external edits land here too.
 */
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
  lineNumbers
} from '@codemirror/view'
import { Vim, vim } from '@replit/codemirror-vim'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { resolveCodeLanguage } from '../lib/cm-code-languages'
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { searchKeymap } from '@codemirror/search'
import type { NoteContent, VaultChangeEvent } from '@shared/ipc'
import type { LineNumberMode } from '../store'
import { livePreviewPlugin } from '../lib/cm-live-preview'
import { headingFolding } from '../lib/cm-heading-fold'
import { Preview } from './Preview'
import { CloseIcon, PinIcon } from './icons'
import {
  DEFAULT_THEME_ID,
  THEMES,
  resolveAuto,
  type ThemeFamily,
  type ThemeMode
} from '../lib/themes'

const PREFS_KEY = 'zen:prefs:v2'
const SAVE_DEBOUNCE_MS = 350

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
  { tag: t.string, class: 'tok-string' },
  { tag: t.special(t.string), class: 'tok-string' },
  { tag: t.regexp, class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.lineComment, class: 'tok-comment' },
  { tag: t.blockComment, class: 'tok-comment' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.bool, class: 'tok-atom' },
  { tag: t.atom, class: 'tok-atom' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.typeName, class: 'tok-type' },
  { tag: t.function(t.variableName), class: 'tok-function' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.punctuation, class: 'tok-punct' }
])

interface FloatingPrefs {
  vimMode: boolean
  livePreview: boolean
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number
  editorLineHeight: number
  lineNumberMode: LineNumberMode
  wordWrap: boolean
  interfaceFont: string | null
  textFont: string | null
  monoFont: string | null
}

function loadFloatingPrefs(): FloatingPrefs {
  const fallback: FloatingPrefs = {
    vimMode: true,
    livePreview: true,
    themeId: DEFAULT_THEME_ID,
    themeFamily: 'gruvbox',
    themeMode: 'dark',
    editorFontSize: 16,
    editorLineHeight: 1.7,
    lineNumberMode: 'off',
    wordWrap: true,
    interfaceFont: null,
    textFont: null,
    monoFont: null
  }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<FloatingPrefs>
    const lineNumberMode: LineNumberMode =
      parsed.lineNumberMode === 'absolute' ||
      parsed.lineNumberMode === 'relative' ||
      parsed.lineNumberMode === 'off'
        ? parsed.lineNumberMode
        : fallback.lineNumberMode
    return {
      ...fallback,
      ...parsed,
      themeFamily: (parsed.themeFamily as ThemeFamily) ?? fallback.themeFamily,
      themeMode: (parsed.themeMode as ThemeMode) ?? fallback.themeMode,
      lineNumberMode
    }
  } catch {
    return fallback
  }
}

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

function applyTheme(prefs: FloatingPrefs): void {
  const html = document.documentElement
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  let id = prefs.themeId
  if (prefs.themeMode === 'auto') {
    id = resolveAuto(prefs.themeFamily, mql.matches)
  }
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

export function FloatingNoteApp({ notePath }: { notePath: string }): JSX.Element {
  const prefs = useMemo(() => loadFloatingPrefs(), [])
  const [content, setContent] = useState<NoteContent | null>(null)
  const [dirty, setDirty] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const viewRef = useRef<EditorView | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyBodyRef = useRef<string | null>(null)
  /** The body we most recently wrote. Used to suppress watcher echoes
   *  of our own saves — comparing to disk is more robust than a
   *  single-shot ignore flag, since a save can echo more than once
   *  and additional edits can land in between. */
  const lastWrittenBodyRef = useRef<string | null>(null)

  // Apply theme + font vars before paint.
  useEffect(() => {
    applyTheme(prefs)
    const html = document.documentElement
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    if (prefs.themeMode === 'auto') {
      const onChange = (): void => applyTheme(prefs)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    void html
    return undefined
  }, [prefs])

  // Initial load.
  useEffect(() => {
    let alive = true
    void window.zen.readNote(notePath).then((c) => {
      if (!alive) return
      setContent(c)
    })
    return () => {
      alive = false
    }
  }, [notePath])

  // Sync to external changes (file watcher broadcasts to all windows).
  useEffect(() => {
    const off = window.zen.onVaultChange((ev: VaultChangeEvent) => {
      if (ev.path !== notePath) return
      if (ev.kind === 'unlink') {
        // Note deleted — close the window.
        window.zen.windowClose()
        return
      }
      // Only refresh when the disk content differs from what we last
      // wrote ourselves. Skipping the echo prevents the editor from
      // rolling back to an older body when the save echo arrives
      // after the user has typed more characters.
      void window.zen.readNote(notePath).then((c) => {
        if (lastWrittenBodyRef.current === c.body) return
        setContent(c)
      })
    })
    return off
  }, [notePath])

  const persist = useCallback(
    async (body: string) => {
      // Snapshot what's about to hit disk so the watcher echo can be
      // recognised even if the user keeps typing while the write
      // resolves.
      lastWrittenBodyRef.current = body
      try {
        await window.zen.writeNote(notePath, body)
        setDirty(false)
        // IMPORTANT: don't call setContent here. After mount, the CM
        // view owns the document; the `content` state is only used to
        // seed the initial render and to push external file-watcher
        // changes into the view. Re-setting `content` to the same body
        // (or worse, stale body + fresh meta) causes the sync effect
        // to run and programmatically replace the view's contents —
        // which rolls back any edits typed since the save started.
      } catch (err) {
        console.error('floating writeNote failed', err)
      }
    },
    [notePath]
  )

  // Mount CodeMirror.
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        viewRef.current?.destroy()
        viewRef.current = null
        return
      }
      if (viewRef.current) return
      const state = EditorState.create({
        doc: content?.body ?? '',
        extensions: [
          new Compartment().of(prefs.vimMode ? vim() : []),
          history(),
          drawSelection(),
          highlightActiveLine(),
          prefs.wordWrap ? EditorView.lineWrapping : [],
          markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage, addKeymap: true }),
          headingFolding(),
          syntaxHighlighting(paperHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          prefs.livePreview ? livePreviewPlugin : [],
          lineNumberExtension(prefs.lineNumberMode),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((upd) => {
            if (!upd.docChanged) return
            if (upd.transactions.some((tr: Transaction) => tr.annotation(programmatic))) return
            const next = upd.state.doc.toString()
            dirtyBodyRef.current = next
            setDirty(true)
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
            saveTimerRef.current = setTimeout(() => {
              saveTimerRef.current = null
              const body = dirtyBodyRef.current
              if (body != null) void persist(body)
            }, SAVE_DEBOUNCE_MS)
          })
        ]
      })
      viewRef.current = new EditorView({ state, parent: el })
    },
    // Intentionally omit `content?.body` so the CM view isn't rebuilt
    // every keystroke; the sync effect below pushes external changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persist, prefs.livePreview, prefs.vimMode]
  )

  // Push external content updates into the live CM view (with
  // selection clamping to keep cursor near where it was).
  useEffect(() => {
    const view = viewRef.current
    if (!view || !content) return
    if (view.state.doc.toString() === content.body) return
    const sel = view.state.selection.main
    const anchor = Math.min(sel.anchor, content.body.length)
    const head = Math.min(sel.head, content.body.length)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content.body },
      annotations: programmatic.of(true),
      selection: { anchor, head }
    })
  }, [content])

  // Flush pending save before unload.
  useEffect(() => {
    const flush = (): void => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        const body = dirtyBodyRef.current
        if (body != null) void persist(body)
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [persist])

  // Floating windows have no tab strip, so browser-style window close
  // shortcuts should close the OS window itself rather than trying to
  // mimic the main app's "close active tab" behavior.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.altKey) return
      if (event.key.toLowerCase() !== 'w') return
      event.preventDefault()
      window.zen.windowClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Vim ex commands scoped to the floating window. The main-window
  // `registerVimCommands` never runs here (each Electron window has its
  // own renderer process), so `:q` / `:w` / `:wq` / `:x` would otherwise
  // be "Not an editor command". We keep the set minimal — there's no
  // sidebar / tabs / tasks view here, so broader ex commands don't apply.
  useEffect(() => {
    floatingHandlers.persist = async (): Promise<void> => {
      const body = viewRef.current?.state.doc.toString()
      if (body != null) await persist(body)
    }
    floatingHandlers.close = (): void => {
      window.zen.windowClose()
    }
    registerFloatingVimCommands()
  }, [persist])

  const title = useMemo(() => {
    if (content?.title) return content.title
    return notePath.split('/').pop()?.replace(/\.md$/i, '') ?? notePath
  }, [content, notePath])

  // Is this note currently the user's pinned reference? Read it from
  // the same prefs blob the main window writes to, so the pin icon
  // only shows up when it actually means something.
  const isPinnedReference = useMemo(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY)
      if (!raw) return false
      const parsed = JSON.parse(raw) as { pinnedRefPath?: string | null }
      return parsed.pinnedRefPath === notePath
    } catch {
      return false
    }
  }, [notePath])

  // Reflect the title in the OS window title.
  useEffect(() => {
    document.title = title
  }, [title])

  return (
    <div className="flex h-screen w-screen flex-col bg-paper-100 text-ink-900">
      <header
        className="glass-header flex h-12 shrink-0 items-center justify-between gap-2 border-b border-paper-300/70 px-4"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 pl-16">
          {isPinnedReference && (
            <PinIcon width={14} height={14} className="shrink-0 text-accent" />
          )}
          <span className="truncate text-sm font-semibold text-ink-900">{title}</span>
          {dirty && (
            <span
              aria-label="Unsaved changes"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/80"
            />
          )}
        </div>
        <div
          className="flex shrink-0 items-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="flex items-center gap-1 rounded-md bg-paper-200/70 p-0.5 text-[11px]">
            {(['edit', 'preview'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={[
                  'rounded px-1.5 py-0.5 capitalize transition-colors',
                  mode === m
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
            title="Close window"
            onClick={() => window.zen.windowClose()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-paper-200 hover:text-ink-900"
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === 'edit' ? (
          <div ref={setContainerRef} className="min-h-0 min-w-0 flex-1" />
        ) : content ? (
          <div
            data-preview-scroll
            className="min-h-0 min-w-0 flex-1 overflow-y-auto"
          >
            <Preview markdown={content.body} notePath={content.path} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-400">
            Loading…
          </div>
        )}
      </div>
    </div>
  )
}

// Module-scoped handler slots — the Vim ex callbacks are registered
// exactly once per window but need to see the latest `persist` closure,
// so the component effect above overwrites these on each re-render.
const floatingHandlers: {
  persist: null | (() => Promise<void>)
  close: null | (() => void)
} = { persist: null, close: null }

let floatingVimRegistered = false

/** Defer the window close by one tick so CM-Vim can finish unwinding its
 *  ex-command stack before the renderer is torn down. Closing synchronously
 *  from inside the ex callback means any follow-up IPC (history writes,
 *  panel cleanup) races against the already-destroyed WebContents and
 *  surfaces as a "TypeError: Object has been destroyed" in main. */
function deferredClose(): void {
  setTimeout(() => floatingHandlers.close?.(), 0)
}

function registerFloatingVimCommands(): void {
  if (floatingVimRegistered) return
  floatingVimRegistered = true

  Vim.defineEx('write', 'w', () => {
    void floatingHandlers.persist?.()
  })
  Vim.defineEx('quit', 'q', () => {
    // Pending autosave flushes on `beforeunload`, so closing without
    // `:w` first still writes whatever the user typed.
    deferredClose()
  })
  Vim.defineEx('wq', 'wq', () => {
    void floatingHandlers.persist?.().then(deferredClose)
  })
  // `:x` is its own command in vim (write + close if modified). CM-Vim
  // requires prefix to match the leading chars of name, so we register
  // `x` as both the name and the prefix rather than aliasing `exit`.
  Vim.defineEx('x', 'x', () => {
    void floatingHandlers.persist?.().then(deferredClose)
  })
}
