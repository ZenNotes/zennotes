import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedArgs } from '../args'
import {
  cmdAssetImport,
  cmdAssetList,
  cmdAssetRestore,
  cmdAssetTrash
} from './assets'

const roots: string[] = []
let stdout: string[]

function makeArgs(positionals: string[] = [], flags: Array<[string, string]> = []): ParsedArgs {
  return { positionals, flags: new Map(flags.map(([key, value]) => [key, [value]])) }
}

async function makeVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cli-assets-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'inbox'), { recursive: true })
  await fs.mkdir(path.join(root, 'quick'), { recursive: true })
  await fs.mkdir(path.join(root, 'archive'), { recursive: true })
  await fs.mkdir(path.join(root, 'trash'), { recursive: true })
  return root
}

beforeEach(() => {
  stdout = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('asset CLI commands', () => {
  it('imports, lists, trashes, and restores managed assets', async () => {
    const root = await makeVault()
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cli-assets-source-'))
    roots.push(sourceDir)
    const sourcePdf = path.join(sourceDir, 'Brief.pdf')
    await fs.writeFile(sourcePdf, 'pdf-bytes', 'utf8')

    await cmdAssetImport(root, makeArgs([sourcePdf], [['json', 'true']]))
    const [imported] = JSON.parse(stdout.join(''))
    expect(imported).toMatchObject({
      name: 'Brief.pdf',
      kind: 'pdf',
      managed: true
    })
    expect(imported.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(imported.path).toBe(`assets/${imported.id}.asset`)
    expect(imported.sourcePath).toBe(`${imported.path}/source.pdf`)

    stdout = []
    await cmdAssetList(root, makeArgs([], [['json', 'true']]))
    expect(JSON.parse(stdout.join(''))).toEqual([expect.objectContaining({ id: imported.id })])

    stdout = []
    await cmdAssetTrash(root, makeArgs([imported.sourcePath], [['json', 'true']]))
    const trashResult = JSON.parse(stdout.join(''))
    expect(trashResult.handle).toMatch(/^trash\//)
    await expect(fs.readFile(path.join(root, imported.sourcePath), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })

    stdout = []
    await cmdAssetRestore(root, makeArgs([trashResult.handle], [['json', 'true']]))
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      id: imported.id,
      path: imported.path,
      sourcePath: imported.sourcePath
    })
    await expect(fs.readFile(path.join(root, imported.sourcePath), 'utf8')).resolves.toBe(
      'pdf-bytes'
    )
  })
})
