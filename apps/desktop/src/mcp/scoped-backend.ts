/**
 * A VaultBackend that shows an MCP client only what its scope allows
 * (ZenNotes/tui#21, @shared/mcp-scope). Every tool runs against one, so no
 * handler can skip the check, and a new handler written against VaultBackend
 * gets it for free. The Go `zn mcp` has the same decorator in
 * internal/mcp/scoped.go (ZenNotes/tui); the two answer the shared fixture
 * packages/bridge-contract/fixtures/mcp-scope.json with the same bytes.
 *
 * A path is resolved against the vault's own listings before the scope check,
 * never trusted as given: the listings walk real directories and regular
 * files only, so a path through a symbolic link, a case variant of a hidden
 * folder on a case-insensitive volume, or a hidden directory simply has no
 * match. Whatever the client is never shown does not exist for it, and the
 * error for a hidden path is the same bytes as for a missing one. The same
 * rule covers a vault on a ZenNotes server, whose listings come from the
 * server.
 *
 * One is made per tool call; the listings it reads are cached for that call.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  foldMcpScopePath,
  isInsideMcpScopeEntry,
  isInsideMcpScopeEntryFolded,
  isMcpScopeActive,
  isMcpScopeRestricted,
  mcpAccessAtLeast,
  mcpAccessRefusal,
  mcpScopeAccessInfo,
  type McpAccess,
  type McpScope,
  type McpScopeAccessInfo
} from '@shared/mcp-scope'
import {
  resolveFolderPath,
  systemFolderForDirName,
  type SystemFolderPaths
} from '@shared/system-folder-paths'
import type { DatabaseOps } from '@shared/database-ops'
import type { VaultAssetMeta, VaultBackend, VaultDescription, VaultLayout } from '../cli/backend.js'
import {
  sanitizeTitle,
  type NoteComment,
  type NoteCommentInput,
  type NoteContent,
  type NoteFolder,
  type NoteMeta,
  type VaultTask,
  type VaultTextSearchMatch
} from './vault-ops.js'

type FolderEntry = { folder: NoteFolder; subpath: string }

const FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']

/** Kept out of the root-mode note tree however the system folders are
 *  mapped: the asset directories and the internal one. */
const RESERVED_NON_SYSTEM_ROOT_NAMES = ['assets', 'attachements', '_assets', '.zennotes']

const NOT_OFFERED = 'That is not available to an assistant with scoped access.'

const STALE_DENY =
  "This assistant's scope hides a folder or note that does not exist in this vault (renamed or deleted outside ZenNotes, or it belongs to another vault), so nothing is shared until the MCP client's --deny-path entries are fixed."

const REMOTE_RENAME =
  'Renaming notes on a ZenNotes server is not available to an assistant that sees only part of the vault: the server rewrites links in every note, including ones this assistant cannot see.'

const notFound = (rel: string): Error => new Error(`Note not found: ${rel}`)
const folderNotFound = (subpath: string): Error => new Error(`Folder not found: ${subpath}`)

/** The stderr hint about a missing deny entry, once per entry for the life of
 *  the process. */
const staleDenyLogged = new Set<string>()

function joinRel(dir: string, sub: string): string {
  if (!dir) return sub
  if (!sub) return dir
  return `${dir}/${sub}`
}

/** The vault's spelling of `p` among known paths: exact, else the one path
 *  equal to it after case and accent folding. */
function spell(p: string, known: readonly string[]): string | null {
  const folded = foldMcpScopePath(p)
  let match: string | null = null
  let count = 0
  for (const k of known) {
    if (k === p) return k
    if (foldMcpScopePath(k) === folded) {
      match = k
      count += 1
    }
  }
  return count === 1 ? match : null
}

/** A client's path in vault-relative POSIX form, or null: `.` and `..`
 *  segments and hidden names are never resolved. */
function cleanRequest(raw: string): string | null {
  const parts: string[] = []
  for (const seg of raw.replace(/\\/g, '/').split('/')) {
    if (!seg) continue
    if (seg === '.' || seg === '..' || seg.startsWith('.') || seg.includes('\u0000')) return null
    parts.push(seg)
  }
  return parts.length > 0 ? parts.join('/') : null
}

