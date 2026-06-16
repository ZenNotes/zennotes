import { useCallback, useEffect, useState } from 'react'

export function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const idx = msg.indexOf("': ")
  if (idx !== -1) return msg.slice(idx + 3)
  return msg
}

export interface UseGithubConfigReturn {
  pat: string
  setPat: (pat: string) => void
  repo: string
  setRepo: (repo: string) => void
  repos: string[]
  fetchingRepos: boolean
  fetchRepos: () => Promise<void>
  searchQuery: string
  setSearchQuery: (query: string) => void
  repoError: string
  loading: boolean
  clearConfig: () => Promise<void>
}

export function useGithubConfig(): UseGithubConfigReturn {
  const [pat, setPat] = useState('')
  const [repo, setRepo] = useState('')
  const [repos, setRepos] = useState<string[]>([])
  const [fetchingRepos, setFetchingRepos] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [repoError, setRepoError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.zen.getGithubConfig().then((cfg) => {
      if (cfg.pat) setPat(cfg.pat)
      if (cfg.repo) setRepo(cfg.repo)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const fetchRepos = useCallback(async () => {
    if (!pat.trim()) return
    setFetchingRepos(true)
    setRepoError('')
    setSearchQuery('')
    try {
      await window.zen.setGithubConfig({ pat: pat.trim(), repo: null })
      const list = await window.zen.listGithubRepos()
      if (list.length === 0) {
        setRepoError('No repos found. Check your PAT permissions.')
      }
      setRepos(list)
    } catch (err) {
      setRepoError(cleanError(err))
      setRepos([])
    } finally {
      setFetchingRepos(false)
    }
  }, [pat])

  const clearConfig = useCallback(async () => {
    setPat('')
    setRepo('')
    setRepos([])
    setSearchQuery('')
    setRepoError('')
    await window.zen.setGithubConfig({ pat: null, repo: null })
  }, [])

  return {
    pat, setPat,
    repo, setRepo,
    repos,
    fetchingRepos,
    fetchRepos,
    searchQuery, setSearchQuery,
    repoError,
    loading,
    clearConfig
  }
}
