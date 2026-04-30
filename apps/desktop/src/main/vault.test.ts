import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  absolutePath,
  appendToNote,
  ensureVaultLayout,
  getVaultSettings,
  listFolders,
  renameFolder,
  searchVaultTextCapabilities,
  setVaultSettings
} from './vault'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('absolutePath', () => {
  it('rejects sibling-prefix escapes outside the vault root', async () => {
    const parent = await makeTempDir('zennotes-vault-parent-')
    const root = path.join(parent, 'vault')
    const sibling = path.join(parent, 'vault-evil')
    await mkdir(root, { recursive: true })
    await mkdir(sibling, { recursive: true })

    expect(() => absolutePath(root, '../vault-evil/secret.md')).toThrow(/Path escapes vault/)
  })

  it('allows paths that stay inside the vault root', async () => {
    const parent = await makeTempDir('zennotes-vault-allowed-')
    const root = path.join(parent, 'vault')
    await mkdir(path.join(root, 'inbox'), { recursive: true })

    expect(absolutePath(root, 'inbox/note.md')).toBe(path.join(root, 'inbox', 'note.md'))
  })
})

describe('appendToNote', () => {
  it('appends to the end with a separating blank line when target lacks trailing newline', async () => {
    const root = await makeTempDir('zennotes-append-end-')
    await ensureVaultLayout(root)
    const rel = 'inbox/quick.md'
    await writeFile(path.join(root, rel), '# Quick\n\nfirst line', 'utf8')

    await appendToNote(root, rel, 'second thought', 'end')

    const next = await readFile(path.join(root, rel), 'utf8')
    expect(next).toBe('# Quick\n\nfirst line\n\nsecond thought\n')
  })

  it('prepends to the start with a separating blank line', async () => {
    const root = await makeTempDir('zennotes-append-start-')
    await ensureVaultLayout(root)
    const rel = 'inbox/quick.md'
    await writeFile(path.join(root, rel), '# Quick\n\noriginal\n', 'utf8')

    await appendToNote(root, rel, 'breaking news', 'start')

    const next = await readFile(path.join(root, rel), 'utf8')
    expect(next).toBe('breaking news\n\n# Quick\n\noriginal\n')
  })

  it('is a no-op when the addition is whitespace-only', async () => {
    const root = await makeTempDir('zennotes-append-empty-')
    await ensureVaultLayout(root)
    const rel = 'inbox/quick.md'
    const original = '# Quick\n\nbody\n'
    await writeFile(path.join(root, rel), original, 'utf8')

    await appendToNote(root, rel, '   \n  ', 'end')

    const next = await readFile(path.join(root, rel), 'utf8')
    expect(next).toBe(original)
  })
})

describe('renameFolder', () => {
  it('can promote a nested inbox folder to the vault root in root mode', async () => {
    const root = await makeTempDir('zennotes-rename-root-mode-')
    await ensureVaultLayout(root)
    const settings = await getVaultSettings(root)
    await setVaultSettings(root, { ...settings, primaryNotesLocation: 'root' })
    await mkdir(path.join(root, 'inbox', 'demo'), { recursive: true })
    await writeFile(path.join(root, 'inbox', 'demo', 'Start.md'), '# Start\n', 'utf8')

    const next = await renameFolder(root, 'inbox', 'inbox/demo', 'demo')

    expect(next).toBe('demo')
    await expect(readFile(path.join(root, 'demo', 'Start.md'), 'utf8')).resolves.toBe(
      '# Start\n'
    )
    const folders = await listFolders(root)
    expect(folders.some((folder) => folder.folder === 'inbox' && folder.subpath === 'demo')).toBe(
      true
    )
  })
})

describe('searchVaultTextCapabilities', () => {
  it('treats invalid custom executable paths as unavailable', async () => {
    const root = await makeTempDir('zennotes-search-tools-')
    const fake = path.join(root, 'evil-tool')
    await writeFile(fake, 'not a real search binary', 'utf8')

    const capabilities = await searchVaultTextCapabilities(
      { ripgrepPath: fake, fzfPath: fake },
      true
    )

    expect(capabilities.ripgrep).toBe(false)
    expect(capabilities.fzf).toBe(false)
  })
})