/** The top-level directories the root walk keeps out of the inbox. Mirrors
 *  hiddenPrimaryRootNames in ZenNotes/tui and hiddenRootNamesWith in
 *  vault-ops. */
function hiddenPrimaryRootNames(paths: SystemFolderPaths): Set<string> {
  const names = new Set(RESERVED_NON_SYSTEM_ROOT_NAMES)
  for (const folder of ['quick', 'archive', 'trash'] as NoteFolder[]) {
    names.add(resolveFolderPath(folder, paths))
  }
  return names
}

/** Whether a top-level name a client typed is an asset, internal or system
 *  directory. Case-insensitive on purpose: on a case-insensitive volume
 *  `Attachements/` is the attachments directory. */
function isReservedRootName(name: string, paths: SystemFolderPaths): boolean {
  const lower = name.toLowerCase()
  if (RESERVED_NON_SYSTEM_ROOT_NAMES.some((reserved) => reserved.toLowerCase() === lower)) {
    return true
  }
  return systemFolderForDirName(name, paths) != null
}

/** The bucket a vault-relative path classifies into by its first segment. */
function folderForRelativePath(rel: string, paths: SystemFolderPaths): NoteFolder | null {
  const top = rel.split('/')[0] ?? ''
  if (!top || top.startsWith('.')) return null
  const system = systemFolderForDirName(top, paths)
  if (system) return system
  if (hiddenPrimaryRootNames(paths).has(top)) return null
  return 'inbox'
}

/** A note's directory relative to its bucket root, '' at the root. */
function folderSubpathOf(
  rel: string,
  folder: NoteFolder,
  primaryAtRoot: boolean,
  paths: SystemFolderPaths
): string {
  const dir = path.posix.dirname(rel)
  if (dir === '.') return ''
  if (folder === 'inbox' && primaryAtRoot) return dir
  const top = resolveFolderPath(folder, paths)
  if (dir.toLowerCase() === top.toLowerCase()) return ''
  if (
    dir.length > top.length + 1 &&
    dir.slice(0, top.length).toLowerCase() === top.toLowerCase() &&
    dir[top.length] === '/'
  ) {
    return dir.slice(top.length + 1)
  }
  return ''
}

/** The vault as one call sees it. */
class ScopeView {
  /** The visible notes. */
  readonly notes: NoteMeta[] = []
  /** Every listed note, visible or not. */
  readonly byPath = new Map<string, NoteMeta>()
  /** Every listed folder by its vault-relative directory. */
  readonly folders = new Map<string, FolderEntry>()
  /** The folder paths plus the bucket directories, for spelling lookups. */
  readonly dirs: string[] = []
  readonly allow: string[] = []
  readonly deny: string[] = []
  readonly missingAllow: string[] = []
  readonly ancestors = new Set<string>()

  constructor(
    readonly paths: SystemFolderPaths,
    readonly primaryAtRoot: boolean,
    readonly allFolders: FolderEntry[],
    /** Whether anything at all sits at a vault-relative path, for a vault on
     *  this machine; null for a server's, whose walker is its own. */
    private readonly onDisk: ((rel: string) => Promise<boolean>) | null
  ) {}

  bucketDir(folder: NoteFolder): string {
    if (folder === 'inbox' && this.primaryAtRoot) return ''
    return resolveFolderPath(folder, this.paths)
  }

  folderRel(entry: FolderEntry): string {
    return joinRel(this.bucketDir(entry.folder), entry.subpath)
  }

  covers(p: string): boolean {
    return this.allow.length === 0 || this.allow.some((entry) => isInsideMcpScopeEntry(p, entry))
  }

  denied(p: string): boolean {
    return this.deny.some((entry) => isInsideMcpScopeEntryFolded(p, entry))
  }

  visible = (p: string): boolean => this.covers(p) && !this.denied(p)

  /** Whether a deny entry lies at or below `p`. */
  denyInside(p: string): boolean {
    return this.deny.some((entry) => isInsideMcpScopeEntryFolded(entry, p))
  }

