/**
 * A file Cloud will not take, recognized so sync can move past it (#1004).
 *
 * Cloud and the apps keep separate lists of which vault paths may sync
 * (VaultPathService::shouldSync on the server, shouldSyncVaultPath here). When
 * the lists drifted, Cloud refused the whole batch with a 422 naming the path,
 * the run failed before it saved anything, and every later run planned the
 * same upload and failed the same way. Recognizing the refusal lets the
 * coordinator set that path aside and send everything else.
 */
import type {
  CloudSyncMutationRequest,
  CloudSyncMutationResponse
} from '@zennotes/bridge-contract/cloud-sync'
import { describeCloudError } from './cloud-error-copy'

/** How long a refused path waits before sync offers it to Cloud again. Cloud
 *  may learn to take it (the #1004 fix was on the server), so it is retried,
 *  but not on every run. */
export const CLOUD_SYNC_REFUSED_PATH_RETRY_MS = 24 * 60 * 60 * 1000

export interface CloudSyncPathRefusal {
  /** Positions in the batch that was sent, each refused for its path. */
  indices: number[]
  /** What Cloud already applied from this batch: a host that sends one batch
   *  as several requests (inline posts and direct uploads) may have finished
   *  some before the refusal. Empty when Cloud refused the request whole. */
  applied: CloudSyncMutationResponse
  /** Cloud's answer, as Details shows it. */
  detail: string
}

/**
 * Thrown from a host's mutate() when it sent the batch as several requests
 * and one of them was refused for a path. Indices are into the batch the
 * host was given, and `applied` carries what the earlier requests did, so
 * the coordinator commits those and resends only what was never answered.
 */
export class CloudSyncPathRefusedError extends Error {
  constructor(
    readonly refusal: CloudSyncPathRefusal,
    cause?: unknown
  ) {
    super(`ZenNotes Cloud refused ${refusal.indices.length} sync path(s): ${refusal.detail}`, { cause })
    this.name = 'CloudSyncPathRefusedError'
  }
}

const EMPTY_RESPONSE: CloudSyncMutationResponse = { acknowledged: [], conflicts: [], cursor: 0 }
const MUTATION_PATH_FIELD = /^mutations\.(\d+)\.path$/

/**
 * The field errors of a 422 VALIDATION_FAILED, which a host's transport keeps
 * from the answer's `errors` object under `details.errors`. Null for any
 * other failure, or a host that does not keep them.
 */
export function cloudValidationFieldErrors(error: unknown): Record<string, string[]> | null {
  const value = error as { status?: unknown; code?: unknown; details?: unknown } | null
  if (!value || typeof value !== 'object' || value.status !== 422 || value.code !== 'VALIDATION_FAILED') {
    return null
  }
  const details = value.details as { errors?: unknown } | null | undefined
  const errors = details && typeof details === 'object' ? details.errors : undefined
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) return null
  const fields: Record<string, string[]> = {}
  for (const [field, messages] of Object.entries(errors)) {
    fields[field] = Array.isArray(messages) ? messages.filter((m): m is string => typeof m === 'string') : []
  }
  return Object.keys(fields).length > 0 ? fields : null
}

/**
 * The paths Cloud refused in `batch`, or null when what mutate() threw is
 * anything else. Only a refusal that names nothing but upsert and move paths
 * counts: any other field error means the request itself was wrong, and
 * stopping is right.
 */
export function cloudSyncPathRefusal(
  error: unknown,
  batch: CloudSyncMutationRequest
): CloudSyncPathRefusal | null {
  if (error instanceof CloudSyncPathRefusedError) {
    const { indices } = error.refusal
    return indices.length > 0 && indices.every((index) => refusablePath(batch, index)) ? error.refusal : null
  }
  const fields = cloudValidationFieldErrors(error)
  if (!fields) return null
  const indices = new Set<number>()
  for (const field of Object.keys(fields)) {
    const match = MUTATION_PATH_FIELD.exec(field)
    if (!match) return null
    const index = Number(match[1])
    if (!refusablePath(batch, index)) return null
    indices.add(index)
  }
  return {
    indices: [...indices].sort((a, b) => a - b),
    applied: EMPTY_RESPONSE,
    detail: describeCloudError(error).detail ?? ''
  }
}

/** Whether a direct upload's own request was refused for its `path`. */
export function isCloudSyncUploadPathRefused(error: unknown): boolean {
  const fields = cloudValidationFieldErrors(error)
  return fields !== null && Object.keys(fields).every((field) => field === 'path')
}

function refusablePath(batch: CloudSyncMutationRequest, index: number): boolean {
  const mutation = batch.mutations[index]
  return mutation !== undefined && (mutation.type === 'upsert' || mutation.type === 'move')
}
