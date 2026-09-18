import type { ZenBridge } from '@zennotes/bridge-contract/bridge'
import { getZenBridge } from '@zennotes/bridge-contract/bridge'
import type {
  CloudPublishAppearanceInput,
  CloudPublishAssetInput,
  CloudPublishedNote,
  CloudPublishedNoteResult,
  CloudPublishNoteInput
} from '@zennotes/bridge-contract/cloud-sync'
import { useStore } from '../store'
import { resolveAssetVaultRelativePath } from './local-assets'
import { useToastStore } from './toast'

export type CloudPublishingBridge = Pick<
  ZenBridge,
  | 'getCloudServiceAccount'
  | 'listCloudPublishedNotes'
  | 'publishCloudNote'
  | 'updateCloudPublishedNote'
  | 'readVaultAssetBase64'
>

export interface PublishableCloudNote {
  path: string
  title: string
  body: string
  assetEmbeds: string[]
}

export interface CloudPublishOutcome extends CloudPublishedNoteResult {
  updated: boolean
}

export class CloudPublishUnconfirmedError extends Error {
  constructor(readonly publicNote: CloudPublishedNote | null, cause: unknown) {
    super(
      publicNote
        ? 'The publishing result could not be confirmed. Check the public note before retrying; its latest changes may already be available.'
        : 'The publishing result could not be confirmed. Check Published notes in Settings → Cloud before retrying; the note may already be public.',
      { cause }
    )
    this.name = 'CloudPublishUnconfirmedError'
  }
}

export async function publishCloudNote(
  note: PublishableCloudNote,
  bridge: CloudPublishingBridge,
  assets: CloudPublishAssetInput[] = [],
  appearance?: CloudPublishAppearanceInput
): Promise<CloudPublishOutcome> {
  const account = await bridge.getCloudServiceAccount()
  if (!account.features.publish.active) {
    throw new Error('Publishing requires a ZenNotes Cloud plan.')
  }
  const refs = [...new Set(note.assetEmbeds)]
  if (refs.length !== assets.length) {
    throw new Error('ZenNotes could not prepare every attachment for publishing.')
  }

  const existing = (await bridge.listCloudPublishedNotes())
    .find((published) => published.note_path === note.path)
  const input: CloudPublishNoteInput = {
    note_path: note.path,
    title: note.title,
    markdown: note.body,
    ...(assets.length > 0 ? { assets } : {}),
    ...(appearance === undefined ? {} : { appearance })
  }
  try {
    const result = existing
      ? await bridge.updateCloudPublishedNote(existing.id, input)
      : await bridge.publishCloudNote(input)
    return { ...result, updated: existing !== undefined }
  } catch (error) {
    if (!isUncertainPublishError(error)) throw error

    // Finding a share proves that it is public, not that this request committed.
    // Keep the result uncertain and expose the link for verification without
    // issuing a duplicate POST or claiming that the latest content is live.
    const published = await bridge.listCloudPublishedNotes().catch(() => [])
    const publicNote = published.find((candidate) => candidate.note_path === note.path) ?? existing ?? null
    throw new CloudPublishUnconfirmedError(publicNote, error)
  }
}

function isUncertainPublishError(error: unknown): boolean {
  return error instanceof Error && (
    ['TimeoutError', 'AbortError'].includes(error.name) ||
    /timeout|timed out|fetch failed|failed to fetch|network|socket|ECONNRESET/i.test(error.message)
  )
}

export async function publishActiveCloudNote(
  bridge: ZenBridge = getZenBridge()
): Promise<CloudPublishOutcome> {
  const note = useStore.getState().activeNote
  if (!note) {
    throw new Error('Open a note to publish it.')
  }

  return await publishCloudNoteWithFeedback(note, bridge)
}

