import type {
  CloudSyncCapacityConflict,
  CloudSyncConflict,
  CloudSyncConflictCode,
  CloudSyncContent,
  CloudSyncMutation,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncUpsertMutation,
  CloudSyncUploadCompletionResponse,
  CloudSyncUploadInitiationResponse,
  CloudSyncUploadRequest
} from '@zennotes/bridge-contract/cloud-sync'
import { toBase64, zne1CiphertextLength } from '@zennotes/shared-domain/cloud-e2ee'
import type { CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { cloudSendTimeoutMs } from '@zennotes/shared-domain/cloud-sync-stall'
import {
  CloudSyncPathRefusedError,
  cloudSyncPathRefusal,
  isCloudSyncUploadPathRefused
} from '@zennotes/shared-domain/cloud-sync-refusal'

export const CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024

/** What an encrypted vault's direct upload needs from its CloudVaultCipher. */
export type MobileUploadCipher = Pick<
  CloudVaultCipher,
  'beginContentEncryption' | 'directUploadFields' | 'sealContent' | 'openConflict'
>

/** A large file sealed into a private temp by the native chunk loop. */
export interface MobileSealedUpload {
  uri: string
  byteLength: number
  sha256: string
  plaintextByteLength: number
  plaintextSha256: string
  discard(): Promise<void>
}

/** Seals one large source file for an encrypted vault with the given base64 object key, header and AAD. */
export type MobileUploadSealer = (keys: { header: string; objectKey: string; aad: string }) => Promise<MobileSealedUpload>

/** Large scanned files carry no bytes in `data`; the native file URI lives
 * here, keyed by identity, so only the uploader that created it can read it. */
const uploadSources = new WeakMap<CloudSyncContent, { uri: string; seal?: MobileUploadSealer }>()

export function rememberMobileUploadSource(
  content: CloudSyncContent,
  uri: string,
  seal?: MobileUploadSealer
): CloudSyncContent {
  uploadSources.set(content, { uri, seal })
  return content
}

const DIRECT_UPLOAD_COMPLETION_ATTEMPTS = 3
const SYNC_CONFLICT_CODES = new Set<CloudSyncConflictCode>([
  'REVISION_CONFLICT',
  'PATH_CONFLICT',
  'ITEM_DELETED',
  'QUOTA_EXCEEDED',
  'CAPACITY_EXCEEDED',
  'FILE_SIZE_LIMIT_EXCEEDED'
])

export interface MobileDirectUploadApi {
  mutate(vaultId: string, body: CloudSyncMutationRequest): Promise<CloudSyncMutationResponse>
  initiateUpload(
    vaultId: string,
    body: CloudSyncUploadRequest
  ): Promise<CloudSyncUploadInitiationResponse>
  completeUpload(vaultId: string, uploadId: string): Promise<CloudSyncUploadCompletionResponse>
  abortUpload(vaultId: string, uploadId: string): Promise<void>
  /** The vault's cipher, or null for a readable vault; throws while an encrypted vault is locked. */
  vaultCipher?(vaultId: string): Promise<MobileUploadCipher | null>
}

export type MobileObjectUploadRequest = {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  byteLength: number
} & ({ uri: string; sha256: string; base64?: never } | { base64: string; uri?: never; sha256?: string })

export type MobileObjectUpload = (request: MobileObjectUploadRequest) => Promise<void>

export interface MobileObjectUploadOptions {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  data: string
  dataType: 'file'
  connectTimeout: number
  readTimeout: number
  disableRedirects: true
}

export function mobileObjectUploadOptions(
  request: MobileObjectUploadRequest
): MobileObjectUploadOptions {
  if (request.uri !== undefined) throw new Error('File-backed uploads require the native file uploader.')
  // Capacitor iOS only attaches the binary body when Content-Type exists.
  // Production presigned URLs may return just Host; preserve signed headers.
  const headers = { ...request.headers }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/octet-stream'
  }
  return {
    url: request.url,
    method: request.method,
    headers,
    data: request.base64,
    dataType: 'file',
    // iOS uses connectTimeout ahead of readTimeout for the whole request, and
    // bytes going out never restart it: the PUT gets the time its body takes
    // on a slow uplink, plus the stall bound for the store's answer.
    connectTimeout: cloudSendTimeoutMs(request.byteLength),
    readTimeout: cloudSendTimeoutMs(request.byteLength),
    disableRedirects: true
  }
}

