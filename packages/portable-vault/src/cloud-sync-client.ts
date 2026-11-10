import {
  CloudSyncApiClient,
  cloudSyncRateLimits,
  type CloudSyncResponseHeaders,
  type CloudSyncHttpRequest,
  type CloudSyncHttpTransport
} from '@zennotes/shared-domain/cloud-sync-api'
import type {
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncVaultCollection
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudE2eeKeyring } from '@zennotes/shared-domain/cloud-e2ee-account'
import { ENCRYPTED_VAULT_PLACEHOLDER_NAME } from '@zennotes/shared-domain/cloud-e2ee-vault'
import {
  CLOUD_TRANSPORT_RETRY_DELAYS_MS,
  CloudSyncTransportError,
  cloudSendTimeoutMs,
  isCloudSyncTransportError,
  retryCloudTransfer
} from '@zennotes/shared-domain/cloud-sync-stall'
import {
  MobileDirectUploadError,
  mobileObjectUploadOptions,
  mutateWithMobileDirectUploads,
  type MobileObjectUpload
} from './mobile-direct-upload'
import { portableHost } from './host'

let requestLifetime = new AbortController()

export function mobileCloudRequestSignal(): AbortSignal {
  return requestLifetime.signal
}

export function stopMobileCloudRequests(): void {
  requestLifetime.abort()
  cloudSyncRateLimits.cancelAll()
}

export function resumeMobileCloudRequests(): void {
  if (requestLifetime.signal.aborted) requestLifetime = new AbortController()
}

export class CloudServiceRequestError extends Error {
  readonly status: number
  readonly code: string | null
  readonly details: Record<string, unknown> | null

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown> | null = null,
    readonly headers: CloudSyncResponseHeaders = {}
  ) {
    super(message)
    this.name = 'CloudServiceRequestError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function createCloudSyncClient(baseUrl: string, token: string, options: {
  accountId: string
  signal?: AbortSignal
  /**
   * End-to-end encryption: this host opens every path an encrypted vault's
   * bytes take, and each vault's cipher comes from here. Without it the
   * client never tells the service it may serve encrypted vaults.
   */
  keyring?: CloudE2eeKeyring
}): CloudSyncApiClient {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
  const lifetime = options.signal ?? requestLifetime.signal
  const transport: CloudSyncHttpTransport = {
    async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
      const multipart = request.body instanceof FormData
      // The host sizes the timeouts its transport applies (HttpTransport.cloudTimeouts);
      // the default is the iPhone's. URLSession starts this timeout over
      // whenever data arrives, so a big page on a slow link keeps going as
      // long as bytes move. Bytes going out do not restart it: a body also
      // gets the time it takes on a slow uplink (cloud-sync-stall.ts). A
      // request that waits on the service's own work (a publication) says so
      // in timeoutMs.
      const http = portableHost().http
      const timeouts = http.cloudTimeouts?.({ timeoutMs: request.timeoutMs, bodyBytes: bodyBytes(request.body) }) ??
        sendWindow(request.timeoutMs ?? cloudSendTimeoutMs(bodyBytes(request.body)))
      const response = await http.request({
        method: request.method,
        url: `${normalizedBaseUrl}${request.path}`,
        headers: {
          // The client's own headers (the encryption marker) never replace
          // the credential or content headers set here.
          ...request.headers,
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(multipart
            ? { 'Content-Type': 'multipart/form-data' }
            : request.body === undefined
              ? {}
              : { 'Content-Type': 'application/json' })
        },
        data: request.body instanceof FormData
          ? await serializeFormData(request.body)
          : request.body,
        ...(multipart ? { dataType: 'formData' as const } : {}),
        ...timeouts
      }).catch((error: unknown) => { throw unanswered(error) })

      if (response.status < 200 || response.status >= 300) {
        const error = response.data?.error
        const validationMessage = firstValidationMessage(response.data?.errors)
        throw new CloudServiceRequestError(
          validationMessage ?? (typeof error?.message === 'string'
            ? error.message
            : typeof response.data?.message === 'string'
              ? response.data.message
              : `ZenNotes Cloud request failed (${response.status}).`),
          response.status,
          typeof error?.code === 'string' ? error.code : null,
          errorDetails(error?.details, response.data?.errors),
          response.headers ?? {}
        )
      }

      // Capacitor only JSON-parses application/json responses; a 2xx whose
      // body is HTML or truncated arrives as a string and would flow into
      // upstream typed as the API shape, failing far from the cause.
      if (typeof response.data === 'string') {
        if (response.data === '') return undefined as Response
        try {
          return JSON.parse(response.data) as Response
        } catch {
          throw new CloudServiceRequestError(
            'ZenNotes Cloud returned an unexpected response.',
            response.status,
            null
          )
        }
      }
      return response.data as Response
    }
  }

  const loopback = /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(normalizedBaseUrl)
  return new MobileCloudSyncApiClient(cloudSyncRateLimits.wrap(transport, {
    baseUrl: normalizedBaseUrl, accountId: options.accountId, signal: lifetime,
    transportRetryDelaysMs: CLOUD_TRANSPORT_RETRY_DELAYS_MS
  }), async (request) => {
    if (lifetime.aborted) throw new DOMException('Cloud request cancelled.', 'AbortError')
    // The same bytes to the same object: a PUT that got no answer is safe to send again.
    await retryCloudTransfer(() => uploadObject(request), { signal: lifetime, isTransportFailure: unansweredUpload })
    if (lifetime.aborted) throw new DOMException('Cloud request cancelled.', 'AbortError')
  }, {
    // Streaming host: large revisions arrive as references and are downloaded
    // natively into staging, never as base64 through the WebView bridge.
    contentReferences: true,
    accountScope: { baseUrl: normalizedBaseUrl, accountId: options.accountId },
    signal: lifetime,
    bootstrapContentPageBytes: 1024 * 1024,
    allowInsecureLoopbackDownloads: loopback,
    ...(options.keyring ? { endToEndEncryption: true, vaultCiphers: options.keyring } : {})
  }, options.keyring)
}

