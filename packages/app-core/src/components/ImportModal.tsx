import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LogseqDailyNotePlace,
  LogseqImportScan,
  NotionImportProgress,
  NotionImportStatus,
  ObsidianImportScan
} from '@zennotes/bridge-contract/notion-import'
import { dailyNoteLocationForDate, findDailyNoteForDate } from '../lib/vault-layout'
import { useStore } from '../store'
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon } from './icons'
import { OutlineGlyph, VaultGlyph, WorkspaceGlyph } from './ImportGlyphs'
import { ImportTree, type ImportTreeItem } from './ImportTree'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

const INTEGRATIONS_URL = 'https://www.notion.so/profile/integrations'

function plural(count: number, one: string): string {
  return `${count.toLocaleString()} ${one}${count === 1 ? '' : 's'}`
}

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
}

const isRunning = (phase: NotionImportProgress['phase'] | undefined): boolean =>
  phase === 'finding' || phase === 'reading' || phase === 'writing'

/** The window's title, with a way back to the two sources. */
function Heading({ title, onBack }: { title: string; onBack?: () => void }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      {onBack && (
        <button
          type="button"
          aria-label="Back to sources"
          data-import-back
          onClick={onBack}
          className="-ml-1 flex h-6 w-6 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900"
        >
          <ArrowLeftIcon width={14} height={14} />
        </button>
      )}
      <span>{title}</span>
    </div>
  )
}

function SourceCard({
  title,
  detail,
  icon,
  active,
  id,
  buttonRef,
  onChoose,
  onFocus
}: {
  title: string
  detail: string
  icon: JSX.Element
  active: boolean
  id: string
  buttonRef?: React.Ref<HTMLButtonElement>
  onChoose: () => void
  onFocus: () => void
}): JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onChoose}
      onFocus={onFocus}
      data-import-source={id}
      className={[
        'group flex w-full items-center gap-4 rounded-2xl border px-4 py-4 text-left outline-none transition-colors',
        active
          ? 'border-accent/60 bg-accent/10'
          : 'border-paper-300/60 bg-paper-100/60 hover:bg-paper-200/60'
      ].join(' ')}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-paper-300/60 bg-paper-50 text-ink-700">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-900">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-ink-600">{detail}</span>
      </span>
      <ChevronRightIcon width={14} height={14} className="shrink-0 text-ink-400 transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}

type ImportSource = 'notion' | 'obsidian' | 'logseq'
const SOURCES: ImportSource[] = ['notion', 'obsidian', 'logseq']

function ChooseSource({ onChoose }: { onChoose: (source: ImportSource) => void }): JSX.Element {
  const vimMode = useStore((s) => s.vimMode)
  const [active, setActive] = useState(0)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => {
    buttons.current[0]?.focus()
  }, [])
  const move = (next: number): void => {
    const index = Math.max(0, Math.min(SOURCES.length - 1, next))
    setActive(index)
    buttons.current[index]?.focus()
  }
  const card = (index: number) => ({
    id: SOURCES[index],
    active: active === index,
    buttonRef: (el: HTMLButtonElement | null) => {
      buttons.current[index] = el
    },
    onFocus: () => setActive(index),
    onChoose: () => onChoose(SOURCES[index])
  })
  return (
    <div
      className="flex flex-col gap-3"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || (vimMode && e.key === 'j')) move(active + 1)
        else if (e.key === 'ArrowUp' || (vimMode && e.key === 'k')) move(active - 1)
        else return
        e.preventDefault()
      }}
    >
      <SourceCard
        {...card(0)}
        title="Notion"
        detail="Sign in, then choose pages, databases and files."
        icon={<WorkspaceGlyph width={20} height={20} />}
      />
      <SourceCard
        {...card(1)}
        title="Obsidian"
        detail="Copy a vault in, or open it as it is."
        icon={<VaultGlyph width={20} height={20} />}
      />
      <SourceCard
        {...card(2)}
        title="Logseq"
        detail="Copy a graph in: pages, journals and files."
        icon={<OutlineGlyph width={20} height={20} />}
      />
    </div>
  )
}

