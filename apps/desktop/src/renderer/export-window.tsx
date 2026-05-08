import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { AssetMeta, NoteContent, NoteMeta, VaultInfo } from '@shared/ipc'
import { LazyPreview as Preview } from '@renderer/components/LazyPreview'
import { useStore } from '@renderer/store'
import '@renderer/styles/index.css'

const PREFS_KEY = 'zen:prefs:v2'

type ExportPrefs = {
  editorFontSize: number
  editorLineHeight: number
  previewMaxWidth: number
  editorMaxWidth: number
  contentAlign: 'center' | 'left'
  interfaceFont: string | null
  textFont: string | null
  monoFont: string | null
}

const DEFAULT_EXPORT_PREFS: ExportPrefs = {
  editorFontSize: 16,
  editorLineHeight: 1.7,
  previewMaxWidth: 920,
  editorMaxWidth: 920,
  contentAlign: 'center',
  interfaceFont: null,
  textFont: null,
  monoFont: null
}

function setExportState(state: 'loading' | 'ready' | 'error', message?: string): void {
  if (!document.body) return
  document.body.dataset.exportState = state
  if (message) document.body.dataset.exportError = message
  else delete document.body.dataset.exportError
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function loadExportPrefs(): ExportPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_EXPORT_PREFS
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const contentAlign = parsed.contentAlign === 'left' ? 'left' : 'center'
    return {
      editorFontSize: safeNumber(parsed.editorFontSize, DEFAULT_EXPORT_PREFS.editorFontSize),
      editorLineHeight: safeNumber(parsed.editorLineHeight, DEFAULT_EXPORT_PREFS.editorLineHeight),
      previewMaxWidth: safeNumber(parsed.previewMaxWidth, DEFAULT_EXPORT_PREFS.previewMaxWidth),
      editorMaxWidth: safeNumber(parsed.editorMaxWidth, DEFAULT_EXPORT_PREFS.editorMaxWidth),
      contentAlign,
      interfaceFont: safeString(parsed.interfaceFont),
      textFont: safeString(parsed.textFont),
      monoFont: safeString(parsed.monoFont)
    }
  } catch {
    return DEFAULT_EXPORT_PREFS
  }
}

function applyExportPrefs(prefs: ExportPrefs): void {
  const html = document.documentElement
  html.dataset.theme = 'github-light'
  html.dataset.contentAlign = prefs.contentAlign
  html.setAttribute('data-opaque', '')
  html.style.colorScheme = 'light'
  html.style.setProperty('--z-editor-font-size', `${prefs.editorFontSize}px`)
  html.style.setProperty('--z-editor-line-height', String(prefs.editorLineHeight))
  html.style.setProperty('--z-preview-max-width', `${prefs.previewMaxWidth}px`)
  html.style.setProperty('--z-editor-max-width', `${prefs.editorMaxWidth}px`)

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
}

function ExportNoteWindow({ notePath }: { notePath: string }): JSX.Element {
  const [note, setNote] = useState<NoteContent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    applyExportPrefs(loadExportPrefs())
    setExportState('loading')

    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const [vault, notes, assetFiles, noteContent] = await Promise.all([
          window.zen.getCurrentVault(),
          window.zen.listNotes(),
          window.zen.listAssets(),
          window.zen.readNote(notePath)
        ])
        if (cancelled) return
        if (!vault) {
          throw new Error('No active vault was available for PDF export.')
        }

        useStore.setState({
          vault: vault as VaultInfo,
          notes: notes as NoteMeta[],
          assetFiles: assetFiles as AssetMeta[],
          selectedPath: noteContent.path,
          activeNote: noteContent
        })
        document.title = noteContent.title
        setNote(noteContent)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setExportState('error', message)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [notePath])

  if (error) {
    return (
      <main className="min-h-screen bg-[color:rgb(var(--z-bg))] px-10 py-12 text-[color:rgb(var(--z-fg))]">
        <div className="mx-auto max-w-3xl rounded-2xl border border-[color:rgb(var(--z-red)/0.35)] bg-[color:rgb(var(--z-bg-1))] px-6 py-5">
          <h1 className="text-xl font-semibold text-[color:rgb(var(--z-red))]">PDF export failed</h1>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-[color:rgb(var(--z-fg-2))]">
            {error}
          </p>
        </div>
      </main>
    )
  }

  if (!note) {
    return (
      <main className="min-h-screen bg-[color:rgb(var(--z-bg))] px-10 py-12 text-[color:rgb(var(--z-fg))]">
        <div className="mx-auto max-w-3xl rounded-2xl border border-[color:rgb(var(--z-bg-3))] bg-[color:rgb(var(--z-bg-1))] px-6 py-5">
          <p className="text-sm leading-7 text-[color:rgb(var(--z-fg-2))]">Preparing note export…</p>
        </div>
      </main>
    )
  }

  return (
    <>
      <style>{`
        @page {
          margin: 0.7in;
        }
        html,
        body,
        #root {
          height: auto !important;
          min-height: 0 !important;
          overflow: visible !important;
          background: #ffffff !important;
        }
        body,
        #root {
          display: block !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        body {
          user-select: text !important;
        }
        .export-note-shell {
          min-height: auto;
          width: 100%;
          overflow: visible;
          background: #ffffff;
          color: rgb(var(--z-fg));
        }
        .export-note-shell .prose-zen {
          padding: 32px 40px 48px;
        }
        @media print {
          html,
          body,
          #root {
            height: auto !important;
            min-height: 0 !important;
            overflow: visible !important;
            background: #ffffff !important;
          }
          .export-note-shell {
            min-height: auto;
            overflow: visible;
          }
          .export-note-shell .prose-zen {
            max-width: none;
            width: 100%;
            padding: 0;
            margin: 0;
          }
        }
      `}</style>
      <main className="export-note-shell">
        <Preview
          markdown={note.body}
          notePath={note.path}
          onRendered={() => setExportState('ready')}
        />
      </main>
    </>
  )
}

export function renderExportNoteWindow(root: HTMLElement, notePath: string): void {
  ReactDOM.createRoot(root).render(<ExportNoteWindow notePath={notePath} />)
}
