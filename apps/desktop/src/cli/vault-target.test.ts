import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from './args'
import {
  looksLikeServerUrl,
  resolveAuthToken,
  resolveDefaultTarget,
  resolveTarget,
  resolveServerTarget,
  resolveVaultTarget
} from './vault-target'

let tmpDir: string
let configDir: string
let workVault: string

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(path.join(configDir, 'zennotes.config.json'), JSON.stringify(config))
}

const HOME_PROFILE = {
  id: 'p1',
  name: 'home',
  baseUrl: 'http://192.168.1.10:7878',
  authToken: 'stored-token',
  vaultPath: '/srv/notes',
  lastConnectedAt: 5_000
}

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-target-'))
  configDir = path.join(tmpDir, 'config')
  workVault = path.join(tmpDir, 'work')
  await fsp.mkdir(configDir, { recursive: true })
  await fsp.mkdir(workVault, { recursive: true })
})

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.stubEnv('ZENNOTES_CONFIG_DIR', configDir)
  vi.stubEnv('ZENNOTES_VAULT', '')
  vi.stubEnv('ZENNOTES_SERVER', '')
  vi.stubEnv('ZENNOTES_REMOTE_TOKEN', '')
  await writeConfig({
    vaultRoot: workVault,
    localVaults: [{ root: workVault, name: 'work', lastOpenedAt: 2_000 }],
    remoteWorkspaceProfiles: [HOME_PROFILE]
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('looksLikeServerUrl', () => {
  it('accepts schemes and host:port, so a URL never has to be a saved profile', () => {
    expect(looksLikeServerUrl('http://localhost:7878')).toBe(true)
    expect(looksLikeServerUrl('https://notes.example.com')).toBe(true)
    expect(looksLikeServerUrl('localhost:7878')).toBe(true)
    expect(looksLikeServerUrl('192.168.1.10:7878/base')).toBe(true)
  })

  it('rejects ordinary profile names, which are free-form', () => {
    expect(looksLikeServerUrl('home')).toBe(false)
    expect(looksLikeServerUrl('work laptop')).toBe(false)
    // No port: indistinguishable from a name, so it must be saved first.
    expect(looksLikeServerUrl('notes.example.com')).toBe(false)
  })
})

describe('resolveAuthToken (#493 — a token for CI without writing it to disk)', () => {
  it('prefers --token, then the environment, then the saved profile', () => {
    const env = { ZENNOTES_REMOTE_TOKEN: 'env-token' } as NodeJS.ProcessEnv
    expect(resolveAuthToken('flag-token', 'stored', env)).toBe('flag-token')
    expect(resolveAuthToken(undefined, 'stored', env)).toBe('env-token')
    expect(resolveAuthToken(undefined, 'stored', {})).toBe('stored')
  })

  it('is null when nothing supplies one, so the request goes out unauthenticated', () => {
    expect(resolveAuthToken(undefined, null, {})).toBeNull()
    expect(resolveAuthToken('   ', '  ', {})).toBeNull()
  })
})

describe('resolveServerTarget', () => {
  it('resolves a saved profile by name, carrying its stored token', async () => {
    expect(await resolveServerTarget('home', undefined)).toEqual({
      kind: 'remote',
      name: 'home',
      baseUrl: 'http://192.168.1.10:7878',
      authToken: 'stored-token'
    })
  })

  it('matches a profile name case-insensitively, like --vault does', async () => {
    const target = await resolveServerTarget('HOME', undefined)
    expect(target).toMatchObject({ kind: 'remote', name: 'home' })
  })

  it('accepts a bare URL and gives it a scheme', async () => {
    expect(await resolveServerTarget('localhost:7878', 'cli-token')).toEqual({
      kind: 'remote',
      name: '',
      baseUrl: 'http://localhost:7878',
      authToken: 'cli-token'
    })
  })

  it('names the known servers when the selector matches nothing', async () => {
    await expect(resolveServerTarget('nope', undefined)).rejects.toThrow(
      /No server named "nope". Known servers: home/
    )
  })

  it('explains how to get one when no server is saved at all', async () => {
    await writeConfig({ vaultRoot: workVault })
    await expect(resolveServerTarget('nope', undefined)).rejects.toThrow(
      /no server is saved yet.*Settings → Vault/s
    )
  })

  it('rejects a bare --server with no value', async () => {
    // The arg parser turns a valueless flag into "true".
    await expect(resolveServerTarget('true', undefined)).rejects.toThrow(
      /--server needs a server name or URL/
    )
  })

  it('reads the legacy single-server config too', async () => {
    await writeConfig({
      vaultRoot: workVault,
      remoteWorkspace: { baseUrl: 'http://legacy:7878', authToken: 'old' }
    })
    expect(await resolveServerTarget('ZenNotes Server', undefined)).toMatchObject({
      baseUrl: 'http://legacy:7878',
      authToken: 'old'
    })
  })
})

describe('resolveVaultTarget — one flag, either kind of vault', () => {
  it('resolves a local vault name to a root', async () => {
    expect(await resolveVaultTarget('work', undefined)).toEqual({
      kind: 'local',
      root: workVault
    })
  })

  it('falls through to a server profile of the same name', async () => {
    expect(await resolveVaultTarget('home', undefined)).toMatchObject({
      kind: 'remote',
      baseUrl: 'http://192.168.1.10:7878'
    })
  })

  it('still accepts a directory path', async () => {
    expect(await resolveVaultTarget(workVault, undefined)).toEqual({
      kind: 'local',
      root: workVault
    })
  })

  it('refuses to guess when a local vault and a server share a name', async () => {
    await writeConfig({
      vaultRoot: workVault,
      localVaults: [{ root: workVault, name: 'home', lastOpenedAt: 2_000 }],
      remoteWorkspaceProfiles: [HOME_PROFILE]
    })
    await expect(resolveVaultTarget('home', undefined)).rejects.toThrow(
      /names both a local vault.*and a server.*Use --server home/s
    )
  })
})

describe('resolveTarget — precedence across flags and environment', () => {
  const args = (argv: string[]) => parse(argv)

  it('uses --server over --vault when both are given', async () => {
    const target = await resolveTarget(args(['--vault', 'work', '--server', 'home']))
    expect(target).toMatchObject({ kind: 'remote', name: 'home' })
  })

  it('uses --vault when there is no --server', async () => {
    expect(await resolveTarget(args(['--vault', 'work']))).toEqual({
      kind: 'local',
      root: workVault
    })
  })

  it('falls back to ZENNOTES_SERVER, then to the configured local default', async () => {
    expect(await resolveTarget(args([]), { ZENNOTES_SERVER: 'home' })).toMatchObject({
      kind: 'remote',
      name: 'home'
    })
    expect(await resolveTarget(args([]), {})).toEqual({ kind: 'local', root: workVault })
  })

  it('lets --token override the profile token for one invocation', async () => {
    const target = await resolveTarget(args(['--server', 'home', '--token', 'once']))
    expect(target).toMatchObject({ authToken: 'once' })
  })
})

describe('the default target follows the workspace the app has open (#688)', () => {
  it('is the connected server when the app is in remote mode, token from the environment', async () => {
    await writeConfig({
      vaultRoot: workVault,
      workspaceMode: 'remote',
      remoteWorkspace: { baseUrl: 'http://192.168.1.10:7878' },
      remoteWorkspaceProfileId: 'p1',
      remoteWorkspaceProfiles: [{ ...HOME_PROFILE, authToken: undefined }]
    })
    vi.stubEnv('ZENNOTES_REMOTE_TOKEN', 'env-token')
    expect(await resolveDefaultTarget(process.env)).toEqual({
      kind: 'remote',
      name: 'home',
      baseUrl: 'http://192.168.1.10:7878',
      authToken: 'env-token'
    })
    // `zn` with no flags lands on the same server as `zn mcp`.
    expect(await resolveTarget(parse([]))).toMatchObject({ kind: 'remote', name: 'home' })
  })

  it('goes out unauthenticated when nothing supplies a token (the app keeps its own in the secret store)', async () => {
    await writeConfig({
      vaultRoot: workVault,
      workspaceMode: 'remote',
      remoteWorkspace: { baseUrl: 'http://192.168.1.10:7878' },
      remoteWorkspaceProfileId: 'p1',
      remoteWorkspaceProfiles: [{ ...HOME_PROFILE, authToken: undefined }]
    })
    expect(await resolveDefaultTarget(process.env)).toMatchObject({
      kind: 'remote',
      authToken: null
    })
  })

  it('still honours a legacy plaintext token on the profile', async () => {
    await writeConfig({
      vaultRoot: workVault,
      workspaceMode: 'remote',
      remoteWorkspace: { baseUrl: 'http://192.168.1.10:7878' },
      remoteWorkspaceProfileId: 'p1',
      remoteWorkspaceProfiles: [HOME_PROFILE]
    })
    expect(await resolveDefaultTarget(process.env)).toMatchObject({ authToken: 'stored-token' })
  })

  it('names a bare-URL workspace with no matching profile by its URL', async () => {
    await writeConfig({
      vaultRoot: workVault,
      workspaceMode: 'remote',
      remoteWorkspace: { baseUrl: 'localhost:7878' },
      remoteWorkspaceProfiles: []
    })
    expect(await resolveDefaultTarget(process.env)).toEqual({
      kind: 'remote',
      name: 'ZenNotes Server',
      baseUrl: 'http://localhost:7878',
      authToken: null
    })
  })

  it('ZENNOTES_VAULT and ZENNOTES_SERVER still win over the app', async () => {
    await writeConfig({
      vaultRoot: workVault,
      workspaceMode: 'remote',
      remoteWorkspace: { baseUrl: 'http://192.168.1.10:7878' },
      remoteWorkspaceProfiles: [HOME_PROFILE]
    })
    vi.stubEnv('ZENNOTES_VAULT', workVault)
    expect(await resolveDefaultTarget(process.env)).toEqual({ kind: 'local', root: workVault })
    vi.stubEnv('ZENNOTES_VAULT', '')
    vi.stubEnv('ZENNOTES_SERVER', 'localhost:9999')
    expect(await resolveDefaultTarget(process.env)).toMatchObject({
      kind: 'remote',
      baseUrl: 'http://localhost:9999'
    })
  })

  it('stays local when the app is in local mode or the remote entry is incomplete', async () => {
    await writeConfig({ vaultRoot: workVault, workspaceMode: 'local', remoteWorkspaceProfiles: [HOME_PROFILE] })
    expect(await resolveDefaultTarget(process.env)).toEqual({ kind: 'local', root: workVault })
    await writeConfig({ vaultRoot: workVault, workspaceMode: 'remote', remoteWorkspace: { baseUrl: '' } })
    expect(await resolveDefaultTarget(process.env)).toEqual({ kind: 'local', root: workVault })
  })
})
