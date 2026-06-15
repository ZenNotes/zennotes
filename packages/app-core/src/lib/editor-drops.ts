/**
 * Helpers for extracting file paths from native `DataTransfer` objects
 * dropped onto the editor. Kept out of React component files so every
 * pane can use them without duplication.
 */
import type { AssetMeta, ImportedAsset } from '@shared/ipc'

export function importedAssetForExistingVaultAsset(asset: AssetMeta): ImportedAsset {
  return {
    id: asset.id,
    name: asset.name,
    path: asset.path,
    kind: asset.kind,
    markdown: asset.id ? `![[asset:${asset.id}|${asset.name}]]` : `![[${asset.path}]]`
  }
}

export function formatImportedAssetsForInsertion(
  imported: ImportedAsset[],
  before: string,
  after: string
): string {
  let insert = imported.map((asset) => asset.markdown).join('\n\n')
  const wantsStandalonePreview = imported.some(
    (asset) =>
      asset.kind === 'image' ||
      asset.kind === 'pdf' ||
      asset.kind === 'audio' ||
      asset.kind === 'video'
  )

  if (wantsStandalonePreview) {
    if (before && before !== '\n') insert = `\n\n${insert}`
    if (after && after !== '\n') return `${insert.replace(/\n*$/, '')}\n\n`
    return `${insert.replace(/\n*$/, '')}\n`
  }

  if (before && before !== '\n') insert = `\n${insert}`
  if (after && after !== '\n') insert = `${insert}\n`
  return insert
}

function droppedFilePaths(files: FileList | File[]): string[] {
  const getPathForFile =
    typeof (window.zen as { getPathForFile?: (file: File) => string | null }).getPathForFile ===
    'function'
      ? (window.zen as { getPathForFile: (file: File) => string | null }).getPathForFile
      : null
  return Array.from(files)
    .map((file) => {
      const bridged = getPathForFile?.(file) ?? null
      if (bridged) return bridged
      const legacy = (file as File & { path?: string }).path
      return typeof legacy === 'string' && legacy.length > 0 ? legacy : null
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function parseDroppedPathCandidate(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'))
  if (!firstLine) return null
  if (firstLine.startsWith('file://')) {
    try {
      const url = new URL(firstLine)
      if (url.protocol !== 'file:') return null
      return decodeURIComponent(url.pathname)
    } catch {
      return null
    }
  }
  if (firstLine.startsWith('/')) return firstLine
  return null
}

const ATTACHMENT_MIME_RE = /^(image|audio|video)\//

/**
 * True when an OS file drag carries an importable *attachment* (image,
 * audio, video, or PDF), as opposed to a markdown file that should open
 * as a note. File contents/names aren't readable during dragover, but the
 * item MIME types are — and those are reliable for media (`image/*` etc.),
 * which is all this affordance needs. Markdown drags report `text/markdown`
 * or an empty type, so they never match and the editor skips its
 * "drop to attach" border (the file opens instead, via the window-level
 * markdown drop handler). Errs toward NOT showing the border when the drag
 * type is unknown.
 */
export function dragHasAttachmentFile(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === 'file')
  return items.some(
    (item) => ATTACHMENT_MIME_RE.test(item.type) || item.type === 'application/pdf'
  )
}

export function hasDroppedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  if (dataTransfer.files.length > 0) return true
  if (Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')) return true
  const types = new Set(Array.from(dataTransfer.types ?? []))
  return (
    types.has('Files') ||
    types.has('text/uri-list') ||
    types.has('public.file-url') ||
    types.has('text/plain')
  )
}

function droppedFilesFromTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  if (dataTransfer.files.length > 0) return Array.from(dataTransfer.files)
  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file)
}

export function droppedPathsFromTransfer(dataTransfer: DataTransfer | null): string[] {
  const direct = droppedFilePaths(droppedFilesFromTransfer(dataTransfer))
  if (direct.length > 0) return direct
  if (!dataTransfer) return []
  const fallbacks = [
    dataTransfer.getData('text/uri-list'),
    dataTransfer.getData('public.file-url'),
    dataTransfer.getData('text/plain')
  ]
  const seen = new Set<string>()
  for (const raw of fallbacks) {
    const parsed = parseDroppedPathCandidate(raw)
    if (parsed) seen.add(parsed)
  }
  return [...seen]
}
