// The shared scoped-access contract (ZenNotes/tui#21), run against this
// engine the way a client reaches it: a real vault on disk, the stdio
// server's handlers over an in-memory transport. The Go `zn mcp` runs the same
// fixture in internal/mcp/scope_contract_test.go (ZenNotes/tui), so both
// engines give one client the same answers byte for byte. When a case fails,
// settle which behavior is intended before touching the fixture; never copy
// one engine's output into it.
import { promises as fsp, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareMcpScopePaths, newMcpScope, type McpScopeFlags } from '@shared/mcp-scope'
import { runMcpServer } from './server'

interface VaultSeed {
  files: Record<string, string>
  symlinks?: Record<string, string>
  outside?: Record<string, string>
}

interface Expectation {
  error?: string
  ok?: boolean
  notOffered?: boolean
  paths?: string[]
  folders?: string[]
  match?: unknown
  contains?: string[]
  excludes?: string[]
  absentKeys?: string[]
}

interface ContractCase {
  id: string
  vault: string
  flags: McpScopeFlags | null
  tools?: {
    count?: number
    exactly?: string[]
    include?: string[]
    absent?: string[]
    annotations?: Record<string, Record<string, unknown>>
  }
  calls: { tool: string; args: Record<string, unknown>; expect: Expectation }[]
  disk?: { exists?: string[]; absent?: string[]; equals?: Record<string, string> }
}

interface Fixture {
  schemaVersion: number
  vaults: Record<string, VaultSeed>
  flagCases: {
    id: string
    flags: McpScopeFlags
    scope?: { access: string; allow: string[]; deny: string[] }
    error?: string
  }[]
  cases: ContractCase[]
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../packages/bridge-contract/fixtures/mcp-scope.json', import.meta.url)
    ),
    'utf8'
  )
) as Fixture

const sorted = (values: string[]): string[] => [...values].sort(compareMcpScopePaths)

async function seed(base: string, vault: VaultSeed): Promise<string> {
  const root = path.join(base, 'vault')
  const write = async (dir: string, files: Record<string, string>): Promise<void> => {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, ...rel.split('/'))
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      await fsp.writeFile(abs, body, 'utf8')
    }
  }
  await write(root, vault.files)
  await write(path.join(base, 'outside'), vault.outside ?? {})
  for (const [rel, target] of Object.entries(vault.symlinks ?? {})) {
    await fsp.symlink(target, path.join(root, ...rel.split('/')))
  }
  return root
}

/** Every key the fixture names matches; arrays match element for element. */
function expectMatch(actual: unknown, expected: unknown, where: string): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), where).toBe(true)
    const list = actual as unknown[]
    expect(list.length, where).toBe(expected.length)
    expected.forEach((item, i) => expectMatch(list[i], item, `${where}[${i}]`))
    return
  }
  if (expected && typeof expected === 'object') {
    expect(actual && typeof actual === 'object' && !Array.isArray(actual), where).toBe(true)
    for (const [key, value] of Object.entries(expected)) {
      expectMatch((actual as Record<string, unknown>)[key], value, `${where}.${key}`)
    }
    return
  }
  expect(actual, where).toBe(expected)
}

