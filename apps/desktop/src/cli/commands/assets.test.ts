import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackend } from '../backend'
import type { ParsedArgs } from '../args'
import { cmdAssetGet, cmdAssetList } from './assets'

function makeArgs(positionals: string[], flags: Array<[string, string]> = []): ParsedArgs {
  const map = new Map<string, string[]>()
  for (const [k, v] of flags) map.set(k, [...(map.get(k) ?? []), v])
  return { positionals, flags: map }
}

let tmpDir: string
let root: string
let out: string[]
let binChunks: Uint8Array[]

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-assets-cli-'))
  root = path.join(tmpDir, 'vault')
  await fsp.mkdir(path.join(root, 'assets'), { recursive: true })
  await fsp.writeFile(path.join(root, 'assets', 'pic.png'), 'PNGDATA')
  await fsp.writeFile(path.join(root, 'assets', 'doc.pdf'), '%PDF-1.4')
})

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  out = []
  binChunks = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    if (typeof chunk === 'string') out.push(chunk)
    else binChunks.push(chunk)
    return true
  })
})

const backend = (): ReturnType<typeof createBackend> => createBackend({ kind: 'local', root })

describe('zn asset list', () => {
  it('lists assets with size and path', async () => {
    await cmdAssetList(backend(), makeArgs([]))
    const text = out.join('')
    expect(text).toContain('assets/pic.png')
    expect(text).toContain('assets/doc.pdf')
  })

  it('emits JSON with --json', async () => {
    await cmdAssetList(backend(), makeArgs([], [['json', 'true']]))
    const rows = JSON.parse(out.join('')) as Array<{ path: string; size: number }>
    expect(rows.map((r) => r.path)).toContain('assets/pic.png')
    expect(rows.find((r) => r.path === 'assets/pic.png')?.size).toBe(7)
  })
})

describe('zn asset get', () => {
  it('writes the raw bytes to stdout', async () => {
    await cmdAssetGet(backend(), makeArgs(['assets/pic.png']))
    // The mocked write records Uint8Array chunks untouched, so decode the
    // first binary chunk before comparing.
    expect(new TextDecoder().decode(binChunks[0])).toBe('PNGDATA')
  })

  it('saves to --output and reports the byte count', async () => {
    const dest = path.join(tmpDir, 'out', 'copy.png')
    await cmdAssetGet(backend(), makeArgs(['assets/pic.png'], [['output', dest]]))
    expect(await fsp.readFile(dest, 'utf8')).toBe('PNGDATA')
    expect(out.join('')).toContain(`Wrote 7 bytes to ${dest}`)
  })

  it('rejects paths that escape the vault', async () => {
    await expect(
      cmdAssetGet(backend(), makeArgs(['../../../etc/passwd']))
    ).rejects.toThrow(/escapes vault/)
  })

  it('rejects missing assets', async () => {
    await expect(cmdAssetGet(backend(), makeArgs(['assets/nope.png']))).rejects.toThrow()
  })
})
