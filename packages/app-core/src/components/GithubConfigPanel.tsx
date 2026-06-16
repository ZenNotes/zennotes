import { Button } from './ui/Button'

interface GithubConfigPanelProps {
  pat: string
  onPatChange: (pat: string) => void
  repo: string
  onRepoChange: (repo: string) => void
  repos: string[]
  fetchingRepos: boolean
  onFetchRepos: () => void
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  repoError: string
}

export function GithubConfigPanel({
  pat,
  onPatChange,
  repo,
  onRepoChange,
  repos,
  fetchingRepos,
  onFetchRepos,
  searchQuery,
  onSearchQueryChange,
  repoError
}: GithubConfigPanelProps): JSX.Element {
  return (
    <div className="space-y-4">
      {repo && (
        <div className="rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-600">
          Selected repo: <span className="font-medium text-ink-900">{repo}</span>
        </div>
      )}
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-700">
          Personal Access Token
        </label>
        <input
          type="password"
          value={pat}
          onChange={(e) => onPatChange(e.target.value)}
          placeholder="ghp_..."
          className="w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:ring-2 focus:ring-accent/50"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-700">
          Repository
        </label>
        <Button
          variant="secondary"
          size="sm"
          disabled={!pat.trim() || fetchingRepos}
          onClick={onFetchRepos}
        >
          {fetchingRepos ? 'Loading...' : 'Fetch repos'}
        </Button>
        {repos.length > 0 && (
          <div className="mt-2 space-y-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              placeholder="Search repos..."
              className="w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:ring-2 focus:ring-accent/50"
            />
            <div className="max-h-48 overflow-y-auto rounded-lg border border-paper-300">
              {repos
                .filter((r) =>
                  r.toLowerCase().includes(searchQuery.toLowerCase())
                )
                .map((r) => (
                  <div
                    key={r}
                    className={`cursor-pointer border-b border-paper-200 px-3 py-2 text-sm last:border-b-0 ${
                      repo === r
                        ? 'bg-accent/10 font-medium text-accent'
                        : 'text-ink-900 hover:bg-paper-100'
                    }`}
                    onClick={() => onRepoChange(r)}
                  >
                    {r}
                  </div>
                ))}
              {repos.filter((r) =>
                r.toLowerCase().includes(searchQuery.toLowerCase())
              ).length === 0 && (
                <div className="px-3 py-2 text-sm text-ink-400">
                  No repos match &quot;{searchQuery}&quot;
                </div>
              )}
            </div>
          </div>
        )}
        {repoError && <p className="mt-1 text-xs text-danger">{repoError}</p>}
      </div>
    </div>
  )
}
