/**
 * Standalone editor window mounted when the renderer boots with
 * `?externalFile=<abs>`. Spawned by the main process when the user opens
 * a markdown file that lives outside any vault (Finder "Open With", a
 * double-click, etc.).
 *
 * It mirrors the floating-note window — header + edit/preview toggle +
 * CodeMirror / Preview — but reads and writes the file by its absolute
 * path through the external-file IPCs rather than a vault-relative path,
 * and offers a "Move to Vault" action to pull the file into the active
 * vault.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Annotation, Compartment, EditorState, type Transaction } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view'
import { Vim, vim } from '@replit/codemirror-vim'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { resolveCodeLanguage } from '../lib/cm-code-languages'
import { applyVimInsertEscape } from '../lib/vim-insert-escape'
import { markdownListIndentPlugin } from '../lib/cm-markdown-list-indent'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import type { ExternalFileContent } from '@shared/ipc'
import { livePreviewPlugin } from '../lib/cm-live-preview'
import { headingFolding } from '../lib/cm-heading-fold'
import { LazyPreview as Preview } from './LazyPreview'
import { CloseIcon, InboxIcon } from './icons'
import {
  applyTheme,
  lineNumberExtension,
  loadFloatingPrefs,
  paperHighlight
} from './FloatingNoteApp'

const SAVE_DEBOUNCE_MS = 350
const programmatic = Annotation.define<boolean>()

function titleFromName(name: string): string {
  return name.replace(/\.(md|markdown)$/i, '') || name
}

export function ExternalFileApp(): JSX.Element {
  const prefs = useMemo(() => loadFloatingPrefs(), [])
  const [content, setContent] = useState<ExternalFileContent | null>(null)
  const [dirty, setDirty] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Source of truth for the body: seeded on load and updated on every
  // edit. The editor is recreated on each edit/preview toggle, so it must
  // re-seed from here — `content` is captured stale in setContainerRef.
  const bodyRef = useRef<string | null>(null)

  // Apply theme + font vars before paint.
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

  // Initial load.
  useEffect(() => {
    let alive = true
    void window.zen
      .readExternalFile()
      .then((c) => {
        if (!alive) return
        bodyRef.current = c.body
        setContent(c)
      })
      .catch((err) => {
        console.error('readExternalFile failed', err)
      })
    return () => {
      alive = false
    }
  }, [])

  const persist = useCallback(async (body: string) => {
    try {
      await window.zen.writeExternalFile(body)
      setDirty(false)
    } catch (err) {
      console.error('writeExternalFile failed', err)
    }
  }, [])

  // Mount CodeMirror once content is loaded.
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        viewRef.current?.destroy()
        viewRef.current = null
        return
      }
      if (viewRef.current) return
      const state = EditorState.create({
        // Read the live ref, not `content`: this callback's deps omit
        // `content`, so its closure is stale (null) after load. Using the
        // ref keeps the current text when the editor remounts on toggles.
        doc: bodyRef.current ?? '',
        extensions: [
          new Compartment().of(prefs.vimMode ? vim() : []),
          history(),
          drawSelection(),
          highlightActiveLine(),
          prefs.wordWrap ? EditorView.lineWrapping : [],
          markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage, addKeymap: true }),
          markdownListIndentPlugin,
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
            bodyRef.current = next
            setDirty(true)
            setMoveError(null)
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
            saveTimerRef.current = setTimeout(() => {
              saveTimerRef.current = null
              const body = bodyRef.current
              if (body != null) void persist(body)
            }, SAVE_DEBOUNCE_MS)
          })
        ]
      })
      viewRef.current = new EditorView({ state, parent: el })
      // Focus the editor on mount (and on every edit/preview toggle that
      // remounts it) so vim motions work immediately, matching the main
      // editor. Without this the window opens with focus on the body and
      // no keystrokes reach CodeMirror until the user clicks into the text.
      viewRef.current.focus()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persist, prefs.livePreview, prefs.vimMode]
  )

  // Seed the live CM view the first time content arrives.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !content) return
    if (view.state.doc.toString() === content.body) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content.body },
      annotations: programmatic.of(true)
    })
  }, [content])

  // Flush pending save before unload.
  useEffect(() => {
    const flush = (): void => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        const body = bodyRef.current
        if (body != null) void persist(body)
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [persist])

  // Cmd/Ctrl+W closes the standalone window.
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

  const currentBody = useCallback((): string => {
    return viewRef.current?.state.doc.toString() ?? bodyRef.current ?? content?.body ?? ''
  }, [content])

  const moveToVault = useCallback(async () => {
    if (moving) return
    setMoving(true)
    setMoveError(null)
    try {
      // Persist the latest edits to the original path first so the move
      // carries them over.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      await persist(currentBody())
      await window.zen.moveExternalFileToVault()
      // On success the main process opens the note in a vault window and
      // closes this one.
    } catch (err) {
      setMoving(false)
      setMoveError(err instanceof Error ? err.message : 'Could not move this file into a vault.')
    }
  }, [currentBody, moving, persist])

  // Vim ex commands scoped to this window.
  useEffect(() => {
    externalFileHandlers.persist = async (): Promise<void> => {
      await persist(currentBody())
    }
    externalFileHandlers.close = (): void => window.zen.windowClose()
    registerExternalFileVimCommands()
    applyVimInsertEscape(prefs.vimInsertEscape)
  }, [persist, currentBody, prefs.vimInsertEscape])

  const title = useMemo(() => (content ? titleFromName(content.name) : 'Untitled'), [content])

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
          <span className="truncate text-sm font-semibold text-ink-900">{title}</span>
          {dirty && (
            <span
              aria-label="Unsaved changes"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/80"
            />
          )}
          <span className="truncate text-xs text-ink-400">Not in a vault</span>
        </div>
        <div
          className="flex shrink-0 items-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={moveToVault}
            disabled={moving}
            title="Move this file into your vault"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-600 hover:bg-paper-200 hover:text-ink-900 disabled:opacity-50"
          >
            <InboxIcon width={13} height={13} />
            {moving ? 'Moving…' : 'Move to Vault'}
          </button>
          <div className="flex items-center gap-1 rounded-md bg-paper-200/70 p-0.5 text-xs">
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

      {moveError && (
        <div className="shrink-0 border-b border-paper-300/70 bg-rose-500/10 px-4 py-1.5 text-xs text-rose-600">
          {moveError}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === 'edit' ? (
          <div ref={setContainerRef} className="min-h-0 min-w-0 flex-1" />
        ) : content ? (
          <div data-preview-scroll className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <Preview markdown={currentBody()} notePath={content.name} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-400">Loading…</div>
        )}
      </div>
    </div>
  )
}

// Module-scoped handler slots so the Vim ex callbacks always see the
// latest `persist` closure (mirrors the floating-note window).
const externalFileHandlers: {
  persist: null | (() => Promise<void>)
  close: null | (() => void)
} = { persist: null, close: null }

let externalFileVimRegistered = false

function deferredClose(): void {
  setTimeout(() => externalFileHandlers.close?.(), 0)
}

function registerExternalFileVimCommands(): void {
  if (externalFileVimRegistered) return
  externalFileVimRegistered = true

  Vim.defineEx('write', 'w', () => {
    void externalFileHandlers.persist?.()
  })
  Vim.defineEx('quit', 'q', () => {
    deferredClose()
  })
  Vim.defineEx('wq', 'wq', () => {
    void externalFileHandlers.persist?.().then(deferredClose)
  })
  Vim.defineEx('x', 'x', () => {
    void externalFileHandlers.persist?.().then(deferredClose)
  })
}