export async function publishCloudNoteWithFeedback(
  note: PublishableCloudNote,
  bridge: ZenBridge = getZenBridge(),
  appearance?: CloudPublishAppearanceInput
): Promise<CloudPublishOutcome> {
  const vaultRoot = useStore.getState().vault?.root ?? ''
  const assets = await collectCloudPublishAssets(note, vaultRoot, bridge)
  const outcome = await publishCloudNote(note, bridge, assets, appearance)
  bridge.clipboardWriteText(outcome.url)
  useToastStore.getState().addToast(
    outcome.updated ? 'Public note updated. Link copied.' : 'Note published. Link copied.',
    'success',
    { label: 'Open', onClick: () => window.open(outcome.url, '_blank') },
    7000
  )
  return outcome
}

const PUBLISH_LOGO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif'])
const MAX_PUBLISH_LOGO_BYTES = 1024 * 1024

export async function prepareCloudPublishLogo(file: File): Promise<CloudPublishAssetInput> {
  if (!PUBLISH_LOGO_MIMES.has(file.type)) {
    throw new Error('Choose a PNG, JPEG, WebP, or AVIF logo.')
  }
  if (file.size > MAX_PUBLISH_LOGO_BYTES) {
    throw new Error('The logo may not be larger than 1 MB.')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }

  return {
    ref: 'brand-logo',
    name: file.name || 'brand-logo',
    mime: file.type,
    base64: btoa(binary)
  }
}

const MAX_PUBLISH_ASSET_BYTES = 10 * 1024 * 1024
const MAX_PUBLISH_ASSET_TOTAL_BYTES = 25 * 1024 * 1024

export async function collectCloudPublishAssets(
  note: PublishableCloudNote,
  vaultRoot: string,
  bridge: Pick<ZenBridge, 'readVaultAssetBase64'>
): Promise<CloudPublishAssetInput[]> {
  const refs = [...new Set(note.assetEmbeds)]
  if (refs.length === 0) return []
  if (!vaultRoot) throw new Error('Open a local vault before publishing attachments.')
  if (refs.length > 50) throw new Error('A public note can include up to 50 attachments.')

  let totalBytes = 0
  const assets: CloudPublishAssetInput[] = []
  for (const ref of refs) {
    const assetPath = resolveAssetVaultRelativePath(vaultRoot, note.path, ref)
    if (!assetPath) throw new Error(`ZenNotes could not read the attachment “${ref}”.`)
    const base64 = await bridge.readVaultAssetBase64(assetPath)
    const byteLength = base64ByteLength(base64)
    if (byteLength > MAX_PUBLISH_ASSET_BYTES) {
      throw new Error(`The attachment “${ref}” is larger than 10 MB.`)
    }
    totalBytes += byteLength
    if (totalBytes > MAX_PUBLISH_ASSET_TOTAL_BYTES) {
      throw new Error('Published-note attachments may not exceed 25 MB in total.')
    }

    const name = assetName(ref)
    const mime = publishableMime(null, name)
    if (!mime) {
      throw new Error(`The attachment “${ref}” is not a supported image, audio, video, or PDF.`)
    }
    assets.push({ ref, name, mime, base64 })
  }
  return assets
}

function base64ByteLength(value: string): number {
  const normalized = value.replace(/\s/g, '')
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(normalized)) {
    throw new Error('ZenNotes received invalid attachment data.')
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return (normalized.length / 4) * 3 - padding
}

function assetName(ref: string): string {
  const withoutSuffix = ref.split(/[?#]/, 1)[0] ?? ref
  const encodedName = withoutSuffix.split('/').filter(Boolean).pop() ?? 'attachment'
  try {
    return decodeURIComponent(encodedName)
  } catch {
    return encodedName
  }
}

const PUBLISHABLE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'application/pdf'
])

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf'
}

function publishableMime(contentType: string | null, name: string): string | null {
  const reported = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (PUBLISHABLE_MIMES.has(reported)) return reported
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXTENSION[extension] ?? null
}

export function showCloudPublishingError(error: unknown): void {
  useToastStore.getState().addToast(
    error instanceof Error ? error.message : 'Could not publish this note.',
    'error'
  )
}
