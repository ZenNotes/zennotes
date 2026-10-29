import {
  CloudSyncApiClient,
  cloudSyncRateLimits,
  type CloudSyncRateLimitCoordinator,
  type CloudSyncResponseHeaders,
  type CloudSyncHttpRequest,
  type CloudSyncHttpTransport
} from '@zennotes/shared-domain/cloud-sync-api'
import { createHash } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zne1CiphertextLength } from '@zennotes/shared-domain/cloud-e2ee'
import { cloudProtocolError } from '@zennotes/shared-domain/cloud-error-copy'
import {
  CloudSyncPathRefusedError,
  cloudSyncPathRefusal,
  isCloudSyncUploadPathRefused
} from '@zennotes/shared-domain/cloud-sync-refusal'
import type { CloudVaultCipher, CloudVaultCipherSource } from '@zennotes/shared-domain/cloud-e2ee-vault'
import type {
  CloudPublishUploadTarget,
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
    readonly details: Record<string, unknown> | null = null,
    readonly headers: CloudSyncResponseHeaders = {}
  ) {
    super(message)
    this.name = 'CloudServiceRequestError'
  }
}

export interface DesktopCloudSyncClientOptions {
  accountId?: string
  signal?: AbortSignal
  rateLimits?: CloudSyncRateLimitCoordinator
  contentReferences?: boolean
  /** Desktop seals and opens every path an encrypted vault's bytes take. */
  endToEndEncryption?: boolean
  vaultCiphers?: CloudVaultCipherSource
}

/** One staged publish attachment to PUT: a local file streamed from disk, or a
 * remote vault's file already in memory. */
export interface PublishAssetSource {
  mime: string
  byteLength: number
  file?: string
  bytes?: Uint8Array
}

export type DesktopCloudSyncClient = CloudSyncApiClient & {
  uploadPublishAsset(target: CloudPublishUploadTarget, source: PublishAssetSource): Promise<void>
}

export function createCloudSyncClient(
  baseUrl: string,
  token: string,
  fetchImplementation: typeof fetch = fetch,
  options: DesktopCloudSyncClientOptions = {}
): DesktopCloudSyncClient {
  const accountId = options.accountId ?? createHash('sha256').update(token).digest('hex')
  return new DesktopCloudSyncApiClient(
    (options.rateLimits ?? cloudSyncRateLimits).wrap(
      new BearerFetchTransport(baseUrl, token, fetchImplementation),
      {
        baseUrl,
        // The service supplies stable account identity. Standalone callers
        // can still share a credential's cooldown without retaining its token.
        accountId,
        signal: options.signal
      }
    ),
    fetchImplementation,
    options.signal,
    { ...options, accountId, baseUrl }
  )
}