export class MobileDirectUploadError extends Error {
  readonly status: number
  readonly code: string | null
  readonly details: Record<string, unknown> | null

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown> | null = null
  ) {
    super(message)
    this.name = 'MobileDirectUploadError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export async function mutateWithMobileDirectUploads(
  api: MobileDirectUploadApi,
  vaultId: string,
  body: CloudSyncMutationRequest,
  uploadObject: MobileObjectUpload
): Promise<CloudSyncMutationResponse> {
  // Encryption adds a header and a tag per chunk, and the service caps inline
  // bodies, so an encrypted vault decides by the size it will actually send.
  const cipher = (await api.vaultCipher?.(vaultId)) ?? null
  const direct = (mutation: CloudSyncMutation): mutation is CloudSyncUpsertMutation =>
    usesDirectUpload(mutation, cipher !== null)
  if (!body.mutations.some(direct)) return api.mutate(vaultId, body)

  const responses: CloudSyncMutationResponse[] = []
  let inlineMutations: CloudSyncMutation[] = []
  let inlineIndices: number[] = []
  // The batch goes out as several requests, so a path Cloud refuses in one of
  // them (#1004) comes back after the earlier ones were applied. The refusal
  // names positions in the batch this was given and carries what was applied,
  // so sync commits that and resends only what went unanswered. A port of
  // desktop's DesktopCloudSyncApiClient.mutate (core 2.80).
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
      responses.push(await api.mutate(vaultId, { mutations: inlineMutations }))
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
        responses.push(await directUpload(api, vaultId, mutation, uploadObject, cipher))
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

function merged(responses: CloudSyncMutationResponse[]): CloudSyncMutationResponse {
  return {
    acknowledged: responses.flatMap((response) => response.acknowledged),
    conflicts: responses.flatMap((response) => response.conflicts),
    cursor: Math.max(0, ...responses.map((response) => response.cursor))
  }
}

/** A direct upload's refusal names its own request's `path`; as one mutation
 *  of a batch it is that mutation's path. The copy keeps the error's class and
 *  fields, only the refused field is renamed. */
function withMutationField(error: unknown, index: number): unknown {
  if (!isServiceError(error)) return error
  const errors = error.details?.errors as Record<string, unknown> | undefined
  const copy = Object.assign(Object.create(Object.getPrototypeOf(error) as object) as Error, error)
  // An Error's message is its own property but not an enumerable one.
  copy.message = (error as unknown as Error).message
  return Object.assign(copy, {
    details: { ...error.details, errors: { [`mutations.${index}.path`]: errors?.path ?? [] } }
  })
}

function usesDirectUpload(mutation: CloudSyncMutation, encrypted: boolean): mutation is CloudSyncUpsertMutation {
  if (mutation.type !== 'upsert') return false
  const bytes = encrypted ? zne1CiphertextLength(mutation.content.byte_length) : mutation.content.byte_length
  return bytes > CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES
}

/** The upload request and the exact bytes the PUT sends: the file, or for an encrypted vault its ciphertext. */
interface PreparedDirectUpload {
  request: CloudSyncUploadRequest
  source: { uri: string } | { base64: string }
  sha256: string
  byteLength: number
  cleanup(): Promise<void>
}

async function directUpload(
  api: MobileDirectUploadApi,
  vaultId: string,
  mutation: CloudSyncUpsertMutation,
  uploadObject: MobileObjectUpload,
  cipher: MobileUploadCipher | null
): Promise<CloudSyncMutationResponse> {
  const prepared = cipher ? await prepareSealedUpload(mutation, cipher) : preparePlainUpload(mutation)
  try {
    return await sendDirectUpload(api, vaultId, mutation, uploadObject, prepared, cipher)
  } finally {
    await prepared.cleanup()
  }
}

function preparePlainUpload(mutation: CloudSyncUpsertMutation): PreparedDirectUpload {
  const uri = uploadSources.get(mutation.content)?.uri
  return {
    request: uploadRequest(mutation),
    source: uri === undefined ? { base64: uploadBase64(mutation) } : { uri },
    sha256: mutation.content.sha256,
    byteLength: mutation.content.byte_length,
    cleanup: async () => {}
  }
}

/**
 * Seals the file before the upload is initiated, since the service must be
 * told the ciphertext's length and hash first. A large file is sealed by the
 * native chunk loop into a private temp that the native PUT then streams; one
 * whose bytes are already here (it crossed the inline limit only once sealed)
 * is sealed in memory. Either way the plaintext is checked against the hash
 * sync planned with, so a file that changed since is never sealed under it.
 */
async function prepareSealedUpload(
  mutation: CloudSyncUpsertMutation,
  cipher: MobileUploadCipher
): Promise<PreparedDirectUpload> {
  const registered = uploadSources.get(mutation.content)
  if (!registered) {
    const sealed = await cipher.sealContent(mutation.content)
    return {
      request: await sealedUploadRequest(mutation, cipher, sealed),
      source: { base64: sealed.data },
      sha256: sealed.sha256,
      byteLength: sealed.byte_length,
      cleanup: async () => {}
    }
  }
  if (!registered.seal) throw new Error('This device cannot seal large files for an end-to-end encrypted vault.')
  const keys = await cipher.beginContentEncryption()
  const sealed = await registered.seal({
    header: toBase64(keys.header), objectKey: toBase64(keys.objectKey), aad: toBase64(keys.aad)
  })
  try {
    if (sealed.plaintextByteLength !== mutation.content.byte_length || sealed.plaintextSha256 !== mutation.content.sha256) {
      throw directUploadSizeMismatch()
    }
    return {
      request: await sealedUploadRequest(mutation, cipher, { sha256: sealed.sha256, byte_length: sealed.byteLength }),
      source: { uri: sealed.uri },
      sha256: sealed.sha256,
      byteLength: sealed.byteLength,
      cleanup: () => sealed.discard()
    }
  } catch (error) {
    await sealed.discard()
    throw error
  }
}

async function sealedUploadRequest(
  mutation: CloudSyncUpsertMutation,
  cipher: MobileUploadCipher,
  ciphertext: { sha256: string; byte_length: number }
): Promise<CloudSyncUploadRequest> {
  const fields = await cipher.directUploadFields(mutation.path, mutation.kind, mutation.content, {
    sha256: ciphertext.sha256,
    byte_length: ciphertext.byte_length
  })
  return {
    operation_id: mutation.operation_id,
    item_id: mutation.item_id,
    base_revision: mutation.base_revision,
    ...fields
  }
}

async function sendDirectUpload(
  api: MobileDirectUploadApi,
  vaultId: string,
  mutation: CloudSyncUpsertMutation,
  uploadObject: MobileObjectUpload,
  prepared: PreparedDirectUpload,
  cipher: MobileUploadCipher | null
): Promise<CloudSyncMutationResponse> {
  let initiation: CloudSyncUploadInitiationResponse

  try {
    initiation = await api.initiateUpload(vaultId, prepared.request)
  } catch (error) {
    const conflict = directUploadConflict(error, mutation)
    if (conflict) return { acknowledged: [], conflicts: [await openConflict(conflict, cipher)], cursor: 0 }
    throw error
  }

  let instruction: CloudSyncUploadInitiationResponse['data']
  try {
    instruction = directUploadInstruction(initiation, mutation, prepared.byteLength)
  } catch (error) {
    const uploadId = uploadSessionId(initiation)
    if (uploadId) await abortQuietly(api, vaultId, uploadId)
    throw error
  }

  try {
    await uploadObject({
      url: secureDirectUploadUrl(instruction.upload.url),
      method: instruction.upload.method,
      headers: instruction.upload.headers,
      ...prepared.source,
      sha256: prepared.sha256,
      byteLength: prepared.byteLength
    })
  } catch (error) {
    await abortQuietly(api, vaultId, instruction.id)
    throw error
  }

  return completeDirectUpload(api, vaultId, instruction.id, mutation, cipher)
}

async function completeDirectUpload(
  api: MobileDirectUploadApi,
  vaultId: string,
  uploadId: string,
  mutation: CloudSyncUpsertMutation,
  cipher: MobileUploadCipher | null
): Promise<CloudSyncMutationResponse> {
  for (let attempt = 1; attempt <= DIRECT_UPLOAD_COMPLETION_ATTEMPTS; attempt++) {
    try {
      return (await api.completeUpload(vaultId, uploadId)).data.result
    } catch (error) {
      const conflict = directUploadConflict(error, mutation)
      if (conflict) return { acknowledged: [], conflicts: [await openConflict(conflict, cipher)], cursor: 0 }
      if (attempt === DIRECT_UPLOAD_COMPLETION_ATTEMPTS || !retryableCompletionError(error)) {
        throw error
      }
    }
  }
  throw new Error('ZenNotes Cloud upload completion ended unexpectedly.')
}

/** An encrypted vault's conflict names a path id and sealed metadata; the coordinator needs the real path. */
async function openConflict(conflict: CloudSyncConflict, cipher: MobileUploadCipher | null): Promise<CloudSyncConflict> {
  return cipher ? cipher.openConflict(conflict) : conflict
}

async function abortQuietly(
  api: MobileDirectUploadApi,
  vaultId: string,
  uploadId: string
): Promise<void> {
  await api.abortUpload(vaultId, uploadId).catch(() => {})
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

function uploadBase64(mutation: CloudSyncUpsertMutation): string {
  if (mutation.content.encoding === 'utf8') {
    const bytes = new TextEncoder().encode(mutation.content.data)
    if (bytes.byteLength !== mutation.content.byte_length) throw directUploadSizeMismatch()
    return bytesToBase64(bytes)
  }

  const normalized = mutation.content.data.includes(',')
    ? mutation.content.data.slice(mutation.content.data.indexOf(',') + 1).replace(/\s/g, '')
    : mutation.content.data.replace(/\s/g, '')
  if (!validBase64(normalized) || decodedBase64Length(normalized) !== mutation.content.byte_length) {
    throw directUploadSizeMismatch()
  }
  return normalized
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function validBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  const paddingStart = value.indexOf('=')
  const contentEnd = paddingStart < 0 ? value.length : paddingStart
  const padding = value.length - contentEnd
  if (padding > 2 || (padding > 0 && contentEnd < value.length - 2)) return false

  for (let index = 0; index < contentEnd; index++) {
    const code = value.charCodeAt(index)
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    if (!valid) return false
  }
  for (let index = contentEnd; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) return false
  }
  return true
}

function decodedBase64Length(value: string): number {
  if (value === '') return 0
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
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
  return isRecord(candidate.data) && typeof candidate.data.id === 'string' && candidate.data.id !== ''
    ? candidate.data.id
    : null
}

export function secureDirectUploadUrl(value: string): string {
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

function directUploadConflict(
  error: unknown,
  mutation: CloudSyncUpsertMutation
): CloudSyncConflict | null {
  if (!isServiceError(error) || error.status !== 409 || !error.code) return null
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
  ) return null
  return details as unknown as CloudSyncCapacityConflict
}

function isServiceError(error: unknown): error is {
  status: number
  code: string | null
  details: Record<string, unknown> | null
} {
  return error instanceof Error &&
    typeof (error as { status?: unknown }).status === 'number' &&
    ((error as { code?: unknown }).code === null || typeof (error as { code?: unknown }).code === 'string')
}

function retryableCompletionError(error: unknown): boolean {
  return !isServiceError(error) || error.status >= 500
}

function directUploadSizeMismatch(): MobileDirectUploadError {
  return new MobileDirectUploadError(
    'The local file changed while ZenNotes was preparing its Cloud upload.',
    0,
    'DIRECT_UPLOAD_SIZE_MISMATCH'
  )
}

function invalidDirectUploadResponse(): MobileDirectUploadError {
  return new MobileDirectUploadError(
    'ZenNotes Cloud returned an invalid object upload instruction.',
    0,
    'INVALID_DIRECT_UPLOAD_RESPONSE'
  )
}

function insecureDirectUploadUrl(): MobileDirectUploadError {
  return new MobileDirectUploadError(
    'ZenNotes Cloud returned an insecure object upload URL.',
    0,
    'INSECURE_DIRECT_UPLOAD_URL'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