  /** A client's note path resolved to a visible listed note. */
  note(raw: string): NoteMeta | null {
    const clean = cleanRequest(raw)
    if (!clean) return null
    let meta = this.byPath.get(clean) ?? null
    if (!meta) {
      const folded = foldMcpScopePath(clean)
      let count = 0
      for (const [p, m] of this.byPath) {
        if (foldMcpScopePath(p) === folded) {
          meta = m
          count += 1
        }
      }
      if (count !== 1) return null
    }
    return meta && this.visible(meta.path) ? meta : null
  }

  /**
   * Where a note or folder would go, as the subpath under its bucket in the
   * vault's spelling, or a refusal. The directory must sit in the bucket asked
   * for (a subpath never reaches another system folder or a hidden one) and
   * inside an allow entry, not merely above one.
   */
  async destination(folder: NoteFolder, rawSub: string): Promise<string> {
    let sub = rawSub.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (sub) {
      const clean = cleanRequest(sub)
      if (!clean) throw this.createRefusal()
      sub = clean
    }
    // A database folder's insides are its record pages, not notes.
    if (sub.split('/').some((seg) => seg.toLowerCase().endsWith('.base'))) {
      throw this.createRefusal()
    }
    const bucket = this.bucketDir(folder)
    if (!bucket && sub && isReservedRootName(sub.split('/')[0] ?? '', this.paths)) {
      throw this.createRefusal()
    }
    const rel = joinRel(bucket, sub)
    if (rel && folderForRelativePath(`${rel}/x.md`, this.paths) !== folder) {
      throw this.createRefusal()
    }
    // Existing folders keep their spelling; new segments are created as given.
    let spelled = bucket
    let firstNew: string | null = null
    if (sub) {
      for (const seg of sub.split('/')) {
        const next = joinRel(spelled, seg)
        const listed = spell(next, this.dirs)
        if (listed == null && firstNew == null) firstNew = next
        spelled = listed ?? next
      }
    }
    if (!this.visible(spelled)) throw this.createRefusal()
    // A segment the listings do not know is new only when nothing is there.
    // The walks skip symbolic links, so `Projects/inner -> ../Journal` reads
    // as missing, and creating through it would write into the hidden folder.
    if (firstNew != null && this.onDisk && (await this.onDisk(firstNew))) {
      throw this.createRefusal()
    }
    if (!bucket) return spelled
    return spelled.slice(bucket.length).replace(/^\//, '')
  }

  /** The one answer for every destination a client may not use, hidden or
   *  not, so it confirms nothing about hidden folders. */
  createRefusal(): Error {
    if (this.allow.length > 0) {
      return new Error(
        `This assistant can create and move notes only inside: ${this.allow.join(', ')}.`
      )
    }
    return new Error('This assistant cannot put notes there.')
  }

  /** A client's (bucket, subpath) resolved to a visible listed folder. */
  folder(folder: NoteFolder, rawSub: string): { rel: string; entry: FolderEntry } | null {
    const clean = cleanRequest(rawSub)
    if (!clean) return null
    const rel = spell(joinRel(this.bucketDir(folder), clean), this.dirs)
    if (rel == null) return null
    const entry = this.folders.get(rel)
    if (!entry || entry.folder !== folder || !this.visible(rel)) return null
    return { rel, entry }
  }
}

export class ScopedBackend implements VaultBackend {
  private view: Promise<ScopeView> | null = null

  constructor(
    readonly inner: VaultBackend,
    readonly scope: McpScope
  ) {}

  get kind(): 'local' | 'remote' {
    return this.inner.kind
  }

  get label(): string {
    return this.inner.label
  }

  get root(): string {
    return this.inner.root
  }

  private load(): Promise<ScopeView> {
    this.view ??= this.build()
    return this.view
  }

