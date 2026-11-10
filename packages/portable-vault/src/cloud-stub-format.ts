/**
 * The stub file format of attachments on open (cloud-sync-stubs.ts has the
 * rules): a magic line and the Cloud reference as JSON. Kept apart, with no
 * imports, so a host's file worker can tell a stub from a file without
 * loading the sync engine.
 */
import type { CloudSyncEncryptedContent } from '@zennotes/bridge-contract/cloud-sync'

/** The first bytes of every stub file. */
export const CLOUD_STUB_MAGIC = 'ZNSTUB1\n'
/** A file larger than this is never read as a stub. */
export const CLOUD_STUB_MAX_BYTES = 4096
/** Binary attachments above this arrive as stubs. Cloud sends anything up to
 *  1 MiB inline when it fits a page, so an attachment it inlines is written in
 *  full and the bytes in hand are never thrown away; above it, a reference
 *  becomes a stub whether or not it would have fit inline. */
export const CLOUD_STUB_THRESHOLD_BYTES = 1024 * 1024

export interface CloudStubRecord {
  format: 1
  item_id: string
  revision: number
  sha256: string
  byte_length: number
  media_type: string
  /** An end-to-end encrypted vault's revision: what the download returns,
   *  opened in the tab when it hydrates (Phase 5). */
  encrypted?: CloudSyncEncryptedContent
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeCloudStub(record: CloudStubRecord): Uint8Array {
  const body: CloudStubRecord = {
    format: 1,
    item_id: record.item_id,
    revision: record.revision,
    sha256: record.sha256,
    byte_length: record.byte_length,
    media_type: record.media_type,
    ...(record.encrypted ? { encrypted: { sha256: record.encrypted.sha256, byte_length: record.encrypted.byte_length } } : {})
  }
  const bytes = encoder.encode(`${CLOUD_STUB_MAGIC}${JSON.stringify(body)}\n`)
  if (bytes.byteLength > CLOUD_STUB_MAX_BYTES) throw new Error('A Cloud stub record is too large.')
  return bytes
}

/** The record a file's bytes carry, or null when they are not a stub. */
export function decodeCloudStub(bytes: Uint8Array): CloudStubRecord | null {
  if (bytes.byteLength > CLOUD_STUB_MAX_BYTES || bytes.byteLength <= CLOUD_STUB_MAGIC.length) return null
  for (let index = 0; index < CLOUD_STUB_MAGIC.length; index += 1) {
    if (bytes[index] !== CLOUD_STUB_MAGIC.charCodeAt(index)) return null
  }
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes.subarray(CLOUD_STUB_MAGIC.length)))
  } catch {
    return null
  }
  return isCloudStubRecord(value) ? value : null
}

export function isCloudStubRecord(value: unknown): value is CloudStubRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<CloudStubRecord>
  return record.format === 1 &&
    typeof record.item_id === 'string' && record.item_id.length > 0 && record.item_id.length <= 128 &&
    Number.isSafeInteger(record.revision) && (record.revision as number) >= 1 &&
    typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256) &&
    Number.isSafeInteger(record.byte_length) && (record.byte_length as number) >= 0 &&
    typeof record.media_type === 'string' && record.media_type.length > 0 && record.media_type.length <= 255 &&
    (record.encrypted === undefined || isEncryptedContent(record.encrypted))
}

function isEncryptedContent(value: unknown): value is CloudSyncEncryptedContent {
  const content = value as Partial<CloudSyncEncryptedContent> | null
  return !!content && typeof content === 'object' &&
    typeof content.sha256 === 'string' && /^[a-f0-9]{64}$/.test(content.sha256) &&
    Number.isSafeInteger(content.byte_length) && (content.byte_length as number) >= 0
}
