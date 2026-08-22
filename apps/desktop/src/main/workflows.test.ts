import { promises as nodeFs } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_IMPORT_BYTES,
  deleteWorkflowFile,
  listWorkflowFiles,
  readWorkflowImportFile,
  resolveWorkflowPath,
  safeExportFilename,
  writeWorkflowFile
} from './workflows'

const tempDirs: string[] = []

async function makeVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-workflows-'))
  tempDirs.push(dir)
  return dir
}

/** Creates the workflows dir and returns it, so tests can seed files into it. */
async function makeWorkflowsDir(root: string): Promise<string> {
  const dir = path.join(root, '.zennotes', 'workflows')
  await mkdir(dir, { recursive: true })
  return dir
}

/** The workflows dir path without creating it, for write tests. */
function workflowsDirOf(root: string): string {
  return path.join(root, '.zennotes', 'workflows')
}

/** Everything actually on disk in the workflows dir, sorted, temp files included. */
async function entriesOf(root: string): Promise<string[]> {
  return (await readdir(workflowsDirOf(root))).sort()
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('listWorkflowFiles', () => {
  it('returns an empty list when the vault has no workflows dir', async () => {
    const root = await makeVault()
    expect(await listWorkflowFiles(root)).toEqual([])
  })

  it('returns an empty list when the vault itself does not exist', async () => {
    const root = await makeVault()
    expect(await listWorkflowFiles(path.join(root, 'gone'))).toEqual([])
  })

  it('returns an empty list for an existing but empty workflows dir', async () => {
    const root = await makeVault()
    await makeWorkflowsDir(root)
    expect(await listWorkflowFiles(root)).toEqual([])
  })

  it('reports id, sourcePath and raw for a single workflow', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    const raw = '---\nname: Reading log\ntrigger: manual\n---\n\nbooks = tag #book\n'
    await writeFile(path.join(dir, 'reading-log.md'), raw, 'utf8')
    expect(await listWorkflowFiles(root)).toEqual([
      { id: 'reading-log', sourcePath: '.zennotes/workflows/reading-log.md', raw }
    ])
  })

  it('sorts by id regardless of the order the files were written', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    for (const stem of ['zeta', 'alpha', 'mid', 'beta']) {
      await writeFile(path.join(dir, `${stem}.md`), `# ${stem}\n`, 'utf8')
    }
    const files = await listWorkflowFiles(root)
    expect(files.map((f) => f.id)).toEqual(['alpha', 'beta', 'mid', 'zeta'])
    expect(files.map((f) => f.sourcePath)).toEqual([
      '.zennotes/workflows/alpha.md',
      '.zennotes/workflows/beta.md',
      '.zennotes/workflows/mid.md',
      '.zennotes/workflows/zeta.md'
    ])
  })

  it('ignores files that are not .md', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    await writeFile(path.join(dir, 'keep.md'), 'keep\n', 'utf8')
    await writeFile(path.join(dir, 'notes.txt'), 'skip\n', 'utf8')
    await writeFile(path.join(dir, 'schema.json'), '{}\n', 'utf8')
    await writeFile(path.join(dir, 'README'), 'skip\n', 'utf8')
    await writeFile(path.join(dir, 'markdown.mdx'), 'skip\n', 'utf8')
    expect((await listWorkflowFiles(root)).map((f) => f.id)).toEqual(['keep'])
  })

  it('accepts an uppercase .MD extension and strips it from the id', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    await writeFile(path.join(dir, 'Shouty.MD'), 'shouty\n', 'utf8')
    expect((await listWorkflowFiles(root)).map((f) => f.id)).toEqual(['Shouty'])
  })

  it('ignores dotfiles, including editor swap files that end in .md', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    await writeFile(path.join(dir, 'visible.md'), 'visible\n', 'utf8')
    await writeFile(path.join(dir, '.hidden.md'), 'hidden\n', 'utf8')
    await writeFile(path.join(dir, '.DS_Store'), '', 'utf8')
    await writeFile(path.join(dir, '.reading-log.md.swp'), '', 'utf8')
    expect((await listWorkflowFiles(root)).map((f) => f.id)).toEqual(['visible'])
  })

  it('does not recurse into subdirectories', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    await writeFile(path.join(dir, 'top.md'), 'top\n', 'utf8')
    await mkdir(path.join(dir, 'nested'), { recursive: true })
    await writeFile(path.join(dir, 'nested', 'inner.md'), 'inner\n', 'utf8')
    expect((await listWorkflowFiles(root)).map((f) => f.id)).toEqual(['top'])
  })

  it('skips a directory that happens to be named like a workflow', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(path.join(dir, 'impostor.md'), { recursive: true })
    await writeFile(path.join(dir, 'real.md'), 'real\n', 'utf8')
    expect((await listWorkflowFiles(root)).map((f) => f.id)).toEqual(['real'])
  })

  it('preserves raw content byte for byte', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    // CRLF, tabs, trailing spaces, a blank final line and non-ASCII all have to
    // survive: the canvas round-trips this text back to disk on every save.
    const raw =
      '---\r\nname: Ordnung  \r\ndescription: café, naïve, 日本語\r\n---\r\n\r\n' +
      '\tbooks\t= tag #book   \n\ngood | where rating >= 4\n\n'
    await writeFile(path.join(dir, 'exact.md'), raw, 'utf8')
    const files = await listWorkflowFiles(root)
    expect(files).toHaveLength(1)
    expect(files[0].raw).toBe(raw)
  })

  it('lists an empty workflow file with empty raw rather than dropping it', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    await writeFile(path.join(dir, 'blank.md'), '', 'utf8')
    expect(await listWorkflowFiles(root)).toEqual([
      { id: 'blank', sourcePath: '.zennotes/workflows/blank.md', raw: '' }
    ])
  })

  it('keeps spaces and dots in the filename stem as the id', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    await writeFile(path.join(dir, 'reading log.v2.md'), 'x\n', 'utf8')
    expect(await listWorkflowFiles(root)).toEqual([
      {
        id: 'reading log.v2',
        sourcePath: '.zennotes/workflows/reading log.v2.md',
        raw: 'x\n'
      }
    ])
  })

  it('never parses the file, so invalid syntax still lists', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    const raw = 'this is not a workflow at all ||| >>> ###\n'
    await writeFile(path.join(dir, 'broken.md'), raw, 'utf8')
    expect((await listWorkflowFiles(root))[0].raw).toBe(raw)
  })
})