class MobileCloudSyncApiClient extends CloudSyncApiClient {
  constructor(
    http: CloudSyncHttpTransport,
    private readonly uploadObject: MobileObjectUpload,
    options: ConstructorParameters<typeof CloudSyncApiClient>[1],
    private readonly keyring?: CloudE2eeKeyring
  ) {
    super(http, options)
  }

  /** An encrypted vault's real name is sealed: shown while this device is
   *  unlocked, and the placeholder otherwise (desktop parity). */
  override async listVaults(): Promise<CloudSyncVaultCollection> {
    const response = await super.listVaults()
    const keyring = this.keyring
    if (!keyring) return response
    return {
      ...response,
      data: await Promise.all(response.data.map(async (vault) => {
        if (!vault.encryption) return vault
        try {
          return { ...vault, name: await keyring.vaultName(vault) }
        } catch {
          return { ...vault, name: ENCRYPTED_VAULT_PLACEHOLDER_NAME }
        }
      }))
    }
  }

  override async mutate(
    vaultId: string,
    body: CloudSyncMutationRequest
  ): Promise<CloudSyncMutationResponse> {
    return mutateWithMobileDirectUploads(
      {
        mutate: (nextVaultId, nextBody) => super.mutate(nextVaultId, nextBody),
        initiateUpload: (nextVaultId, nextBody) => super.initiateUpload(nextVaultId, nextBody),
        completeUpload: (nextVaultId, uploadId) => super.completeUpload(nextVaultId, uploadId),
        abortUpload: (nextVaultId, uploadId) => super.abortUpload(nextVaultId, uploadId),
        vaultCipher: (nextVaultId) => this.contentDecryptor(nextVaultId)
      },
      vaultId,
      body,
      this.uploadObject
    )
  }
}

export const uploadObject: MobileObjectUpload = async (request) => {
  const http = portableHost().http
  const unreachable = () => {
    throw new MobileDirectUploadError('ZenNotes could not reach Cloud object storage. Check your connection and try again.', 0, 'DIRECT_UPLOAD_FAILED')
  }
  // Large scanned files never had their bytes in JS; stream them natively.
  // A host whose native PUT also takes in-memory bodies (Android) sends
  // every one that way; the iPhone sends those through its HTTP transport.
  const response = request.uri !== undefined
    ? await fileUploader(http)({ url: request.url, headers: request.headers, uri: request.uri, sha256: request.sha256, byteLength: request.byteLength })
        .catch(unreachable)
    : http.putsInMemoryBodies && http.putFile
      ? await http.putFile({
          url: request.url, headers: request.headers, base64: request.base64, byteLength: request.byteLength,
          ...(request.sha256 ? { sha256: request.sha256 } : {})
        }).catch(unreachable)
      : await http.request(mobileObjectUploadOptions(request)).catch((error: unknown) => { throw unanswered(error) })
  if (response.status < 200 || response.status >= 300) {
    throw new MobileDirectUploadError(
      `ZenNotes Cloud object upload failed (${response.status}).`,
      response.status,
      'DIRECT_UPLOAD_FAILED'
    )
  }
}

