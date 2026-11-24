import type {
  CloudSyncMutation,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncRemote } from '@zennotes/shared-domain/cloud-sync-coordinator'
import { applyRemoteHeaders, type RemoteHeader } from '@shared/remote-headers'
import { CloudServiceRequestError } from '../cloud-sync-client'
import { connectionErrorMessage, gatewayRedirectMessage } from '../remote/connection'
import { trustSystemCertificates } from '../system-trust'

/**
 * Cloud's sync engine talking to a self-hosted ZenNotes server (#1108). The
 * server speaks Cloud's wire shapes minus encryption on `/api/sync/*`
 * (znserver 2.91.1, `supportsSync: 1`), so this adapter is only transport:
 * the profile's token and gateway headers, the server's error body worded
 * the way the engine reads Cloud's, and two things Cloud does not need.
 *
 * - Every request names the vault. A server that now serves another vault
 *   answers 409 VAULT_MISMATCH instead of letting a copy sync into a vault it
 *   was never made from.
 * - A mutation batch is split by bytes. The engine sends up to 100 at a time,
 *   which is fine for Cloud, whose large files go through staged uploads;
 *   the server takes every note inline and caps a request at 256 MiB.
 */

export interface ZnServerSyncRemoteOptions {
  baseUrl: string
  authToken?: string | null
  headers?: readonly RemoteHeader[] | null
  /** `supportsSync >= 2`: the server can return an older revision, the base a
   *  three-way merge needs. Without it a conflict stays two-way. */
  revisions: boolean
  signal?: AbortSignal
  /** Called whenever the server answered at all, even with an error. */
  onAnswer?: () => void
  fetchImplementation?: typeof fetch
  /** The most bytes one mutation request carries. */
  mutationBatchBytes?: number
}

/** The server could not be reached: no answer came back. */
export class RemoteMirrorUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteMirrorUnreachableError'
  }
}

/** Well under the server's 256 MiB cap, with room for JSON escaping. */
export const MUTATION_BATCH_BYTES = 64 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000

interface ServerErrorBody {
  code?: unknown
  message?: unknown
  errors?: unknown
}

export function createZnServerSyncRemote(options: ZnServerSyncRemoteOptions): CloudSyncRemote {
  const fetchImplementation = options.fetchImplementation ?? fetch
  const batchBytes = options.mutationBatchBytes ?? MUTATION_BATCH_BYTES

  async function request<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
    options.signal?.throwIfAborted()
    const headers = new Headers({ Accept: 'application/json' })
    if (options.authToken) headers.set('Authorization', `Bearer ${options.authToken}`)
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    applyRemoteHeaders(headers, options.headers)
    trustSystemCertificates()
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)]
    if (options.signal) signals.push(options.signal)
    let response: Response
    try {
      response = await fetchImplementation(`${options.baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals)
      })
    } catch (error) {
      options.signal?.throwIfAborted()
      throw new RemoteMirrorUnreachableError(connectionErrorMessage(options.baseUrl, error))
    }
    options.onAnswer?.()
    const redirected = gatewayRedirectMessage(options.baseUrl, response)
    if (redirected) throw new CloudServiceRequestError(redirected, 403, 'GATEWAY_REDIRECT')
    const text = await response.text()
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    if (!response.ok) {
      const error = (payload && typeof payload === 'object' ? payload : {}) as ServerErrorBody
      throw new CloudServiceRequestError(
        typeof error.message === 'string' && error.message ? error.message : text.trim() || `HTTP ${response.status}`,
        response.status,
        typeof error.code === 'string' ? error.code : null,
        error.errors && typeof error.errors === 'object' ? { errors: error.errors } : null
      )
    }
    if (payload === null) {
      throw new CloudServiceRequestError(`The server sent an empty answer for ${route}.`, response.status, 'EMPTY_RESPONSE')
    }
    return payload as T
  }

  async function mutateOnce(vaultId: string, mutations: CloudSyncMutation[]): Promise<CloudSyncMutationResponse> {
    return request<CloudSyncMutationResponse>(
      'POST',
      `/api/sync/mutations${query({ vault_id: vaultId })}`,
      { mutations: mutations.map(wireMutation) }
    )
  }

  const remote: CloudSyncRemote = {
    downloadSignal: options.signal,
    manifest: (vaultId, request_) =>
      request('GET', `/api/sync/manifest${query({
        vault_id: vaultId,
        page: request_.page,
        perPage: request_.perPage,
        // Without content references every hydration comes from the
        // manifest, so it always carries the bytes.
        include_content: 1
      })}`),
    changes: (vaultId, after, limit) =>
      request('GET', `/api/sync/changes${query({ vault_id: vaultId, after, limit })}`),
    async mutate(vaultId: string, body: CloudSyncMutationRequest): Promise<CloudSyncMutationResponse> {
      const batches = splitByBytes(body.mutations, batchBytes)
      if (batches.length <= 1) return mutateOnce(vaultId, body.mutations)
      const merged: CloudSyncMutationResponse = { acknowledged: [], conflicts: [], cursor: 0 }
      for (const batch of batches) {
        const answer = await mutateOnce(vaultId, batch)
        merged.acknowledged.push(...answer.acknowledged)
        merged.conflicts.push(...answer.conflicts)
        merged.cursor = answer.cursor
      }
      return merged
    }
  }
  if (options.revisions) {
    remote.revision = (vaultId, itemId, revision) =>
      request('GET', `/api/sync/revision${query({ vault_id: vaultId, item: itemId, revision })}`)
  }
  return remote
}

/** The id a server gives the vault it serves, which names its offline copy. */
export async function fetchServerSyncVaultId(
  options: Omit<ZnServerSyncRemoteOptions, 'revisions'>
): Promise<{ vaultId: string; cursor: number }> {
  const remote = createZnServerSyncRemote({ ...options, revisions: false })
  // No vault id: this is how a new copy learns it.
  const manifest = (await remote.manifest('', { page: 1, perPage: 1 })) as unknown as {
    vault_id?: unknown
    cursor?: unknown
  }
  if (typeof manifest.vault_id !== 'string' || !manifest.vault_id) {
    throw new CloudServiceRequestError('The server did not say which vault it serves.', 200, 'PROTOCOL')
  }
  return { vaultId: manifest.vault_id, cursor: typeof manifest.cursor === 'number' ? manifest.cursor : 0 }
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** The engine adds hints to a move for encrypted vaults; they never go on the wire. */
function wireMutation(mutation: CloudSyncMutation): CloudSyncMutation {
  if (mutation.type !== 'move') return mutation
  const { kind: _kind, content_metadata: _metadata, ...wire } = mutation
  return wire
}

/** Mutations in their order, cut wherever the next one would pass the budget.
 *  One that is larger than the budget alone still goes, by itself. */
export function splitByBytes(mutations: CloudSyncMutation[], budget: number): CloudSyncMutation[][] {
  const batches: CloudSyncMutation[][] = []
  let current: CloudSyncMutation[] = []
  let used = 0
  for (const mutation of mutations) {
    const size = Buffer.byteLength(JSON.stringify(wireMutation(mutation)), 'utf8')
    if (current.length > 0 && used + size > budget) {
      batches.push(current)
      current = []
      used = 0
    }
    current.push(mutation)
    used += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}