function ProgressView({
  progress,
  label
}: {
  progress: NotionImportProgress | null
  label: string
}): JSX.Element {
  const fraction = progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : null
  return (
    <div className="flex flex-col gap-3 py-2" role="status" aria-live="polite" data-import-progress>
      <div className="flex items-baseline justify-between gap-3 text-sm text-ink-800">
        <span className="font-medium">{label}</span>
        {progress && progress.total > 0 && (
          <span className="shrink-0 tabular-nums text-xs text-ink-500">
            {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
          </span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-paper-200">
        <div
          className={`h-full rounded-full bg-accent transition-all duration-300 ${fraction === null ? 'w-1/4 animate-pulse' : ''}`}
          style={fraction === null ? undefined : { width: `${Math.max(2, Math.round(fraction * 100))}%` }}
        />
      </div>
      <p className="h-4 truncate text-xs text-ink-500">{progress?.title ?? ''}</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-xl border border-paper-300/60 bg-paper-100/60 px-3 py-2.5">
      <div className="text-lg font-semibold tabular-nums text-ink-900">{value.toLocaleString()}</div>
      <div className="form-label mt-0.5">{label}</div>
    </div>
  )
}

function ResultView({
  result,
  pagesLabel
}: {
  result: NonNullable<NotionImportProgress['result']>
  pagesLabel: string
}): JSX.Element {
  const stats = [
    { label: pagesLabel, value: result.pages },
    { label: 'Journals', value: result.journals ?? 0 },
    { label: 'Databases', value: result.databases },
    { label: 'Rows', value: result.rows },
    { label: 'Files', value: result.files },
    { label: 'Kept as written', value: result.kept ?? 0 }
  ].filter((stat) => stat.value > 0 || stat.label === pagesLabel)
  return (
    <div className="flex flex-col gap-4" data-import-result>
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <CheckIcon width={16} height={16} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900">Imported</div>
          <div className="truncate text-xs text-ink-600">{result.folder}</div>
        </div>
      </div>
      <div className={`grid gap-2 ${stats.length > 2 ? 'grid-cols-4' : 'grid-cols-2'}`}>
        {stats.map((stat) => (
          <Stat key={stat.label} {...stat} />
        ))}
      </div>
      <p className="text-xs leading-5 text-ink-600">
        {result.issues > 0
          ? `The report lists ${plural(result.issues, 'thing')} that came over differently.`
          : 'The report lists what every import changes.'}
      </p>
    </div>
  )
}

function ChoiceSummary({
  name,
  excluded,
  roots,
  onChange
}: {
  name: string
  excluded: Set<string>
  roots: ImportTreeItem[]
  onChange: (next: Set<string>) => void
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <p className="min-w-0 truncate" data-import-summary>
        <span className="font-medium text-ink-900">{name}</span>
        <span className="text-ink-600">
          {' · '}
          {excluded.size === 0 ? 'Everything' : `${plural(excluded.size, 'item')} left out`}
        </span>
      </p>
      <button
        type="button"
        data-import-select-all
        className="shrink-0 text-xs text-ink-500 transition-colors hover:text-ink-900"
        onClick={() => onChange(excluded.size === 0 ? new Set(roots.map((root) => root.id)) : new Set())}
      >
        {excluded.size === 0 ? 'Select none' : 'Select all'}
      </button>
    </div>
  )
}

interface FlowProps {
  renderChrome: (body: JSX.Element, footer: JSX.Element) => JSX.Element
  onClose: () => void
  onOpenNote: (path: string) => void
  onImported: (folder: string) => void
}

function NotionFlow({ renderChrome, onClose, onOpenNote, onImported }: FlowProps): JSX.Element {
  const [status, setStatus] = useState<NotionImportStatus | null>(null)
  const [progress, setProgress] = useState<NotionImportProgress | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [roots, setRoots] = useState<ImportTreeItem[] | null>(null)
  const [loadingRoots, setLoadingRoots] = useState(false)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [signingIn, setSigningIn] = useState(false)
  const [useToken, setUseToken] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [includeTasks, setIncludeTasks] = useState(false)
  const [saving, setSaving] = useState(false)
  const tokenRef = useRef<HTMLInputElement>(null)
  const signInRef = useRef<HTMLButtonElement>(null)

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

  useEffect(() => {
    void refresh().then((next) => {
      if (next && (next.signedIn || next.tokenSet) && !next.running && !next.remote) void loadRoots()
    })
    return window.zen.onNotionImportProgress?.((update) => {
      setProgress(update)
      if (update.phase === 'stopped' || update.phase === 'failed') {
        void refresh().then(() => loadRoots())
      } else if (update.phase === 'done') {
        if (update.result) onImported(update.result.folder)
        void refresh()
      }
    })
  }, [refresh, loadRoots, onImported])

  const connected = !!status && (status.signedIn || status.tokenSet)
  const asksToConnect = !!status && !connected && !status.remote && !status.running
  useEffect(() => {
    if (!asksToConnect) return
    if (useToken) tokenRef.current?.focus()
    else signInRef.current?.focus()
  }, [asksToConnect, useToken])

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

  const signOut = async (): Promise<void> => {
    await window.zen.notionImportSignOut?.()
    setRoots(null)
    setWorkspace('')
    setExcluded(new Set())
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

  const finishClose = (): void => {
    if (progress?.phase === 'done') void window.zen.notionImportDiscard?.()
    if (signingIn) void window.zen.notionImportCancelSignIn?.()
    onClose()
  }

  const errorLine =
    error && progress?.phase !== 'failed' ? (
      <p className="text-sm text-danger" role="alert">
        {error}
      </p>
    ) : null

  if (!status) {
    return renderChrome(<p className="text-sm text-ink-600">Checking…</p>, <Button onClick={finishClose}>Close</Button>)
  }
  if (status.remote) {
    return renderChrome(
      <p className="text-sm text-ink-700">Imports write to a local vault. Switch to one to import from Notion.</p>,
      <Button variant="primary" onClick={finishClose}>
        Close
      </Button>
    )
  }
  if (status.running || isRunning(progress?.phase)) {
    return renderChrome(
      <ProgressView
        progress={progress}
        label={progress?.phase === 'writing' ? 'Writing notes' : progress?.phase === 'reading' ? 'Reading from Notion' : 'Finding pages'}
      />,
      <>
        <Button variant="ghost" onClick={finishClose}>
          Hide
        </Button>
        <Button onClick={() => void window.zen.notionImportStop?.()}>Stop</Button>
      </>
    )
  }
  if (progress?.phase === 'done' && progress.result) {
    const result = progress.result
    return renderChrome(
      <ResultView result={result} pagesLabel="Pages" />,
      <>
        <Button variant="ghost" onClick={finishClose}>
          Close
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            finishClose()
            onOpenNote(result.reportPath)
          }}
        >
          Open report
        </Button>
      </>
    )
  }
  if (!connected) {
    if (useToken) {
      return renderChrome(
        <div className="flex flex-col gap-3 text-sm">
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
            data-import-token
            className="w-full rounded-lg border border-paper-300/70 bg-paper-100/60 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/60"
          />
          {errorLine}
        </div>,
        <>
          <Button variant="ghost" onClick={() => setUseToken(false)}>
            Back
          </Button>
          <Button variant="primary" disabled={!token.trim() || saving} onClick={() => void saveToken()}>
            {saving ? 'Checking' : 'Save token'}
          </Button>
        </>
      )
    }
    return renderChrome(
      <div className="flex flex-col gap-3 text-sm text-ink-700">
        <p>{signingIn ? 'Finish signing in in your browser.' : 'Sign in to choose what to bring over. Nothing is imported until you say so.'}</p>
        {errorLine}
      </div>,
      <>
        <Button variant="ghost" onClick={() => setUseToken(true)} data-import-use-token>
          Use a token
        </Button>
        <Button
          ref={signInRef}
          variant="primary"
          disabled={signingIn}
          onClick={() => void signIn()}
          data-import-sign-in
        >
          {signingIn ? 'Waiting for Notion' : 'Sign in with Notion'}
        </Button>
      </>
    )
  }

  const hasRoots = !!roots && roots.length > 0
  const everythingOut = hasRoots && roots.every((root) => excluded.has(root.id))
  return renderChrome(
    <div className="flex flex-col gap-3 text-sm">
      {loadingRoots && <p className="text-ink-600">Finding your workspace…</p>}
      {roots && roots.length === 0 && !loadingRoots && <p className="text-ink-600">Nothing to import here yet.</p>}
      {hasRoots && (
        <>
          <ChoiceSummary name={workspace} excluded={excluded} roots={roots} onChange={setExcluded} />
          <ImportTree
            roots={roots}
            excluded={excluded}
            onExcludedChange={setExcluded}
            label="What to import"
            onError={setError}
            loadChildren={async (item) => (await window.zen.notionImportTreeChildren?.(item.id)) ?? []}
          />
          <label className="flex items-center gap-2 text-xs text-ink-700">
            <input
              type="checkbox"
              checked={includeTasks}
              onChange={(e) => setIncludeTasks(e.target.checked)}
              className="accent-[rgb(var(--z-accent))]"
            />
            Show imported to-dos in Tasks
          </label>
        </>
      )}
      {status.resumable && <p className="text-xs text-ink-600">An earlier import stopped partway. It can pick up where it was.</p>}
      {progress?.phase === 'failed' && <p className="text-danger">{progress.error}</p>}
      {errorLine}
    </div>,
    <>
      <Button variant="ghost" onClick={() => void signOut()}>
        Sign out
      </Button>
      {status.resumable && <Button onClick={() => void startOver()}>Start over</Button>}
      <Button
        variant="primary"
        disabled={loadingRoots || !hasRoots || everythingOut}
        onClick={() => void start()}
        data-import-start
      >
        {status.resumable ? 'Continue import' : 'Import'}
      </Button>
    </>
  )
}

function ObsidianFlow({ renderChrome, onClose, onOpenNote, onImported }: FlowProps): JSX.Element {
  const [scan, setScan] = useState<ObsidianImportScan | null>(null)
  const [progress, setProgress] = useState<NotionImportProgress | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [includeTasks, setIncludeTasks] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const pickRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void window.zen.obsidianImportStatus?.().then((status) => {
      if (status?.progress) setProgress(status.progress)
    })
    return window.zen.onObsidianImportProgress?.((update) => {
      setProgress(update)
      if (update.phase === 'done' && update.result) onImported(update.result.folder)
    })
  }, [onImported])

  const showingPicker = !scan && !isRunning(progress?.phase) && progress?.phase !== 'done'
  useEffect(() => {
    if (showingPicker) pickRef.current?.focus()
  }, [showingPicker])

  const pick = async (): Promise<void> => {
    setPicking(true)
    setError(null)
    try {
      const answer = (await window.zen.obsidianImportPick?.()) ?? null
      if (answer) {
        setScan(answer)
        setExcluded(new Set())
      }
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setPicking(false)
    }
  }

  const start = async (): Promise<void> => {
    setError(null)
    setProgress({ phase: 'finding', done: 0, total: 0 })
    try {
      await window.zen.obsidianImportStart?.({ includeTasks, excluded: [...excluded] })
    } catch (err) {
      setProgress(null)
      setError(cleanError(err))
    }
  }

  const openDirectly = async (): Promise<void> => {
    if (!scan) return
    onClose()
    await useStore.getState().openLocalVault(scan.path)
  }

  const finishClose = (): void => {
    if (progress?.phase === 'done') void window.zen.obsidianImportDismiss?.()
    onClose()
  }

  const errorLine = error ? (
    <p className="text-sm text-danger" role="alert">
      {error}
    </p>
  ) : null

  if (isRunning(progress?.phase)) {
    return renderChrome(
      <ProgressView progress={progress} label="Copying your vault" />,
      <>
        <Button variant="ghost" onClick={finishClose}>
          Hide
        </Button>
        <Button onClick={() => void window.zen.obsidianImportStop?.()}>Stop</Button>
      </>
    )
  }
  if (progress?.phase === 'done' && progress.result) {
    const result = progress.result
    return renderChrome(
      <ResultView result={result} pagesLabel="Notes" />,
      <>
        <Button variant="ghost" onClick={finishClose}>
          Close
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            finishClose()
            onOpenNote(result.reportPath)
          }}
        >
          Open report
        </Button>
      </>
    )
  }
  if (!scan) {
    return renderChrome(
      <div className="flex flex-col gap-3 text-sm text-ink-700">
        <p>Choose the folder that holds your vault. It isn&apos;t changed by importing.</p>
        {progress?.phase === 'failed' && <p className="text-danger">{progress.error}</p>}
        {errorLine}
      </div>,
      <Button ref={pickRef} variant="primary" disabled={picking} onClick={() => void pick()} data-import-pick>
        {picking ? 'Choosing' : 'Choose vault folder'}
      </Button>
    )
  }

  const roots: ImportTreeItem[] = scan.tree.map(function toItem(item): ImportTreeItem {
    const counts = [
      item.noteCount ? plural(item.noteCount, 'note') : '',
      !item.noteCount && item.fileCount ? plural(item.fileCount, 'file') : ''
    ].filter(Boolean)
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      detail: counts.join(', ') || undefined,
      children: item.kind === 'folder' ? (item.children ?? []).map(toItem) : undefined
    }
  })
  const everythingOut = roots.length > 0 && roots.every((root) => excluded.has(root.id))
  return renderChrome(
    <div className="flex flex-col gap-3 text-sm">
      {!scan.isObsidian && (
        <p className="text-xs text-ink-600" data-import-not-obsidian>
          This folder has no <code>.obsidian</code> settings. It can still be copied in.
        </p>
      )}
      <ChoiceSummary name={scan.name} excluded={excluded} roots={roots} onChange={setExcluded} />
      <ImportTree roots={roots} excluded={excluded} onExcludedChange={setExcluded} label="What to import" />
      <p className="text-xs text-ink-500" data-import-counts>
        {plural(scan.notes, 'note')} and {plural(scan.files, 'file')}. Images a kept note uses come along even from a
        folder you untick.
      </p>
      <label className="flex items-center gap-2 text-xs text-ink-700">
        <input
          type="checkbox"
          checked={includeTasks}
          onChange={(e) => setIncludeTasks(e.target.checked)}
          className="accent-[rgb(var(--z-accent))]"
        />
        Show imported to-dos in Tasks
      </label>
      {progress?.phase === 'failed' && <p className="text-danger">{progress.error}</p>}
      {errorLine}
    </div>,
    <>
      <Button variant="ghost" onClick={() => void pick()}>
        Other folder
      </Button>
      <Button onClick={() => void openDirectly()} data-import-open-directly>
        Open as its own vault
      </Button>
      <Button
        variant="primary"
        disabled={roots.length === 0 || everythingOut}
        onClick={() => void start()}
        data-import-start
      >
        Copy in
      </Button>
    </>
  )
}