  private async build(): Promise<ScopeView> {
    const layout = await this.inner.vaultLayout()
    const notes = await this.inner.listNotes()
    const folders = await this.inner.listFolders()
    const root = this.inner.root
    const v = new ScopeView(
      layout.systemFolderPaths,
      layout.primaryNotesLocation === 'root',
      folders,
      this.inner.kind === 'local' && root
        ? (rel) =>
            fs.lstat(path.join(root, ...rel.split('/'))).then(
              () => true,
              // Anything but plain absence counts as something being there.
              (err: NodeJS.ErrnoException) => err.code !== 'ENOENT'
            )
        : null
    )
    for (const folder of FOLDERS) {
      const dir = v.bucketDir(folder)
      if (dir) v.dirs.push(dir)
    }
    for (const entry of folders) {
      const rel = v.folderRel(entry)
      v.folders.set(rel, entry)
      v.dirs.push(rel)
    }
    const known: string[] = []
    for (const note of notes) {
      v.byPath.set(note.path, note)
      known.push(note.path)
    }
    known.push(...v.dirs)

    // Entries take the vault's own spelling, so `--allow-path /projects`
    // finds `Projects/`.
    for (const entry of this.scope.allow) {
      let canonical = spell(entry, known)
      if (canonical == null) {
        v.missingAllow.push(entry)
        canonical = entry
      }
      v.allow.push(canonical)
      for (let p = path.posix.dirname(canonical); p !== '.' && p !== '/'; p = path.posix.dirname(p)) {
        v.ancestors.add(p)
      }
    }
    // A deny entry that matches nothing was renamed or deleted outside
    // ZenNotes, or belongs to another vault: what it hid may now sit under a
    // new name, so the scope shares nothing until it is fixed. Only stderr,
    // which lands in the client's logs and not in front of the model, names
    // the entry.
    for (const entry of this.scope.deny) {
      const folded = foldMcpScopePath(entry)
      if (!known.some((p) => foldMcpScopePath(p) === folded)) {
        if (!staleDenyLogged.has(entry)) {
          staleDenyLogged.add(entry)
          process.stderr.write(
            `[zennotes-mcp] --deny-path ${entry} matches nothing in this vault, so the MCP server shares nothing until it is fixed\n`
          )
        }
        throw new Error(STALE_DENY)
      }
      v.deny.push(entry)
    }
    for (const note of notes) {
      if (v.visible(note.path)) v.notes.push(note)
    }
    return v
  }

  private need(access: McpAccess): void {
    if (!mcpAccessAtLeast(this.scope.access, access)) throw new Error(mcpAccessRefusal(this.scope))
  }

  /** Loads the view and resolves a note: the first step of every per-note
   *  operation. */
  private async noteFor(rel: string, access: McpAccess): Promise<NoteMeta> {
    this.need(access)
    const v = await this.load()
    const meta = v.note(rel)
    if (!meta) throw notFound(rel)
    return meta
  }

  /* ---------- VaultBackend ---------------------------------------------- */

  describe = (): Promise<VaultDescription> => this.inner.describe()
  vaultLayout = (): Promise<VaultLayout> => this.inner.vaultLayout()

  listNotes = async (): Promise<NoteMeta[]> => [...(await this.load()).notes]

  /** The visible folders plus the folders above an allow entry, which are
   *  listed by name (the entry names them already) so the tree makes sense,
   *  while nothing directly inside them is visible. */
  listFolders = async (): Promise<FolderEntry[]> => {
    const v = await this.load()
    return v.allFolders.filter((entry) => {
      const rel = v.folderRel(entry)
      return v.visible(rel) || (v.ancestors.has(rel) && !v.denied(rel))
    })
  }

  listAssets = async (): Promise<VaultAssetMeta[]> => {
    const v = await this.load()
    return (await this.inner.listAssets()).filter((asset) => v.visible(asset.path))
  }

  readNote = async (rel: string): Promise<NoteContent> =>
    await this.inner.readNote((await this.noteFor(rel, 'read')).path)

  writeNote = async (rel: string, body: string): Promise<NoteMeta> =>
    await this.inner.writeNote((await this.noteFor(rel, 'write')).path, body)

  createNote = async (
    folder: NoteFolder,
    title?: string,
    subpath = '',
    body?: string
  ): Promise<NoteMeta> => {
    this.need('write')
    const v = await this.load()
    return await this.inner.createNote(folder, title, await v.destination(folder, subpath), body)
  }

