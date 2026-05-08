import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ensureVaultLayout,
  invalidateNoteMetaCache,
  listNotes,
  readNote,
  searchVaultText,
  writeNote
} from './vault'

const NOTE_COUNT = 5_000
const FOLDER_COUNT = 50
const WRITE_BATCH_SIZE = 250

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function measure<T>(
  label: string,
  detail: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<{ value: T; durationMs: number }> {
  const startedAt = performance.now()
  const value = await fn()
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100
  console.info(`[zen:bench] ${label} ${durationMs.toFixed(2)}ms`, detail)
  return { value, durationMs }
}

async function seedLargeVault(root: string): Promise<void> {
  await ensureVaultLayout(root)
  await rm(path.join(root, 'inbox', 'Welcome.md'), { force: true })

  const writes: Array<() => Promise<void>> = []
  for (let index = 0; index < NOTE_COUNT; index += 1) {
    const folder = `folder-${String(index % FOLDER_COUNT).padStart(2, '0')}`
    const title = `Note ${String(index).padStart(5, '0')}`
    const rel = path.join(root, 'inbox', folder, `${title}.md`)
    const needle = `needle-${index}`
    const body = [
      `# ${title}`,
      '',
      `This synthetic benchmark note includes ${needle}.`,
      'It has tags #perf #benchmark and enough body text to exercise metadata parsing.',
      'The quick brown fox jumps over the lazy dog while ZenNotes indexes markdown.',
      'A wikilink [[Synthetic Reference]] keeps wikilink extraction on the hot path.',
      '',
      '- [ ] task item for task extraction adjacent workloads',
      '- [x] completed task item',
      '',
      'Final paragraph with repeated benchmark words for text search scoring.'
    ].join('\n')
    writes.push(async () => {
      await mkdir(path.dirname(rel), { recursive: true })
      await writeFile(rel, body, 'utf8')
    })
  }

  for (let index = 0; index < writes.length; index += WRITE_BATCH_SIZE) {
    await Promise.all(writes.slice(index, index + WRITE_BATCH_SIZE).map((write) => write()))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe.skipIf(process.env['ZEN_PERF_BENCH'] !== '1')('large vault performance', () => {
  it('measures note listing, note read, note write, and built-in text search', async () => {
    const root = await makeTempDir('zennotes-large-vault-')
    await measure('seedLargeVault', { notes: NOTE_COUNT }, () => seedLargeVault(root))

    const coldList = await measure('listNotes.cold', { notes: NOTE_COUNT }, () => listNotes(root))
    expect(coldList.value).toHaveLength(NOTE_COUNT)

    const warmList = await measure('listNotes.warm', { notes: NOTE_COUNT }, () => listNotes(root))
    expect(warmList.value).toHaveLength(NOTE_COUNT)

    await sleep(1100)
    invalidateNoteMetaCache(root)
    const persistedWarmList = await measure('listNotes.persistedWarm', { notes: NOTE_COUNT }, () =>
      listNotes(root)
    )
    expect(persistedWarmList.value).toHaveLength(NOTE_COUNT)

    const target = 'inbox/folder-49/Note 04999.md'
    const read = await measure('readNote', { path: target }, () => readNote(root, target))
    expect(read.value.body).toContain('needle-4999')

    const coldSearch = await measure('searchVaultText.builtin.cold', { query: 'needle-4999' }, () =>
      searchVaultText(root, 'needle-4999', 'builtin', {}, 20)
    )
    expect(coldSearch.value.map((match) => match.path)).toContain(target)

    const warmSearch = await measure('searchVaultText.builtin.warm', { query: 'needle-4999' }, () =>
      searchVaultText(root, 'needle-4999', 'builtin', {}, 20)
    )
    expect(warmSearch.value.map((match) => match.path)).toContain(target)

    const write = await measure('writeNote', { path: target }, () =>
      writeNote(root, target, `${read.value.body}\n\nBenchmark write update.\n`)
    )
    expect(write.value.path).toBe(target)
  }, 120_000)
})
