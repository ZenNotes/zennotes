/**
 * Pure vault semantics, ported 1:1 from apps/desktop/src/main/vault.ts so the
 * on-disk contract (folder mapping, meta extraction, naming, search scoring)
 * matches desktop byte-for-byte. No Capacitor / DOM dependencies.
 *
 * The `attachements` (sic) constant is the intentional, load-bearing legacy
 * spelling: do not "fix" it and do not add an `attachments` variant.
 */
import type { ImportedAssetKind, NoteFolder, VaultSettings } from '@zennotes/bridge-contract/ipc'
import { noteCommentsSidecarPath } from '@zennotes/shared-domain/note-comments'
import {
  resolveFolderPath,
  systemFolderForDirName,
  type SystemFolderPaths
} from '@zennotes/shared-domain/system-folder-paths'
import { ASSETS_DIR } from './imported-assets'

// Re-exported so every existing importer keeps reaching them here; they live in
// a leaf module because this one cannot be loaded by `node --test`.
export {
  ASSETS_DIR,
  importedAssetFilename,
  importedAssetMarkdown,
  importedAssetRelPath
} from './imported-assets'

export const FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']
export const SYSTEM_FOLDERS = new Set<string>(FOLDERS)
export const PRIMARY_ATTACHMENTS_DIR = 'attachements'
export const LEGACY_ATTACHMENTS_DIRS = [PRIMARY_ATTACHMENTS_DIR, '_assets']
export const ATTACHMENTS_DIRS = [ASSETS_DIR, ...LEGACY_ATTACHMENTS_DIRS]
export const INTERNAL_VAULT_DIR = '.zennotes'
export const DELETED_ASSETS_DIR = 'deleted-assets'
export const VAULT_SETTINGS_FILE = 'vault.json'
export { NOTE_COMMENTS_DIR, NOTE_COMMENTS_SUFFIX } from '@zennotes/shared-domain/note-comments'
// A note's creation date, which desktop keeps beside it as
// `.zennotes/note-metadata/<note path>.metadata.json`
// (apps/desktop/src/main/note-creation-metadata.ts, no shared export yet).
// The phone never reads or writes one, only moves or deletes it with its note.
export const NOTE_METADATA_DIR = 'note-metadata'
export const NOTE_METADATA_SUFFIX = '.metadata.json'
export const TEMPLATES_DIR = '.zennotes/templates'

export const RESERVED_ROOT_NAMES = new Set<string>([
  ...FOLDERS,
  ...ATTACHMENTS_DIRS,
  INTERNAL_VAULT_DIR
])
// The subset that stays reserved however the system folders are remapped
// (vault.json `systemFolderPaths`): asset dirs and our own internal dir are
// never user note folders, while `inbox`/`archive`/… are reserved only while
// a system folder actually resolves there (see systemFolderForDirName).
export const RESERVED_NON_SYSTEM_ROOT_NAMES = new Set<string>([
  ...ATTACHMENTS_DIRS,
  INTERNAL_VAULT_DIR
])

export const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp'
])
export const PDF_EXTENSIONS = new Set(['.pdf'])
export const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])
export const VIDEO_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4', '.ogv', '.webm'])

export const SEARCHABLE_TEXT_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive']

// ---------------------------------------------------------------------------
// Path helpers (vault-relative POSIX paths throughout)
// ---------------------------------------------------------------------------

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export function normalizeVaultRelativePath(rel: string): string {
  return toPosix(rel).replace(/^\/+/, '').replace(/\/+$/, '')
}

export function baseName(p: string): string {
  const posix = toPosix(p)
  const idx = posix.lastIndexOf('/')
  return idx === -1 ? posix : posix.slice(idx + 1)
}

export function dirName(p: string): string {
  const posix = toPosix(p)
  const idx = posix.lastIndexOf('/')
  return idx === -1 ? '' : posix.slice(0, idx)
}

export function extName(p: string): string {
  const base = baseName(p)
  const idx = base.lastIndexOf('.')
  return idx <= 0 ? '' : base.slice(idx)
}

export function stemName(p: string): string {
  const base = baseName(p)
  const ext = extName(base)
  return ext ? base.slice(0, -ext.length) : base
}

