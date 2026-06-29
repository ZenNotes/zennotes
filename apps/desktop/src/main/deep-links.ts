import path from 'node:path'

export const ZENNOTES_DEEP_LINK_SCHEME = 'zennotes'

export type OpenNoteDeepLinkTarget = 'tab' | 'window'

export interface OpenNoteDeepLinkRequest {
  target: OpenNoteDeepLinkTarget
  path: string
}

const OPEN_NOTE_ACTION_TARGETS: Record<string, OpenNoteDeepLinkTarget> = {
  open: 'tab',
  'open-window': 'window'
}

function deepLinkAction(parsed: URL): string {
  return parsed.hostname || parsed.pathname.replace(/^\/+/, '')
}

export function parseQuickCaptureDeepLink(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed) return false

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }

  return parsed.protocol === `${ZENNOTES_DEEP_LINK_SCHEME}:` && deepLinkAction(parsed) === 'quick-capture'
}

export function parseOpenNoteDeepLink(rawUrl: string): OpenNoteDeepLinkRequest | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== `${ZENNOTES_DEEP_LINK_SCHEME}:`) return null

  const action = deepLinkAction(parsed)
  const target = OPEN_NOTE_ACTION_TARGETS[action]
  if (!target) return null

  const notePath = normalizeDeepLinkNotePath(parsed.searchParams.get('path'))
  return notePath ? { target, path: notePath } : null
}

export function normalizeDeepLinkNotePath(rawPath: string | null | undefined): string | null {
  const trimmed = rawPath?.trim()
  if (!trimmed || trimmed.includes('\0')) return null

  const slashPath = trimmed.replace(/\\/g, '/')
  if (slashPath.startsWith('/') || /^[a-zA-Z]:\//.test(slashPath)) return null
  if (slashPath.split('/').some((part) => part === '..')) return null

  const normalized = path.posix.normalize(slashPath)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  if (path.posix.isAbsolute(normalized)) return null

  return normalized
}
