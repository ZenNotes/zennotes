import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')

// One lock serializes every process that produces the web bundle: the vite
// build that fills apps/web/dist (it empties the directory first, so a reader
// can otherwise stage a half-written tree), the artifact packer that reads it,
// and the sync that moves that tree into an external server checkout's
// web/dist (which briefly has no dist/ at all, and `go:embed all:dist` cannot
// compile in that window). It lives next to the tree it guards so a leftover
// lock is easy to spot and delete by hand.
export const WEB_DIST_LOCK_DIR = resolve(repoRoot, 'apps/web/.web-dist.lock')
const OWNER_FILE = resolve(WEB_DIST_LOCK_DIR, 'owner.json')
// Only an ownerless lock can expire by age. A cold Go build may legitimately
// hold the lock much longer while the compiler reads embedded browser assets.
const STALE_MS = 10 * 60 * 1000
const POLL_MS = 50
// Handed to child processes so a locked script that shells out to another
// locked script does not deadlock waiting for the lock it already holds.
const TOKEN_ENV = 'ZEN_WEB_DIST_LOCK_TOKEN'

const rmOptions =
  process.platform === 'win32'
    ? { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }
    : { recursive: true, force: true }

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err.code === 'EPERM'
  }
}

async function readOwner() {
  try {
    return JSON.parse(await readFile(OWNER_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function lockIsStale() {
  const owner = await readOwner()
  if (!owner) {
    // Either a lock caught between its mkdir and its owner file, or debris from
    // a process killed in that same window. The directory's own age tells them
    // apart without a race.
    try {
      const info = await stat(WEB_DIST_LOCK_DIR)
      return Date.now() - info.mtimeMs > STALE_MS
    } catch {
      return false
    }
  }
  return !pidIsAlive(owner.pid)
}

async function releaseLock(token) {
  const owner = await readOwner()
  // Ours was declared stale and taken over: the directory belongs to whoever
  // holds it now, so leave it alone.
  if (owner && owner.token !== token) return
  await rm(WEB_DIST_LOCK_DIR, rmOptions)
}

/**
 * Runs `fn` with exclusive access to the web bundle. Nested calls in the same
 * process tree reuse the inherited lock (see webDistLockEnv).
 */
export async function withWebDistLock(fn) {
  const inherited = process.env[TOKEN_ENV]
  if (inherited) return fn({ token: inherited })

  const token = randomUUID()
  await mkdir(dirname(WEB_DIST_LOCK_DIR), { recursive: true })
  for (;;) {
    try {
      await mkdir(WEB_DIST_LOCK_DIR)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (await lockIsStale()) {
        process.stderr.write(`[web-dist] clearing a stale build lock at ${WEB_DIST_LOCK_DIR}\n`)
        await rm(WEB_DIST_LOCK_DIR, rmOptions)
        continue
      }
      await delay(POLL_MS)
      continue
    }
    await writeFile(OWNER_FILE, JSON.stringify({ token, pid: process.pid, startedAt: Date.now() }), 'utf8')
    break
  }

  // A signal-killed run would otherwise leave the lock for the next process to
  // time out on. This is best-effort; the staleness check is the real backstop.
  const onExit = () => {
    try {
      rmSync(WEB_DIST_LOCK_DIR, { recursive: true, force: true })
    } catch {
      // Nothing useful to do while exiting.
    }
  }
  process.once('exit', onExit)
  try {
    return await fn({ token })
  } finally {
    process.off('exit', onExit)
    await releaseLock(token)
  }
}

/** Environment for a child process that must reuse this process's lock. */
export function webDistLockEnv(lock, env = process.env) {
  return { ...env, [TOKEN_ENV]: lock.token }
}
