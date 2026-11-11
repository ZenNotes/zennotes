/**
 * The browser's VaultFileSystem (OPFS store, worker dispatcher, client) over
 * an in-memory OPFS with each engine's quirks (opfs-fake.ts): the package's
 * VaultFileSystem contract once per engine, then the rules the spikes added
 * (atomic replace, folder moves without folder move(), case folding, names,
 * fencing, the export window's read-only reader) and a PortableVault running
 * on top of it.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { vaultFileSystemContract, type VaultFileSystemContractHarness } from '@zennotes/portable-vault/vault-fs-contract'
import { PortableVault } from '@zennotes/portable-vault/vault'
import { DEMO_TOUR_NOTES } from '@zennotes/shared-domain/demo-tour-data'
import { createOpfsDispatcher } from '../opfs-dispatch'
import { OPFS_BAD_NAME, OPFS_EXISTS, OPFS_FENCED } from '../opfs-errors'
import { OpfsVaultFileSystem, directTransport } from '../opfs-fs'
import { FakeOpfs, type FakeEngine } from './opfs-fake'

const ENGINES: FakeEngine[] = ['chrome', 'firefox', 'safari']

let ids = 0
const randomId = (): string => `id${(ids += 1)}`

const origins = new WeakMap<OpfsVaultFileSystem, FakeOpfs>()

async function openFs(
  origin: FakeOpfs,
  options: { vaultKey?: string; generation?: number; generations?: Map<string, number>; readOnly?: boolean } = {}
): Promise<OpfsVaultFileSystem> {
  const generations = options.generations
  const dispatcher = createOpfsDispatcher({
    root: async () => origin.root,
    randomId,
    readOnly: options.readOnly,
    ...(generations ? { currentGeneration: async (key: string) => generations.get(key) ?? 0 } : {})
  })
  const fs = new OpfsVaultFileSystem(options.vaultKey ?? 'test', directTransport(dispatcher), {
    generation: options.generation ?? 0
  })
  await fs.init()
  origins.set(fs, origin)
  return fs
}

function harnessFor(engine: FakeEngine): VaultFileSystemContractHarness<OpfsVaultFileSystem> {
  return {
    async create() {
      return openFs(new FakeOpfs(engine))
    },
    async reopen(fs) {
      return openFs(origins.get(fs)!)
    },
    breakStorage: (fs) => origins.get(fs)!.breakStorage(),
    restoreStorage: (fs) => origins.get(fs)!.restoreStorage()
  }
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code)
    return true
  })
}

for (const engine of ENGINES) {
  describe(`the OPFS vault keeps the VaultFileSystem contract (${engine})`, () => {
    const harness = harnessFor(engine)
    for (const contract of vaultFileSystemContract) {
      it(contract.name, () => contract.run(harness))
    }
  })

  describe(`OPFS rules from the spikes (${engine})`, () => {
    it('a write that fails leaves the old file, and no temp file behind', async () => {
      const origin = new FakeOpfs(engine)
      const fs = await openFs(origin)
      await fs.writeText('inbox/a.md', 'old body')
      origin.failNextSyncWrite()
      await assert.rejects(fs.writeText('inbox/a.md', 'a much longer new body'))
      assert.equal(await fs.readText('inbox/a.md'), 'old body')
      assert.deepEqual(origin.paths().filter((path) => path.includes('.zn-tmp-')), [])
      assert.equal(origin.openSyncHandles(), 0)
    })

    it('replaces a file by moving a temp over it, with every handle closed', async () => {
      const origin = new FakeOpfs(engine)
      const fs = await openFs(origin)
      await fs.writeText('a.md', 'one')
      const movesBefore = origin.moveCalls
      await fs.writeText('a.md', 'two')
      assert.equal(origin.moveCalls, movesBefore + 1)
      assert.equal(await fs.readText('a.md'), 'two')
      assert.equal(origin.openSyncHandles(), 0)
      assert.ok(origin.paths().every((path) => !path.includes('.zn-tmp-')))
    })

    it('renames a folder by moving its files, never with a folder move()', async () => {
      const origin = new FakeOpfs(engine)
      const fs = await openFs(origin)
      await fs.writeText('Projects/a.md', 'a')
      await fs.writeText('Projects/deep/b.md', 'b')
      await fs.rename('Projects', 'Archive of projects')
      assert.equal(await fs.readText('Archive of projects/a.md'), 'a')
      assert.equal(await fs.readText('Archive of projects/deep/b.md'), 'b')
      assert.equal(await fs.statVerified('Projects'), null)
    })

    it('never moves a folder onto an existing one', async () => {
      const origin = new FakeOpfs(engine)
      const fs = await openFs(origin)
      await fs.writeText('one/a.md', 'a')
      await fs.writeText('two/b.md', 'b')
      await rejectsWithCode(fs.rename('one', 'two'), OPFS_EXISTS)
      assert.equal(await fs.readText('one/a.md'), 'a')
      assert.equal(await fs.readText('two/b.md'), 'b')
      assert.equal(await fs.statVerified('two/a.md'), null)
    })

    it('never renames a file onto another file', async () => {
      const fs = await openFs(new FakeOpfs(engine))
      await fs.writeText('a.md', 'a')
      await fs.writeText('b.md', 'b')
      await rejectsWithCode(fs.rename('a.md', 'b.md'), OPFS_EXISTS)
      assert.equal(await fs.readText('b.md'), 'b')
    })

    it('finishes a folder move a closed tab left half done', async () => {
      const origin = new FakeOpfs(engine)
      const fs = await openFs(origin)
      await fs.writeText('from/a.md', 'a')
      await fs.writeText('from/b.md', 'b')
      await fs.writeText('from/c.md', 'c')
      origin.failMoveAfter(1)
      await assert.rejects(fs.rename('from', 'to'))
      // Half moved: both folders are there.
      assert.equal(await fs.statVerified('from'), 'directory')
      assert.equal(await fs.statVerified('to'), 'directory')
      const reopened = await openFs(origin)
      assert.equal(await reopened.statVerified('from'), null)
      assert.deepEqual((await reopened.readdirStrict('to')).map((entry) => entry.name), ['a.md', 'b.md', 'c.md'])
    })

    it('a case-only rename keeps the one file, under its new spelling', async () => {
      const origin = new FakeOpfs(engine)
      const fs = await openFs(origin)
      await fs.writeText('Note.md', 'body')
      await fs.rename('Note.md', 'note.md')
      assert.deepEqual((await fs.readdirStrict('')).filter((entry) => entry.type === 'file').map((entry) => entry.name), ['note.md'])
      assert.equal(await fs.readText('note.md'), 'body')
      await fs.writeText('Folder/x.md', 'x')
      await fs.rename('Folder', 'folder')
      assert.equal(await fs.readText('folder/x.md'), 'x')
      assert.ok(!origin.paths().includes('Folder/'))
    })

    // Only a store that folds case reaches b/Note.md as b/note.md.
    it.runIf(engine === 'safari')('a rename onto a same-named file in another folder is still refused', async () => {
      const origin = new FakeOpfs(engine)
      const fs = await openFs(origin)
      await fs.writeText('a/Note.md', 'one')
      await fs.writeText('b/Note.md', 'two')
      await assert.rejects(fs.rename('a/Note.md', 'b/note.md'))
      assert.equal(await fs.readText('a/Note.md'), 'one')
      assert.equal(await fs.readText('b/Note.md'), 'two')
    })

    it('refuses names a browser cannot store, everywhere', async () => {
      const fs = await openFs(new FakeOpfs(engine))
      await rejectsWithCode(fs.writeText('back\\slash.md', 'x'), OPFS_BAD_NAME)
      await rejectsWithCode(fs.writeText(`${'a'.repeat(253)}.md`, 'x'), OPFS_BAD_NAME)
      await rejectsWithCode(fs.mkdir(`${'é'.repeat(130)}`), OPFS_BAD_NAME)
      assert.equal(await fs.readTextOrNull('back\\slash.md'), null)
      // 255 bytes exactly is fine.
      await fs.writeText(`${'a'.repeat(252)}.md`, 'ok')
      assert.equal(await fs.readText(`${'a'.repeat(252)}.md`), 'ok')
    })

    it('a tab with an older generation can read but not write', async () => {
      const origin = new FakeOpfs(engine)
      const generations = new Map([['test', 1]])
      const fs = await openFs(origin, { generation: 1, generations })
      await fs.writeText('a.md', 'mine')
      generations.set('test', 2)
      await rejectsWithCode(fs.writeText('a.md', 'stale tab'), OPFS_FENCED)
      await rejectsWithCode(fs.deleteFile('a.md'), OPFS_FENCED)
      await rejectsWithCode(fs.rename('a.md', 'b.md'), OPFS_FENCED)
      assert.equal(await fs.readText('a.md'), 'mine')
    })

    it('the export window reads without writing or making the vault', async () => {
      const origin = new FakeOpfs(engine)
      const owner = await openFs(origin)
      await owner.writeText('inbox/a.md', 'body')
      const before = origin.paths()
      const reader = await openFs(origin, { readOnly: true })
      assert.equal(await reader.readText('inbox/a.md'), 'body')
      await assert.rejects(reader.writeText('inbox/a.md', 'x'), /only reads/)
      await assert.rejects(reader.mkdir('new'), /only reads/)
      assert.deepEqual(origin.paths(), before)
      await assert.rejects(openFs(new FakeOpfs(engine), { readOnly: true }))
    })
  })
}

describe('case folding is probed per vault', () => {
  it('Safari on a Mac folds case, so note.md is Note.md (as on desktop macOS)', async () => {
    const fs = await openFs(new FakeOpfs('safari'))
    assert.equal(fs.foldsCase, true)
    await fs.writeText('Note.md', 'first')
    assert.equal(await fs.statVerified('note.md'), 'file')
    await fs.writeText('note.md', 'second')
    // One file, never two: the write replaced it, and like an atomic write
    // on macOS (temp, then rename) it took the spelling that was written.
    const files = (await fs.readdirStrict('')).filter((entry) => entry.type === 'file')
    assert.equal(files.length, 1)
    assert.equal(await fs.readText('Note.md'), 'second')
  })

  it('Chrome and Firefox keep the two apart', async () => {
    for (const engine of ['chrome', 'firefox'] as const) {
      const fs = await openFs(new FakeOpfs(engine))
      assert.equal(fs.foldsCase, false)
      await fs.writeText('Note.md', 'first')
      await fs.writeText('note.md', 'second')
      assert.equal(await fs.readText('Note.md'), 'first')
      assert.equal(await fs.readText('note.md'), 'second')
    }
  })
})

describe('a PortableVault on the OPFS vault', () => {
  for (const engine of ENGINES) {
    it(`seeds the demo tour, renames, trashes and restores (${engine})`, async () => {
      const origin = new FakeOpfs(engine)
      const fs = await openFs(origin, { vaultKey: 'try' })
      const vault = new PortableVault('Try ZenNotes', fs)
      await vault.open()
      const tour = await vault.generateDemoTour()
      assert.equal(tour.notePaths.length, DEMO_TOUR_NOTES.length)
      const notes = await vault.listNotes()
      assert.ok(notes.some((note) => note.path === 'inbox/demo/00 Start Here.md'))
      const created = await vault.createNote('inbox', 'Groceries')
      await vault.writeNote(created.path, '# Groceries\n\n- tea\n')
      const renamed = await vault.renameNote(created.path, 'Shopping')
      assert.equal((await vault.readNote(renamed.path)).body, '# Groceries\n\n- tea\n')
      const trashed = await vault.moveToTrash(renamed.path)
      assert.ok(trashed.path.startsWith('trash/'))
      const restored = await vault.restoreFromTrash(trashed.path)
      assert.equal((await vault.readNote(restored.path)).body, '# Groceries\n\n- tea\n')
      await vault.renameFolder('inbox', 'demo', 'tour')
      assert.ok((await vault.listNotes()).some((note) => note.path === 'inbox/tour/00 Start Here.md'))
      assert.equal(origin.openSyncHandles(), 0)
      // Reopened as after a reload: the same notes are there.
      const again = new PortableVault('Try ZenNotes', await openFs(origin, { vaultKey: 'try' }))
      await again.open()
      assert.equal((await again.listNotes()).length, notes.length + 1)
    })
  }
})
