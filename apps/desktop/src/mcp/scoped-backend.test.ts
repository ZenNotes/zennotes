import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_TOOL_ACCESS, mcpScopeInstructions, newMcpScope } from '@shared/mcp-scope'
import { parse } from '../cli/args'
import { createBackend, type VaultBackend } from '../cli/backend'
import { mcpScopeFromArgs } from '../cli/commands/mcp'
import { ScopedBackend, scrubVaultRoot } from './scoped-backend'
import { callTool, describeToolError, listToolNames, runMcpServer } from './server'

// What the shared fixture (bridge-contract/fixtures/mcp-scope.json, run by
// scope-contract.test.ts) cannot reach: a server-backed vault, error text from
// the filesystem, the server instructions and the launch flags. zn's own
// tests (internal/mcp/scope_test.go in ZenNotes/tui) cover the same ground.

const shared = newMcpScope({ access: 'write', allow: ['Projects'], deny: ['Projects/Clients'] })

let root: string

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-scoped-'))
  const files: Record<string, string> = {
    '.zennotes/vault.json': '{"primaryNotesLocation":"root"}',
    'Projects/Plan.md': '# Plan\n',
    'Projects/Clients/Acme.md': '# Acme\n',
    'Journal/Diary.md': '# Diary\n\nabout [[Plan]]\n'
  }
  for (const [rel, body] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fsp.writeFile(path.join(root, rel), body)
  }
  vi.stubEnv('ZENNOTES_CONFIG_DIR', path.join(root, '.config'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await fsp.rm(root, { recursive: true, force: true })
})

/** A local vault dressed as a server's: a server rewrites inbound links in
 *  every note itself, which is what the remote checks key on. */
function serverBacked(): VaultBackend {
  const local = createBackend({ kind: 'local', root })
  return {
    ...local,
    kind: 'remote',
    root: '',
    label: 'home (http://10.0.0.5:7878)',
    describe: async () => ({
      kind: 'remote',
      baseUrl: 'http://10.0.0.5:7878',
      name: 'home',
      vaultPath: '/srv/notes',
      vaultName: 'notes',
      primaryNotesLocation: 'root',
      authConfigured: true
    })
  } as VaultBackend
}

describe('every MCP tool has an access class', () => {
  it('classifies exactly the tools the server registers', () => {
    expect([...listToolNames()].sort()).toEqual(Object.keys(MCP_TOOL_ACCESS).sort())
  })
})

describe('a scoped client on a ZenNotes server', () => {
  it('cannot rename, since the server would rewrite links in notes it cannot see', async () => {
    const backend = serverBacked()
    const rename = vi.spyOn(backend, 'renameNote')
    await expect(
      callTool('rename_note', { path: 'Projects/Plan.md', newTitle: 'Other' }, backend, shared)
    ).rejects.toThrow('the server rewrites links in every note')
    expect(rename).not.toHaveBeenCalled()
    await expect(fsp.stat(path.join(root, 'Projects', 'Plan.md'))).resolves.toBeTruthy()
  })

  it('still renames when it sees the whole vault', async () => {
    const backend = serverBacked()
    const scope = newMcpScope({ access: 'write' })
    await expect(
      callTool('rename_note', { path: 'Projects/Plan.md', newTitle: 'Other' }, backend, scope)
    ).resolves.toMatchObject({ path: 'Projects/Other.md' })
  })

  it('learns the server and its layout from vault_info, not where the server keeps the vault', async () => {
    const info = (await callTool('vault_info', {}, serverBacked(), shared)) as Record<string, unknown>
    expect(Object.keys(info)).toEqual([
      'kind',
      'server',
      'serverName',
      'primaryNotesLocation',
      'topFolders',
      'subfolders',
      'access',
      'notes'
    ])
    expect(info).toMatchObject({ kind: 'remote', server: 'http://10.0.0.5:7878', serverName: 'home' })
    expect(JSON.stringify(info)).not.toContain('/srv/notes')
  })
})

