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
import { builtinGradientForAsset } from '@shared/note-cover-gradients'
import { resolveAssetVaultRelativePath } from './local-assets'
import { useToastStore } from './toast'

export type CloudPublishingBridge = Pick<
  ZenBridge,
  | 'getCloudServiceAccount'
  | 'listCloudPublishedNotes'
  | 'publishCloudNote'
  | 'updateCloudPublishedNote'
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
    throw new Error("Publishing isn't part of your current plan. Choose a plan under Billing on zennotes.org to publish notes.")
  }
  const refs = publishableAssetRefs(note)
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
  const assets = collectCloudPublishAssets(note, vaultRoot)
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

/**
 * The attachments a publish uploads: every embed but a built-in gradient
 * cover. The service refuses SVG files, and that one does not need to travel:
 * the share viewer draws the gradient its file name names from the same spec
 * (note-cover-gradients.ts). Any other SVG is still refused, with the message
 * that says why.
 */
function publishableAssetRefs(note: PublishableCloudNote): string[] {
  return [...new Set(note.assetEmbeds)].filter((ref) => !builtinGradientForAsset(ref))
}

/** Matches the service's limit for apps that upload attachments ahead of the
 * publish; it checks the count, sizes and types again before anything is sent. */
const MAX_PUBLISH_ATTACHMENTS = 50

/**
 * The attachments a note embeds, by vault-relative path. The platform reads
 * each file itself when it publishes, so nothing is loaded here.
 */
export function collectCloudPublishAssets(
  note: PublishableCloudNote,
  vaultRoot: string
): CloudPublishAssetInput[] {
  const refs = publishableAssetRefs(note)
  if (refs.length === 0) return []
  if (!vaultRoot) throw new Error('Open a local vault before publishing attachments.')
  if (refs.length > MAX_PUBLISH_ATTACHMENTS) {
    throw new Error(
      `This note has ${refs.length} attached files, but a published note can have at most ${MAX_PUBLISH_ATTACHMENTS}. Remove some attachments and publish again.`
    )
  }

  return refs.map((ref) => {
    const path = resolveAssetVaultRelativePath(vaultRoot, note.path, ref)
    if (!path) throw new Error(`ZenNotes could not read the attachment “${ref}”.`)
    const name = assetName(ref)
    const mime = publishableMime(null, name)
    if (!mime) {
      throw new Error(`The attachment “${ref}” is not a supported image, audio, video, or PDF.`)
    }
    return { ref, name, mime, path }
  })
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
