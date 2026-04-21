import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { absolutePath, searchVaultTextCapabilities } from './vault'

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