describe('resolveWorkflowPath', () => {
  it('resolves a workflow file inside the workflows dir', async () => {
    const root = await makeVault()
    expect(resolveWorkflowPath(root, '.zennotes/workflows/reading-log.md')).toBe(
      path.join(root, '.zennotes', 'workflows', 'reading-log.md')
    )
  })

  it('rejects a parent traversal that escapes the vault', async () => {
    const root = await makeVault()
    expect(() =>
      resolveWorkflowPath(root, '.zennotes/workflows/../../../evil.md')
    ).toThrow(/outside workflows dir/)
  })

  it('rejects a traversal that lands elsewhere in the same vault', async () => {
    const root = await makeVault()
    expect(() => resolveWorkflowPath(root, '.zennotes/workflows/../templates/x.md')).toThrow(
      /outside workflows dir/
    )
  })

  it('rejects a path in a subdirectory of the workflows dir', async () => {
    const root = await makeVault()
    expect(() => resolveWorkflowPath(root, '.zennotes/workflows/nested/inner.md')).toThrow(
      /outside workflows dir/
    )
  })

  it('rejects an absolute path outside the vault', async () => {
    const root = await makeVault()
    expect(() => resolveWorkflowPath(root, path.join(os.tmpdir(), 'elsewhere.md'))).toThrow(
      /outside workflows dir/
    )
  })

  it('rejects a path that is not a .md file', async () => {
    const root = await makeVault()
    expect(() => resolveWorkflowPath(root, '.zennotes/workflows/reading-log.txt')).toThrow(
      /must be a .md file/
    )
  })

  it('rejects the workflows dir itself', async () => {
    const root = await makeVault()
    expect(() => resolveWorkflowPath(root, '.zennotes/workflows')).toThrow()
  })
})