function LogseqFlow({ renderChrome, onClose, onOpenNote, onImported }: FlowProps): JSX.Element {
  const dailyDirectory = useStore((s) => s.vaultSettings.dailyNotes.directory)
  const [scan, setScan] = useState<LogseqImportScan | null>(null)
  const [progress, setProgress] = useState<NotionImportProgress | null>(null)
  const [folder, setFolder] = useState('Logseq')
  const [journalsToDaily, setJournalsToDaily] = useState(true)
  const [bullets, setBullets] = useState(false)
  const [includeTasks, setIncludeTasks] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const pickRef = useRef<HTMLButtonElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.zen.logseqImportStatus?.().then((status) => {
      if (status?.progress) setProgress(status.progress)
    })
    return window.zen.onLogseqImportProgress?.((update) => {
      setProgress(update)
      if (update.phase === 'done' && update.result) onImported(update.result.folder)
    })
  }, [onImported])

  const showingPicker = !scan && !isRunning(progress?.phase) && progress?.phase !== 'done'
  useEffect(() => {
    if (showingPicker) pickRef.current?.focus()
  }, [showingPicker])
  const showingOptions = !!scan && !isRunning(progress?.phase) && progress?.phase !== 'done'
  useEffect(() => {
    if (showingOptions) folderRef.current?.focus()
  }, [showingOptions])

  const pick = async (): Promise<void> => {
    setPicking(true)
    setError(null)
    try {
      const answer = (await window.zen.logseqImportPick?.()) ?? null
      if (answer) setScan(answer)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setPicking(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!scan || !folder.trim()) return
    setError(null)
    // Where each journal's daily note goes, by this vault's own settings, and
    // whether that day has one already. Main checks every path again.
    let dailyNotes: Record<string, LogseqDailyNotePlace> | undefined
    if (journalsToDaily && scan.journalDates.length > 0) {
      const { vaultSettings, notes } = useStore.getState()
      dailyNotes = {}
      for (const iso of scan.journalDates) {
        const [year, month, day] = iso.split('-').map(Number)
        const date = new Date(year, month - 1, day)
        const { subpath, title } = dailyNoteLocationForDate(date, vaultSettings)
        dailyNotes[iso] = { subpath, title, exists: !!findDailyNoteForDate(notes, vaultSettings, date) }
      }
    }
    setProgress({ phase: 'finding', done: 0, total: 0 })
    try {
      await window.zen.logseqImportStart?.({ folder: folder.trim(), dailyNotes, bullets, includeTasks })
    } catch (err) {
      setProgress(null)
      setError(cleanError(err))
    }
  }

  const finishClose = (): void => {
    if (progress?.phase === 'done') void window.zen.logseqImportDismiss?.()
    onClose()
  }

  const errorLine = error ? (
    <p className="text-sm text-danger" role="alert">
      {error}
    </p>
  ) : null

  if (isRunning(progress?.phase)) {
    return renderChrome(
      <ProgressView progress={progress} label={progress?.phase === 'writing' ? 'Writing notes' : 'Reading your graph'} />,
      <>
        <Button variant="ghost" onClick={finishClose}>
          Hide
        </Button>
        <Button onClick={() => void window.zen.logseqImportStop?.()}>Stop</Button>
      </>
    )
  }
  if (progress?.phase === 'done' && progress.result) {
    const result = progress.result
    return renderChrome(
      <ResultView result={result} pagesLabel="Pages" />,
      <>
        <Button variant="ghost" onClick={finishClose}>
          Close
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            finishClose()
            onOpenNote(result.reportPath)
          }}
        >
          Open report
        </Button>
      </>
    )
  }
  if (!scan) {
    return renderChrome(
      <div className="flex flex-col gap-3 text-sm text-ink-700">
        <p>Choose the folder that holds your graph, the one with pages and journals in it. It isn&apos;t changed by importing.</p>
        {progress?.phase === 'failed' && <p className="text-danger">{progress.error}</p>}
        {errorLine}
      </div>,
      <Button ref={pickRef} variant="primary" disabled={picking} onClick={() => void pick()} data-import-pick>
        {picking ? 'Choosing' : 'Choose graph folder'}
      </Button>
    )
  }

  const counts = [
    plural(scan.pages + scan.orgPages, 'page'),
    plural(scan.journals, 'journal'),
    plural(scan.files, 'file')
  ].join(', ')
  return renderChrome(
    <div className="flex flex-col gap-3 text-sm">
      <p className="min-w-0 truncate" data-import-summary>
        <span className="font-medium text-ink-900">{scan.name}</span>
        <span className="text-ink-600">
          {' · '}
          {counts}
        </span>
      </p>
      {!scan.isLogseq && (
        <p className="text-xs text-ink-600" data-import-not-logseq>
          This folder has no <code>logseq/config.edn</code>, so Logseq&apos;s default formats are used.
        </p>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="form-label">Import into</span>
        <input
          ref={folderRef}
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && folder.trim()) {
              e.preventDefault()
              void start()
            }
          }}
          aria-label="Folder to import into"
          spellCheck={false}
          data-import-folder
          className="w-full rounded-lg border border-paper-300/70 bg-paper-100/60 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/60"
        />
        <span className="text-xs text-ink-500">A new folder in your notes. If the name is taken, it gets a number.</span>
      </label>
      {scan.journals > 0 && (
        <label className="flex items-center gap-2 text-xs text-ink-700">
          <input
            type="checkbox"
            checked={journalsToDaily}
            onChange={(e) => setJournalsToDaily(e.target.checked)}
            className="accent-[rgb(var(--z-accent))]"
            data-import-journals-daily
          />
          Make journals daily notes, in {dailyDirectory || 'your notes'}
        </label>
      )}
      <label className="flex items-center gap-2 text-xs text-ink-700">
        <input
          type="checkbox"
          checked={bullets}
          onChange={(e) => setBullets(e.target.checked)}
          className="accent-[rgb(var(--z-accent))]"
          data-import-bullets
        />
        Keep every block a bullet
      </label>
      <label className="flex items-center gap-2 text-xs text-ink-700">
        <input
          type="checkbox"
          checked={includeTasks}
          onChange={(e) => setIncludeTasks(e.target.checked)}
          className="accent-[rgb(var(--z-accent))]"
        />
        Show imported to-dos in Tasks
      </label>
      {progress?.phase === 'failed' && <p className="text-danger">{progress.error}</p>}
      {errorLine}
    </div>,
    <>
      <Button variant="ghost" onClick={() => void pick()}>
        Other folder
      </Button>
      <Button variant="primary" disabled={!folder.trim()} onClick={() => void start()} data-import-start>
        Import
      </Button>
    </>
  )
}