/** The host's native file PUT. Only a host with the sync fast path hands out
 *  file-backed upload requests, and every such host has one. */
function fileUploader(http: ReturnType<typeof portableHost>['http']): NonNullable<typeof http.putFile> {
  if (!http.putFile) throw new Error('File-backed uploads require the native file uploader.')
  return http.putFile.bind(http)
}

/** The iPhone's timeouts: connect and read equal, the whole send window. */
function sendWindow(timeoutMs: number): { connectTimeout: number; readTimeout: number } {
  return { connectTimeout: timeoutMs, readTimeout: timeoutMs }
}

/**
 * The host's HTTP resolves any answer, error statuses included, so a
 * rejection means none came: the request went silent past its timeout, the
 * connection dropped, or it never opened. A stall is known by each
 * platform's own words for it: iOS reports only the error domain, so
 * URLSession's message; Android names the Java exception in `code`.
 */
function unanswered(error: unknown): CloudSyncTransportError {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown }
  const text = typeof message === 'string' && message ? message : 'ZenNotes Cloud did not answer.'
  const name = typeof code === 'string' && code ? code : null
  return new CloudSyncTransportError(text, {
    code: name,
    stalled: /timed out/i.test(text) || name === 'SocketTimeoutException',
    cause: error
  })
}

/** What the request body weighs on the wire, near enough to size its timeout. */
function bodyBytes(body: unknown): number {
  if (body === undefined) return 0
  if (!(body instanceof FormData)) return new TextEncoder().encode(JSON.stringify(body)).byteLength
  let bytes = 0
  for (const [, value] of body.entries()) bytes += typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.size
  return bytes
}

/** The object store never answered the PUT (a status means it did). */
function unansweredUpload(error: unknown): boolean {
  return isCloudSyncTransportError(error) ||
    (error instanceof MobileDirectUploadError && error.status === 0 && error.code === 'DIRECT_UPLOAD_FAILED')
}

/** The answer's error details, with a 422's field errors kept under
 *  `details.errors`: which field Cloud refused (`mutations.3.path`) is only in
 *  those keys, and sync needs it to set one refused path aside instead of
 *  stopping the whole run (#1004, core 2.80; desktop's asErrorPayload). */
export function errorDetails(details: unknown, errors: unknown): Record<string, unknown> | null {
  const kept = isRecord(details) ? details : null
  const fields = isRecord(errors) ? errors : null
  return kept || fields ? { ...kept, ...(fields ? { errors: fields } : {}) } : null
}

export function firstValidationMessage(errors: unknown): string | null {
  if (!errors || typeof errors !== 'object') return null

  for (const messages of Object.values(errors)) {
    if (Array.isArray(messages)) {
      const message = messages.find((candidate): candidate is string => typeof candidate === 'string')
      if (message) return message
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function serializeFormData(form: FormData): Promise<Array<{
  key: string
  value: string
  type: 'base64File' | 'string'
  contentType?: string
  fileName?: string
}>> {
  const entries = []
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      entries.push({ key, value, type: 'string' as const })
      continue
    }
    entries.push({
      key,
      value: await blobToBase64(value),
      type: 'base64File' as const,
      contentType: value.type || 'application/octet-stream',
      fileName: value.name
    })
  }
  return entries
}

// Everything here still crosses the WebKit bridge as one JSON message, and
// the WebView content process lives under iOS jetsam limits: refuse clearly
// above this rather than dying mid-publish with a white screen.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

async function blobToBase64(blob: Blob & { name?: string }): Promise<string> {
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new CloudServiceRequestError(
      `${blob.name ?? 'An attachment'} is ${Math.round(blob.size / (1024 * 1024))} MB. Files over ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB cannot be uploaded from the app yet.`,
      413,
      'attachment-too-large'
    )
  }
  // FileReader encodes natively: peak memory is the blob plus one base64
  // string, instead of the ~6x of arrayBuffer → Uint8Array → binary string →
  // btoa.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Attachment read failed.'))
    reader.readAsDataURL(blob)
  })
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