class DesktopCloudSyncApiClient extends CloudSyncApiClient {
  constructor(
    http: CloudSyncHttpTransport,
    private readonly fetchImplementation: typeof fetch,
    private readonly signal: AbortSignal | undefined,
    options: DesktopCloudSyncClientOptions & { baseUrl: string; accountId: string }
  ) {
    const url = new URL(options.baseUrl)
    super(http, {
      contentReferences: options.contentReferences, accountScope: { baseUrl: options.baseUrl, accountId: options.accountId },
      signal, allowInsecureLoopbackDownloads: url.protocol === 'http:' &&
        (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname)),
      endToEndEncryption: options.endToEndEncryption,
      vaultCiphers: options.vaultCiphers
    })
  }

  override async mutate(
    vaultId: string,
    body: CloudSyncMutationRequest
  ): Promise<CloudSyncMutationResponse> {
    // Encryption adds a header and a tag per chunk, and the service caps inline
    // bodies, so an encrypted vault decides by the size it will actually send.
    const encrypted = (await this.vaultCipher(vaultId)) !== null
    const direct = (mutation: CloudSyncMutation): mutation is CloudSyncUpsertMutation =>
      usesDirectUpload(mutation, encrypted)
    if (!body.mutations.some(direct)) return super.mutate(vaultId, body)

    const responses: CloudSyncMutationResponse[] = []
    let inlineMutations: CloudSyncMutation[] = []
    let inlineIndices: number[] = []
    // The batch goes out as several requests, so a path Cloud refuses in one
    // of them comes back after the earlier ones were applied. The refusal
    // names positions in the batch this was given and carries what was
    // applied, so sync commits that and resends only what went unanswered.
    const refused = (error: unknown, indices: number[]): never => {
      const refusal = indices.length === 1 && isCloudSyncUploadPathRefused(error)
        ? cloudSyncPathRefusal(withMutationField(error, 0), { mutations: [body.mutations[indices[0]]] })
        : cloudSyncPathRefusal(error, { mutations: indices.map((index) => body.mutations[index]) })
      if (!refusal) throw error
      throw new CloudSyncPathRefusedError(
        { ...refusal, indices: refusal.indices.map((index) => indices[index]), applied: merged(responses) },
        error
      )
    }
    const flushInline = async (): Promise<void> => {
      if (inlineMutations.length === 0) return
      try {
        responses.push(await super.mutate(vaultId, { mutations: inlineMutations }))
      } catch (error) {
        refused(error, inlineIndices)
      }
      inlineMutations = []
      inlineIndices = []
    }

    for (const [index, mutation] of body.mutations.entries()) {
      if (direct(mutation)) {
        await flushInline()
        try {
          responses.push(await this.directUpload(vaultId, mutation))
        } catch (error) {
          refused(error, [index])
        }
      } else {
        inlineMutations.push(mutation)
        inlineIndices.push(index)
      }
    }
    await flushInline()

    return merged(responses)
  }

  private async directUpload(
    vaultId: string,
    mutation: CloudSyncUpsertMutation
  ): Promise<CloudSyncMutationResponse> {
    this.signal?.throwIfAborted()
    const cipher = await this.vaultCipher(vaultId)
    const prepared = cipher
      ? await prepareEncryptedDirectUpload(mutation, cipher, this.signal)
      : await preparePlainDirectUpload(mutation)
    try {
      return await this.sendDirectUpload(vaultId, mutation, prepared, cipher)
    } finally {
      await prepared.cleanup()
    }
  }

  private async sendDirectUpload(
    vaultId: string,
    mutation: CloudSyncUpsertMutation,
    prepared: PreparedDirectUpload,
    cipher: CloudVaultCipher | null
  ): Promise<CloudSyncMutationResponse> {
    const uploadBody = prepared
    let initiation: CloudSyncUploadInitiationResponse
    try {
      initiation = await this.initiateUpload(vaultId, prepared.request)
    } catch (error) {
      const conflict = directUploadConflict(error, mutation)
      if (conflict) return { acknowledged: [], conflicts: [cipher ? await cipher.openConflict(conflict) : conflict], cursor: 0 }
      throw error
    }
    let instruction: CloudSyncUploadInitiationResponse['data']
    let uploadUrl: string
    try {
      instruction = directUploadInstruction(initiation, mutation, prepared.contentLength)
      uploadUrl = secureDirectUploadUrl(instruction.upload.url)
    } catch (error) {
      const uploadId = uploadSessionId(initiation)
      if (uploadId) await this.abortQuietly(vaultId, uploadId)
      throw error
    }
    const upload = instruction.upload
    // The Cloud service signs only the host of the presigned PUT and hands back
    // no length, and a streamed file has no length of its own, so fetch would
    // send it chunked. Object storage refuses a chunked PUT without a
    // Content-Length (411 Length Required), which is what every file above the
    // inline limit ran into. The mutation knows the byte count, so it travels
    // as Content-Length unless the service already set one; a file that
    // changes size mid-upload then fails the request instead of storing a
    // truncated or padded object. Content-Type likewise names the media type
    // the service reserved.
    const headers = new Headers(upload.headers)
    if (!headers.has('content-length')) {
      headers.set('content-length', String(prepared.contentLength))
    }
    if (!headers.has('content-type')) headers.set('content-type', prepared.contentType)
    let response: Response

    try {
      try {
        response = await this.fetchImplementation(uploadUrl, {
          method: upload.method,
          headers,
          body: uploadBody.createBody(),
          signal: requestSignal(this.signal, DIRECT_UPLOAD_TIMEOUT_MS),
          redirect: 'error',
          ...(uploadBody.stream ? { duplex: 'half' } : {})
        })
      } finally {
        // A server can reject the PUT before reading the file. Stop its reader
        // before waiting for reservation cleanup (including on timeout/abort).
        uploadBody.dispose()
      }
    } catch (error) {
      await this.abortQuietly(vaultId, instruction.id)
      throw error
    }
    await response.body?.cancel().catch(() => {})

    if (!response.ok) {
      await this.abortQuietly(vaultId, instruction.id)
      throw new CloudServiceRequestError(
        `ZenNotes Cloud object upload failed (${response.status}).`,
        response.status,
        'DIRECT_UPLOAD_FAILED'
      )
    }

    return await this.completeDirectUpload(vaultId, instruction.id, mutation, cipher)
  }

  /**
   * PUT one staged publish attachment to the presigned URL the service gave it,
   * with the same safeguards as a sync upload: HTTPS only, no redirects, and an
   * explicit Content-Length (object storage refuses a chunked PUT, 411), from a
   * file that must still be the size that was declared.
   */
  async uploadPublishAsset(target: CloudPublishUploadTarget, source: PublishAssetSource): Promise<void> {
    this.signal?.throwIfAborted()
    const uploadUrl = secureDirectUploadUrl(target.url)
    const headers = new Headers(target.headers)
    if (!headers.has('content-length')) headers.set('content-length', String(source.byteLength))
    if (!headers.has('content-type')) headers.set('content-type', source.mime)

    let reader: ReadStream | undefined
    let body: FetchBody
    if (source.file !== undefined) {
      const sourceStats = await stat(source.file)
      if (!sourceStats.isFile() || sourceStats.size !== source.byteLength) throw directUploadSizeMismatch()
      body = (reader = createReadStream(source.file)) as unknown as FetchBody
    } else if (source.bytes !== undefined) {
      if (source.bytes.byteLength !== source.byteLength) throw directUploadSizeMismatch()
      body = source.bytes as FetchBody
    } else {
      throw cloudProtocolError('A publish upload needs a file or its bytes.')
    }

    let response: Response
    try {
      response = await this.fetchImplementation(uploadUrl, {
        method: target.method,
        headers,
        body,
        signal: requestSignal(this.signal, DIRECT_UPLOAD_TIMEOUT_MS),
        redirect: 'error',
        ...(reader ? { duplex: 'half' } : {})
      })
    } finally {
      reader?.destroy()
    }
    await response.body?.cancel().catch(() => {})

    if (!response.ok) {
      throw new CloudServiceRequestError(
        `ZenNotes Cloud object upload failed (${response.status}).`,
        response.status,
        'DIRECT_UPLOAD_FAILED'
      )
    }
  }

  private async abortQuietly(vaultId: string, uploadId: string): Promise<void> {
    await this.abortUpload(vaultId, uploadId).catch(() => {})
  }

  private async completeDirectUpload(
    vaultId: string,
    uploadId: string,
    mutation: CloudSyncUpsertMutation,
    cipher: CloudVaultCipher | null
  ): Promise<CloudSyncMutationResponse> {
    for (let attempt = 1; attempt <= DIRECT_UPLOAD_COMPLETION_ATTEMPTS; attempt++) {
      this.signal?.throwIfAborted()
      try {
        return (await this.completeUpload(vaultId, uploadId)).data.result
      } catch (error) {
        const conflict = directUploadConflict(error, mutation)
        if (conflict) return { acknowledged: [], conflicts: [cipher ? await cipher.openConflict(conflict) : conflict], cursor: 0 }
        if (attempt === DIRECT_UPLOAD_COMPLETION_ATTEMPTS || !retryableCompletionError(error)) {
          throw error
        }
      }
    }

    throw new CloudServiceRequestError('ZenNotes Cloud upload completion ended unexpectedly.', 0, 'INVALID_DIRECT_UPLOAD_RESPONSE')
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
        ...request.headers,
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
      signal: requestSignal(request.signal, request.timeoutMs ?? 30_000)
    })
    const payload = await parseJson(response)

    if (!response.ok) {
      const error = asErrorPayload(payload)
      throw new CloudServiceRequestError(
        error?.message ?? `ZenNotes Cloud request failed (${response.status}).`,
        response.status,
        error?.code ?? null,
        error?.details ?? null,
        response.headers
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
      null,
      null,
      response.headers
    )
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
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
  const details =
    candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
      ? (candidate.details as Record<string, unknown>)
      : null
  // Which field a 422 refused is only in the answer's `errors` keys
  // (`mutations.3.path`); sync needs it to set one refused path aside (#1004).
  const errors =
    response.errors && typeof response.errors === 'object' && !Array.isArray(response.errors)
      ? response.errors
      : null

  return {
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(validationMessage !== null
      ? { message: validationMessage }
      : typeof candidate.message === 'string'
        ? { message: candidate.message }
        : {}),
    ...(details || errors ? { details: { ...details, ...(errors ? { errors } : {}) } } : {})
  }
}

