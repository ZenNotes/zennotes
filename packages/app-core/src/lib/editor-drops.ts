/**
 * Helpers for extracting file paths from native `DataTransfer` objects
 * dropped onto the editor. Kept out of React component files so every
 * pane can use them without duplication.
 */

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
