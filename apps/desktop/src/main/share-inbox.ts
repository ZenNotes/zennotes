/**
 * Shares from the macOS Share menu: Share > ZenNotes in Safari and any other
 * app. The share extension (apps/share-extension) is sandboxed and can reach
 * no vault, so it leaves each share as one JSON file in the share inbox, the
 * one folder its sandbox opens to it (inside the app's Application Support),
 * and the app files them as notes (in Quick Notes unless the vault's
 * sharesLocation names another place): at startup, and as they arrive while
 * it runs. The app leaves `vaults.json` there in turn, so the share sheet can
 * offer the vaults it knows.
 *
 * A share file is untrusted input: anything that can write the inbox can
 * write one. Its vault is a key looked up in the app's own remembered
 * vaults, never a path, and sizes are capped. A share is deleted only after
 * its note is written; one that cannot be filed yet stays for the next drain.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { deriveTitleFromBody, timestampTitle } from '@shared/quick-note-title'

export const SHARE_CAPTURE_VERSION = 1
export const SHARE_CAPTURES_FOLDER = 'Captures'
export const SHARE_VAULTS_FILE = 'vaults.json'
/** Files a drain could not read, kept out of the queue but not deleted. */
export const SHARE_UNREADABLE_FOLDER = 'Unreadable'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TEXT = 1_000_000
const MAX_NOTE = 10_000
const MAX_TITLE = 500
const MAX_URL = 8192

export interface ShareCapture {
  id: string
  createdAt: number
  /** A key from vaults.json, or null for the app's current vault. */
  vault: string | null
  url?: string
  /** The page or document title the sharing app supplied. */
  title?: string
  text?: string
  note?: string
  /** Bundle identifier of the app the share came from. */
  sourceApp?: string
}