describe('writeWorkflowFile', () => {
  it('creates the workflows dir on the first save', async () => {
    const root = await makeVault()
    const raw = '---\nname: Reading log\ntrigger: manual\n---\n\nbooks = tag #book\n'
    const saved = await writeWorkflowFile(root, { slug: 'reading-log', raw })
    expect(saved).toEqual({
      id: 'reading-log',
      sourcePath: '.zennotes/workflows/reading-log.md',
      raw
    })
    expect(await readFile(path.join(workflowsDirOf(root), 'reading-log.md'), 'utf8')).toBe(raw)
  })

  it('writes raw byte for byte, never reformatting the file', async () => {
    const root = await makeVault()
    // Same shape as the list test: CRLF, tabs, trailing spaces and non-ASCII
    // all have to survive, because the canvas round-trips this text on save.
    const raw =
      '---\r\nname: Ordnung  \r\ndescription: café, naïve, 日本語\r\n---\r\n\r\n' +
      '\tbooks\t= tag #book   \n\ngood | where rating >= 4\n\n'
    await writeWorkflowFile(root, { slug: 'exact', raw })
    expect(await readFile(path.join(workflowsDirOf(root), 'exact.md'), 'utf8')).toBe(raw)
  })

  it('overwrites the same slug instead of forking into a second file', async () => {
    const root = await makeVault()
    await writeWorkflowFile(root, { slug: 'reading-log', raw: 'first\n' })
    const saved = await writeWorkflowFile(root, { slug: 'reading-log', raw: 'second\n' })
    // The stem is the workflow id that `call` steps resolve against, so a
    // re-save must land on the same file (unlike templates, which de-duplicate).
    expect(saved.sourcePath).toBe('.zennotes/workflows/reading-log.md')
    expect(await entriesOf(root)).toEqual(['reading-log.md'])
    expect(await readFile(path.join(workflowsDirOf(root), 'reading-log.md'), 'utf8')).toBe(
      'second\n'
    )
  })

  it('leaves no temp file behind after a successful write', async () => {
    const root = await makeVault()
    await writeWorkflowFile(root, { slug: 'atomic', raw: 'x\n' })
    // The atomic write stages `<file>.<pid>.<ts>.tmp` next to the target; if the
    // rename ever stopped happening, the directory would show it.
    expect(await entriesOf(root)).toEqual(['atomic.md'])
  })

  it('moves the file when previousSourcePath names a different slug', async () => {
    const root = await makeVault()
    await writeWorkflowFile(root, { slug: 'old-name', raw: 'body\n' })
    const saved = await writeWorkflowFile(root, {
      slug: 'new-name',
      raw: 'body\n',
      previousSourcePath: '.zennotes/workflows/old-name.md'
    })
    expect(saved.id).toBe('new-name')
    expect(await entriesOf(root)).toEqual(['new-name.md'])
    expect((await listWorkflowFiles(root)).map((f) => f.id)).toEqual(['new-name'])
  })

  it('keeps the file when previousSourcePath resolves to the new path', async () => {
    const root = await makeVault()
    await writeWorkflowFile(root, { slug: 'same', raw: 'first\n' })
    const saved = await writeWorkflowFile(root, {
      slug: 'same',
      raw: 'second\n',
      previousSourcePath: '.zennotes/workflows/same.md'
    })
    // A no-op rename must not delete the file it just wrote.
    expect(saved.raw).toBe('second\n')
    expect(await readFile(path.join(workflowsDirOf(root), 'same.md'), 'utf8')).toBe('second\n')
  })

  it('survives a rename that differs from the old file only by case (#605 review)', async () => {
    const root = await makeVault()
    // Seed the odd-cased spelling directly: on a case-insensitive filesystem
    // it names the same physical file the save lands on, and the cleanup used
    // to delete the workflow that was just written.
    await mkdir(workflowsDirOf(root), { recursive: true })
    await writeFile(path.join(workflowsDirOf(root), 'My-Flow.md'), 'old\n')
    const saved = await writeWorkflowFile(root, {
      slug: 'my-flow',
      raw: 'new\n',
      previousSourcePath: '.zennotes/workflows/My-Flow.md'
    })
    expect(saved.raw).toBe('new\n')
    expect(await readFile(path.join(workflowsDirOf(root), 'my-flow.md'), 'utf8')).toBe('new\n')
  })

  it('tolerates a previousSourcePath that no longer exists', async () => {
    const root = await makeVault()
    const saved = await writeWorkflowFile(root, {
      slug: 'renamed',
      raw: 'body\n',
      previousSourcePath: '.zennotes/workflows/never-existed.md'
    })
    expect(saved.id).toBe('renamed')
    expect(await entriesOf(root)).toEqual(['renamed.md'])
  })

  it('keeps the original when a rename fails to write the new file', async () => {
    const root = await makeVault()
    await writeWorkflowFile(root, { slug: 'old-name', raw: 'the only copy\n' })
    // A directory sitting on the target path makes the final rename fail, which
    // is the realistic version of "the write did not land". listWorkflowFiles
    // warns about the unreadable directory below; that is its documented
    // behaviour, so silence it rather than let it litter the test output.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(path.join(workflowsDirOf(root), 'new-name.md'), { recursive: true })
    await expect(
      writeWorkflowFile(root, {
        slug: 'new-name',
        raw: 'replacement\n',
        previousSourcePath: '.zennotes/workflows/old-name.md'
      })
    ).rejects.toThrow()
    // The point of deleting last: a failed rename must not lose the only copy.
    expect(await readFile(path.join(workflowsDirOf(root), 'old-name.md'), 'utf8')).toBe(
      'the only copy\n'
    )
    expect((await listWorkflowFiles(root)).map((f) => f.id)).toEqual(['old-name'])
  })

  it('keeps the original when the write throws mid-rename', async () => {
    const root = await makeVault()
    await writeWorkflowFile(root, { slug: 'old-name', raw: 'the only copy\n' })
    vi.spyOn(nodeFs, 'rename').mockRejectedValueOnce(new Error('ENOSPC: disk full'))
    await expect(
      writeWorkflowFile(root, {
        slug: 'new-name',
        raw: 'replacement\n',
        previousSourcePath: '.zennotes/workflows/old-name.md'
      })
    ).rejects.toThrow(/disk full/)
    expect(await readFile(path.join(workflowsDirOf(root), 'old-name.md'), 'utf8')).toBe(
      'the only copy\n'
    )
    // The staged temp file is cleaned up, so it never shows up as a workflow.
    expect(await entriesOf(root)).toEqual(['old-name.md'])
  })

  it('rejects a previousSourcePath that points outside the workflows dir', async () => {
    const root = await makeVault()
    await writeFile(path.join(root, 'victim.md'), 'not a workflow\n', 'utf8')
    await expect(
      writeWorkflowFile(root, {
        slug: 'attacker',
        raw: 'x\n',
        previousSourcePath: '.zennotes/workflows/../../victim.md'
      })
    ).rejects.toThrow(/outside workflows dir/)
    // Rejected before anything is written, so the bystander file is untouched
    // and no half-finished rename is left on disk.
    expect(await readFile(path.join(root, 'victim.md'), 'utf8')).toBe('not a workflow\n')
    await expect(entriesOf(root)).rejects.toThrow()
  })
})