  appendToNote = async (rel: string, text: string): Promise<NoteMeta> =>
    await this.inner.appendToNote((await this.noteFor(rel, 'write')).path, text)

  prependToNote = async (rel: string, text: string): Promise<NoteMeta> =>
    await this.inner.prependToNote((await this.noteFor(rel, 'write')).path, text)

  /**
   * The new name must be one the client can see. This engine's rename does
   * not rewrite inbound links at all, so it never writes into a note the
   * client cannot see; zn rewrites links in the notes it can see only. A
   * server rewrites inbound links in every note itself, so on a remote vault
   * a client that sees part of it cannot rename.
   */
  renameNote = async (rel: string, nextTitle: string): Promise<NoteMeta> => {
    const meta = await this.noteFor(rel, 'write')
    const v = await this.load()
    const next = path.posix.join(path.posix.dirname(meta.path), `${sanitizeTitle(nextTitle)}.md`)
    if (!v.visible(next)) throw new Error('This assistant cannot give the note that name.')
    if (isMcpScopeRestricted(this.scope) && this.inner.kind === 'remote') {
      throw new Error(REMOTE_RENAME)
    }
    return await this.inner.renameNote(meta.path, nextTitle)
  }

  moveNote = async (rel: string, folder: NoteFolder, subpath: string): Promise<NoteMeta> => {
    const meta = await this.noteFor(rel, 'write')
    const v = await this.load()
    return await this.inner.moveNote(meta.path, folder, await v.destination(folder, subpath))
  }

  // Archiving and trashing are lifecycle exits: the note may leave what the
  // client sees, and the user can undo either in the app.
  archiveNote = async (rel: string): Promise<NoteMeta> =>
    await this.inner.archiveNote((await this.noteFor(rel, 'write')).path)

  moveToTrash = async (rel: string): Promise<NoteMeta> =>
    await this.inner.moveToTrash((await this.noteFor(rel, 'write')).path)

  /** A note brought back to the inbox must land where the client can see it:
   *  the same subpath under the inbox bucket. */
  private async restoreTarget(rel: string): Promise<NoteMeta> {
    const meta = await this.noteFor(rel, 'write')
    const v = await this.load()
    await v.destination('inbox', folderSubpathOf(meta.path, meta.folder, v.primaryAtRoot, v.paths))
    return meta
  }

  unarchiveNote = async (rel: string): Promise<NoteMeta> =>
    await this.inner.unarchiveNote((await this.restoreTarget(rel)).path)

  restoreFromTrash = async (rel: string): Promise<NoteMeta> =>
    await this.inner.restoreFromTrash((await this.restoreTarget(rel)).path)

  duplicateNote = async (rel: string): Promise<NoteMeta> =>
    await this.inner.duplicateNote((await this.noteFor(rel, 'write')).path)

  deleteNote = async (rel: string): Promise<void> =>
    await this.inner.deleteNote((await this.noteFor(rel, 'write')).path)

  emptyTrash = async (): Promise<void> => {
    this.need('write')
    if (isMcpScopeRestricted(this.scope)) throw new Error(NOT_OFFERED)
    await this.inner.emptyTrash()
  }

  insertAtLine = async (rel: string, lineNumber: number, text: string): Promise<NoteMeta> =>
    await this.inner.insertAtLine((await this.noteFor(rel, 'write')).path, lineNumber, text)

  replaceInNote = async (
    rel: string,
    find: string,
    replace: string,
    occurrence: 'first' | 'all'
  ): Promise<{ meta: NoteMeta; replacements: number }> =>
    await this.inner.replaceInNote((await this.noteFor(rel, 'write')).path, find, replace, occurrence)

  createFolder = async (folder: NoteFolder, subpath: string): Promise<void> => {
    this.need('write')
    const v = await this.load()
    const sub = await v.destination(folder, subpath)
    if (!sub) throw new Error('Folder name is required')
    await this.inner.createFolder(folder, sub)
  }