export type ParsedShareCapture =
  | { kind: 'capture'; capture: ShareCapture }
  /** Nothing to file: no text, no link and no note. */
  | { kind: 'empty' }
  /** Written by a newer share extension; left for a newer app. */
  | { kind: 'newer' }
  | { kind: 'unreadable' }

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\0/g, '').trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function webUrl(value: unknown): string | undefined {
  const raw = cleanString(value, MAX_URL)
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

export function parseShareCapture(raw: string): ParsedShareCapture {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { kind: 'unreadable' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'unreadable' }
  const record = data as Record<string, unknown>
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 1) {
    return { kind: 'unreadable' }
  }
  if (record.version > SHARE_CAPTURE_VERSION) return { kind: 'newer' }
  const id = cleanString(record.id, 100)
  if (!id) return { kind: 'unreadable' }
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0
  const url = webUrl(record.url)
  const text = cleanString(record.text, MAX_TEXT)
  const note = cleanString(record.note, MAX_NOTE)
  if (!url && !text && !note) return { kind: 'empty' }
  const title = cleanString(record.title, MAX_TITLE)?.replace(/\s+/g, ' ')
  return {
    kind: 'capture',
    capture: {
      id,
      createdAt,
      vault: cleanString(record.vault, 4096) ?? null,
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
      ...(text ? { text } : {}),
      ...(note ? { note } : {}),
      ...(cleanString(record.sourceApp, 255) ? { sourceApp: cleanString(record.sourceApp, 255) } : {})
    }
  }
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * The note's title, first that exists: the title the sharing app supplied,
 * the page title the app fetched, the first line of the shared text (Quick
 * Capture's rule), the link's host (the iPhone share's rule), the first line
 * of the note, and last a timestamp, so a share never lands as "Untitled".
 */
export function shareCaptureTitle(capture: ShareCapture, fetchedTitle?: string, now = new Date()): string {
  return (
    capture.title ||
    cleanString(fetchedTitle, MAX_TITLE)?.replace(/\s+/g, ' ') ||
    deriveTitleFromBody(capture.text ?? '') ||
    hostOf(capture.url) ||
    deriveTitleFromBody(capture.note ?? '') ||
    timestampTitle(now)
  )
}

function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (ch) => `\\${ch}`)
}

/** A bare `)` would end a markdown link destination early. */
function linkDestination(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>'))
    .join('\n')
}

/**
 * The note: the title as its heading, the shared text (quoted when it came
 * with a page, as written when it is the whole share), the note line, and
 * the link last. A share of text alone follows Quick Capture instead: its
 * first line is already the title, so it gets no heading of its own.
 */
export function shareCaptureBody(capture: ShareCapture, title: string, pageTitle?: string): string {
  const parts: string[] = []
  const titledByText = !capture.title && !pageTitle && !!capture.text && title === deriveTitleFromBody(capture.text)
  if (!titledByText) parts.push(`# ${title}`)
  if (capture.text) parts.push(capture.url ? quote(capture.text) : capture.text.trimEnd())
  if (capture.note) parts.push(capture.note)
  if (capture.url) {
    const label = capture.title || pageTitle
    parts.push(label ? `[${escapeLinkText(label)}](${linkDestination(capture.url)})` : `<${capture.url}>`)
  }
  return `${parts.join('\n\n')}\n`
}

// Vaults the share sheet offers. `local:<root>` and `remote:<profile id>`;
// the app resolves either against its own config before filing anything.

export interface ShareConfig {
  workspaceMode: 'local' | 'remote'
  vaultRoot: string | null
  localVaults: Array<{ root: string; name: string; lastOpenedAt: number }>
  remoteWorkspaceProfileId: string | null
  remoteWorkspaceProfiles: Array<{
    id: string
    name: string
    baseUrl: string
    lastConnectedAt: number | null
  }>
}

export type ShareTarget =
  | { kind: 'local'; key: string; root: string }
  | { kind: 'remote'; key: string; profileId: string }

export interface ShareVaultChoice {
  id: string
  name: string
  kind: 'local' | 'remote'
  /** The server's host for a remote vault. */
  detail?: string
  /** Where a share to this vault is filed, as the sheet's heading names it
   *  ("Save to Clippings"); see shareLocationLabel. */
  destination?: string
}

export interface ShareVaultsFile {
  version: 1
  vaults: ShareVaultChoice[]
  /** The vault a share goes to when the sheet names none. */
  current: string | null
}

export function localShareKey(root: string): string {
  return `local:${path.resolve(root)}`
}

export function remoteShareKey(profileId: string): string {
  return `remote:${profileId}`
}

function localEntries(cfg: ShareConfig): ShareConfig['localVaults'] {
  const entries = [...cfg.localVaults]
  if (cfg.vaultRoot && !entries.some((entry) => path.resolve(entry.root) === path.resolve(cfg.vaultRoot!))) {
    entries.unshift({ root: cfg.vaultRoot, name: path.basename(cfg.vaultRoot), lastOpenedAt: 0 })
  }
  return entries
}

function currentShareTarget(cfg: ShareConfig): ShareTarget | null {
  if (cfg.workspaceMode === 'remote' && cfg.remoteWorkspaceProfileId) {
    const profile = cfg.remoteWorkspaceProfiles.find((entry) => entry.id === cfg.remoteWorkspaceProfileId)
    if (profile) return { kind: 'remote', key: remoteShareKey(profile.id), profileId: profile.id }
  }
  const root = cfg.vaultRoot ?? localEntries(cfg)[0]?.root
  return root ? { kind: 'local', key: localShareKey(root), root: path.resolve(root) } : null
}

export function shareVaultsFile(cfg: ShareConfig): ShareVaultsFile {
  const vaults: ShareVaultChoice[] = []
  const seen = new Set<string>()
  for (const entry of localEntries(cfg)) {
    const id = localShareKey(entry.root)
    if (seen.has(id)) continue
    seen.add(id)
    vaults.push({ id, name: entry.name || path.basename(entry.root), kind: 'local' })
  }
  for (const profile of cfg.remoteWorkspaceProfiles) {
    const id = remoteShareKey(profile.id)
    if (seen.has(id)) continue
    seen.add(id)
    vaults.push({ id, name: profile.name, kind: 'remote', detail: hostOf(profile.baseUrl) || undefined })
  }
  return { version: 1, vaults, current: currentShareTarget(cfg)?.key ?? null }
}

/** The vault list with each vault's share destination filled in. A vault
 *  whose label cannot be read (its folder is gone) is listed without one. */
export async function withShareDestinations(
  file: ShareVaultsFile,
  destinationFor: (choice: ShareVaultChoice) => Promise<string | undefined>
): Promise<ShareVaultsFile> {
  const vaults = await Promise.all(
    file.vaults.map(async (choice) => {
      const destination = await destinationFor(choice).catch(() => undefined)
      return destination ? { ...choice, destination } : choice
    })
  )
  return { ...file, vaults }
}

/** The vault a share names, when the app still remembers it; otherwise the
 *  app's current vault. */
export function resolveShareTarget(key: string | null, cfg: ShareConfig): ShareTarget | null {
  if (key?.startsWith('local:')) {
    const entry = localEntries(cfg).find((candidate) => localShareKey(candidate.root) === key)
    if (entry) return { kind: 'local', key, root: path.resolve(entry.root) }
  } else if (key?.startsWith('remote:')) {
    const profileId = key.slice('remote:'.length)
    if (cfg.remoteWorkspaceProfiles.some((profile) => profile.id === profileId)) {
      return { kind: 'remote', key, profileId }
    }
  }
  return currentShareTarget(cfg)
}

// Draining.

export interface ShareInboxDeps {
  /** `<share inbox>/Captures`. */
  capturesDir: string
  loadConfig: () => Promise<ShareConfig>
  /** The page title for a link shared without one; undefined when offline. */
  fetchTitle: (url: string) => Promise<string | undefined>
  /** Creates the note where the local vault files shares; resolves its path. */
  fileLocal: (root: string, title: string, body: string) => Promise<string>
  /** Creates the note on a server, or null while that server is not the
   *  connected workspace: the share then waits. */
  fileRemote: (profileId: string, title: string, body: string) => Promise<string | null>
  isDirectory: (dir: string) => Promise<boolean>
  now?: () => Date
}

export interface ShareDrainResult {
  filed: Array<{ id: string; title: string; path: string; target: string }>
  waiting: number
  setAside: number
}

/** Share files in the order they were made: names start with the time. */
export async function pendingShareFiles(capturesDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(capturesDir)
  } catch {
    return []
  }
  return names.filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort()
}