describe('writeWorkflowFile slug sanitization', () => {
  it('lowercases and dashes a display name', async () => {
    const root = await makeVault()
    const saved = await writeWorkflowFile(root, { slug: 'My Books!', raw: 'x\n' })
    expect(saved.id).toBe('my-books')
    expect(saved.sourcePath).toBe('.zennotes/workflows/my-books.md')
  })

  it('collapses runs of punctuation and trims leading/trailing dashes', async () => {
    const root = await makeVault()
    const saved = await writeWorkflowFile(root, { slug: '  --Reading   Log!!! v2--  ', raw: 'x\n' })
    expect(saved.id).toBe('reading-log-v2')
  })

  it('flattens a parent traversal into a harmless stem', async () => {
    const root = await makeVault()
    const saved = await writeWorkflowFile(root, { slug: '../../evil', raw: 'pwned\n' })
    expect(saved.sourcePath).toBe('.zennotes/workflows/evil.md')
    expect(await entriesOf(root)).toEqual(['evil.md'])
    // Nothing was created next to the vault root.
    await expect(readFile(path.join(root, '..', 'evil.md'), 'utf8')).rejects.toThrow()
  })

  it('flattens an absolute path into a harmless stem', async () => {
    const root = await makeVault()
    const saved = await writeWorkflowFile(root, { slug: '/etc/passwd', raw: 'x\n' })
    expect(saved.sourcePath).toBe('.zennotes/workflows/etc-passwd.md')
    expect(await entriesOf(root)).toEqual(['etc-passwd.md'])
  })

  it('flattens embedded slashes and backslashes rather than nesting', async () => {
    const root = await makeVault()
    const saved = await writeWorkflowFile(root, { slug: 'nested/deep\\deeper', raw: 'x\n' })
    expect(saved.id).toBe('nested-deep-deeper')
    expect(await entriesOf(root)).toEqual(['nested-deep-deeper.md'])
  })

  it('strips a .md the caller left on the slug instead of doubling it', async () => {
    const root = await makeVault()
    const saved = await writeWorkflowFile(root, { slug: 'reading-log.md', raw: 'x\n' })
    // `.` is not in the safe set, so the extension folds into the stem; what
    // matters is that the file is still a single `.md` inside the dir.
    expect(await entriesOf(root)).toEqual(['reading-log-md.md'])
    expect(saved.id).toBe('reading-log-md')
  })

  it('falls back to "workflow" when nothing survives sanitization', async () => {
    const root = await makeVault()
    for (const slug of ['', '   ', '!!!', '../..', '日本語']) {
      const saved = await writeWorkflowFile(root, { slug, raw: `for ${slug}\n` })
      expect(saved.id).toBe('workflow')
      expect(saved.sourcePath).toBe('.zennotes/workflows/workflow.md')
    }
    expect(await entriesOf(root)).toEqual(['workflow.md'])
  })

  it('caps a very long slug so the filename stays writable', async () => {
    const root = await makeVault()
    const saved = await writeWorkflowFile(root, { slug: 'a'.repeat(400), raw: 'x\n' })
    expect(saved.id).toBe('a'.repeat(64))
    expect(await entriesOf(root)).toEqual([`${'a'.repeat(64)}.md`])
  })
})

