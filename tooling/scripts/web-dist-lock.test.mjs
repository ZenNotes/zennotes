import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'

test('a second producer waits for a live owner even after ten minutes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zennotes-lock-test-'))
  const script = join(root, 'tooling/scripts/web-dist-lock.mjs')
  let pending
  try {
    await mkdir(dirname(script), { recursive: true })
    await copyFile(new URL('./web-dist-lock.mjs', import.meta.url), script)
    const { WEB_DIST_LOCK_DIR, withWebDistLock } = await import(pathToFileURL(script).href)
    await mkdir(WEB_DIST_LOCK_DIR, { recursive: true })
    await writeFile(join(WEB_DIST_LOCK_DIR, 'owner.json'), JSON.stringify({
      token: 'slow-compiler', pid: process.pid, startedAt: Date.now() - 60 * 60 * 1000
    }))
    let acquired = false
    pending = withWebDistLock(async () => { acquired = true })
    await setTimeout(150)
    try {
      assert.equal(acquired, false, 'a live compiler lost its lock based on age')
    } finally {
      await rm(WEB_DIST_LOCK_DIR, { recursive: true, force: true })
      await pending
    }
    assert.equal(acquired, true, 'the waiting producer did not acquire the released lock')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
