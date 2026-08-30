/**
 * Which vault a `zn` command is about: a folder on this machine, or a vault
 * behind a self-hosted ZenNotes server (#493).
 *
 * Two ways to say it, because they answer different questions:
 *
 *   --vault <name|path>   the vault, wherever it happens to live
 *   --server <name|url>   that server, explicitly
 *
 * `--vault` resolves against local vault names first, then saved server
 * profiles, then a directory path — so the short thing you already type keeps
 * working and reaches a server if that is where the name matches. `--server`
 * forces the remote reading and wins when both are given, which is what a
 * script wants when a local vault and a server profile share a name.
 *
 * Server profiles come from the same config the desktop app writes when you
 * use Settings → Vault → "Connect to Server...", so a server set up in the GUI
 * is immediately nameable from the CLI with nothing else to configure.
 */

import { normalizeBaseUrl } from '../main/remote/connection.js'
import {
  readActiveWorkspaceFromConfig,
  readKnownVaultsFromConfig,
  readRemoteProfilesFromConfig,
  resolveVaultRoot,
  type KnownRemoteProfile
} from '../mcp/vault-ops.js'
import { getString, type ParsedArgs } from './args.js'

export type VaultTarget =
  | { kind: 'local'; root: string }
  | { kind: 'remote'; name: string; baseUrl: string; authToken: string | null }

/** Token precedence, loudest first: an explicit `--token`, then the
 *  environment (the CI / headless case, where nothing is stored on disk),
 *  then whatever the saved profile carries. Mirrors how `--vault` beats
 *  `ZENNOTES_VAULT` beats the configured default. */
export const REMOTE_TOKEN_ENV = 'ZENNOTES_REMOTE_TOKEN'

export function resolveAuthToken(
  flagToken: string | undefined,
  profileToken: string | null,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const explicit = flagToken?.trim()
  if (explicit) return explicit
  const fromEnv = env[REMOTE_TOKEN_ENV]?.trim()
  if (fromEnv) return fromEnv
  return profileToken?.trim() || null
}

/** A bare URL rather than a profile name: has a scheme, or looks like
 *  `host:port`. Profile names are free-form, so this stays conservative. */
export function looksLikeServerUrl(value: string): boolean {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) return true
  return /^[\w.-]+:\d+(\/|$)/.test(trimmed)
}

function findProfile(
  profiles: KnownRemoteProfile[],
  selector: string
): KnownRemoteProfile | undefined {
  const needle = selector.trim().toLowerCase()
  return profiles.find((profile) => profile.name.toLowerCase() === needle)
}

/** Resolve `--server <name|url>` to a remote target. */
export async function resolveServerTarget(
  selector: string,
  flagToken: string | undefined
): Promise<VaultTarget> {
  const trimmed = selector.trim()
  if (!trimmed || trimmed === 'true') {
    throw new Error('--server needs a server name or URL, e.g. `--server home` or `--server localhost:7878`.')
  }

  const profiles = await readRemoteProfilesFromConfig()
  const profile = findProfile(profiles, trimmed)
  if (profile) {
    return {
      kind: 'remote',
      name: profile.name,
      baseUrl: profile.baseUrl,
      authToken: resolveAuthToken(flagToken, profile.authToken)
    }
  }

  if (looksLikeServerUrl(trimmed)) {
    return {
      kind: 'remote',
      name: '',
      baseUrl: normalizeBaseUrl(trimmed),
      authToken: resolveAuthToken(flagToken, null)
    }
  }

  const names = profiles.map((p) => p.name).join(', ')
  throw new Error(
    names
      ? `No server named "${trimmed}". Known servers: ${names}. You can also pass a URL like localhost:7878.`
      : `No server named "${trimmed}" and no server is saved yet. Pass a URL like localhost:7878, or connect once from ZenNotes → Settings → Vault.`
  )
}

/** Resolve `--vault <name|path>`: a local vault name, then a server profile
 *  name, then a directory path. */
export async function resolveVaultTarget(
  selector: string,
  flagToken: string | undefined
): Promise<VaultTarget> {
  const trimmed = selector.trim()
  const [known, profiles] = await Promise.all([
    readKnownVaultsFromConfig(),
    readRemoteProfilesFromConfig()
  ])

  const localMatches = known.filter((v) => v.name.toLowerCase() === trimmed.toLowerCase())
  const profile = findProfile(profiles, trimmed)

  // A local vault and a server sharing a name is ambiguous enough that
  // guessing would eventually write to the wrong one. Name both and say how
  // to disambiguate rather than picking.
  if (localMatches.length > 0 && profile) {
    throw new Error(
      `"${trimmed}" names both a local vault (${localMatches[0].root}) and a server (${profile.baseUrl}). ` +
        `Use --server ${trimmed} for the server, or pass the local vault's path.`
    )
  }

  if (profile) {
    return {
      kind: 'remote',
      name: profile.name,
      baseUrl: profile.baseUrl,
      authToken: resolveAuthToken(flagToken, profile.authToken)
    }
  }

  return { kind: 'local', root: await resolveVaultRoot(trimmed) }
}

/**
 * The target when nothing named one: `ZENNOTES_SERVER` points at a server for
 * a whole shell session, `ZENNOTES_VAULT` at a folder, and otherwise the vault
 * the desktop app has open, a connected server included (#688). This is what
 * `zn mcp` uses, so an agent works on the vault the user is looking at; the
 * app's own token stays in the OS secret store, so a server that needs one
 * gets it from `ZENNOTES_REMOTE_TOKEN` (or `--token`).
 */
export async function resolveDefaultTarget(
  env: NodeJS.ProcessEnv = process.env,
  flagToken?: string
): Promise<VaultTarget> {
  const envServer = env.ZENNOTES_SERVER?.trim()
  if (envServer) return await resolveServerTarget(envServer, flagToken)

  if (env.ZENNOTES_VAULT?.trim()) return { kind: 'local', root: await resolveVaultRoot() }

  const active = await readActiveWorkspaceFromConfig()
  if (active.kind === 'remote') {
    return {
      kind: 'remote',
      name: active.name,
      baseUrl: active.baseUrl,
      authToken: resolveAuthToken(flagToken, active.authToken, env)
    }
  }
  return { kind: 'local', root: await resolveVaultRoot() }
}

/**
 * The target for this invocation. `--server` wins over `--vault`; with
 * neither, `resolveDefaultTarget` follows the environment and then the app.
 */
export async function resolveTarget(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env
): Promise<VaultTarget> {
  const flagToken = getString(args, 'token')
  const server = getString(args, 'server')
  if (server) return await resolveServerTarget(server, flagToken)

  const vault = getString(args, 'vault')
  if (vault) return await resolveVaultTarget(vault, flagToken)

  return await resolveDefaultTarget(env, flagToken)
}