describe('a local scoped client', () => {
  it('renames a note it sees without writing into the ones it does not', async () => {
    const backend = createBackend({ kind: 'local', root })
    await callTool('rename_note', { path: 'Projects/Plan.md', newTitle: 'Plan B' }, backend, shared)
    await expect(fsp.readFile(path.join(root, 'Journal', 'Diary.md'), 'utf8')).resolves.toBe(
      '# Diary\n\nabout [[Plan]]\n'
    )
  })

  it('cannot give a note a name it could not see', async () => {
    const backend = createBackend({ kind: 'local', root })
    const narrow = newMcpScope({ access: 'write', allow: ['Projects/Plan.md'] })
    await expect(
      callTool('rename_note', { path: 'Projects/Plan.md', newTitle: 'Elsewhere' }, backend, narrow)
    ).rejects.toThrow('This assistant cannot give the note that name.')
  })

  it('gets errors without the vault’s absolute path', () => {
    const local = createBackend({ kind: 'local', root })
    const failure = new Error(`EACCES: permission denied, open '${path.join(root, 'Projects', 'Plan.md')}'`)
    const scoped = describeToolError(failure, null, new ScopedBackend(local, shared))
    expect(scoped).not.toContain(root)
    expect(scoped).toContain('Projects/Plan.md')
    expect(describeToolError(failure, null, local)).toContain(root)
  })

  // PR #1019's Windows runs: the error named `Projects\Plan.md` once the root
  // was gone, not the vault path the tools report.
  it('names a Windows path the way the tools do, with forward slashes', () => {
    const winRoot = 'C:\\Users\\ada\\Notes'
    const failure = `EACCES: permission denied, open '${winRoot}\\Projects\\Plan.md'`
    expect(scrubVaultRoot(failure, winRoot, '\\')).toBe(
      "EACCES: permission denied, open 'Projects/Plan.md'"
    )
    expect(scrubVaultRoot(`cannot read ${winRoot}`, winRoot, '\\')).toBe('cannot read the vault')
    expect(scrubVaultRoot(`a '${winRoot}\\A\\B.md' and '${winRoot}\\C.md'`, winRoot, '\\')).toBe(
      "a 'A/B.md' and 'C.md'"
    )
  })
})

describe('the server under a scope', () => {
  async function instructionsFor(scope: ReturnType<typeof newMcpScope> | null): Promise<string> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await runMcpServer({
      resolveTarget: async () => ({ kind: 'local', root }),
      scope,
      transport: serverTransport
    })
    const client = new Client({ name: 'scope-test', version: '0' })
    await client.connect(clientTransport)
    const text = client.getInstructions() ?? ''
    await client.close()
    return text
  }

  it('tells the model what it can reach', async () => {
    const scope = newMcpScope({ access: 'read', allow: ['Projects'] })
    expect((await instructionsFor(scope)).endsWith(mcpScopeInstructions(scope))).toBe(true)
    expect(await instructionsFor(null)).not.toContain('## Access')
  })

  it('names a stale deny entry on stderr once, and never to the model', async () => {
    const stderr: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    const backend = createBackend({ kind: 'local', root })
    const stale = newMcpScope({ access: 'read', deny: ['Renamed Elsewhere'] })
    for (let i = 0; i < 2; i++) {
      await expect(callTool('list_notes', {}, backend, stale)).rejects.toThrow('nothing is shared')
    }
    expect(stderr.filter((line) => line.includes('Renamed Elsewhere'))).toHaveLength(1)
  })
})

describe('scope flags on the command line', () => {
  it('reads zn mcp’s flags, with --read-only as a switch', () => {
    const scope = mcpScopeFromArgs(
      parse(['--read-only', '--allow-path', '/projects', '--allow-path', 'Areas/Health', '--deny-path', 'Projects/Clients'])
    )
    expect(scope).toEqual({
      access: 'read',
      allow: ['projects', 'Areas/Health'],
      deny: ['Projects/Clients']
    })
    // A switch never swallows the next token.
    expect(parse(['--read-only', 'inbox']).positionals).toEqual(['inbox'])
    expect(mcpScopeFromArgs(parse(['--access', 'comment']))).toMatchObject({ access: 'comment' })
  })

  it('means full access without them, and refuses a bad entry', () => {
    expect(mcpScopeFromArgs(parse(['--vault', 'work']))).toBeNull()
    expect(() => mcpScopeFromArgs(parse(['--allow-path', '.zennotes']))).toThrow(
      '--allow-path ".zennotes" names a hidden folder'
    )
  })
})
