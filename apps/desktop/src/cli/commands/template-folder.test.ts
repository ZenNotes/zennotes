import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackend } from '../backend'
import type { ParsedArgs } from '../args'
import { cmdList } from './notes'
import { cmdSearch, cmdSearchTitle } from './search'
import { cmdTagFind, cmdTagList } from './tags'

// #1024: a vault's template folder holds placeholders for the notes it makes.
// `zn search` and the tag commands leave its notes out, as the app, the MCP
// server and the Go server do; `zn search-title` and a plain `zn list` still
// reach them, which is how a template is found to edit.

function makeArgs(flags: Array<[string, string]> = [], positionals: string[] = []): ParsedArgs {
  const map = new Map<string, string[]>()
  for (const [k, v] of flags) map.set(k, [...(map.get(k) ?? []), v])
  return { positionals, flags: map }
}

let tmpDir: string
let root: string
let out: string[]

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-template-cli-'))
  root = path.join(tmpDir, 'vault')
  await fsp.mkdir(path.join(root, 'Templates', 'Work'), { recursive: true })
  await fsp.mkdir(path.join(root, '.zennotes'), { recursive: true })
  await fsp.writeFile(
    path.join(root, '.zennotes', 'vault.json'),
    JSON.stringify({ primaryNotesLocation: 'root', templates: { folder: 'Templates' } })
  )
  await fsp.writeFile(path.join(root, 'Standup.md'), '# Standup\n\nagenda #meeting\n')
  await fsp.writeFile(
    path.join(root, 'Templates', 'Meeting.md'),
    '# Meeting\n\nagenda #meeting #agenda-only\n'
  )
  await fsp.writeFile(path.join(root, 'Templates', 'Work', 'Retro.md'), '# Retro\n\nagenda #retro\n')
})

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  out = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const backend = (): ReturnType<typeof createBackend> => createBackend({ kind: 'local', root })
const json = (): unknown => JSON.parse(out.join(''))
const paths = (): string[] => (json() as Array<{ path: string }>).map((row) => row.path).sort()

describe('the template folder on the command line (#1024)', () => {
  it('zn search finds no template, and spends --limit on real notes', async () => {
    await cmdSearch(backend(), makeArgs([['json', 'true']], ['agenda']))
    expect(paths()).toEqual(['Standup.md'])
    out = []
    await cmdSearch(backend(), makeArgs([['json', 'true'], ['limit', '1']], ['agenda']))
    expect(paths()).toEqual(['Standup.md'])
  })

  it('zn tag list counts no tag a template carries', async () => {
    await cmdTagList(backend(), makeArgs([['json', 'true']]))
    expect(json()).toEqual([{ tag: 'meeting', count: 1 }])
  })

  it('zn tag find and zn list --tag return no template', async () => {
    await cmdTagFind(backend(), makeArgs([['json', 'true']], ['meeting']))
    expect(paths()).toEqual(['Standup.md'])
    out = []
    await cmdList(backend(), makeArgs([['json', 'true'], ['tag', 'meeting']]))
    expect(paths()).toEqual(['Standup.md'])
  })

  it('zn list and zn search-title still reach the templates', async () => {
    await cmdList(backend(), makeArgs([['json', 'true']]))
    expect(paths()).toEqual(['Standup.md', 'Templates/Meeting.md', 'Templates/Work/Retro.md'])
    out = []
    await cmdSearchTitle(backend(), makeArgs([['json', 'true']], ['retro']))
    expect(paths()).toEqual(['Templates/Work/Retro.md'])
  })
})