describe('shared scoped-access contract: flags', () => {
  it('is a fixture this runner understands', () => {
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it.each(fixture.flagCases)('$id', (c) => {
    if (c.error) {
      expect(() => newMcpScope(c.flags)).toThrow(c.error)
      try {
        newMcpScope(c.flags)
      } catch (err) {
        expect((err as Error).message).toBe(c.error)
      }
      return
    }
    expect(newMcpScope(c.flags)).toEqual(c.scope)
  })
})

describe('shared scoped-access contract: tools on a real vault', () => {
  let base: string

  beforeEach(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-scope-'))
    await fsp.mkdir(path.join(base, 'config'), { recursive: true })
    vi.stubEnv('ZENNOTES_CONFIG_DIR', path.join(base, 'config'))
    vi.stubEnv('ZENNOTES_USER_DATA_PATH', path.join(base, 'config'))
    // The stale-deny hint goes to stderr, which is the client's log.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fsp.rm(base, { recursive: true, force: true })
  })

  it.each(fixture.cases)('$id', async (c) => {
    const root = await seed(base, fixture.vaults[c.vault])
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await runMcpServer({
      resolveTarget: async () => ({ kind: 'local', root }),
      scope: c.flags ? newMcpScope(c.flags) : null,
      transport: serverTransport
    })
    const client = new Client({ name: 'scope-contract', version: '0' })
    await client.connect(clientTransport)
    try {
      if (c.tools) {
        const listed = (await client.listTools()).tools
        const names = sorted(listed.map((t) => t.name))
        if (c.tools.count != null) expect(names.length, 'tool count').toBe(c.tools.count)
        if (c.tools.exactly) expect(names).toEqual(sorted(c.tools.exactly))
        for (const name of c.tools.include ?? []) expect(names).toContain(name)
        for (const name of c.tools.absent ?? []) expect(names).not.toContain(name)
        for (const [name, annotations] of Object.entries(c.tools.annotations ?? {})) {
          expect(listed.find((t) => t.name === name)?.annotations, name).toEqual(annotations)
        }
      }

      for (const call of c.calls) {
        const where = `${call.tool} ${JSON.stringify(call.args)}`
        let text = ''
        let failed = false
        try {
          const result = await client.callTool({ name: call.tool, arguments: call.args })
          text = (result.content as { text: string }[])[0]?.text ?? ''
          failed = !!result.isError
        } catch (err) {
          text = err instanceof Error ? err.message : String(err)
          failed = true
        }
        const e = call.expect
        if (e.notOffered) {
          expect(failed, where).toBe(true)
          continue
        }
        if (e.error != null) {
          expect(failed, where).toBe(true)
          expect(text, where).toBe(`Error: ${e.error}`)
        }
        if (e.ok || e.paths || e.folders || e.match !== undefined || e.absentKeys) {
          expect(failed, `${where}: ${text}`).toBe(false)
        }
        if (e.paths) {
          const notes = JSON.parse(text) as { path: string }[]
          expect(sorted(notes.map((n) => n.path)), where).toEqual(sorted(e.paths))
        }
        if (e.folders) {
          const folders = JSON.parse(text) as { folder: string; subpath: string }[]
          expect(sorted(folders.map((f) => `${f.folder}:${f.subpath}`)), where).toEqual(
            sorted(e.folders)
          )
        }
        if (e.match !== undefined) expectMatch(JSON.parse(text), e.match, where)
        if (e.absentKeys) {
          const object = JSON.parse(text) as Record<string, unknown>
          for (const key of e.absentKeys) expect(object, where).not.toHaveProperty(key)
        }
        // A tool answering in JSON spells a Windows root with its backslashes
        // doubled, so `$VAULT` is the root either way: one spelling must show
        // where the fixture expects it, and neither may leak where it must not.
        const spellings = (needle: string): string[] =>
          needle.includes('$VAULT')
            ? [...new Set([root, JSON.stringify(root).slice(1, -1)])].map((r) =>
                needle.replace('$VAULT', r)
              )
            : [needle]
        for (const needle of e.contains ?? []) {
          expect(
            spellings(needle).some((s) => text.includes(s)),
            `${where}: contains ${needle}`
          ).toBe(true)
        }
        for (const needle of e.excludes ?? []) {
          for (const s of spellings(needle)) expect(text, where).not.toContain(s)
        }
      }

      const at = (rel: string): string => path.join(root, ...rel.split('/'))
      for (const rel of c.disk?.exists ?? []) {
        await expect(fsp.lstat(at(rel)), `${rel} exists`).resolves.toBeTruthy()
      }
      for (const rel of c.disk?.absent ?? []) {
        await expect(fsp.lstat(at(rel)), `${rel} is absent`).rejects.toThrow()
      }
      for (const [rel, body] of Object.entries(c.disk?.equals ?? {})) {
        expect(await fsp.readFile(at(rel), 'utf8'), rel).toBe(body)
      }
    } finally {
      await client.close()
    }
  })
})
