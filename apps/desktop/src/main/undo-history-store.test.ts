import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_UNDO_HISTORY_AGE_MS,
  MAX_UNDO_HISTORY_BYTES,
  MAX_UNDO_HISTORY_FILES,
  UNDO_HISTORY_DIR,
  clearUndoHistories,
  pruneUndoHistories,
  readUndoHistory,
  undoHistoryFile,
  writeUndoHistory
} from './undo-history-store'

let base: string
const VAULT = '/Users/test/Notes'

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'zn-undo-'))
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('undo history files (#793)', () => {
  it('gives back what was written for a note, and nothing for a note it has not seen', async () => {
    await writeUndoHistory(base, VAULT, 'inbox/A.md', '{"v":1}')
    expect(await readUndoHistory(base, VAULT, 'inbox/A.md')).toBe('{"v":1}')
    expect(await readUndoHistory(base, VAULT, 'inbox/B.md')).toBeNull()
  })

  it('keeps vaults apart, since note paths are relative and repeat', async () => {
    await writeUndoHistory(base, VAULT, 'inbox/A.md', 'one')
    await writeUndoHistory(base, '/Users/test/Work', 'inbox/A.md', 'two')
    expect(await readUndoHistory(base, VAULT, 'inbox/A.md')).toBe('one')
    expect(await readUndoHistory(base, '/Users/test/Work', 'inbox/A.md')).toBe('two')
  })

  // The renderer is not trusted: whatever it sends as a path, the file stays here.
  it('never writes outside its own folder, whatever the note path says', async () => {
    const root = path.join(base, UNDO_HISTORY_DIR)
    for (const hostile of ['../../escape.md', '/etc/passwd', 'a/../../../b.md', 'C:\\Windows\\x.md']) {
      const file = undoHistoryFile(base, VAULT, hostile)
      expect(file).not.toBeNull()
      expect(path.relative(root, file!).startsWith('..')).toBe(false)
      expect(path.basename(file!)).toMatch(/^[0-9a-f]{32}\.json$/)
    }
  })

  it('ignores anything that is not a plausible note path or payload', async () => {
    for (const bad of [null, undefined, 7, '', 'a\0b', 'x'.repeat(5000)]) {
      expect(undoHistoryFile(base, VAULT, bad)).toBeNull()
      await writeUndoHistory(base, VAULT, bad, 'data')
      expect(await readUndoHistory(base, VAULT, bad)).toBeNull()
    }
    await writeUndoHistory(base, VAULT, 'inbox/A.md', { not: 'a string' })
    await writeUndoHistory(base, VAULT, 'inbox/A.md', 'x'.repeat(MAX_UNDO_HISTORY_BYTES + 1))
    expect(await readUndoHistory(base, VAULT, 'inbox/A.md')).toBeNull()
  })

  it('forgets one note on request, and everything when the setting is turned off', async () => {
    await writeUndoHistory(base, VAULT, 'inbox/A.md', 'a')
    await writeUndoHistory(base, VAULT, 'inbox/B.md', 'b')
    await writeUndoHistory(base, VAULT, 'inbox/A.md', null)
    expect(await readUndoHistory(base, VAULT, 'inbox/A.md')).toBeNull()
    expect(await readUndoHistory(base, VAULT, 'inbox/B.md')).toBe('b')

    await clearUndoHistories(base)
    expect(await readUndoHistory(base, VAULT, 'inbox/B.md')).toBeNull()
    expect(await readdir(base)).toEqual([])
  })

  it('leaves no partial file behind after a write', async () => {
    await writeUndoHistory(base, VAULT, 'inbox/A.md', 'data')
    const dir = path.dirname(undoHistoryFile(base, VAULT, 'inbox/A.md')!)
    expect((await readdir(dir)).every((name) => name.endsWith('.json'))).toBe(true)
  })
})

describe('pruning undo history files', () => {
  it('drops histories nobody came back to, and stray partial writes', async () => {
    await writeUndoHistory(base, VAULT, 'inbox/Old.md', 'old')
    await writeUndoHistory(base, VAULT, 'inbox/New.md', 'new')
    const oldFile = undoHistoryFile(base, VAULT, 'inbox/Old.md')!
    const long = new Date(Date.now() - MAX_UNDO_HISTORY_AGE_MS - 60_000)
    await utimes(oldFile, long, long)
    await writeFile(path.join(path.dirname(oldFile), 'abc.json.123.tmp'), 'partial')

    await pruneUndoHistories(base)
    expect(await readUndoHistory(base, VAULT, 'inbox/Old.md')).toBeNull()
    expect(await readUndoHistory(base, VAULT, 'inbox/New.md')).toBe('new')
    expect((await readdir(path.dirname(oldFile))).length).toBe(1)
  })

  it('keeps the most recently written notes when a vault has too many', async () => {
    const extra = 3
    for (let n = 0; n < MAX_UNDO_HISTORY_FILES + extra; n++) {
      await writeUndoHistory(base, VAULT, `inbox/${n}.md`, String(n))
      const file = undoHistoryFile(base, VAULT, `inbox/${n}.md`)!
      const at = new Date(Date.now() - (MAX_UNDO_HISTORY_FILES + extra - n) * 1000)
      await utimes(file, at, at)
    }
    await pruneUndoHistories(base)
    expect(await readUndoHistory(base, VAULT, 'inbox/0.md')).toBeNull()
    expect(await readUndoHistory(base, VAULT, `inbox/${extra - 1}.md`)).toBeNull()
    expect(await readUndoHistory(base, VAULT, `inbox/${extra}.md`)).toBe(String(extra))
    expect(await readFile(undoHistoryFile(base, VAULT, `inbox/${MAX_UNDO_HISTORY_FILES}.md`)!, 'utf8')).toBe(
      String(MAX_UNDO_HISTORY_FILES)
    )
  })

  it('is fine with nothing to prune', async () => {
    await expect(pruneUndoHistories(base)).resolves.toBeUndefined()
  })
})