/**
 * The one window for bringing notes in, from the palette, the keyboard or
 * onboarding. It opens on the sources, or straight on one when asked for
 * it by name.
 */
export function ImportModal(): JSX.Element {
  const dialog = useStore((s) => s.importDialog)
  const setImportDialog = useStore((s) => s.setImportDialog)
  const setLastImportFolder = useStore((s) => s.setLastImportFolder)
  const selectNote = useStore((s) => s.selectNote)

  const close = useCallback(() => setImportDialog(null), [setImportDialog])
  const onImported = useCallback((folder: string) => setLastImportFolder(folder), [setLastImportFolder])
  const onOpenNote = useCallback((path: string) => void selectNote(path), [selectNote])
  const back = useCallback(() => setImportDialog('choose'), [setImportDialog])

  const title =
    dialog === 'notion'
      ? 'Import from Notion'
      : dialog === 'obsidian'
        ? 'Import from Obsidian'
        : dialog === 'logseq'
          ? 'Import from Logseq'
          : 'Import your notes'

  const renderChrome = (body: JSX.Element, footer: JSX.Element): JSX.Element => (
    <>
      <Modal.Body>{body}</Modal.Body>
      <Modal.Footer className="items-center">{footer}</Modal.Footer>
    </>
  )

  return (
    <Modal
      size="lg"
      layer="modal"
      onClose={close}
      closeOnBackdrop={false}
      data={{ 'data-import-dialog': dialog ?? 'choose' }}
    >
      <Modal.Header title={<Heading title={title} onBack={dialog === 'choose' ? undefined : back} />} />
      {dialog === 'notion' ? (
        <NotionFlow renderChrome={renderChrome} onClose={close} onOpenNote={onOpenNote} onImported={onImported} />
      ) : dialog === 'obsidian' ? (
        <ObsidianFlow renderChrome={renderChrome} onClose={close} onOpenNote={onOpenNote} onImported={onImported} />
      ) : dialog === 'logseq' ? (
        <LogseqFlow renderChrome={renderChrome} onClose={close} onOpenNote={onOpenNote} onImported={onImported} />
      ) : (
        <Modal.Body>
          <ChooseSource onChoose={(source) => setImportDialog(source)} />
        </Modal.Body>
      )}
    </Modal>
  )
}
