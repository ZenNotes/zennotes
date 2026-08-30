import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultChangeEvent, VaultSettings } from '@shared/ipc'
import { VaultWatcher } from './watcher'

const tempDirs: string[] = []
const watchers: VaultWatcher[] = []

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.stop()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
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
