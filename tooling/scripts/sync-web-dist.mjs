import { createHash } from 'node:crypto'
import { cp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withWebDistLock } from './web-dist-lock.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const webDist = resolve(repoRoot, 'apps/web/dist')
// The server no longer lives here. The destination is a ZenNotes/znserver
// checkout's web/dist, given as the first argument or through ZENNOTES_SERVER_DIR.
const destinationArg = process.argv[2]?.trim()
const checkout = process.env.ZENNOTES_SERVER_DIR?.trim()
const serverDist = destinationArg ? resolve(destinationArg) : checkout ? resolve(checkout, 'web/dist') : null
if (!serverDist) {
  throw new Error('sync-web-dist needs a destination: pass <checkout>/web/dist or set ZENNOTES_SERVER_DIR to a ZenNotes/znserver checkout')
}

// Two producers can run this concurrently (a perf run and a manual sync, or
// two turbo tasks in the checkout). A plain `rm` followed by `cp`
// therefore races: the second process deletes the directory while the first is
// still copying into it, and the first dies with ENOENT partway through. It
// surfaces as `turbo run typecheck test:run` failing on a machine where each
// task passes perfectly well on its own, with no connection to the change being
// built, which is the worst kind of red.
//
// Every producer of this tree holds the shared lock, so the copy and the swap
// below never interleave with another one. That still leaves the swap's own
// window, between retiring the old directory and moving the new one in, where
// `go:embed all:dist` has nothing to embed. Hence the early exit when the tree
// has not changed, which is the common case once the bundle has been built.

const rmOptions =
  process.platform === 'win32'
    ? { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }
    : { recursive: true, force: true }

// Windows reports "the destination directory is in the way" as EPERM/EACCES
// from MoveFileExW, where POSIX reports ENOTEMPTY/EEXIST.
const REPLACE_ERRORS = new Set(['ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'])

async function treeSignature(dir) {
  try {
    await stat(dir)
  } catch {
    return null
  }
  const hash = createHash('sha256')
  const walk = async (current, prefix) => {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const abs = resolve(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        hash.update(`d ${rel}\n`)
        await walk(abs, rel)
        continue
      }
      if (!entry.isFile()) continue
      const body = await readFile(abs)
      hash.update(`f ${rel} ${body.length}\n`)
      hash.update(body)
    }
  }
  await walk(dir, '')
  return hash.digest('hex')
}

// Staging directories from a run that died mid-copy. Nobody else can be staging
// while we hold the lock, so anything still lying around is debris.
async function sweepStagingDebris() {
  const parent = dirname(serverDist)
  const prefixes = [`${basename(serverDist)}.stage-`, `${basename(serverDist)}.retired-`]
  let entries
  try {
    entries = await readdir(parent, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue
    await rm(resolve(parent, entry.name), rmOptions)
  }
}

async function retire(retired) {
  try {
    await rename(serverDist, retired)
  } catch (err) {
    if (err.code === 'ENOENT') return // Nothing to retire on a first run.
    if (!REPLACE_ERRORS.has(err.code)) throw err
    // Windows refuses to rename a directory something else still has open.
    // Removing it in place widens the window, but under the lock the only
    // readers left are compilers, which retry on the next build.
    await rm(serverDist, rmOptions)
  }
}

async function promote(stage) {
  try {
    await rename(stage, serverDist)
  } catch (err) {
    if (!REPLACE_ERRORS.has(err.code)) throw err
    await rm(serverDist, rmOptions)
    await rename(stage, serverDist)
  }
}

async function main() {
  await sweepStagingDebris()

  const source = await treeSignature(webDist)
  if (source === null) {
    throw new Error(`no web bundle at ${webDist}; run \`npm run build --workspace @zennotes/web\` first`)
  }
  // Identical trees are the steady state across repeated runs. Skipping the
  // swap keeps the checkout's web/dist continuously present for go:embed.
  if (source === (await treeSignature(serverDist))) return

  const stage = `${serverDist}.stage-${process.pid}`
  const retired = `${serverDist}.retired-${process.pid}`
  await rm(stage, rmOptions)
  try {
    await cp(webDist, stage, { recursive: true, force: true })
    await retire(retired)
    await promote(stage)
  } finally {
    // A failed copy or swap must not leave a staging tree behind for the next
    // run to trip over.
    await rm(stage, rmOptions)
    await rm(retired, rmOptions)
  }
}

try {
  await withWebDistLock(main)
} catch (err) {
  process.stderr.write(`[web-dist] ${err?.message ?? err}\n`)
  process.exitCode = 1
}