async function setAside(capturesDir: string, name: string): Promise<void> {
  const dir = path.join(capturesDir, SHARE_UNREADABLE_FOLDER)
  await fs.mkdir(dir, { recursive: true })
  await fs.rename(path.join(capturesDir, name), path.join(dir, name))
}

async function fallbackFor(
  missing: Extract<ShareTarget, { kind: 'local' }>,
  current: ShareTarget | null,
  deps: ShareInboxDeps
): Promise<ShareTarget | null> {
  if (!current) return null
  if (current.kind === 'remote') return current
  if (current.root === missing.root) return null
  return (await deps.isDirectory(current.root)) ? current : null
}

export async function drainShareInbox(deps: ShareInboxDeps): Promise<ShareDrainResult> {
  const result: ShareDrainResult = { filed: [], waiting: 0, setAside: 0 }
  const names = await pendingShareFiles(deps.capturesDir)
  if (names.length === 0) return result
  const cfg = await deps.loadConfig()
  const current = currentShareTarget(cfg)

  for (const name of names) {
    const file = path.join(deps.capturesDir, name)
    let raw: string
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) continue
      if (stat.size > MAX_FILE_BYTES) {
        await setAside(deps.capturesDir, name)
        result.setAside++
        continue
      }
      raw = await fs.readFile(file, 'utf8')
    } catch {
      continue // gone already, or unreadable for now: the next drain retries
    }
    const parsed = parseShareCapture(raw)
    if (parsed.kind === 'newer') {
      result.waiting++
      continue
    }
    if (parsed.kind === 'empty') {
      await fs.rm(file, { force: true })
      continue
    }
    if (parsed.kind === 'unreadable') {
      await setAside(deps.capturesDir, name).catch(() => {})
      result.setAside++
      continue
    }
    const capture = parsed.capture
    let target = resolveShareTarget(capture.vault, cfg)
    // A remembered vault whose folder is gone (moved, unmounted) must not be
    // recreated by filing into it; the share goes to the current vault.
    if (target?.kind === 'local' && !(await deps.isDirectory(target.root))) {
      target = await fallbackFor(target, current, deps)
    }
    if (!target) {
      result.waiting++
      continue
    }

    const pageTitle = capture.url && !capture.title ? await deps.fetchTitle(capture.url).catch(() => undefined) : undefined
    const title = shareCaptureTitle(capture, pageTitle, deps.now?.() ?? new Date())
    const body = shareCaptureBody(capture, title, pageTitle)
    let notePath: string | null
    try {
      notePath =
        target.kind === 'local'
          ? await deps.fileLocal(target.root, title, body)
          : await deps.fileRemote(target.profileId, title, body)
    } catch (err) {
      console.warn(`Could not file the share ${capture.id}`, err)
      result.waiting++
      continue
    }
    if (notePath === null) {
      result.waiting++
      continue
    }
    await fs.rm(file, { force: true })
    result.filed.push({ id: capture.id, title, path: notePath, target: target.key })
  }
  return result
}

/** Writes vaults.json for the share sheet, atomically: the sheet may read it
 *  at any moment. */
export async function writeShareVaults(groupDir: string, file: ShareVaultsFile): Promise<void> {
  await fs.mkdir(groupDir, { recursive: true })
  const target = path.join(groupDir, SHARE_VAULTS_FILE)
  const tmp = `${target}.${process.pid}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, target)
}

/** The share inbox the bundled share extension names in its Info.plist,
 *  relative to the home folder; null when the plist names none, or names a
 *  path that could leave the home folder. */
export function shareInboxFromInfoPlist(plist: string): string | null {
  const match = plist.match(/<key>ZenNotesShareInbox<\/key>\s*<string>([^<]+)<\/string>/)
  const relative = match?.[1].trim()
  if (!relative || relative.startsWith('/') || relative.split('/').some((part) => part === '..' || part === '')) {
    return null
  }
  return relative
}
