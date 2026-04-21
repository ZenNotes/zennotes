import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DirectoryBrowseEntry, DirectoryBrowseShortcut } from '@shared/ipc'

export interface ServerDirectoryPickerOptions {
  title: string
  description?: string
  initialPath?: string
  confirmLabel?: string
}

export function ServerDirectoryPickerModal({
  options,
  onSubmit,
  onCancel
}: {
  options: ServerDirectoryPickerOptions
  onSubmit: (path: string) => Promise<void> | void
  onCancel: () => void
}): JSX.Element {
  const [currentPath, setCurrentPath] = useState('')
  const [draftPath, setDraftPath] = useState(options.initialPath ?? '')
  const [showAdvancedPath, setShowAdvancedPath] = useState(false)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<DirectoryBrowseEntry[]>([])
  const [shortcuts, setShortcuts] = useState<DirectoryBrowseShortcut[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const loadDirectory = useCallback(async (nextPath: string) => {
    setLoading(true)
    setError(null)
    setSubmitError(null)
    try {
      const result = await window.zen.browseServerDirectories(nextPath)
      setCurrentPath(result.currentPath)
      setDraftPath(result.currentPath)
      setParentPath(result.parentPath)
      setEntries(result.entries)
      setShortcuts(result.shortcuts)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDirectory(options.initialPath ?? '')
  }, [options.initialPath, options.title, loadDirectory])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (showAdvancedPath) {
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [showAdvancedPath])

  const submitPath = useMemo(() => draftPath.trim() || currentPath, [currentPath, draftPath])
  const canSubmit = useMemo(
    () => !loading && !submitting && !error && submitPath.trim().length > 0,
    [error, loading, submitPath, submitting]
  )

  const pathCrumbs = useMemo(() => {
    const path = currentPath.trim()
    if (!path) return [] as Array<{ label: string; path: string }>

    const windowsMatch = path.match(/^([A-Za-z]:)(\\.*)?$/)
    if (windowsMatch) {
      const drive = windowsMatch[1]
      const rest = (windowsMatch[2] ?? '').split('\\').filter(Boolean)
      let running = `${drive}\\`
      const crumbs = [{ label: drive, path: running }]
      for (const part of rest) {
        running = running.endsWith('\\') ? `${running}${part}` : `${running}\\${part}`
        crumbs.push({ label: part, path: running })
      }
      return crumbs
    }

    const parts = path.split('/').filter(Boolean)
    let running = '/'
    const crumbs: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
    for (const part of parts) {
      running = running === '/' ? `/${part}` : `${running}/${part}`
      crumbs.push({ label: part, path: running })
    }
    return crumbs
  }, [currentPath])

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onSubmit(submitPath)
    } catch (err) {
      setSubmitError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      data-server-directory-picker
      className="fixed inset-0 z-[72] flex items-start justify-center bg-black/45 pt-[14vh] backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[min(720px,94vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5">
          <div className="text-sm font-semibold text-ink-900">{options.title}</div>
          {options.description && (
            <div className="mt-1 text-xs text-ink-500">{options.description}</div>
          )}
        </div>

        <div className="px-5 pt-4">
          {shortcuts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {shortcuts.map((shortcut) => (
                <button
                  key={`${shortcut.label}:${shortcut.path}`}
                  type="button"
                  onClick={() => void loadDirectory(shortcut.path)}
                  className={[
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    shortcut.path === currentPath
                      ? 'border-accent bg-paper-200 text-ink-900'
                      : 'border-paper-300 bg-paper-50 text-ink-700 hover:bg-paper-200'
                  ].join(' ')}
                >
                  {shortcut.label}
                </button>
              ))}
            </div>
          )}

          <div className="mt-3 overflow-hidden rounded-lg border border-paper-300/70 bg-paper-50/95">
            <div className="border-b border-paper-300/60 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-ink-400">
              Location
            </div>
            <div className="px-3 py-3">
              {pathCrumbs.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  {pathCrumbs.map((crumb, index) => (
                    <div key={crumb.path} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void loadDirectory(crumb.path)}
                        className={[
                          'rounded px-2 py-1 text-sm transition-colors',
                          index === pathCrumbs.length - 1
                            ? 'bg-paper-200 text-ink-900'
                            : 'text-ink-700 hover:bg-paper-200'
                        ].join(' ')}
                      >
                        {crumb.label}
                      </button>
                      {index < pathCrumbs.length - 1 && (
                        <span className="text-xs text-ink-400">/</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-ink-400">{loading ? 'Loading folders…' : 'No folder selected yet.'}</div>
              )}
            </div>
          </div>

          <div className="mt-3 overflow-hidden rounded-lg border border-paper-300/70 bg-paper-50/95 shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between gap-3 border-b border-paper-300/60 px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.16em] text-ink-400">Folders</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowAdvancedPath((prev) => !prev)}
                  className="rounded-md border border-paper-300 bg-paper-100 px-2.5 py-1 text-[11px] text-ink-700 hover:bg-paper-200"
                >
                  {showAdvancedPath ? 'Hide Manual Path' : 'Enter Path Manually'}
                </button>
              </div>
            </div>
            {showAdvancedPath && (
              <div className="border-b border-paper-300/60 px-3 py-3">
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    value={draftPath}
                    placeholder="/srv/notes or /home/you/ObsidianVault"
                    onChange={(e) => {
                      setDraftPath(e.target.value)
                      setError(null)
                      setSubmitError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void loadDirectory(draftPath.trim())
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        onCancel()
                      }
                    }}
                    className="min-w-0 flex-1 rounded-md border border-paper-300 bg-paper-50 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => void loadDirectory(draftPath.trim())}
                    disabled={loading}
                    className="rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-xs text-ink-800 enabled:hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Go
                  </button>
                </div>
                <div className="mt-2 text-[11px] text-ink-400">
                  Optional: paste an absolute server path if you already know it.
                </div>
              </div>
            )}
            <div className="max-h-[44vh] overflow-y-auto py-1">
              {loading ? (
                <div className="px-3 py-8 text-center text-sm text-ink-400">Loading folders…</div>
              ) : entries.length === 0 && !parentPath ? (
                <div className="px-3 py-8 text-center text-sm text-ink-400">This folder has no subfolders. You can still choose it.</div>
              ) : (
                <>
                  {parentPath && (
                    <button
                      type="button"
                      onClick={() => void loadDirectory(parentPath)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-paper-200/70"
                    >
                      <span className="min-w-0 truncate text-sm text-ink-900">..</span>
                      <span className="shrink-0 text-[11px] text-ink-400">Up one level</span>
                    </button>
                  )}
                  {entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => void loadDirectory(entry.path)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-paper-200/70"
                    >
                      <span className="min-w-0 truncate text-sm text-ink-900">{entry.name}</span>
                      <span className="shrink-0 text-[11px] text-ink-400">Open</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          {error && (
            <div className="mt-3 text-xs" style={{ color: 'rgb(var(--z-red))' }}>
              {error}
            </div>
          )}
          {!error && submitError && (
            <div className="mt-3 text-xs" style={{ color: 'rgb(var(--z-red))' }}>
              {submitError}
            </div>
          )}
          <div className="mt-3 text-xs text-ink-400">
            Chosen folder: <span className="text-ink-700">{submitPath || 'None'}</span>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-paper-300/50 bg-paper-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-sm text-ink-800 hover:bg-paper-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-paper-50 enabled:hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Working…' : options.confirmLabel ?? 'Select folder'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
