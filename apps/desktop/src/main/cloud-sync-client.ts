import {
  CloudSyncApiClient,
  type CloudSyncHttpRequest,
  type CloudSyncHttpTransport
} from '@zennotes/shared-domain/cloud-sync-api'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type {
  CloudSyncCapacityConflict,
  CloudSyncConflict,
  CloudSyncConflictCode,
  CloudSyncMutation,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncUpsertMutation,
  CloudSyncUploadInitiationResponse,
  CloudSyncUploadRequest
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES,
  cloudSyncUploadSource
} from './cloud-sync-upload-source'

const DIRECT_UPLOAD_TIMEOUT_MS = 300_000
const DIRECT_UPLOAD_COMPLETION_ATTEMPTS = 3
type FetchBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>
const SYNC_CONFLICT_CODES = new Set<CloudSyncConflictCode>([
  'REVISION_CONFLICT',
  'PATH_CONFLICT',
  'ITEM_DELETED',
  'QUOTA_EXCEEDED',
  'CAPACITY_EXCEEDED',
  'FILE_SIZE_LIMIT_EXCEEDED'
])

export class CloudServiceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: Record<string, unknown> | null = null
  ) {
    super(message)
    this.name = 'CloudServiceRequestError'
  }
}

export function createCloudSyncClient(
  baseUrl: string,
  token: string,
  fetchImplementation: typeof fetch = fetch
): CloudSyncApiClient {
  return new DesktopCloudSyncApiClient(
    new BearerFetchTransport(baseUrl, token, fetchImplementation),
    fetchImplementation
  )
}

class DesktopCloudSyncApiClient extends CloudSyncApiClient {
  constructor(
    http: CloudSyncHttpTransport,
    private readonly fetchImplementation: typeof fetch
  ) {
    super(http)
  }

  override async mutate(
    vaultId: string,
    body: CloudSyncMutationRequest
  ): Promise<CloudSyncMutationResponse> {
    if (!body.mutations.some(usesDirectUpload)) return super.mutate(vaultId, body)

    const responses: CloudSyncMutationResponse[] = []
    let inlineMutations: CloudSyncMutation[] = []
    const flushInline = async (): Promise<void> => {
      if (inlineMutations.length === 0) return
      responses.push(await super.mutate(vaultId, { mutations: inlineMutations }))
      inlineMutations = []
    }

    for (const mutation of body.mutations) {
      if (usesDirectUpload(mutation)) {
        await flushInline()
        responses.push(await this.directUpload(vaultId, mutation))
      } else {
        inlineMutations.push(mutation)
      }
    }
    await flushInline()

    return {
      acknowledged: responses.flatMap((response) => response.acknowledged),
      conflicts: responses.flatMap((response) => response.conflicts),
      cursor: Math.max(0, ...responses.map((response) => response.cursor))
    }
  }

  private async directUpload(
    vaultId: string,
    mutation: CloudSyncUpsertMutation
  ): Promise<CloudSyncMutationResponse> {
    const uploadBody = await prepareDirectUploadBody(mutation)

    let initiation: CloudSyncUploadInitiationResponse
    try {
      initiation = await this.initiateUpload(vaultId, uploadRequest(mutation))
    } catch (error) {
      const conflict = directUploadConflict(error, mutation)
      if (conflict) return { acknowledged: [], conflicts: [conflict], cursor: 0 }
      throw error
    }
    let instruction: CloudSyncUploadInitiationResponse['data']
    let uploadUrl: string
    try {
      instruction = directUploadInstruction(initiation, mutation)
      uploadUrl = secureDirectUploadUrl(instruction.upload.url)
    } catch (error) {
      const uploadId = uploadSessionId(initiation)
      if (uploadId) await this.abortQuietly(vaultId, uploadId)
      throw error
    }
    const upload = instruction.upload
    let response: Response

    try {
      response = await this.fetchImplementation(uploadUrl, {
        method: upload.method,
        headers: upload.headers,
        body: uploadBody.createBody(),
        signal: AbortSignal.timeout(DIRECT_UPLOAD_TIMEOUT_MS),
        redirect: 'error',
        ...(uploadBody.stream ? { duplex: 'half' } : {})
      })
    } catch (error) {
      await this.abortQuietly(vaultId, instruction.id)
      throw error
    }

    if (!response.ok) {
      await this.abortQuietly(vaultId, instruction.id)
      throw new CloudServiceRequestError(
        `ZenNotes Cloud object upload failed (${response.status}).`,
        response.status,
        'DIRECT_UPLOAD_FAILED'
      )
    }

    return await this.completeDirectUpload(vaultId, instruction.id, mutation)
  }

