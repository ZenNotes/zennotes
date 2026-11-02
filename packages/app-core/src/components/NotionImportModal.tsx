import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  NotionImportProgress,
  NotionImportStatus,
  NotionTreeItem
} from '@zennotes/bridge-contract/notion-import'
import { useStore } from '../store'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

const INTEGRATIONS_URL = 'https://www.notion.so/profile/integrations'

const PHASE_LABEL: Record<NotionImportProgress['phase'], string> = {
  finding: 'Finding pages',
  reading: 'Reading from Notion',
  writing: 'Writing notes',
  done: 'Imported',
  stopped: 'Stopped',
  failed: 'Import failed'
}

function plural(count: number, one: string): string {
  return `${count.toLocaleString()} ${one}${count === 1 ? '' : 's'}`
}

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
}

interface TreeState {
  children: Map<string, NotionTreeItem[]>
  expanded: Set<string>
  loading: Set<string>
}

interface VisibleRow {
  item: NotionTreeItem
  depth: number
  /** An ancestor is left out, so this one is too, whatever its own box says. */
  blocked: boolean
}

/**
 * Importing Notion: sign in, choose what comes over from a tree of the
 * workspace (everything to start with), then the run, which keeps going in main
 * if this closes. A person who reopens the dialog lands back on the same
 * progress. Children load a level at a time, since listing them means reading
 * the page.
 */