function merged(responses: CloudSyncMutationResponse[]): CloudSyncMutationResponse {
  return {
    acknowledged: responses.flatMap((response) => response.acknowledged),
    conflicts: responses.flatMap((response) => response.conflicts),
    cursor: Math.max(0, ...responses.map((response) => response.cursor))
  }
}

/** A direct upload's refusal names its own request's `path`; as one
 *  mutation of a batch it is that mutation's path. */
function withMutationField(error: unknown, index: number): unknown {
  if (!(error instanceof CloudServiceRequestError)) return error
  const errors = error.details?.errors as Record<string, unknown> | undefined
  return new CloudServiceRequestError(error.message, error.status, error.code, {
    ...error.details,
    errors: { [`mutations.${index}.path`]: errors?.path ?? [] }
  }, error.headers)
}

function usesDirectUpload(mutation: CloudSyncMutation, encrypted: boolean): mutation is CloudSyncUpsertMutation {
  if (mutation.type !== 'upsert') return false
  const bytes = encrypted ? zne1CiphertextLength(mutation.content.byte_length) : mutation.content.byte_length
  return bytes > CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES
}

interface PreparedDirectUpload {
  request: CloudSyncUploadRequest
  /** The exact bytes the PUT sends: the file, or for an encrypted vault its ciphertext. */
  contentLength: number
  contentType: string
  createBody(): FetchBody
  dispose(): void
  stream: boolean
  cleanup(): Promise<void>
}