export function joinPath(...parts: string[]): string {
  return parts
    .map((p) => toPosix(p).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/** Normalize `.`/`..` segments; returns '..'-prefixed value when escaping. */
export function posixNormalize(input: string): string {
  const parts = toPosix(input).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return '..'
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

/** Reject paths that escape the vault (mirror of desktop resolveSafe). */
export function resolveSafeRel(rel: string): string {
  const normalized = posixNormalize(normalizeVaultRelativePath(rel))
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path escapes vault')
  }
  return normalized
}

export function isExcalidrawPath(p: string): boolean {
  return p.toLowerCase().endsWith('.excalidraw')
}

export function isMarkdownPath(p: string): boolean {
  return p.toLowerCase().endsWith('.md')
}

/** Desktop's refusal (note-sidecars.ts `leftoverCommentsMessage`), word for
 *  word, when a rename or move lands on a name an earlier note left comments
 *  under: every writer refuses the same way and names the file to move aside. */
export function leftoverCommentsMessage(notePath: string): string {
  const sidecar = noteCommentsSidecarPath(INTERNAL_VAULT_DIR, notePath)
  return `Comments from an earlier note named “${stemName(notePath)}” are still in ${sidecar}. Move or delete that file to use this name.`
}

// ---------------------------------------------------------------------------
// Folder mapping: mirrors desktop folderForRelativePath, remap-aware since
// 2.20 (vault.json `systemFolderPaths`): only the RESOLVED name of each
// system folder counts. With `inbox` remapped to `01 - Entry`, a directory
// literally named `inbox/` is an ordinary user folder.
// ---------------------------------------------------------------------------

export function folderForRelativePath(
  rel: string,
  settings?: VaultSettings | null
): NoteFolder | null {
  const normalized = normalizeVaultRelativePath(rel)
  const top = normalized.split('/')[0] ?? ''
  if (!top || top.startsWith('.')) return null
  const system = systemFolderForDirName(top, settings?.systemFolderPaths)
  if (system) return system
  // Only the dirs that are reserved no matter where the system folders live.
  // A default name whose folder has moved (`inbox/` once inbox is `01 - Entry`)
  // is an ordinary user folder and must classify as one.
  if (RESERVED_NON_SYSTEM_ROOT_NAMES.has(top)) return null
  return 'inbox'
}

/**
 * Directory names skipped while walking the vault root in `root` primary
 * mode, where the root itself is the inbox: the asset dirs, our internal dir,
 * and the RESOLVED directory of every other system folder. A default name
 * whose folder has been remapped away (`quick/` once quick lives in `Fast/`)
 * is an ordinary user folder and must not be hidden.
 */
export function hiddenPrimaryRootNames(overrides?: SystemFolderPaths | null): Set<string> {
  const names = new Set<string>([...ATTACHMENTS_DIRS, INTERNAL_VAULT_DIR])
  for (const f of ['quick', 'archive', 'trash'] as NoteFolder[]) {
    names.add(resolveFolderPath(f, overrides))
  }
  return names
}

// ---------------------------------------------------------------------------
// Code stripping + meta extraction: byte-matched to vault.ts:1460-1610
// (the same logic exists in app-core tags.ts/wikilinks.ts and the Go server;
// this is the mobile copy of the desktop-main variant)
// ---------------------------------------------------------------------------

export function stripCodeContent(body: string): string {
  if (!body.includes('`') && !body.includes('~')) return body
  const lines = body.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    // `.` never matches `\r`, so the `\r?` is what lets a CRLF-saved fence line match.
    const m = /^[ \t]*(`{3,}|~{3,})(.*)\r?$/.exec(line)
    if (m) {
      const marker = m[1] as string
      const char = marker[0] as string
      const rest = m[2] as string
      if (!inFence) {
        if (char === '~' || !rest.includes('`')) {
          inFence = true
          fenceChar = char
          fenceLen = marker.length
          lines[i] = ' '
          continue
        }
      } else if (char === fenceChar && marker.length >= fenceLen && rest.trim() === '') {
        inFence = false
        lines[i] = ' '
        continue
      }
    }
    if (inFence) lines[i] = ' '
  }
  return lines.join('\n').replace(/`[^`\n]*`/g, ' ')
}

export function localAssetTargetKind(target: string): ImportedAssetKind | null {
  const clean = target.split('#')[0]?.split('?')[0] ?? target
  const lastDot = clean.lastIndexOf('.')
  if (lastDot === -1) return null
  const ext = clean.slice(lastDot).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'file'
}

export function extractTags(body: string): string[] {
  if (!body.includes('#')) return []
  const stripped = stripCodeContent(body)
  const matches = stripped.match(/(?:^|\s)#(\p{L}[\p{L}\d_/-]*)/gu) || []
  const seen = new Set<string>()
  for (const m of matches) seen.add(m.trim().slice(1))
  return [...seen]
}

export function extractWikilinks(body: string): string[] {
  if (!body.includes('[[')) return []
  const stripped = stripCodeContent(body)
  // `\|` is the separator a table writes, to keep the pipe in its cell.
  const re = /(!?)\[\[([^\]|]+?)(?:\\?\|[^\]]+)?\]\]/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const bang = m[1] ?? ''
    const target = (m[2] ?? '').trim()
    if (!target || target === '\\') continue
    if (bang === '!' && localAssetTargetKind(target)) continue
    seen.add(target)
  }
  return [...seen]
}

export function extractAssetEmbeds(body: string): string[] {
  const stripped = stripCodeContent(body)
  const seen = new Set<string>()
  if (stripped.includes('![[')) {
    const re = /!\[\[([^\]|]+?)(?:\\?\|[^\]]+)?\]\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const t = (m[1] ?? '').trim()
      if (t && localAssetTargetKind(t)) seen.add(t)
    }
  }
  if (stripped.includes('](')) {
    const re = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const raw = (m[1] ?? '').trim()
      if (!raw || raw.startsWith('#') || /^[a-zA-Z][\w+.-]*:/.test(raw)) continue
      try {
        seen.add(decodeURIComponent(raw))
      } catch {
        seen.add(raw)
      }
    }
  }
  return [...seen]
}

export function bodyHasLocalAsset(body: string): boolean {
  if (!body.includes('](') && !body.includes('![[')) return false
  const stripped = stripCodeContent(body)
  const linkRe = /(!?)\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g
  const embedRe = /!\[\[([^\]|]+?)(?:\\?\|[^\]]+)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(stripped)) !== null) {
    let href = (m[2] ?? '').trim()
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1)
    if (!href || href.startsWith('#') || href.startsWith('//')) continue
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) continue
    if (localAssetTargetKind(href)) return true
  }
  while ((m = embedRe.exec(stripped)) !== null) {
    if (localAssetTargetKind((m[1] ?? '').trim())) return true
  }
  return false
}

export function buildExcerpt(body: string): string {
  const withoutFront = body.startsWith('---\n')
    ? body.replace(/^---\n[\s\S]*?\n---\n/, '')
    : body
  let text = stripCodeContent(withoutFront)
  if (text.includes('](')) {
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  }
  if (text.includes('![['))
    text = text.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
  if (text.includes('[['))
    text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
  if (text.includes('#')) text = text.replace(/^#{1,6}\s+/gm, '')
  if (/[*_~>]/.test(text)) text = text.replace(/[*_~>]+/g, '')
  text = text.replace(/\s+/g, ' ').trim()
  return text.slice(0, 220)
}

// ---------------------------------------------------------------------------
// Naming: mirrors sanitizeNoteTitle / classifyImportedAsset (vault.ts)
// ---------------------------------------------------------------------------

export function sanitizeNoteTitle(raw: string | undefined): string {
  return (
    (raw ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:\u0000-\u001f*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200) || 'Untitled'
  )
}

export function classifyImportedAsset(filename: string): ImportedAssetKind {
  const ext = extName(filename).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'file'
}

// ---------------------------------------------------------------------------
// Builtin text search scoring: mirrors scoreMatch / firstMatchColumn /
// collapseSearchLine (vault.ts:1616-1658)
// ---------------------------------------------------------------------------

export function collapseSearchLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

export function scoreMatch(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q || !t) return 0
  if (t === q) return 1000
  if (t.startsWith(q)) return 900 - t.length * 0.5
  const wordBoundary = new RegExp(`(?:^|[\\s·:_\\-/])${escapeRegExp(q)}`)
  if (wordBoundary.test(t)) return 700 - t.length * 0.5
  const idx = t.indexOf(q)
  if (idx !== -1) return 500 - t.length * 0.5
  // subsequence fuzzy
  let ti = 0
  let gaps = 0
  let last = -1
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return 0
    if (last !== -1 && found > last + 1) gaps += found - last - 1
    last = found
    ti = found + 1
  }
  return Math.max(1, 200 - gaps * 3 - t.length * 0.2)
}

export function firstMatchColumn(query: string, line: string): number {
  const q = query.toLowerCase()
  const l = line.toLowerCase()
  if (!q) return 0
  const direct = l.indexOf(q)
  if (direct !== -1) return direct
  const first = l.indexOf(q[0] ?? '')
  return first === -1 ? 0 : first
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