export function NotionImportModal(): JSX.Element {
  const close = useStore((s) => s.setNotionImportOpen)
  const selectNote = useStore((s) => s.selectNote)
  const vimMode = useStore((s) => s.vimMode)

  const [status, setStatus] = useState<NotionImportStatus | null>(null)
  const [progress, setProgress] = useState<NotionImportProgress | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [roots, setRoots] = useState<NotionTreeItem[] | null>(null)
  const [loadingRoots, setLoadingRoots] = useState(false)
  const [tree, setTree] = useState<TreeState>({ children: new Map(), expanded: new Set(), loading: new Set() })
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const [signingIn, setSigningIn] = useState(false)
  const [useToken, setUseToken] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [includeTasks, setIncludeTasks] = useState(false)
  const [saving, setSaving] = useState(false)
  const tokenRef = useRef<HTMLInputElement>(null)
  const signInRef = useRef<HTMLButtonElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<NotionImportStatus | null> => {
    const next = (await window.zen.notionImportStatus?.()) ?? null
    setStatus(next)
    setProgress(next?.progress ?? null)
    return next
  }, [])

  const loadRoots = useCallback(async (): Promise<void> => {
    setLoadingRoots(true)
    setError(null)
    try {
      const answer = await window.zen.notionImportTree?.()
      setWorkspace(answer?.workspace ?? '')
      setRoots(answer?.items ?? [])
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setLoadingRoots(false)
    }
  }, [])

  const connected = !!status && (status.signedIn || status.tokenSet)

  useEffect(() => {
    void refresh().then((next) => {
      if (next && (next.signedIn || next.tokenSet) && !next.running && !next.remote) void loadRoots()
    })
    return window.zen.onNotionImportProgress?.((update) => {
      setProgress(update)
      if (update.phase === 'stopped' || update.phase === 'failed') {
        void refresh().then(() => loadRoots())
      } else if (update.phase === 'done') {
        void refresh()
      }
    })
  }, [refresh, loadRoots])

  const visible = useMemo<VisibleRow[]>(() => {
    const out: VisibleRow[] = []
    const walk = (items: NotionTreeItem[], depth: number, blocked: boolean): void => {
      for (const item of items) {
        out.push({ item, depth, blocked })
        if (tree.expanded.has(item.id)) {
          walk(tree.children.get(item.id) ?? [], depth + 1, blocked || excluded.has(item.id))
        }
      }
    }
    walk(roots ?? [], 0, false)
    return out
  }, [roots, tree, excluded])

  const expand = useCallback(
    async (item: NotionTreeItem): Promise<void> => {
      if (item.kind !== 'page') return
      setTree((t) => ({ ...t, expanded: new Set(t.expanded).add(item.id) }))
      if (tree.children.has(item.id) || tree.loading.has(item.id)) return
      setTree((t) => ({ ...t, loading: new Set(t.loading).add(item.id) }))
      try {
        const items = (await window.zen.notionImportTreeChildren?.(item.id)) ?? []
        setTree((t) => {
          const loading = new Set(t.loading)
          loading.delete(item.id)
          return { ...t, loading, children: new Map(t.children).set(item.id, items) }
        })
      } catch (err) {
        setError(cleanError(err))
        setTree((t) => {
          const loading = new Set(t.loading)
          loading.delete(item.id)
          const expanded = new Set(t.expanded)
          expanded.delete(item.id)
          return { ...t, loading, expanded }
        })
      }
    },
    [tree]
  )

  const collapse = (item: NotionTreeItem): void => {
    setTree((t) => {
      const expanded = new Set(t.expanded)
      expanded.delete(item.id)
      return { ...t, expanded }
    })
  }

  const toggle = (row: VisibleRow): void => {
    if (row.blocked) return
    setExcluded((set) => {
      const next = new Set(set)
      if (next.has(row.item.id)) next.delete(row.item.id)
      else next.add(row.item.id)
      return next
    })
  }

  const onTreeKey = (e: React.KeyboardEvent): void => {
    const row = visible[cursor]
    if (!row) return
    const key = e.key
    const down = key === 'ArrowDown' || (vimMode && key === 'j')
    const up = key === 'ArrowUp' || (vimMode && key === 'k')
    const right = key === 'ArrowRight' || (vimMode && key === 'l')
    const left = key === 'ArrowLeft' || (vimMode && key === 'h')
    if (down) setCursor((c) => Math.min(c + 1, visible.length - 1))
    else if (up) setCursor((c) => Math.max(c - 1, 0))
    else if (right) {
      if (row.item.kind === 'page' && !tree.expanded.has(row.item.id)) void expand(row.item)
      else if (visible[cursor + 1]?.depth === row.depth + 1) setCursor(cursor + 1)
    } else if (left) {
      if (tree.expanded.has(row.item.id)) collapse(row.item)
      else if (row.depth > 0) {
        for (let i = cursor - 1; i >= 0; i--) {
          if (visible[i].depth === row.depth - 1) {
            setCursor(i)
            break
          }
        }
      }
    } else if (key === ' ') toggle(row)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  useEffect(() => {
    treeRef.current?.querySelector(`[data-tree-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const signIn = async (): Promise<void> => {
    setSigningIn(true)
    setError(null)
    try {
      await window.zen.notionImportSignIn?.()
      await refresh()
      await loadRoots()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setSigningIn(false)
    }
  }

  const saveToken = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await window.zen.notionImportSaveToken?.(token)
    setSaving(false)
    if (!result?.ok) {
      setError(result?.error ?? 'The token could not be saved.')
      return
    }
    setToken('')
    setUseToken(false)
    await refresh()
    await loadRoots()
  }

  const disconnect = async (): Promise<void> => {
    await window.zen.notionImportSignOut?.()
    setRoots(null)
    setWorkspace('')
    setExcluded(new Set())
    setTree({ children: new Map(), expanded: new Set(), loading: new Set() })
    setError(null)
    await refresh()
  }

  const start = async (): Promise<void> => {
    setError(null)
    setProgress({ phase: 'finding', done: 0, total: 0 })
    try {
      await window.zen.notionImportStart?.({ includeTasks, excluded: [...excluded] })
      await refresh()
    } catch (err) {
      setProgress(null)
      setError(cleanError(err))
    }
  }

  const startOver = async (): Promise<void> => {
    await window.zen.notionImportDiscard?.()
    setProgress(null)
    await refresh()
  }

  const phase = progress?.phase
  // A finished result has been seen once it's closed. Left in place, reopening
  // would show it again with no way to start another import.
  const onClose = (): void => {
    if (phase === 'done') void window.zen.notionImportDiscard?.()
    if (signingIn) void window.zen.notionImportCancelSignIn?.()
    close(false)
  }

  const openReport = (): void => {
    const path = progress?.result?.reportPath
    onClose()
    if (path) void selectNote(path)
  }

  const running = status?.running || phase === 'finding' || phase === 'reading' || phase === 'writing'
  const asksToConnect = !!status && !connected && !status.remote && !running
  useEffect(() => {
    if (!asksToConnect) return
    if (useToken) tokenRef.current?.focus()
    else signInRef.current?.focus()
  }, [asksToConnect, useToken])

  // The tree takes the keyboard as soon as it's there to steer.
  const hasRoots = !!roots && roots.length > 0
  useEffect(() => {
    if (hasRoots && !running) treeRef.current?.focus()
  }, [hasRoots, running])

  const everythingOut = hasRoots && roots.every((root) => excluded.has(root.id))
  const selectionLabel =
    excluded.size === 0 ? 'Everything is selected.' : `${plural(excluded.size, 'item')} left out.`

  let body: JSX.Element
  let footer: JSX.Element

  if (!status) {
    body = <p className="text-sm text-ink-600">Checking…</p>
    footer = <Button onClick={onClose}>Close</Button>
  } else if (status.remote) {
    body = <p className="text-sm text-ink-700">Imports write to a local vault. Switch to one to import from Notion.</p>
    footer = <Button variant="primary" onClick={onClose}>Close</Button>
  } else if (running) {
    const fraction = progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : null
    body = (
      <div className="flex flex-col gap-2" role="status" aria-live="polite" data-notion-import-progress>
        <div className="flex items-baseline justify-between gap-3 text-sm text-ink-800">
          <span>{phase ? PHASE_LABEL[phase] : 'Starting'}</span>
          {progress && progress.total > 0 && (
            <span className="shrink-0 tabular-nums text-ink-500">
              {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
            </span>
          )}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-paper-200">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: fraction === null ? '10%' : `${Math.round(fraction * 100)}%` }}
          />
        </div>
        <p className="truncate text-xs text-ink-500">{progress?.title || ' '}</p>
      </div>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>Hide</Button>
        <Button onClick={() => void window.zen.notionImportStop?.()}>Stop</Button>
      </>
    )
  } else if (phase === 'done' && progress?.result) {
    const result = progress.result
    body = (
      <div className="flex flex-col gap-2 text-sm text-ink-800" data-notion-import-result>
        <p>
          {plural(result.pages, 'page')}, {plural(result.databases, 'database')} with{' '}
          {plural(result.rows, 'row')}, and {plural(result.files, 'file')} are in{' '}
          <span className="font-medium">{result.folder}</span>.
        </p>
        <p className="text-ink-600">
          {result.issues > 0
            ? `The report lists ${plural(result.issues, 'thing')} left out or changed.`
            : 'The report lists what every import changes.'}
        </p>
      </div>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={openReport}>Open report</Button>
      </>
    )
  } else if (!connected) {
    body = useToken ? (
      <div className="flex flex-col gap-3 text-sm text-ink-800">
        <p className="text-ink-700">
          Create an integration in{' '}
          <button
            type="button"
            className="text-accent underline"
            onClick={() => void window.zen.openExternalUrl(INTEGRATIONS_URL)}
          >
            Notion
          </button>{' '}
          and connect it to each page to import.
        </p>
        <input
          ref={tokenRef}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && token.trim() && !saving) void saveToken()
          }}
          placeholder="Notion token"
          aria-label="Notion token"
          autoComplete="off"
          spellCheck={false}
          data-notion-import-token
          className="w-full rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-sm text-ink-900 outline-none focus:border-accent"
        />
      </div>
    ) : (
      <p className="text-sm text-ink-700">
        {signingIn ? 'Finish signing in in your browser.' : 'Sign in to choose what to bring over. Nothing is imported until you say so.'}
      </p>
    )
    footer = useToken ? (
      <>
        <Button variant="ghost" onClick={() => setUseToken(false)}>Back</Button>
        <Button variant="primary" disabled={!token.trim() || saving} onClick={() => void saveToken()}>
          {saving ? 'Checking' : 'Save token'}
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={() => setUseToken(true)} data-notion-import-use-token>Use a token</Button>
        <Button ref={signInRef} variant="primary" disabled={signingIn} onClick={() => void signIn()} data-notion-import-sign-in>
          {signingIn ? 'Waiting for Notion' : 'Sign in with Notion'}
        </Button>
      </>
    )
  } else {
    body = (
      <div className="flex flex-col gap-3 text-sm text-ink-800">
        {loadingRoots && <p className="text-ink-600">Finding your workspace…</p>}
        {roots && roots.length === 0 && !loadingRoots && (
          <p className="text-ink-600" data-notion-import-empty>
            Nothing to import here yet.
          </p>
        )}
        {hasRoots && (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <p data-notion-import-scan>
                <span className="font-medium">{workspace}</span>
                <span className="text-ink-600">: {selectionLabel}</span>
              </p>
              <button
                type="button"
                className="shrink-0 text-xs text-ink-500 hover:text-ink-800"
                data-notion-import-select-all
                onClick={() => setExcluded(excluded.size === 0 ? new Set(roots.map((root) => root.id)) : new Set())}
              >
                {excluded.size === 0 ? 'Select none' : 'Select all'}
              </button>
            </div>
            <div
              ref={treeRef}
              role="tree"
              aria-label="What to import"
              tabIndex={0}
              onKeyDown={onTreeKey}
              data-notion-import-tree
              className="max-h-[52vh] overflow-y-auto rounded-md border border-paper-300 py-1 outline-none focus:border-accent"
            >
              {visible.map((row, index) => {
                const { item, depth, blocked } = row
                const open = tree.expanded.has(item.id)
                const out = blocked || excluded.has(item.id)
                const kids = tree.children.get(item.id)
                const leaf = item.kind !== 'page' || (kids !== undefined && kids.length === 0)
                return (
                  <div
                    key={`${depth}-${item.id}`}
                    role="treeitem"
                    aria-selected={index === cursor}
                    aria-checked={!out}
                    aria-expanded={leaf ? undefined : open}
                    data-tree-index={index}
                    data-notion-tree-item={item.id}
                    data-notion-tree-out={out ? 'true' : undefined}
                    onMouseDown={() => setCursor(index)}
                    className={[
                      'flex items-center gap-1.5 py-1 pr-2 text-sm',
                      index === cursor ? 'bg-paper-200' : '',
                      out ? 'text-ink-400' : 'text-ink-800'
                    ].join(' ')}
                    style={{ paddingLeft: 8 + depth * 16 }}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={open ? 'Collapse' : 'Expand'}
                      disabled={leaf}
                      className="w-4 shrink-0 text-center text-xs text-ink-500 disabled:opacity-0"
                      onClick={() => (open ? collapse(item) : void expand(item))}
                    >
                      {open ? '▾' : '▸'}
                    </button>
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      checked={!out}
                      disabled={blocked}
                      aria-label={item.title}
                      onChange={() => toggle(row)}
                    />
                    <span className="truncate">{item.title}</span>
                    {item.kind === 'database' && <span className="shrink-0 text-xs text-ink-400">database</span>}
                    {tree.loading.has(item.id) && <span className="shrink-0 text-xs text-ink-400">…</span>}
                  </div>
                )
              })}
            </div>
            <label className="flex items-center gap-2 text-ink-700">
              <input
                type="checkbox"
                checked={includeTasks}
                onChange={(e) => setIncludeTasks(e.target.checked)}
              />
              Show imported to-dos in Tasks
            </label>
          </>
        )}
        {status.resumable && <p className="text-ink-600">An earlier import stopped partway. It can pick up where it was.</p>}
        {phase === 'failed' && <p className="text-danger">{progress?.error}</p>}
      </div>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={() => void disconnect()}>Sign out</Button>
        {status.resumable && <Button onClick={() => void startOver()}>Start over</Button>}
        <Button
          variant="primary"
          disabled={loadingRoots || !hasRoots || everythingOut}
          onClick={() => void start()}
          data-notion-import-start
        >
          {status.resumable ? 'Continue import' : 'Import'}
        </Button>
      </>
    )
  }

  return (
    <Modal
      size="md"
      layer="modal"
      onClose={onClose}
      closeOnBackdrop={false}
      data={{ 'data-notion-import': '' }}
    >
      <Modal.Header title="Import from Notion" />
      <Modal.Body>
        <div className="flex flex-col gap-3">
          {body}
          {error && phase !== 'failed' && <p className="text-sm text-danger" role="alert">{error}</p>}
        </div>
      </Modal.Body>
      <Modal.Footer>{footer}</Modal.Footer>
    </Modal>
  )
}
