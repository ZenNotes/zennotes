import { execFile } from 'node:child_process'
import { getRemoteWorkspaceSecret, setRemoteWorkspaceSecret } from './secret-store'
import { loadConfig, updateConfig } from './vault'
import type { PersistedConfig } from './vault'
import type { GithubConfig, GithubSyncResult } from '@shared/ipc'

const GIT_BRANCH = 'main'
const GITHUB_PAT_KEY = 'github-pat'

function readGithubRepo(cfg: PersistedConfig): string | null {
  return cfg.githubRepo?.trim() || null
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile('git', args, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr.trim() || err.message
        reject(new Error(message))
        return
      }
      resolve(stdout.trim())
    })
    child.on('error', (err) => reject(new Error(`Failed to spawn git: ${err.message}`)))
  })
}

async function checkGit(): Promise<string | null> {
  try {
    await runGit(['--version'], '/')
    return null
  } catch {
    return 'Git is not installed. Install git and restart ZenNotes.'
  }
}

async function ensureGitRepo(vaultRoot: string): Promise<void> {
  try {
    await runGit(['rev-parse', '--git-dir'], vaultRoot)
  } catch {
    await runGit(['init'], vaultRoot)
  }
}

async function setupRemote(vaultRoot: string, repo: string, pat: string): Promise<void> {
  const authUrl = `https://${pat}:x-oauth-basic@github.com/${repo}.git`
  try {
    const currentRemote = await runGit(['remote', 'get-url', 'origin'], vaultRoot)
    if (currentRemote !== authUrl) {
      await runGit(['remote', 'set-url', 'origin', authUrl], vaultRoot)
    }
  } catch {
    await runGit(['remote', 'add', 'origin', authUrl], vaultRoot)
  }
}

function parseMergeConflictStderr(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/)
  const conflictLines = lines.filter(
    (l) => l.includes('CONFLICT') || l.includes('merge conflict') || l.includes('Merge conflict')
  )
  if (conflictLines.length === 0) return null
  return conflictLines.join('; ')
}

async function prepareRepo(vaultRoot: string, pat: string, repo: string): Promise<string | null> {
  const gitMissing = await checkGit()
  if (gitMissing) return gitMissing
  await ensureGitRepo(vaultRoot)
  await runGit(['checkout', '-B', GIT_BRANCH], vaultRoot).catch(() => {})
  await setupRemote(vaultRoot, repo, pat)
  return null
}

async function pullRemote(vaultRoot: string): Promise<string | null> {
  try {
    const remoteOutput = await runGit(['ls-remote', '--heads', 'origin', GIT_BRANCH], vaultRoot)
    if (remoteOutput) {
      try {
        await runGit(['pull', 'origin', GIT_BRANCH, '--rebase', '--autostash'], vaultRoot)
      } catch (pullErr) {
        const stderr = pullErr instanceof Error ? pullErr.message : String(pullErr)
        const conflict = parseMergeConflictStderr(stderr)
        if (conflict) {
          await runGit(['merge', '--abort'], vaultRoot).catch(() => { })
          return `Merge conflict detected: ${conflict}. Resolve manually via git, then retry sync.`
        }
        throw pullErr
      }
    }
    return null
  } catch (err) {
    if (err instanceof Error && err.message.includes('Could not read from remote repository')) {
      return 'Cannot reach GitHub. Check your repo name and internet connection.'
    }
    throw err
  }
}

async function hasLocalChanges(vaultRoot: string): Promise<boolean> {
  const status = await runGit(['status', '--porcelain'], vaultRoot)
  return status.length > 0
}

async function stageAndCommit(vaultRoot: string): Promise<void> {
  await runGit(['add', '-A'], vaultRoot)
  const timestamp = new Date().toISOString()
  await runGit(['commit', '-m', `zennotes-sync ${timestamp}`], vaultRoot)
}

async function pushLocal(vaultRoot: string): Promise<string | null> {
  try {
    await runGit(['push', 'origin', GIT_BRANCH], vaultRoot)
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('rejected') && message.includes('non-fast-forward')) {
      return 'Remote has changes you don\'t have locally. Pull remote changes first, then retry sync.'
    }
    if (message.includes('Connection refused') || message.includes('Could not read from remote')) {
      return 'Cannot reach GitHub. Check your internet connection.'
    }
    return `Push failed: ${message}`
  }
}

export async function listRepos(pat: string): Promise<string[]> {
  const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=created', {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ZenNotes',
      'Cache-Control': 'no-cache'
    }
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitHub API error (${response.status}): ${body}`)
  }
  const repos = (await response.json()) as Array<{ full_name: string; created_at: string }>
  repos.sort((a, b) => b.created_at.localeCompare(a.created_at))
  return repos.map((r) => r.full_name)
}

export async function sync(vaultRoot: string, pat: string, repo: string): Promise<GithubSyncResult> {
  try {
    const prepErr = await prepareRepo(vaultRoot, pat, repo)
    if (prepErr) return { ok: false, error: prepErr }

    const pullErr = await pullRemote(vaultRoot)
    if (pullErr) return { ok: false, error: pullErr }

    if (!(await hasLocalChanges(vaultRoot))) {
      return { ok: true, message: 'No local changes to sync.' }
    }

    await stageAndCommit(vaultRoot)
    const pushErr = await pushLocal(vaultRoot)
    if (pushErr) return { ok: false, error: pushErr }

    return { ok: true, message: 'Notes synced successfully.' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

export async function handleGetConfig(): Promise<GithubConfig> {
  const pat = await getRemoteWorkspaceSecret(GITHUB_PAT_KEY)
  const repo = readGithubRepo(await loadConfig())
  return { pat, repo }
}

export async function handleSetConfig(config: GithubConfig): Promise<void> {
  await setRemoteWorkspaceSecret(GITHUB_PAT_KEY, config.pat)
  await updateConfig((cfg) => ({
    ...cfg,
    githubRepo: config.repo ?? null
  }))
}

export async function handleListRepos(): Promise<string[]> {
  const pat = await getRemoteWorkspaceSecret(GITHUB_PAT_KEY)
  if (!pat) return []
  try {
    return await listRepos(pat)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('401')) {
      throw new Error('Invalid token. Check your PAT permissions.')
    }
    if (msg.includes('403')) {
      throw new Error('Token does not have permission to list repositories.')
    }
    if (
      msg.includes('fetch failed') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ENETUNREACH') ||
      msg.includes('ETIMEDOUT')
    ) {
      throw new Error('Cannot reach GitHub. Check your internet connection.')
    }
    throw new Error('GitHub returned an error. Try again.')
  }
}

export async function handleSync(vaultRoot: string): Promise<GithubSyncResult> {
  const pat = await getRemoteWorkspaceSecret(GITHUB_PAT_KEY)
  if (!pat) return { ok: false, error: 'GitHub PAT not configured.' }
  const repo = readGithubRepo(await loadConfig())
  if (!repo) return { ok: false, error: 'GitHub repo not configured.' }
  return await sync(vaultRoot, pat, repo)
}
