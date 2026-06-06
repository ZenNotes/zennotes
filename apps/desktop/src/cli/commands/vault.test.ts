import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveVaultRoot, resolveVaultSelector } from '../../mcp/vault-ops'
import { cmdVaultList } from './vault'
import type { ParsedArgs } from '../args'

function makeArgs(flags: Array<[string, string]> = []): ParsedArgs {
  return { positionals: [], flags: new Map(flags.map(([k, v]) => [k, [v]])) }
}

let tmpDir: string
let configDir: string
let workVault: string
let personalVault: string
let stdoutLines: string[]

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(path.join(configDir, 'zennotes.config.json'), JSON.stringify(config))
}

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-vaults-'))
  configDir = path.join(tmpDir, 'config')
  workVault = path.join(tmpDir, 'Work Vault')
  personalVault = path.join(tmpDir, 'personal')
  await fsp.mkdir(configDir, { recursive: true })
  await fsp.mkdir(workVault, { recursive: true })
  await fsp.mkdir(personalVault, { recursive: true })
})

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.stubEnv('ZENNOTES_CONFIG_DIR', configDir)
  vi.stubEnv('ZENNOTES_VAULT', '')
  stdoutLines = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutLines.push(String(chunk))
    return true
  })
  await writeConfig({
    vaultRoot: workVault,
    localVaults: [
      { root: workVault, name: 'Work Vault', lastOpenedAt: 2_000 },
      { root: personalVault, name: 'personal', lastOpenedAt: 1_000 }
    ]
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('resolveVaultSelector', () => {
  it('matches known vaults by name, case-insensitively', async () => {
    expect(await resolveVaultSelector('personal')).toBe(personalVault)
    expect(await resolveVaultSelector('work vault')).toBe(workVault)
  })

  it('accepts a directory path when no name matches', async () => {
    expect(await resolveVaultSelector(personalVault)).toBe(personalVault)
  })

  it('lists known vault names on a bad selector', async () => {
    await expect(resolveVaultSelector('nope')).rejects.toThrow(
      /No vault named "nope".*Work Vault, personal/
    )
  })

  it('reports a known vault whose directory is gone', async () => {
    const ghost = path.join(tmpDir, 'ghost')
    await writeConfig({
      vaultRoot: workVault,
      localVaults: [{ root: ghost, name: 'ghost', lastOpenedAt: 1 }]
    })
    await expect(resolveVaultSelector('ghost')).rejects.toThrow(/points to .*ghost, which is missing/)
  })
})

describe('resolveVaultRoot', () => {
  it('prefers an explicit selector over env and config', async () => {
    vi.stubEnv('ZENNOTES_VAULT', personalVault)
    expect(await resolveVaultRoot('work vault')).toBe(workVault)
  })

  it('falls back to env, then the config default', async () => {
    vi.stubEnv('ZENNOTES_VAULT', personalVault)
    expect(await resolveVaultRoot()).toBe(personalVault)

    vi.stubEnv('ZENNOTES_VAULT', '')
    expect(await resolveVaultRoot()).toBe(workVault)
  })

  it('rejects a bad selector instead of falling back', async () => {
    await expect(resolveVaultRoot('typo')).rejects.toThrow(/No vault named "typo"/)
  })
})

describe('cmdVaultList', () => {
  it('lists vaults most recently opened first, marking the default', async () => {
    await cmdVaultList('', makeArgs())
    const output = stdoutLines.join('')
    const lines = output.trimEnd().split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\* Work Vault .*Work Vault$/)
    expect(lines[1]).toMatch(/^ {2}personal .*personal$/)
  })

  it('emits structured entries with --json', async () => {
    await cmdVaultList('', makeArgs([['json', 'true']]))
    const entries = JSON.parse(stdoutLines.join(''))

    expect(entries).toEqual([
      {
        name: 'Work Vault',
        root: workVault,
        lastOpenedAt: 2_000,
        isDefault: true
      },
      {
        name: 'personal',
        root: personalVault,
        lastOpenedAt: 1_000,
        isDefault: false
      }
    ])
  })

  it('explains the empty state', async () => {
    await writeConfig({})
    await cmdVaultList('', makeArgs())
    expect(stdoutLines.join('')).toContain('No vaults known yet')
  })
})