  /**
   * A folder a client may rename or delete as a whole: visible, and holding
   * nothing hidden, or the operation would carry or destroy what the client
   * cannot see. The refusal for a folder that holds something hidden is the
   * one bit this tells a client, documented in the design.
   */
  private async wholeFolder(
    folder: NoteFolder,
    subpath: string,
    verb: string
  ): Promise<{ v: ScopeView; subpath: string }> {
    this.need('write')
    const v = await this.load()
    const found = v.folder(folder, subpath)
    if (!found) throw folderNotFound(subpath)
    if (v.denyInside(found.rel)) throw new Error(`This assistant cannot ${verb} that folder.`)
    return { v, subpath: found.entry.subpath }
  }

  renameFolder = async (
    folder: NoteFolder,
    oldSubpath: string,
    newSubpath: string
  ): Promise<string> => {
    const { v, subpath: oldSub } = await this.wholeFolder(folder, oldSubpath, 'rename')
    const newSub = await v.destination(folder, newSubpath)
    if (!newSub) throw new Error('Both old and new folder paths are required')
    return await this.inner.renameFolder(folder, oldSub, newSub)
  }

  deleteFolder = async (folder: NoteFolder, subpath: string): Promise<void> => {
    const { subpath: sub } = await this.wholeFolder(folder, subpath, 'delete')
    await this.inner.deleteFolder(folder, sub)
  }

  /** Filters before it limits: the inner walk stops at its limit, so
   *  filtering its first page would let hidden matches crowd out visible
   *  ones, and a short page would say how many hidden notes match. */
  searchText = async (query: string, limit: number): Promise<VaultTextSearchMatch[]> => {
    const v = await this.load()
    const cap = limit <= 0 ? 80 : limit
    const out: VaultTextSearchMatch[] = []
    for (const match of await this.inner.searchText(query, Number.MAX_SAFE_INTEGER)) {
      if (out.length >= cap) break
      const note = v.byPath.get(match.path)
      if (note && v.visible(note.path)) out.push(match)
    }
    return out
  }

  backlinks = async (rel: string): Promise<NoteMeta[]> => {
    const meta = await this.noteFor(rel, 'read')
    const v = await this.load()
    return (await this.inner.backlinks(meta.path)).filter((note) => v.visible(note.path))
  }

  scanAllTasks = async (opts?: { includeExcluded?: boolean }): Promise<VaultTask[]> => {
    const v = await this.load()
    return (await this.inner.scanAllTasks(opts)).filter(
      (task) => v.byPath.has(task.sourcePath) && v.visible(task.sourcePath)
    )
  }

  toggleTask = async (taskId: string): Promise<VaultTask | null> => {
    const hash = taskId.lastIndexOf('#')
    if (hash <= 0) throw new Error(`Task not found: ${taskId}`)
    const meta = await this.noteFor(taskId.slice(0, hash), 'write')
    return await this.inner.toggleTask(meta.path + taskId.slice(hash))
  }

  listComments = async (rel: string): Promise<NoteComment[]> =>
    await this.inner.listComments((await this.noteFor(rel, 'read')).path)

  writeComments = async (rel: string, comments: NoteCommentInput[]): Promise<NoteComment[]> =>
    await this.inner.writeComments((await this.noteFor(rel, 'comment')).path, comments)

  /** No MCP tool reaches databases. */
  databaseOps = (): DatabaseOps => {
    throw new Error(NOT_OFFERED)
  }

  /** The scope as vault_info reports it, with entries in the vault's
   *  spelling, or why it shares nothing. */
  async accessInfo(): Promise<McpScopeAccessInfo> {
    try {
      const v = await this.load()
      return mcpScopeAccessInfo(this.scope, v.allow, v.missingAllow)
    } catch (err) {
      return mcpScopeAccessInfo(
        this.scope,
        this.scope.allow,
        [],
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}

/** A call's backend under its scope; full access runs bare. */
export function scopeBackend(backend: VaultBackend, scope: McpScope | null | undefined): VaultBackend {
  return isMcpScopeActive(scope) ? new ScopedBackend(backend, scope) : backend
}

/**
 * Keeps the vault's absolute location out of a scoped client's errors: an
 * MCP-only client has no use for it, and it names the user's home folder.
 */
export function scrubVaultRoot(message: string, root: string): string {
  if (!root) return message
  return message.split(root + path.sep).join('').split(root).join('the vault')
}
