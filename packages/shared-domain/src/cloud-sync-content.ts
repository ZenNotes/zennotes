import type {
  CloudSyncContent,
  CloudSyncContentMetadata,
  CloudSyncContentReference,
  CloudSyncDownloadInstruction
} from '@zennotes/bridge-contract/cloud-sync'

/** Host-only token. Its native handle is never serialized or accepted from HTTP. */
export interface CloudSyncStagedFile {
  readonly source: 'file'
  readonly reference: Readonly<CloudSyncContentReference>
  readonly preview?: Readonly<CloudSyncContent>
}

export interface CloudSyncDownloadSource {
  reference: CloudSyncContentReference
  /** Obtain just in time; refresh only the same immutable reference. */
  getInstruction(): Promise<CloudSyncDownloadInstruction>
  signal?: AbortSignal
  /** Optional UTF-8 preview; never bridge more than this many bytes. */
  previewLimitBytes: number
  allowInsecureLoopback?: boolean
}

export interface CloudSyncStagedConflict {
  expected_path: string | null
  expected_sha256: string | null
  cloud_path: string
  file: CloudSyncStagedFile
  /** Copy the original local file here before applying Cloud. */
  keep_both_path?: string
}

const stagedFiles = new WeakMap<
  CloudSyncStagedFile,
  { handle: unknown; discard(): Promise<void> }
>()
const metadataKeys = ['encoding', 'sha256', 'byte_length', 'media_type']

export function validateCloudSyncContentReference(
  value: unknown,
  expected?: {
    item_id: string
    revision: number
    sha256?: string
    byte_length?: number
    media_type?: string
    encoding?: CloudSyncContent['encoding']
  }
): CloudSyncContentReference {
  const ref = record(value)
  if (
    !ref ||
    !onlyKeys(ref, [...metadataKeys, 'item_id', 'revision']) ||
    typeof ref.item_id !== 'string' ||
    !ref.item_id ||
    !Number.isSafeInteger(ref.revision) ||
    (ref.revision as number) < 1
  )
    invalid()
  const metadata = validatedMetadata(ref)
  if (
    expected &&
    (ref.item_id !== expected.item_id ||
      (ref.revision as number) > expected.revision ||
      !sameMetadata(metadata, expected))
  )
    invalid()
  return { item_id: ref.item_id as string, revision: ref.revision as number, ...metadata }
}

export function validateCloudSyncDownloadInstruction(
  value: unknown,
  reference: CloudSyncContentReference,
  allowInsecureLoopback = false
): CloudSyncDownloadInstruction {
  const ref = validateCloudSyncContentReference(reference)
  const data = record(record(value)?.data)
  const content = record(data?.content)
  const download = record(data?.download)
  const headers = record(download?.headers)
  if (
    !data ||
    !onlyKeys(data, ['item_id', 'revision', 'content', 'download']) ||
    data.item_id !== ref.item_id ||
    data.revision !== ref.revision ||
    !content ||
    !onlyKeys(content, metadataKeys) ||
    !sameMetadata(validatedMetadata(content), ref) ||
    !download ||
    !onlyKeys(download, ['method', 'url', 'headers', 'expires_at']) ||
    download.method !== 'GET' ||
    typeof download.url !== 'string' ||
    typeof download.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(download.expires_at)) ||
    !headers ||
    Object.entries(headers).some(
      ([key, value]) =>
        typeof value !== 'string' || /^(authorization|proxy-authorization|cookie|host)$/i.test(key)
    )
  )
    invalid()
  validateCloudSyncDownloadUrl(download.url as string, allowInsecureLoopback)
  return {
    item_id: ref.item_id,
    revision: ref.revision,
    content: validatedMetadata(content),
    download: {
      method: 'GET',
      url: download.url as string,
      headers: { ...headers } as Record<string, string>,
      expires_at: download.expires_at as string
    }
  }
}

export function validateCloudSyncDownloadUrl(value: string, allowInsecureLoopback = false): void {
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:'))
  )
    invalid()
}

/** Call only after the native downloader has verified the on-disk length and
 * SHA-256. The coordinator validates the token/reference again before apply. */
export function registerCloudSyncStagedFile(
  reference: CloudSyncContentReference,
  handle: unknown,
  discard: () => Promise<void>,
  preview?: CloudSyncContent
): CloudSyncStagedFile {
  if (typeof discard !== 'function') throw new Error('Cloud staging requires a cleanup callback.')
  const file: CloudSyncStagedFile = Object.freeze({
    source: 'file',
    reference: Object.freeze(validateCloudSyncContentReference(reference)),
    ...(preview ? { preview: Object.freeze({ ...preview }) } : {})
  })
  stagedFiles.set(file, { handle, discard })
  return file
}

export function cloudSyncStagedHandle<Handle = unknown>(
  file: CloudSyncStagedFile,
  expected?: CloudSyncContentReference
): Handle {
  const stored = stagedFiles.get(file)
  if (!stored) throw new Error('Untrusted or released Cloud staging handle.')
  if (expected) validateCloudSyncContentReference(expected)
  if (
    expected &&
    (file.reference.revision !== expected.revision ||
      file.reference.item_id !== expected.item_id ||
      !sameMetadata(file.reference, expected))
  )
    invalid()
  return stored.handle as Handle
}

export async function releaseCloudSyncStagedFile(file: CloudSyncStagedFile): Promise<void> {
  const stored = stagedFiles.get(file)
  if (!stored) return
  stagedFiles.delete(file)
  await stored.discard()
}

export function throwIfCloudSyncCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Cloud download cancelled.', 'AbortError')
}

function validatedMetadata(value: Record<string, unknown>): CloudSyncContentMetadata {
  if (
    !['utf8', 'base64'].includes(value.encoding as string) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.byte_length) ||
    (value.byte_length as number) < 0 ||
    typeof value.media_type !== 'string' ||
    !value.media_type
  )
    invalid()
  return {
    encoding: value.encoding as 'utf8' | 'base64',
    sha256: value.sha256 as string,
    byte_length: value.byte_length as number,
    media_type: value.media_type as string
  }
}

function sameMetadata(
  actual: CloudSyncContentMetadata,
  expected: Partial<CloudSyncContentMetadata>
): boolean {
  return metadataKeys.every(
    (key) =>
      expected[key as keyof CloudSyncContentMetadata] === undefined ||
      actual[key as keyof CloudSyncContentMetadata] ===
        expected[key as keyof CloudSyncContentMetadata]
  )
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function invalid(): never {
  throw new Error('Invalid Cloud content reference or download instruction.')
}
