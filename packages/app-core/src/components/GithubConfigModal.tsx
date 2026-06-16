import { useCallback, useState } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Spinner } from './ui/Spinner'
import { GithubConfigPanel } from './GithubConfigPanel'
import { useGithubConfig } from '../lib/use-github-config'

export function GithubConfigModal({ onClose }: { onClose: () => void }): JSX.Element {
  const {
    pat, setPat,
    repo, setRepo,
    repos,
    fetchingRepos, fetchRepos,
    searchQuery, setSearchQuery,
    repoError,
    loading
  } = useGithubConfig()

  const [confirming, setConfirming] = useState(false)

  const confirmChanges = useCallback(async () => {
    if (!pat.trim() || !repo.trim()) return
    setConfirming(true)
    try {
      await window.zen.setGithubConfig({ pat: pat.trim(), repo: repo.trim() })
      onClose()
    } catch (err) {
      setConfirming(false)
      /* repoError is managed by the hook; the fetch-repos path already handles it */
    }
  }, [pat, repo, onClose])

  return (
    <Modal size="sm" onClose={onClose} labelledBy="github-config-title">
      <Modal.Header>
        <div id="github-config-title" className="text-sm font-semibold text-ink-900">
          Configure GitHub Sync
        </div>
        <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-500">
          Update your GitHub personal access token and repository for syncing notes.
        </div>
      </Modal.Header>

      <Modal.Body>
        {loading ? (
          <Spinner />
        ) : (
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
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!pat.trim() || !repo.trim() || confirming}
          onClick={confirmChanges}
        >
          {confirming ? 'Saving...' : 'Confirm changes'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
