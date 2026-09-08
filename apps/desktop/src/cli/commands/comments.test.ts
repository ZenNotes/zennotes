import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackend, type VaultBackend } from '../backend'
import type { ParsedArgs } from '../args'
import { cmdCommentAdd, cmdCommentList, cmdCommentReply, cmdCommentResolve } from './comments'

// `zn comment` (#738) against a folder vault: the same sidecar the app and
// the MCP tools read, so a thread started here shows up in the panel.

function args(positionals: string[], flags: Array<[string, string]> = []): ParsedArgs {
  return { positionals, flags: new Map(flags.map(([k, v]) => [k, [v]])) }
}

let root: string
let backend: VaultBackend
let out: string[]

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-comment-cli-'))
  await fsp.mkdir(path.join(root, 'inbox'), { recursive: true })
  await fsp.writeFile(path.join(root, 'inbox', 'Plan.md'), '# Plan\n\nShip the beta in October.\n')
  backend = createBackend({ kind: 'local', root })
  out = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fsp.rm(root, { recursive: true, force: true })
})

describe('zn comment', () => {
  it('adds, lists, answers and resolves a thread', async () => {
    await cmdCommentAdd(
      backend,
      args(['inbox/Plan.md', 'Still realistic?'], [['anchor', 'Ship the beta in October.']])
    )
    expect(out.join('')).toMatch(/Commented on inbox\/Plan\.md \(.+, line 3\)/)

    out = []
    await cmdCommentList(backend, args(['inbox/Plan.md'], [['json', 'true']]))
    const threads = JSON.parse(out.join('')) as Array<{ id: string; author: string | null; line: number }>
    expect(threads).toHaveLength(1)
    expect(threads[0].author).toBeNull()
    expect(threads[0].line).toBe(3)

    out = []
    await cmdCommentReply(
      backend,
      args(['inbox/Plan.md', threads[0].id, 'Yes, the blocker runs at night.'], [['author', 'Claude']])
    )
    expect(out.join('')).toContain('Replied in')

    out = []
    await cmdCommentList(backend, args(['inbox/Plan.md']))
    const text = out.join('')
    expect(text).toContain('You')
    expect(text).toContain('> Ship the beta in October.')
    expect(text).toContain('Claude')
    expect(text).toContain('Yes, the blocker runs at night.')

    out = []
    await cmdCommentResolve(backend, args(['inbox/Plan.md', threads[0].id]))
    expect(out.join('')).toContain('Resolved')
    out = []
    await cmdCommentList(backend, args(['inbox/Plan.md']))
    expect(out.join('')).toContain('No open comments')
    out = []
    await cmdCommentList(backend, args(['inbox/Plan.md'], [['all', 'true']]))
    expect(out.join('')).toContain('(resolved)')
  })

  it('explains usage when the path or body is missing', async () => {
    await expect(cmdCommentAdd(backend, args([]))).rejects.toThrow(/Usage: zn comment add/)
    await expect(cmdCommentAdd(backend, args(['inbox/Plan.md']))).rejects.toThrow(/Usage: zn comment add/)
    await expect(cmdCommentReply(backend, args(['inbox/Plan.md']))).rejects.toThrow(/Usage: zn comment reply/)
    await expect(cmdCommentResolve(backend, args(['inbox/Plan.md']))).rejects.toThrow(/Usage: zn comment resolve/)
  })
})