async function preparePlainDirectUpload(mutation: CloudSyncUpsertMutation): Promise<PreparedDirectUpload> {
  return {
    ...(await prepareDirectUploadBody(mutation)),
    request: uploadRequest(mutation),
    contentLength: mutation.content.byte_length,
    contentType: mutation.content.media_type,
    cleanup: async () => {}
  }
}

/**
 * Seals the file into a private temp file first: the service must be told the
 * ciphertext's length and hash before the PUT starts, and streaming keeps a
 * 200 MB attachment from ever sitting in memory. The plaintext is hashed on the
 * way through, so a file that changed since sync hashed it is refused instead
 * of being sealed under the old hash.
 */
async function prepareEncryptedDirectUpload(
  mutation: CloudSyncUpsertMutation,
  cipher: CloudVaultCipher,
  signal: AbortSignal | undefined
): Promise<PreparedDirectUpload> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zennotes-upload-'))
  const cleanup = () => rm(directory, { recursive: true, force: true })
  try {
    await chmod(directory, 0o700)
    const sealedPath = path.join(directory, 'sealed')
    const sourcePath = cloudSyncUploadSource(mutation.content)
    const plaintext: AsyncIterable<Uint8Array> | Iterable<Uint8Array> = sourcePath
      ? createReadStream(sourcePath)
      : [uploadBytes(mutation)]
    const plainHash = createHash('sha256')
    let plainLength = 0
    async function* hashed(): AsyncGenerator<Uint8Array> {
      for await (const chunk of plaintext) {
        plainLength += chunk.byteLength
        plainHash.update(chunk)
        yield chunk
      }
    }
    const sealedHash = createHash('sha256')
    let sealedLength = 0
    const file = await open(sealedPath, 'wx', 0o600)
    try {
      for await (const piece of cipher.encryptStream(hashed())) {
        signal?.throwIfAborted()
        sealedHash.update(piece)
        sealedLength += piece.byteLength
        let offset = 0
        while (offset < piece.byteLength) {
          const written = await file.write(piece, offset)
          if (written.bytesWritten === 0) throw Object.assign(new Error('Encrypted upload staging made no progress.'), { code: 'EIO' })
          offset += written.bytesWritten
        }
      }
      await file.sync()
    } finally {
      await file.close()
    }
    if (plainLength !== mutation.content.byte_length || plainHash.digest('hex') !== mutation.content.sha256) {
      throw directUploadSizeMismatch()
    }
    const fields = await cipher.directUploadFields(mutation.path, mutation.kind, mutation.content, {
      sha256: sealedHash.digest('hex'),
      byte_length: sealedLength
    })
    let reader: ReadStream | undefined
    return {
      request: {
        operation_id: mutation.operation_id,
        item_id: mutation.item_id,
        base_revision: mutation.base_revision,
        path: fields.path,
        kind: fields.kind,
        content: fields.content,
        meta: fields.meta
      },
      contentLength: sealedLength,
      contentType: fields.content.media_type,
      createBody: () => (reader = createReadStream(sealedPath)) as unknown as FetchBody,
      dispose: () => {
        reader?.destroy()
      },
      stream: true,
      cleanup
    }
  } catch (error) {
    await cleanup()
    throw error
  }
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
): Promise<{ createBody(): FetchBody; dispose(): void; stream: boolean }> {
  const sourcePath = cloudSyncUploadSource(mutation.content)
  if (sourcePath) {
    const sourceStats = await stat(sourcePath)
    if (!sourceStats.isFile() || sourceStats.size !== mutation.content.byte_length) {
      throw directUploadSizeMismatch()
    }
    let reader: ReadStream | undefined
    return {
      // Node fetch accepts async iterables directly. Avoid the event-based
      // toWeb adapter: late file events after cancellation can enqueue into
      // a closed WebStream controller outside the fetch promise's catch.
      createBody: () => (reader = createReadStream(sourcePath)) as unknown as FetchBody,
      dispose: () => {
        reader?.destroy()
      },
      stream: true
    }
  }

  const bytes = uploadBytes(mutation)
  if (bytes.byteLength !== mutation.content.byte_length) throw directUploadSizeMismatch()
  return { createBody: () => bytes as FetchBody, dispose: () => {}, stream: false }
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
  mutation: CloudSyncUpsertMutation,
  expectedBytes: number
): CloudSyncUploadInitiationResponse['data'] {
  const candidate = initiation as unknown as { data?: unknown }
  if (!isRecord(candidate.data)) throw invalidDirectUploadResponse()
  const data = candidate.data
  if (!isRecord(data.upload)) throw invalidDirectUploadResponse()
  const upload = data.upload
  if (
    data.operation_id !== mutation.operation_id ||
    data.expected_bytes !== expectedBytes ||
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
    ...(typeof error.details?.current_meta === 'string' ? { current_meta: error.details.current_meta } : {}),
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