describe('deleteWorkflowFile', () => {
  it('removes an existing workflow', async () => {
    const root = await makeVault()
    await writeWorkflowFile(root, { slug: 'doomed', raw: 'x\n' })
    await deleteWorkflowFile(root, '.zennotes/workflows/doomed.md')
    expect(await entriesOf(root)).toEqual([])
    expect(await listWorkflowFiles(root)).toEqual([])
  })

  it('leaves the other workflows alone', async () => {
    const root = await makeVault()
    await writeWorkflowFile(root, { slug: 'keep-a', raw: 'a\n' })
    await writeWorkflowFile(root, { slug: 'doomed', raw: 'x\n' })
    await writeWorkflowFile(root, { slug: 'keep-b', raw: 'b\n' })
    await deleteWorkflowFile(root, '.zennotes/workflows/doomed.md')
    expect((await listWorkflowFiles(root)).map((f) => f.id)).toEqual(['keep-a', 'keep-b'])
  })

  it('resolves when the file is already gone', async () => {
    const root = await makeVault()
    await makeWorkflowsDir(root)
    // Deleting twice from two windows is normal; the caller wanted it gone and
    // it is gone, so this is success rather than an error to surface.
    const gone = deleteWorkflowFile(root, '.zennotes/workflows/missing.md')
    await expect(gone).resolves.toBeUndefined()
  })

  it('resolves when the workflows dir does not exist at all', async () => {
    const root = await makeVault()
    const gone = deleteWorkflowFile(root, '.zennotes/workflows/missing.md')
    await expect(gone).resolves.toBeUndefined()
  })

  it('refuses to delete outside the workflows dir', async () => {
    const root = await makeVault()
    await writeFile(path.join(root, 'victim.md'), 'not a workflow\n', 'utf8')
    await expect(deleteWorkflowFile(root, '.zennotes/workflows/../../victim.md')).rejects.toThrow(
      /outside workflows dir/
    )
    await expect(deleteWorkflowFile(root, path.join(os.tmpdir(), 'elsewhere.md'))).rejects.toThrow(
      /outside workflows dir/
    )
    expect(await readFile(path.join(root, 'victim.md'), 'utf8')).toBe('not a workflow\n')
  })

  it('refuses to delete a non-.md file', async () => {
    const root = await makeVault()
    const dir = await makeWorkflowsDir(root)
    await writeFile(path.join(dir, 'notes.txt'), 'keep\n', 'utf8')
    await expect(deleteWorkflowFile(root, '.zennotes/workflows/notes.txt')).rejects.toThrow(
      /must be a .md file/
    )
    expect(await entriesOf(root)).toEqual(['notes.txt'])
  })
})

