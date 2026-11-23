import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The installer reads home from Electron and the client config dirs from
// XDG_CONFIG_HOME; both point into a temp dir so no test can touch a real
// ~/.config/opencode.
let homeDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return homeDir
      throw new Error(`unexpected app.getPath(${name})`)
    }
  }
}))

vi.mock('./cli-install', () => ({
  findManagedCliBinary: async () => '/usr/local/bin/zn'
}))

// The installer refuses to register a server whose compiled entry is
// missing, and in a test run `mcp.js` next to this source file never
// exists. Report it present; every other access goes to the real disk.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: async (p: string, mode?: number) =>
        p.endsWith(`${path.sep}mcp.js`) ? undefined : actual.promises.access(p, mode)
    }
  }
})

import { installMcpForClient, uninstallMcpForClient, getMcpClientStatuses } from './mcp-integrations'

// The shape the OpenCode docs show, with the comments and trailing commas
// OpenCode accepts. Before #1104 was fixed, Install replaced all of this
// with a file holding only the ZenNotes entry.
const COMMENTED_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  // Local models through Ollama.
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:11434/v1" }, // default port
      "models": { "qwen3:8b": {} },
    },
  },
  "model": "ollama/qwen3:8b",
}
`

let root = ''
let ocDir = ''
let savedXdg: string | undefined

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zn-mcp-integrations-'))
  homeDir = path.join(root, 'home')
  savedXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = path.join(homeDir, '.config')
  ocDir = path.join(homeDir, '.config', 'opencode')
  await mkdir(ocDir, { recursive: true })
})

afterEach(async () => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  await rm(root, { recursive: true, force: true })
})

const ocJson = (): string => path.join(ocDir, 'opencode.json')

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

describe('OpenCode MCP install (#1104)', () => {
  it('keeps comments, providers and every other setting when it adds the entry', async () => {
    await writeFile(ocJson(), COMMENTED_CONFIG)

    const status = await installMcpForClient('opencode')
    expect(status).toMatchObject({ installed: true, upToDate: true })

    const after = await readFile(ocJson(), 'utf8')
    expect(after.startsWith(COMMENTED_CONFIG.slice(0, COMMENTED_CONFIG.lastIndexOf('}')))).toBe(true)
    expect(after).toContain('// Local models through Ollama.')
    expect(after).toContain('// default port')
    expect(after).toContain('"zennotes": {')
    expect(after).toContain('"/usr/local/bin/zn"')
  })

  it('takes back only its own entry on uninstall', async () => {
    await writeFile(ocJson(), COMMENTED_CONFIG)
    await installMcpForClient('opencode')

    const status = await uninstallMcpForClient('opencode')
    expect(status).toMatchObject({ installed: false })

    const after = await readFile(ocJson(), 'utf8')
    expect(after).not.toContain('zennotes')
    expect(after).not.toContain('"mcp"')
    expect(after).toContain('// Local models through Ollama.')
    expect(after).toContain('"model": "ollama/qwen3:8b"')
  })

  it('leaves other MCP servers in place on install and uninstall', async () => {
    await writeFile(
      ocJson(),
      `{
  "mcp": {
    // my other server
    "github": { "type": "remote", "url": "https://example.test/mcp" }
  }
}
`
    )
    await installMcpForClient('opencode')
    expect(await readFile(ocJson(), 'utf8')).toContain('"github"')

    await uninstallMcpForClient('opencode')
    const after = await readFile(ocJson(), 'utf8')
    expect(after).toContain('// my other server')
    expect(after).toContain('"github"')
    expect(after).not.toContain('zennotes')
  })

  it('refuses to write a file it cannot read, and says so', async () => {
    const broken = '{\n  "model": "ollama/qwen3:8b"\n  "provider": {}\n}\n'
    await writeFile(ocJson(), broken)

    await expect(installMcpForClient('opencode')).rejects.toThrow(/left it unchanged/)
    await expect(uninstallMcpForClient('opencode')).rejects.toThrow(/left it unchanged/)
    expect(await readFile(ocJson(), 'utf8')).toBe(broken)

    const status = (await getMcpClientStatuses()).find((s) => s.id === 'opencode')
    expect(status?.installed).toBe(false)
    expect(status?.note).toMatch(/line 3/)
  })

  it('refuses a config whose mcp setting is not an object', async () => {
    const odd = '{ "mcp": [] }\n'
    await writeFile(ocJson(), odd)
    await expect(installMcpForClient('opencode')).rejects.toThrow(/not an object/)
    expect(await readFile(ocJson(), 'utf8')).toBe(odd)
  })

  it('creates a config when there is none', async () => {
    await installMcpForClient('opencode')
    const created = JSON.parse(await readFile(ocJson(), 'utf8'))
    expect(created.mcp.zennotes).toEqual({
      type: 'local',
      command: ['/usr/local/bin/zn', 'mcp'],
      enabled: true
    })
  })

  it('edits opencode.jsonc when that is the only config the user keeps', async () => {
    const jsonc = path.join(ocDir, 'opencode.jsonc')
    await writeFile(jsonc, COMMENTED_CONFIG)

    const status = await installMcpForClient('opencode')
    expect(status.configPath).toBe(jsonc)
    expect(await exists(ocJson())).toBe(false)
    expect(await readFile(jsonc, 'utf8')).toContain('"zennotes": {')
  })

  it('follows a tab-indented file', async () => {
    await writeFile(ocJson(), '{\n\t"model": "x"\n}\n')
    await installMcpForClient('opencode')
    expect(await readFile(ocJson(), 'utf8')).toMatch(/\n\t"mcp": \{\n\t\t"zennotes": \{/)
  })
})
