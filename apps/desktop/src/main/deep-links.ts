import path from 'node:path'

export const ZENNOTES_DEEP_LINK_SCHEME = 'zennotes'

export type OpenNoteDeepLinkTarget = 'tab' | 'window'

export interface OpenNoteDeepLinkRequest {
  target: OpenNoteDeepLinkTarget
  path: string
}

export interface CloudAuthDeepLinkRequest {
  code: string
  state: string
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

export function parseCloudAuthDeepLink(rawUrl: string): CloudAuthDeepLinkRequest | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== `${ZENNOTES_DEEP_LINK_SCHEME}:` || deepLinkAction(parsed) !== 'auth') {
    return null
  }

  const code = parsed.searchParams.get('code') ?? ''
  const state = parsed.searchParams.get('state') ?? ''
  if (!/^[A-Za-z0-9]+$/.test(code) || code.length > 256) return null
  if (!/^[A-Za-z0-9._-]+$/.test(state) || state.length > 128) return null

  return { code, state }
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

/** The inverse of parseOpenNoteDeepLink: the shareable URL that opens a
 *  vault-relative note in the app. Segments are percent-encoded so titles
 *  with spaces, `#`, `?` or `&` survive; slashes stay readable. Parens are
 *  encoded beyond what encodeURIComponent does because these URLs live
 *  inside markdown `[title](url)` links, where a bare `)` ends the link. */
export function buildOpenNoteDeepLink(relPath: string): string {
  const encoded = relPath
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/')
  return `${ZENNOTES_DEEP_LINK_SCHEME}://open?path=${encoded}`
}

/** Whether the app registers itself for zennotes:// links each time it starts.
 *  Windows has to: electron-builder's `protocols` option is macOS only, so
 *  neither the NSIS installer nor the zip writes the scheme to the registry,
 *  and until 2.68 no Windows install could open a zennotes:// link at all.
 *  Registering per user at launch also covers the zip, wherever it was
 *  unpacked. Linux stays with the package's .desktop file, which already
 *  declares the scheme; setting the default there would override the user's
 *  own xdg-mime choice.
 *
 *  On macOS only a packaged app registers. macOS registers whatever bundle is
 *  running and ignores the app path Electron passes, so an unpackaged run (a
 *  dev build, the CDP harnesses) made the bare Electron.app the handler: every
 *  zennotes:// link, from the web clipper or a note link, then opened an empty
 *  Electron window instead of ZenNotes until ZenNotes was launched again. On
 *  Windows the path and arguments are honored, so a dev build there still
 *  registers itself correctly. */
export function registersDeepLinkSchemeAtLaunch(platform: NodeJS.Platform, packaged: boolean): boolean {
  if (platform === 'darwin') return packaged
  return platform === 'win32'
}

/** Whether a Cloud sign-in returns to the app through a one-time page on
 *  http://127.0.0.1 (RFC 8252's loopback redirect) instead of a zennotes://
 *  link. The loopback needs no link handler and no browser prompt, so it is
 *  the default; only packaged macOS keeps the link, which its signed bundle
 *  always registers. Windows and Linux sign-ins used to hang on a link nothing
 *  handled (an AppImage without desktop integration, every Windows install). */
export function cloudSignInUsesLoopback(packaged: boolean, platform: NodeJS.Platform): boolean {
  return !packaged || platform !== 'darwin'
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
