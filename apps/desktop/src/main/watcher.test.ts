import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getActiveResourcesInfo } from 'node:process'
import chokidar from 'chokidar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultChangeEvent, VaultSettings } from '@shared/ipc'
import { VaultWatcher } from './watcher'

const tempDirs: string[] = []
const watchers: VaultWatcher[] = []

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.stop()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-watcher-'))
  tempDirs.push(root)
  await mkdir(path.join(root, '99 - Archive'), { recursive: true })
  return root
}

function settingsWithArchiveRemap(): VaultSettings {
  return {
    primaryNotesLocation: 'inbox',
    systemFolderPaths: { archive: '99 - Archive' }
  } as VaultSettings
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wait for `events` to be non-empty, or give up. */
async function waitForEvent(events: VaultChangeEvent[]): Promise<VaultChangeEvent | null> {
  for (let i = 0; i < 60; i++) {
    if (events.length > 0) return events[0] as VaultChangeEvent
    await sleep(50)
  }
  return null
}

// Chokidar starts reporting the instant start() returns, while the settings
// load is a promise. Anything classified in that window used the DEFAULT
// folder names, so a note in a remapped archive was announced as an inbox
// note, and the sidebar then showed it in the wrong place until something else
// forced a refresh.
describe('VaultWatcher settings startup window', () => {
  it(
    'holds events until the first settings load lands, then classifies with the remap',
    async () => {
      const root = await makeVault()
      const settings = deferred<VaultSettings>()
      const events: VaultChangeEvent[] = []

      const watcher = new VaultWatcher(() => settings.promise)
      watchers.push(watcher)
      watcher.start(root, (ev) => events.push(ev))

      // Let chokidar finish its initial scan so the write below is a real add.
      await sleep(400)
      await writeFile(path.join(root, '99 - Archive', 'Old.md'), '# Old\n')
      // Long past chokidar's awaitWriteFinish window: without the buffer the
      // event would already have been delivered, classified as `inbox`.
      await sleep(600)
      expect(events).toEqual([])

      settings.resolve(settingsWithArchiveRemap())
      const first = await waitForEvent(events)
      expect(first?.path).toBe('99 - Archive/Old.md')
      expect(first?.folder).toBe('archive')
    },
    20_000
  )

  it(
    'still reports changes when the settings load fails',
    async () => {
      const root = await makeVault()
      const events: VaultChangeEvent[] = []

      const watcher = new VaultWatcher(() => Promise.reject(new Error('unreadable vault.json')))
      watchers.push(watcher)
      watcher.start(root, (ev) => events.push(ev))

      await sleep(400)
      await writeFile(path.join(root, 'Note.md'), '# Note\n')
      const first = await waitForEvent(events)
      expect(first?.path).toBe('Note.md')
      expect(first?.folder).toBe('inbox')
    },
    20_000
  )
})

describe('VaultWatcher atomic saves', () => {
  it(
    'reports the completed note without exposing its scratch filename',
    async () => {
      const root = await makeVault()
      const events: VaultChangeEvent[] = []
      const watcher = new VaultWatcher()
      watchers.push(watcher)
      watcher.start(root, (event) => events.push(event))
      await sleep(400)

      const scratch = path.join(root, 'Daily.md.3252272.1787800172047252.tmp')
      await writeFile(scratch, '# Daily\n')
      await sleep(250)
      expect(events).toEqual([])

      await rename(scratch, path.join(root, 'Daily.md'))
      const completed = await waitForEvent(events)

      expect(completed?.path).toBe('Daily.md')
      expect(events.some((event) => event.path.endsWith('.tmp'))).toBe(false)
    },
    20_000
  )
})

describe('VaultWatcher large vaults', () => {
  it('watches external edits with bounded native handles and releases them on stop', async () => {
    const root = await makeVault()
    const directoryCount = 20
    for (let index = 0; index < directoryCount; index++) {
      const dir = path.join(root, `folder-${index}`)
      await mkdir(dir)
      await Promise.all(Array.from({ length: 50 }, (_, note) =>
        writeFile(path.join(dir, `Note-${note}.md`), '# Note\n')
      ))
    }
    const nativeHandles = (): number =>
      getActiveResourcesInfo().filter((resource) => resource === 'FSEventWrap').length
    const baseline = nativeHandles()
    const events: VaultChangeEvent[] = []
    const watcher = new VaultWatcher()
    watchers.push(watcher)
    watcher.start(root, (event) => events.push(event))

    // Keep writing until the initial scan has completed, even on a slow disk.
    await expect.poll(async () => {
      await writeFile(path.join(root, 'folder-0', 'Note-0.md'), `Updated ${Date.now()}\n`)
      return events.some((event) => event.path === 'folder-0/Note-0.md')
    }, { interval: 250, timeout: 10_000 }).toBe(true)
    // Allow per-directory watching on Linux, but never one handle per file.
    expect(nativeHandles() - baseline).toBeLessThan(directoryCount * 2 + 10)

    await watcher.stop()
    await expect.poll(nativeHandles).toBeLessThanOrEqual(baseline)

    const nextRoot = await makeVault()
    events.length = 0
    watcher.start(nextRoot, (event) => events.push(event))
    await expect.poll(async () => {
      await writeFile(path.join(nextRoot, 'Next.md'), `Updated ${Date.now()}\n`)
      return events.some((event) => event.path === 'Next.md')
    }, { interval: 250, timeout: 10_000 }).toBe(true)
  }, 30_000)

  it('closes a failed watcher without an unhandled error and can start again', async () => {
    const root = await makeVault()
    const watch = vi.spyOn(chokidar, 'watch')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: VaultChangeEvent[] = []
    const watcher = new VaultWatcher()
    watchers.push(watcher)
    watcher.start(root, (event) => events.push(event))
    const active = watch.mock.results.find((result) => result.type === 'return')?.value
    if (!active) throw new Error('Watcher did not start')
    const closed = vi.spyOn(active, 'close')

    active.emit('error', Object.assign(new Error('Watch limit reached'), { code: 'EMFILE' }))
    expect(closed).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledOnce()
    await active.close()

    watcher.start(root, (event) => events.push(event))
    await expect.poll(async () => {
      await writeFile(path.join(root, 'Recovered.md'), `Updated ${Date.now()}\n`)
      return events.some((event) => event.path === 'Recovered.md')
    }, { interval: 250, timeout: 10_000 }).toBe(true)
  }, 15_000)

  it.each(['EMFILE', 'ENFILE', 'ENOSPC'])(
    'tells its owner when watch handles run out (%s)',
    async (code) => {
      const root = await makeVault()
      const watch = vi.spyOn(chokidar, 'watch')
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const exhausted = vi.fn()
      const watcher = new VaultWatcher()
      watchers.push(watcher)
      watcher.start(root, () => {}, exhausted)
      const active = watch.mock.results.find((result) => result.type === 'return')?.value
      if (!active) throw new Error('Watcher did not start')
      const closed = vi.spyOn(active, 'close')

      active.emit('error', Object.assign(new Error('Out of handles'), { code }))
      expect(closed).toHaveBeenCalledOnce()
      expect(exhausted).toHaveBeenCalledOnce()
    }
  )

  it('keeps watching after an error about one path', async () => {
    const root = await makeVault()
    const watch = vi.spyOn(chokidar, 'watch')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exhausted = vi.fn()
    const events: VaultChangeEvent[] = []
    const watcher = new VaultWatcher()
    watchers.push(watcher)
    watcher.start(root, (event) => events.push(event), exhausted)
    const active = watch.mock.results.find((result) => result.type === 'return')?.value
    if (!active) throw new Error('Watcher did not start')
    const closed = vi.spyOn(active, 'close')

    active.emit('error', Object.assign(new Error('Cannot watch one folder'), { code: 'EINVAL' }))
    expect(report).toHaveBeenCalledOnce()
    expect(closed).not.toHaveBeenCalled()
    expect(exhausted).not.toHaveBeenCalled()
    await expect.poll(async () => {
      await writeFile(path.join(root, 'Still.md'), `Updated ${Date.now()}\n`)
      return events.some((event) => event.path === 'Still.md')
    }, { interval: 250, timeout: 10_000 }).toBe(true)
  }, 15_000)

  // Linux watches folder by folder, so an unreadable one is an EACCES the
  // watcher meets while it walks the vault. macOS and Windows watch the tree
  // as a whole and never open it; there the test only proves nothing regressed.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps reporting the rest of the vault when one folder cannot be read',
    async () => {
      const root = await makeVault()
      const locked = path.join(root, 'lost+found')
      await mkdir(path.join(root, 'Open'))
      await mkdir(locked)
      await writeFile(path.join(locked, 'Hidden.md'), '# Hidden\n')
      await chmod(locked, 0o000)
      const report = vi.spyOn(console, 'error')
      const exhausted = vi.fn()
      try {
        const events: VaultChangeEvent[] = []
        const watcher = new VaultWatcher()
        watchers.push(watcher)
        watcher.start(root, (event) => events.push(event), exhausted)
        await expect.poll(async () => {
          await writeFile(path.join(root, 'Open', 'After.md'), `Updated ${Date.now()}\n`)
          return events.some((event) => event.path === 'Open/After.md')
        }, { interval: 250, timeout: 10_000 }).toBe(true)
        expect(report).not.toHaveBeenCalled()
        expect(exhausted).not.toHaveBeenCalled()
      } finally {
        // rm cannot clear a folder it cannot read.
        await chmod(locked, 0o755)
      }
    },
    15_000
  )
})

describe('VaultWatcher custom templates (#723)', () => {
  it(
    'announces a template file under its own scope, and ignores what is not a template',
    async () => {
      const root = await makeVault()
      const events: VaultChangeEvent[] = []
      const watcher = new VaultWatcher(() => Promise.resolve(settingsWithArchiveRemap()))
      watchers.push(watcher)
      watcher.start(root, (ev) => events.push(ev))
      await sleep(400)

      const dir = path.join(root, '.zennotes', 'templates')
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'adr.md'), '---\nname: ADR\n---\n')
      const event = await waitForEvent(events)
      expect(event).toEqual({
        kind: 'add',
        path: '.zennotes/templates/adr.md',
        folder: 'inbox',
        scope: 'templates'
      })

      events.length = 0
      await writeFile(path.join(dir, '.draft.md'), 'hidden')
      await writeFile(path.join(dir, 'notes.txt'), 'text')
      await sleep(600)
      expect(events).toEqual([])
    },
    15_000
  )
})