  private async abortQuietly(vaultId: string, uploadId: string): Promise<void> {
    await this.abortUpload(vaultId, uploadId).catch(() => {})
  }

  private async completeDirectUpload(
    vaultId: string,
    uploadId: string,
    mutation: CloudSyncUpsertMutation
  ): Promise<CloudSyncMutationResponse> {
    for (let attempt = 1; attempt <= DIRECT_UPLOAD_COMPLETION_ATTEMPTS; attempt++) {
      try {
        return (await this.completeUpload(vaultId, uploadId)).data.result
      } catch (error) {
        const conflict = directUploadConflict(error, mutation)
        if (conflict) return { acknowledged: [], conflicts: [conflict], cursor: 0 }
        if (attempt === DIRECT_UPLOAD_COMPLETION_ATTEMPTS || !retryableCompletionError(error)) {
          throw error
        }
      }
    }

    throw new Error('ZenNotes Cloud upload completion ended unexpectedly.')
  }
}

class BearerFetchTransport implements CloudSyncHttpTransport {
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImplementation: typeof fetch
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '')
  }

  async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
    const multipart = request.body instanceof FormData
    const response = await this.fetchImplementation(`${this.baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(request.body === undefined || multipart ? {} : { 'Content-Type': 'application/json' })
      },
      body:
        request.body === undefined
          ? undefined
          : request.body instanceof FormData
            ? request.body
            : JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000)
    })
    const payload = await parseJson(response)

    if (!response.ok) {
      const error = asErrorPayload(payload)
      throw new CloudServiceRequestError(
        error?.message ?? `ZenNotes Cloud request failed (${response.status}).`,
        response.status,
        error?.code ?? null,
        error?.details ?? null
      )
    }

    return payload as Response
  }
}

async function parseJson(response: globalThis.Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null

  try {
    return JSON.parse(text)
  } catch {
    throw new CloudServiceRequestError(
      'ZenNotes Cloud returned an invalid JSON response.',
      response.status,
      null
    )
  }
}

function asErrorPayload(payload: unknown): {
  code?: string
  message?: string
  details?: Record<string, unknown>
} | null {
  if (!payload || typeof payload !== 'object') return null
  const response = payload as {
    code?: unknown
    details?: unknown
    error?: unknown
    errors?: unknown
    message?: unknown
  }
  const candidate =
    response.error && typeof response.error === 'object'
      ? (response.error as {
          code?: unknown
          details?: unknown
          message?: unknown
        })
      : response
  const validationMessage = firstValidationMessage(response.errors)

  return {
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(validationMessage !== null
      ? { message: validationMessage }
      : typeof candidate.message === 'string'
        ? { message: candidate.message }
        : {}),
    ...(candidate.details &&
    typeof candidate.details === 'object' &&
    !Array.isArray(candidate.details)
      ? { details: candidate.details as Record<string, unknown> }
      : {})
  }
}

function usesDirectUpload(mutation: CloudSyncMutation): mutation is CloudSyncUpsertMutation {
  return (
    mutation.type === 'upsert' &&
    mutation.content.byte_length > CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES
  )
}

function uploadRequest(mutation: CloudSyncUpsertMutation): CloudSyncUploadRequest {
  return {
    operation_id: mutation.operation_id,
    item_id: mutation.item_id,
    base_revision: mutation.base_revision,
    path: mutation.path,
    kind: mutation.kind,
    content: {
      encoding: mutation.content.encoding,
      sha256: mutation.content.sha256,
      byte_length: mutation.content.byte_length,
      media_type: mutation.content.media_type
    }
  }
}

async function prepareDirectUploadBody(
  mutation: CloudSyncUpsertMutation
): Promise<{ createBody(): FetchBody; stream: boolean }> {
  const sourcePath = cloudSyncUploadSource(mutation.content)
  if (sourcePath) {
    const sourceStats = await stat(sourcePath)
    if (!sourceStats.isFile() || sourceStats.size !== mutation.content.byte_length) {
      throw directUploadSizeMismatch()
    }
    return {
      createBody: () => Readable.toWeb(createReadStream(sourcePath)) as unknown as FetchBody,
      stream: true
    }
  }

  const bytes = uploadBytes(mutation)
  if (bytes.byteLength !== mutation.content.byte_length) throw directUploadSizeMismatch()
  return { createBody: () => bytes as FetchBody, stream: false }
}

function uploadBytes(mutation: CloudSyncUpsertMutation): Uint8Array {
  if (mutation.content.encoding === 'utf8') {
    return new TextEncoder().encode(mutation.content.data)
  }
  return Buffer.from(mutation.content.data, 'base64')
}

function directUploadSizeMismatch(): CloudServiceRequestError {
  return new CloudServiceRequestError(
    'The local file changed while ZenNotes was preparing its Cloud upload.',
    0,
    'DIRECT_UPLOAD_SIZE_MISMATCH'
  )
}

function secureDirectUploadUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw insecureDirectUploadUrl()
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password
  ) {
    throw insecureDirectUploadUrl()
  }

  return url.href
}

function directUploadInstruction(
  initiation: CloudSyncUploadInitiationResponse,
  mutation: CloudSyncUpsertMutation
): CloudSyncUploadInitiationResponse['data'] {
  const candidate = initiation as unknown as { data?: unknown }
  if (!isRecord(candidate.data)) throw invalidDirectUploadResponse()
  const data = candidate.data
  if (!isRecord(data.upload)) throw invalidDirectUploadResponse()
  const upload = data.upload
  if (
    data.operation_id !== mutation.operation_id ||
    data.expected_bytes !== mutation.content.byte_length ||
    typeof data.id !== 'string' ||
    data.id === '' ||
    upload.method !== 'PUT' ||
    typeof upload.url !== 'string' ||
    !isRecord(upload.headers) ||
    !Object.values(upload.headers).every((value) => typeof value === 'string')
  ) {
    throw invalidDirectUploadResponse()
  }

  return data as unknown as CloudSyncUploadInitiationResponse['data']
}

function uploadSessionId(initiation: CloudSyncUploadInitiationResponse): string | null {
  const candidate = initiation as unknown as { data?: unknown }
  return isRecord(candidate.data) &&
    typeof candidate.data.id === 'string' &&
    candidate.data.id !== ''
    ? candidate.data.id
    : null
}

function invalidDirectUploadResponse(): CloudServiceRequestError {
  return new CloudServiceRequestError(
    'ZenNotes Cloud returned an invalid object upload instruction.',
    0,
    'INVALID_DIRECT_UPLOAD_RESPONSE'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function insecureDirectUploadUrl(): CloudServiceRequestError {
  return new CloudServiceRequestError(
    'ZenNotes Cloud returned an insecure object upload URL.',
    0,
    'INSECURE_DIRECT_UPLOAD_URL'
  )
}

function directUploadConflict(
  error: unknown,
  mutation: CloudSyncUpsertMutation
): CloudSyncConflict | null {
  if (!(error instanceof CloudServiceRequestError) || error.status !== 409 || !error.code) {
    return null
  }
  if (!SYNC_CONFLICT_CODES.has(error.code as CloudSyncConflictCode)) return null

  const capacity = capacityConflictDetails(error.details)

  return {
    operation_id: mutation.operation_id,
    item_id: mutation.item_id,
    code: error.code as CloudSyncConflictCode,
    current_revision:
      typeof error.details?.current_revision === 'number' ? error.details.current_revision : null,
    current_path:
      typeof error.details?.current_path === 'string' ? error.details.current_path : null,
    ...(capacity ? { capacity } : {})
  }
}

function capacityConflictDetails(
  details: Record<string, unknown> | null
): CloudSyncCapacityConflict | null {
  if (
    !details ||
    typeof details.dimension !== 'string' ||
    typeof details.used !== 'number' ||
    typeof details.reserved !== 'number' ||
    typeof details.limit !== 'number' ||
    typeof details.projected !== 'number' ||
    typeof details.can_retry_after_reduction !== 'boolean'
  ) {
    return null
  }

  return {
    dimension: details.dimension,
    used: details.used,
    reserved: details.reserved,
    limit: details.limit,
    projected: details.projected,
    can_retry_after_reduction: details.can_retry_after_reduction
  }
}

function retryableCompletionError(error: unknown): boolean {
  return !(error instanceof CloudServiceRequestError) || error.status >= 500
}

function firstValidationMessage(errors: unknown): string | null {
  if (!errors || typeof errors !== 'object') return null

  for (const messages of Object.values(errors)) {
    if (Array.isArray(messages)) {
      const message = messages.find(
        (candidate): candidate is string => typeof candidate === 'string'
      )
      if (message) return message
    }
  }

  return null
}