describe('write/list round trip', () => {
  it('lists a written workflow exactly as writeWorkflowFile reported it', async () => {
    const root = await makeVault()
    const raw = '---\nname: Reading log\nkey: <leader>wr\n---\n\nbooks = tag #book\n'
    const saved = await writeWorkflowFile(root, { slug: 'Reading Log', raw })
    expect(await listWorkflowFiles(root)).toEqual([saved])
  })

  it('survives create, edit, rename and delete in sequence', async () => {
    const root = await makeVault()
    await writeWorkflowFile(root, { slug: 'draft', raw: 'v1\n' })
    await writeWorkflowFile(root, { slug: 'draft', raw: 'v2\n' })
    expect((await listWorkflowFiles(root))[0].raw).toBe('v2\n')

    await writeWorkflowFile(root, {
      slug: 'Reading Log',
      raw: 'v3\n',
      previousSourcePath: '.zennotes/workflows/draft.md'
    })
    expect(await listWorkflowFiles(root)).toEqual([
      { id: 'reading-log', sourcePath: '.zennotes/workflows/reading-log.md', raw: 'v3\n' }
    ])

    await deleteWorkflowFile(root, '.zennotes/workflows/reading-log.md')
    expect(await listWorkflowFiles(root)).toEqual([])
  })
})

describe('safeExportFilename', () => {
  it('keeps a plain stem and gives it one .md', () => {
    expect(safeExportFilename('reading-log')).toBe('reading-log.md')
    expect(safeExportFilename('reading-log.md')).toBe('reading-log.md')
  })

  it('cannot suggest a path, so a save dialog opens where it was pointed', () => {
    expect(safeExportFilename('../../etc/passwd')).toBe('etc-passwd.md')
    expect(safeExportFilename('/absolute/thing')).toBe('absolute-thing.md')
  })

  it('joins spaces and drops the characters Windows reserves', () => {
    expect(safeExportFilename('My Reading Log')).toBe('My-Reading-Log.md')
    expect(safeExportFilename('a:b|c?d*e')).toBe('a-b-c-d-e.md')
  })

  it('always yields a filename, however little it was given', () => {
    expect(safeExportFilename('')).toBe('workflow.md')
    expect(safeExportFilename('   ')).toBe('workflow.md')
    expect(safeExportFilename('...')).toBe('workflow.md')
  })

  it('truncates a pasted paragraph rather than failing the save', () => {
    const name = safeExportFilename('x'.repeat(500))
    expect(name.length).toBeLessThanOrEqual(67)
    expect(name.endsWith('.md')).toBe(true)
  })
})

describe('readWorkflowImportFile', () => {
  it('hands back the bytes and the stem, and interprets neither', async () => {
    const root = await makeVault()
    const file = path.join(root, 'Reading Log.md')
    await writeFile(file, 'not even frontmatter\n', 'utf8')
    expect(await readWorkflowImportFile(file)).toEqual({
      name: 'Reading Log',
      raw: 'not even frontmatter\n'
    })
  })

  it('refuses a file far larger than any workflow, before reading it', async () => {
    const root = await makeVault()
    const file = path.join(root, 'huge.md')
    await writeFile(file, 'x'.repeat(MAX_IMPORT_BYTES + 1), 'utf8')
    await expect(readWorkflowImportFile(file)).rejects.toThrow(/larger than any workflow/)
  })

  it('refuses a directory', async () => {
    const root = await makeVault()
    await expect(readWorkflowImportFile(root)).rejects.toThrow(/not a file/)
  })
})
