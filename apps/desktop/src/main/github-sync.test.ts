import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))
vi.mock('./secret-store', () => ({
  getRemoteWorkspaceSecret: vi.fn().mockResolvedValue(null),
  setRemoteWorkspaceSecret: vi.fn().mockResolvedValue(true)
}))
vi.mock('./vault', () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
  updateConfig: vi.fn().mockImplementation(async (fn: (cfg: any) => any) => fn({}))
}))

import { execFile } from 'node:child_process'

const mockExecOnce = (stdout: string, stderr = ''): void => {
  vi.mocked(execFile).mockImplementationOnce((_cmd, _args, _opts, cb) => {
    if (cb) cb(null, stdout, stderr)
    return {} as ReturnType<typeof execFile>
  })
}

const mockExecErrorOnce = (msg: string): void => {
  vi.mocked(execFile).mockImplementationOnce((_cmd, _args, _opts, cb) => {
    if (cb) cb(new Error(msg), '', msg)
    return {} as ReturnType<typeof execFile>
  })
}

describe('github-sync', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('listRepos', () => {
    it('fetches repos from GitHub API, sorted by creation date', async () => {
      const mockResponse = [
        { full_name: 'user/repo1', created_at: '2024-01-01T00:00:00Z' },
        { full_name: 'user/repo2', created_at: '2025-06-01T00:00:00Z' }
      ]
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      }))

      const { listRepos } = await import('./github-sync')
      const repos = await listRepos('ghp_token')
      expect(repos).toEqual(['user/repo2', 'user/repo1'])
    })

    it('throws on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Bad credentials')
      }))

      const { listRepos } = await import('./github-sync')
      await expect(listRepos('bad_token')).rejects.toThrow('GitHub API error')
    })
  })

  describe('sync', () => {
    it('returns error when git is missing', async () => {
      mockExecErrorOnce('command not found: git')
      const { sync } = await import('./github-sync')
      const result = await sync('/some/vault', 'ghp_token', 'user/repo')
      expect(result.ok).toBe(false)
      expect((result as any).error).toContain('Git is not installed')
    })

    it('returns merge conflict error on pull conflict', async () => {
      mockExecOnce('git version 2.40.0')
      mockExecOnce('.git')
      mockExecOnce('')
      mockExecOnce('https://ghp_token:x-oauth-basic@github.com/user/repo.git')
      mockExecOnce('refs/heads/main')
      mockExecErrorOnce(
        'Auto-merging notes/note.md\nCONFLICT (content): Merge conflict in notes/note.md\nAutomatic merge failed'
      )

      const { sync } = await import('./github-sync')
      const result = await sync('/some/vault', 'ghp_token', 'user/repo')
      expect(result.ok).toBe(false)
      expect((result as any).error).toContain('Merge conflict')
    })

    it('returns no-local-changes when git status --porcelain is empty', async () => {
      mockExecOnce('git version 2.40.0')
      mockExecOnce('.git')
      mockExecOnce('')
      mockExecOnce('https://ghp_token:x-oauth-basic@github.com/user/repo.git')
      mockExecOnce('refs/heads/main')
      mockExecOnce('Already up to date.')
      mockExecOnce('')

      const { sync } = await import('./github-sync')
      const result = await sync('/some/vault', 'ghp_token', 'user/repo')
      expect(result.ok).toBe(true)
      expect((result as any).message).toContain('No local changes')
    })

    it('succeeds when there are local changes', async () => {
      mockExecOnce('git version 2.40.0')
      mockExecOnce('.git')
      mockExecOnce('')
      mockExecOnce('https://ghp_token:x-oauth-basic@github.com/user/repo.git')
      mockExecOnce('refs/heads/main')
      mockExecOnce('Already up to date.')
      mockExecOnce('M note.md')
      mockExecOnce('')
      mockExecOnce('')
      mockExecOnce('Everything up-to-date')

      const { sync } = await import('./github-sync')
      const result = await sync('/some/vault', 'ghp_token', 'user/repo')
      expect(result.ok).toBe(true)
      expect((result as any).message).toBe('Notes synced successfully.')
    })

    it('returns error when ls-remote fails with Could not read from remote', async () => {
      mockExecOnce('git version 2.40.0')
      mockExecOnce('.git')
      mockExecOnce('')
      mockExecOnce('https://ghp_token:x-oauth-basic@github.com/user/repo.git')
      mockExecErrorOnce('Could not read from remote repository')

      const { sync } = await import('./github-sync')
      const result = await sync('/some/vault', 'ghp_token', 'user/repo')
      expect(result.ok).toBe(false)
      expect((result as any).error).toBe('Cannot reach GitHub. Check your repo name and internet connection.')
    })

    it('throws on non-conflict pull failure', async () => {
      mockExecOnce('git version 2.40.0')
      mockExecOnce('.git')
      mockExecOnce('')
      mockExecOnce('https://ghp_token:x-oauth-basic@github.com/user/repo.git')
      mockExecOnce('refs/heads/main')
      mockExecErrorOnce('Something went wrong during pull')

      const { sync } = await import('./github-sync')
      const result = await sync('/some/vault', 'ghp_token', 'user/repo')
      expect(result.ok).toBe(false)
      expect((result as any).error).toBe('Something went wrong during pull')
    })

    it('returns error on non-fast-forward push rejection', async () => {
      mockExecOnce('git version 2.40.0')
      mockExecOnce('.git')
      mockExecOnce('')
      mockExecOnce('https://ghp_token:x-oauth-basic@github.com/user/repo.git')
      mockExecOnce('refs/heads/main')
      mockExecOnce('Already up to date.')
      mockExecOnce('M note.md')
      mockExecOnce('')
      mockExecOnce('')
      mockExecErrorOnce('rejected: non-fast-forward')

      const { sync } = await import('./github-sync')
      const result = await sync('/some/vault', 'ghp_token', 'user/repo')
      expect(result.ok).toBe(false)
      expect((result as any).error).toContain('Pull remote changes first')
    })

    it('returns error on push connection failure', async () => {
      mockExecOnce('git version 2.40.0')
      mockExecOnce('.git')
      mockExecOnce('')
      mockExecOnce('https://ghp_token:x-oauth-basic@github.com/user/repo.git')
      mockExecOnce('refs/heads/main')
      mockExecOnce('Already up to date.')
      mockExecOnce('M note.md')
      mockExecOnce('')
      mockExecOnce('')
      mockExecErrorOnce('Connection refused')

      const { sync } = await import('./github-sync')
      const result = await sync('/some/vault', 'ghp_token', 'user/repo')
      expect(result.ok).toBe(false)
      expect((result as any).error).toContain('Cannot reach GitHub')
    })
  })

  describe('handleSync', () => {
    it('returns error when PAT is missing', async () => {
      const { handleSync } = await import('./github-sync')
      const result = await handleSync('/some/vault')
      expect(result.ok).toBe(false)
      expect((result as any).error).toBe('GitHub PAT not configured.')
    })

    it('returns error when repo is missing', async () => {
      const secretStore = await import('./secret-store')
      vi.mocked(secretStore.getRemoteWorkspaceSecret).mockResolvedValueOnce('ghp_token')
      const { handleSync } = await import('./github-sync')
      const result = await handleSync('/some/vault')
      expect(result.ok).toBe(false)
      expect((result as any).error).toBe('GitHub repo not configured.')
    })
  })
})
