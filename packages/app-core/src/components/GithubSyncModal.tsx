import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Spinner } from './ui/Spinner'
import { GithubConfigPanel } from './GithubConfigPanel'
import { useGithubConfig, cleanError } from '../lib/use-github-config'

type View = 'config' | 'syncing' | 'result'

interface SyncStatus {
  message: string
  error?: string
}

const AUTO_CLOSE_DELAY_MS = 2_000

export function GithubSyncModal({ onClose }: { onClose: () => void }): JSX.Element {
  const {
    pat, setPat,
    repo, setRepo,
    repos,
    fetchingRepos, fetchRepos,
    searchQuery, setSearchQuery,
    repoError,
    loading,
  } = useGithubConfig()

  const [view, setView] = useState<View>('config')
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function scheduleAutoClose(): void {
    autoCloseTimer.current = setTimeout(() => {
      onClose()
    }, AUTO_CLOSE_DELAY_MS)
  }

  useEffect(() => {
    return () => {
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current)
    }
  }, [])

  useEffect(() => {
    if (pat && repo && !loading) {
      setView('syncing')
      syncWithGithub()
    }
  }, [loading])

  async function syncWithGithub(): Promise<void> {
    setStatus(null)
    try {
      const result = await window.zen.syncWithGithub()
      setStatus({ message: result.ok ? result.message : '', error: result.ok ? undefined : result.error })
      setView('result')
      if (result.ok) scheduleAutoClose()
    } catch (err) {
      setStatus({ message: '', error: cleanError(err) })
      setView('result')
    }
  }

  const saveConfig = useCallback(async () => {
    if (!pat.trim() || !repo.trim()) return
    setSaving(true)
    try {
      await window.zen.setGithubConfig({ pat: pat.trim(), repo: repo.trim() })
      setView('syncing')
      await syncWithGithub()
    } catch (err) {
      setStatus({ message: '', error: cleanError(err) })
      setView('result')
    } finally {
      setSaving(false)
    }
  }, [pat, repo])

  return (
    <Modal size="sm" onClose={onClose} labelledBy="github-sync-title">
      <Modal.Header>
        <div id="github-sync-title" className="text-sm font-semibold text-ink-900">
          Sync with GitHub
        </div>
        <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-500">
          {view === 'config'
            ? 'Configure your GitHub personal access token and repository to sync your notes.'
            : view === 'syncing'
              ? 'Syncing notes with GitHub...'
              : status?.error
                ? status.error
                : status?.message ?? ''}
        </div>
      </Modal.Header>

      <Modal.Body>
        {view === 'config' && (
          <GithubConfigPanel
            pat={pat}
            onPatChange={setPat}
            repo={repo}
            onRepoChange={setRepo}
            repos={repos}
            fetchingRepos={fetchingRepos}
            onFetchRepos={fetchRepos}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            repoError={repoError}
          />
        )}

        {view === 'syncing' && <Spinner />}

        {view === 'result' && (
          <div className="space-y-3">
            {(status?.error || status?.message) && (
              <div
                className={`rounded-lg border px-3 py-2 text-sm ${status.error
                  ? 'border-danger/30 bg-danger/10 text-danger'
                  : 'border-green-400/30 bg-green-50 text-green-800'
                  }`}
              >
                {status.error || status.message}
              </div>
            )}
            <div className="rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-600">
              Repo: <span className="font-medium text-ink-900">{repo}</span>
            </div>
          </div>
        )}
      </Modal.Body>

      {view !== 'syncing' && (
        <Modal.Footer>
          {view === 'config' && (
            <>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!pat.trim() || !repo.trim() || saving}
                onClick={saveConfig}
              >
                {saving ? 'Saving...' : 'Save & Sync'}
              </Button>
            </>
          )}

          {view === 'result' && (
            <>
              {status?.error && (
                <Button variant="primary" onClick={() => { setView('syncing'); syncWithGithub() }}>
                  Retry
                </Button>
              )}
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </>
          )}
        </Modal.Footer>

      )}
    </Modal>
  )
}
