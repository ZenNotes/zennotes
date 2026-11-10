/**
 * What every VaultFileSystem must do beyond its signatures: the phones'
 * NativeFs (Capacitor, iCloud, SAF), the browser's OPFS worker, and the test
 * double. Cloud sync turns these answers into deletes and conflicts, so an
 * adapter that reads a failure as an empty folder or a missing file would
 * plan the deletion of a vault it could not read. Each case throws on a
 * violation, with no test framework of its own, so a host runs them in
 * whatever runner it has:
 *
 *   for (const check of vaultFileSystemContract) it(check.name, () => check.run(harness))
 *
 * The harness gives the cases a store to break. `breakStorage` makes every
 * later operation fail the way storage fails in practice (a permission
 * revoked, a provider gone, a Keychain item out of reach), never with a
 * not-found error; `restoreStorage` undoes it.
 */
import type { VaultFileSystem } from './host'

export interface VaultFileSystemContractHarness<F extends VaultFileSystem = VaultFileSystem> {
  /** A fresh file system on empty storage, already through init(). */
  create(): Promise<F>
  /** A second file system on the same storage, as after a relaunch. */
  reopen(fs: F): Promise<F>
  breakStorage(fs: F): void
  restoreStorage(fs: F): void
}

export interface VaultFileSystemContractCase {
  name: string
  run<F extends VaultFileSystem>(harness: VaultFileSystemContractHarness<F>): Promise<void>
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`VaultFileSystem contract: ${message}`)
}

async function rejects(operation: Promise<unknown>, message: string): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error(`VaultFileSystem contract: ${message}`)
}

async function broken<F extends VaultFileSystem>(
  harness: VaultFileSystemContractHarness<F>,
  fs: F,
  body: () => Promise<void>
): Promise<void> {
  harness.breakStorage(fs)
  try {
    await body()
  } finally {
    harness.restoreStorage(fs)
  }
}

export const vaultFileSystemContract: VaultFileSystemContractCase[] = [
  {
    name: 'readdirStrict throws when storage fails, where readdir answers []',
    async run(harness) {
      const fs = await harness.create()
      await fs.writeText('notes/a.md', 'a')
      await broken(harness, fs, async () => {
        const error = await rejects(fs.readdirStrict('notes'), 'readdirStrict answered a failed listing (an empty answer there plans a delete for every tracked item)')
        check(!fs.isNotFound(error), 'a failed listing is not a verified absence')
        const lenient = await fs.readdir('notes')
        check(Array.isArray(lenient) && lenient.length === 0, 'readdir maps a failure to []')
      })
      const listed = await fs.readdirStrict('notes')
      check(listed.some((entry) => entry.name === 'a.md' && entry.type === 'file'), 'readdirStrict lists what is there once storage answers again')
    }
  },
  {
    name: 'readdirStrict throws for a folder that does not exist',
    async run(harness) {
      const fs = await harness.create()
      await rejects(fs.readdirStrict('missing'), 'readdirStrict answered for a missing folder')
      const lenient = await fs.readdir('missing')
      check(lenient.length === 0, 'readdir answers [] for a missing folder')
    }
  },
  {
    name: 'statVerified answers null only for a verified absence',
    async run(harness) {
      const fs = await harness.create()
      await fs.writeText('notes/a.md', 'a')
      check(await fs.statVerified('notes/a.md') === 'file', 'a file stats as file')
      check(await fs.statVerified('notes') === 'directory', 'a folder stats as directory')
      check(await fs.statVerified('notes/missing.md') === null, 'a missing file stats as null')
      await broken(harness, fs, async () => {
        await rejects(fs.statVerified('notes/a.md'), 'statVerified answered while storage failed (null there drives deletes and conflicts)')
      })
    }
  },
  {
    name: 'readTextOrNull answers null only for a missing file, and isNotFound tells the two apart',
    async run(harness) {
      const fs = await harness.create()
      await fs.writeText('a.md', 'body')
      check(await fs.readTextOrNull('missing.md') === null, 'a missing file reads as null')
      check(fs.isNotFound(await rejects(fs.readText('missing.md'), 'readText of a missing file resolved')), 'isNotFound recognizes a missing file')
      await broken(harness, fs, async () => {
        const error = await rejects(fs.readTextOrNull('a.md'), 'readTextOrNull answered while storage failed')
        check(!fs.isNotFound(error), 'isNotFound reads a storage failure as absence')
      })
    }
  },
  {
    name: 'writes make their folders, and text and base64 read back byte for byte',
    async run(harness) {
      const fs = await harness.create()
      await fs.writeText('deep/er/note.md', 'caf\u00e9 \u2603\n')
      check(await fs.readText('deep/er/note.md') === 'caf\u00e9 \u2603\n', 'text reads back as written')
      check(await fs.readBase64('deep/er/note.md') === 'Y2Fmw6kg4piDCg==', 'readBase64 is the UTF-8 bytes')
      await fs.writeBase64('assets/bytes.bin', 'AP8BAg==')
      check(await fs.readBase64('assets/bytes.bin') === 'AP8BAg==', 'base64 reads back as written')
      check(await fs.statVerified('deep/er') === 'directory', 'a write makes its parent folders')
    }
  },
  {
    name: 'writeGeneration moves with every change and stands still for reads',
    async run(harness) {
      const fs = await harness.create()
      const changes: Array<[string, () => Promise<unknown>]> = [
        ['writeText', () => fs.writeText('a.md', 'a')],
        ['writeBase64', () => fs.writeBase64('b.bin', 'AQ==')],
        ['mkdir', () => fs.mkdir('folder')],
        ['rename', () => fs.rename('a.md', 'folder/a.md')],
        ['copy', () => fs.copy('folder/a.md', 'c.md')],
        ['deleteFile', () => fs.deleteFile('c.md')],
        ['rmdir', () => fs.rmdir('folder')]
      ]
      for (const [name, change] of changes) {
        const before = fs.writeGeneration
        await change()
        check(fs.writeGeneration > before, `${name} did not move writeGeneration (a walk could reuse a listing taken before it)`)
      }
      const before = fs.writeGeneration
      await fs.readdir('')
      await fs.readTextOrNull('b.bin')
      await fs.statVerified('b.bin')
      check(fs.writeGeneration === before, 'a read moved writeGeneration')
    }
  },
  {
    name: 'rmdirIfEmpty refuses a folder that holds anything',
    async run(harness) {
      const fs = await harness.create()
      await fs.writeText('full/a.md', 'a')
      await rejects(fs.rmdirIfEmpty('full'), 'rmdirIfEmpty removed a folder holding a note')
      check(await fs.readTextOrNull('full/a.md') === 'a', 'the note survives')
      await fs.mkdir('empty')
      await fs.rmdirIfEmpty('empty')
      check(await fs.statVerified('empty') === null, 'an empty folder goes')
    }
  },
  {
    name: 'syncKey is the same for the same vault after a relaunch',
    async run(harness) {
      const fs = await harness.create()
      check(typeof fs.syncKey === 'string' && fs.syncKey.length > 0, 'syncKey is a non-empty string')
      const again = await harness.reopen(fs)
      check(again.syncKey === fs.syncKey, 'syncKey changed across a relaunch (every Cloud link, sync state and scan cache is keyed on it)')
    }
  }
]
