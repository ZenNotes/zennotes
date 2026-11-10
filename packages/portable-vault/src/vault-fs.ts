import { relocateVaultEntries, type VaultRelocation, type VaultRelocationIO } from '@zennotes/shared-domain/vault-relocation'
/**
 * The vault the phones and the browser open: desktop `vault.ts` semantics
 * reimplemented over the host's VaultFileSystem (there is no Node `fs` in a
 * WKWebView, an Android WebView or a browser tab). Same on-disk layout, same
 * folder mapping, same naming rules, so a vault created here opens unchanged
 * in ZenNotes desktop. Lifted from the iPhone shell's MobileVault, which the
 * Android shell carried as a copy.
 */
import type { PortableVaultFiles, VaultDirEntry } from './host'
import type {
  AssetMeta,
  DeletedAsset,
  FolderEntry,
  ImportedAsset,
  NoteComment,
  NoteCommentInput,
  NoteContent,
  NoteFolder,
  NoteMeta,
  PastedImageInput,
  VaultDemoTourResult,
  VaultSettings,
  VaultTextSearchMatch
} from '@zennotes/bridge-contract/ipc'
import { DEFAULT_VAULT_SETTINGS } from '@zennotes/bridge-contract/ipc'
import type { CustomTemplateFile, WriteTemplateInput } from '@zennotes/bridge-contract/templates'
import type { VaultTask } from '@zennotes/shared-domain/tasks'
import { parseTaskFile, parseTasksFromBody } from '@zennotes/shared-domain/tasks'
import { normalizeHarperVaultState } from '@zennotes/shared-domain/harper-settings'
import { normalizeNoteComments } from '@zennotes/shared-domain/note-comments'
import { AGENT_EDITS_DIR, agentEditSidecarPath } from '@zennotes/shared-domain/agent-edits'
import {
  isPathExcludedFromTasks,
  normalizeTasksExcludedFolders,
  normalizeTasksIncludedFolders,
  rewriteTasksFoldersForRename,
  tasksFolderListsForSettings
} from '@zennotes/shared-domain/tasks-excluded-folders'
import {
  isPathInTemplateFolder,
  normalizeTemplateFolderSettings,
  resolveTemplateFolder,
  rewriteTemplateFolderForRename
} from '@zennotes/shared-domain/template-folder'
import { pastedImageFilename } from '@zennotes/shared-domain/pasted-image'
import { randomUUID } from './uuid'
import { bytesToBase64 } from './base64'
import { isFormDirName, isDatabaseInternalPath } from '@zennotes/shared-domain/databases'
import { emptyExcalidrawDocument } from '@zennotes/shared-domain/excalidraw'
import { DEMO_TOUR_ASSETS, DEMO_TOUR_NOTES } from '@zennotes/shared-domain/demo-tour-data'
import { currentDemoTourPath, DEMO_TOUR_DIR, demoTourNestedDirs } from '@zennotes/shared-domain/demo-tour'
import {
  WELCOME_NOTE_PATH,
  WELCOME_NOTE_BODY,
  isUntouchedInboxWelcome,
  isWelcomeSeedName,
  sha256OfText
} from './welcome-note'
import {
  rewriteWikilinksForRename,
  type RenameNoteRef
} from '@zennotes/shared-domain/wikilink-rename'
import { emitVaultChange } from './events'
import {
  buildExcerpt,
  bodyHasLocalAsset,
  classifyImportedAsset,
  collapseSearchLine,
  dirName,
  extName,
  extractAssetEmbeds,
  extractTags,
  extractWikilinks,
  firstMatchColumn,
  folderForRelativePath,
  hiddenPrimaryRootNames,
  importedAssetFilename,
  importedAssetMarkdown,
  importedAssetRelPath,
  isExcalidrawPath,
  isMarkdownPath,
  joinPath,
  leftoverCommentsMessage,
  NOTE_COMMENTS_DIR,
  NOTE_COMMENTS_SUFFIX,
  NOTE_METADATA_DIR,
  NOTE_METADATA_SUFFIX,
  RESERVED_ROOT_NAMES,
  resolveSafeRel,
  sanitizeNoteTitle,
  scoreMatch,
  SEARCHABLE_TEXT_FOLDERS,
  stemName,
  ATTACHMENTS_DIRS,
  ASSETS_DIR,
  INTERNAL_VAULT_DIR,
  TEMPLATES_DIR,
  FOLDERS
} from './vault-core'
import {
  DEFAULT_FOLDER_PATHS,
  describeSystemFolderPathIssue,
  normalizeSystemFolderPaths,
  resolveFolderPath,
  type SystemFolderPaths
} from '@zennotes/shared-domain/system-folder-paths'

const META_CACHE_FILE = `${INTERNAL_VAULT_DIR}/mobile-note-meta-cache-v1.json`
/** Bump when what a note's meta holds changes, so every vault re-reads its notes
 *  once. Version 2: `[[C\|d]]` in a table links to C, not to `C\`. */
const META_CACHE_VERSION = 2
/** Restore metadata written next to each deleted asset (desktop parity). */
const DELETED_ASSET_META = '.zn-deleted.json'

interface CachedMeta {
  mtime: number
  size: number
  meta: NoteMeta
}

interface CachedTasks {
  mtime: number
  size: number
  title: string
  folder: NoteFolder
  tasks: VaultTask[]
}

/** How long the listings of a finished walk stay shareable. Long enough for
 *  the resync a rescan emits to reuse the rescan's walk, short enough that no
 *  external change waits on it in a way a person could notice. */
const SHARED_LISTING_GRACE_MS = 1000

interface SearchCandidate {
  path: string
  title: string
  folder: NoteFolder
  lineNumber: number
  offset: number
  lineText: string
  rawLine: string
}

function uuid(): string {
  return randomUUID()
}

/**
 * Say something when a hand-written `systemFolderPaths` entry is thrown away,
 * mirrored 1:1 from desktop vault.ts (#533). Normalization drops what it
 * cannot use, which is the right way to read a file a person may have edited
 * with any text editor, but doing it silently left them concluding the
 * setting did not work. Runs only where vault.json is actually parsed, which
 * the settings cache makes once per open rather than once per read.
 */
function warnAboutDiscardedFolderPaths(parsed: unknown, settings: VaultSettings): void {
  // The RAW object, deliberately: normalization is exactly the step that
  // throws the bad value away, so asking the normalized settings what the
  // file said reports only what survived.
  if (!parsed || typeof parsed !== 'object') return
  const stated = (parsed as { systemFolderPaths?: unknown }).systemFolderPaths
  if (!stated || typeof stated !== 'object') return
  for (const [folder, value] of Object.entries(stated as Record<string, unknown>)) {
    if (!(folder in DEFAULT_FOLDER_PATHS)) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    const kept = settings.systemFolderPaths?.[folder as NoteFolder]
    if (kept === value.trim()) continue
    // Its own default is not a rejection, just a redundant line.
    if (value.trim() === DEFAULT_FOLDER_PATHS[folder as NoteFolder]) continue
    const reason =
      describeSystemFolderPathIssue(folder as NoteFolder, value, settings.systemFolderPaths) ??
      'it could not be used'
    console.warn(
      `[zen] vault.json: systemFolderPaths.${folder} = ${JSON.stringify(value)} was ignored. ${reason}`
    )
  }
}

/**
 * The Tasks folder lists validated the way desktop's normalizeTasksSettings
 * validates them: the folders left out of Tasks (#458) and the Task folders
 * it is narrowed to (#962). A hand-edited list that is not an array would
 * otherwise reach a folder rename and refuse it. An empty list is left out,
 * other keys under `tasks` pass through, and undefined comes back when
 * nothing is left, so vault.json carries no empty stub.
 */
function normalizeTasksSettings(raw: unknown): VaultSettings['tasks'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { excludedFolders, includedFolders, ...rest } = raw as Record<string, unknown>
  const excluded = normalizeTasksExcludedFolders(excludedFolders)
  const included = normalizeTasksIncludedFolders(includedFolders)
  const out = {
    ...rest,
    ...(excluded.length > 0 ? { excludedFolders: excluded } : {}),
    ...(included.length > 0 ? { includedFolders: included } : {})
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export class PortableVault<F extends PortableVaultFiles = PortableVaultFiles> {
  readonly name: string
  readonly fs: F
  private metaCache = new Map<string, CachedMeta>()
  private metaCacheDirty = false
  private metaCachePersistTimer: ReturnType<typeof setTimeout> | null = null
  private settingsCache: VaultSettings | null = null
  /**
   * Directory listings the tree walks (notes, folders, assets) share. app-core
   * asks for notes and folders together on every refresh, and a new note or a
   * return to the app starts two refreshes at once, so the vault was listed
   * four times over before a new note could open. On Android, where a picked
   * folder answers each listing with a document-provider query, that was 12
   * to 15 seconds on a budget phone (zennotesandroid#128); the walks here are
   * the same code and multiplied the same way on a large vault.
   * A listing is shared only with walks that overlap it or start
   * within SHARED_LISTING_GRACE_MS of the last one ending (the resync a rescan
   * emits), and never across a write this vault makes.
   */
  private sharedListings: { generation: number; byDir: Map<string, Promise<VaultDirEntry[]>> } | null = null
  private walksInFlight = 0
  private sharedListingsTimer: ReturnType<typeof setTimeout> | null = null
  /** Each note's parsed tasks, reused while its listed mtime and size hold,
   *  the test the meta cache uses. Without it every task scan read every note
   *  in the vault, and adding one task runs a full scan (zennotesandroid#128). */
  private taskCache = new Map<string, CachedTasks>()

  /** `fs` is the host's file system for this vault's root (the phones'
   *  NativeFs, the browser's OPFS directory). */
  constructor(name: string, fs: F) {
    this.name = name
    this.fs = fs
  }

  async open(): Promise<void> {
    // The host's init does what its storage needs before the first walk: on
    // an iCloud vault, materializing evicted items so nothing reads as
    // missing (bounded wait; stragglers land via later rescans).
    await this.fs.init()
    await this.ensureVaultLayout()
    await this.settleSeededInbox()
    await this.loadMetaCache()
    await this.sweepWriteArtifacts()
  }

  /** Remove `.md.bak`/`.md.tmp` siblings an earlier build's atomic-write
   *  experiment left behind: they read as stray files in the sidebar. */
  private async sweepWriteArtifacts(): Promise<void> {
    const sweep = async (dirRel: string): Promise<void> => {
      const entries = await this.fs.readdir(dirRel)
      for (const entry of entries) {
        const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
        if (entry.type === 'directory') {
          if (entry.name.startsWith('.')) continue
          await sweep(childRel)
          continue
        }
        const lower = entry.name.toLowerCase()
        if (lower.endsWith('.md.bak') || lower.endsWith('.md.tmp')) {
          await this.fs.deleteFile(childRel).catch(() => {})
        }
      }
    }
    await sweep('')
    for (const entry of await this.fs.readdir(INTERNAL_VAULT_DIR)) {
      const lower = entry.name.toLowerCase()
      if (entry.type === 'file' && (lower.endsWith('.bak') || lower.endsWith('.tmp'))) {
        await this.fs.deleteFile(`${INTERNAL_VAULT_DIR}/${entry.name}`).catch(() => {})
      }
    }
  }

  get rootLabel(): string {
    return this.fs.rootLabel
  }

  // -------------------------------------------------------------------
  // Layout / settings
  // -------------------------------------------------------------------

  async ensureVaultLayout(): Promise<void> {
    const settings = await this.getVaultSettings()
    // The inbox waits for a vault that states its layout, or for its first note
    // (every write makes its folder). A folder opened before its notes arrived
    // infers its layout from what lands in it (#1023), and an inbox made here
    // then sat among the notes as an empty folder once that said root mode.
    const stated = (await this.fs.readTextOrNull(`${INTERNAL_VAULT_DIR}/vault.json`)) !== null
    // The RESOLVED directory of each system folder (vault.json
    // `systemFolderPaths`), not the default name, creating `inbox/` while
    // the settings point the inbox at `01 - Entry/` would leave a stray
    // directory every classifier then reads as the system inbox.
    const folders: NoteFolder[] =
      settings.primaryNotesLocation === 'root' || !stated
        ? ['quick', 'archive', 'trash']
        : ['inbox', 'quick', 'archive', 'trash']
    for (const f of folders) {
      await this.fs.mkdir(resolveFolderPath(f, settings.systemFolderPaths))
    }
  }

  private async inferPrimaryNotesLocation(
    systemFolderPaths?: SystemFolderPaths | null
  ): Promise<'inbox' | 'root'> {
    const entries = await this.fs.readdir('')
    // The resolved inbox directory is the strongest signal of ZenNotes' own
    // layout: trust it even when other loose folders exist at the root (a
    // daily/weekly-notes dir created during a transient mis-inference must
    // never flip a vault into root mode permanently).
    //
    // An empty one says nothing, though: this app makes it on first open, so a
    // folder opened before its notes arrived (Syncthing still copying, a vault
    // moved over in parts) read as inbox mode for good and showed none of them
    // (#1023). With nothing inside, reading the root instead cannot hide a note.
    //
    // Nor does one holding only the Welcome this app seeded there, untouched: the
    // folder copied in beside it is the vault (ZenNotes 4e8c13f8, settleSeededInbox).
    const inboxDir = resolveFolderPath('inbox', systemFolderPaths).toLowerCase()
    const inbox = entries.find((e) => e.type === 'directory' && e.name.toLowerCase() === inboxDir)
    if (inbox) {
      const inside = (await this.fs.readdir(inbox.name)).filter((e) => !e.name.startsWith('.'))
      const onlySeed = inside.length === 1 && (await this.isUntouchedSeedAt(inbox.name, inside[0]!))
      if (inside.length > 0 && !onlySeed) return 'inbox'
    }
    return this.rootHoldsLooseContent(entries, systemFolderPaths) ? 'root' : 'inbox'
  }

  /** A Welcome in `dir` that nobody wrote in or commented on. */
  private async isUntouchedSeedAt(dir: string, entry: VaultDirEntry): Promise<boolean> {
    if (entry.type !== 'file' || !isWelcomeSeedName(entry.name)) return false
    const rel = `${dir}/${entry.name}`
    const text = await this.fs.readTextOrNull(rel)
    if (text === null || !isUntouchedInboxWelcome(entry.name, await sha256OfText(text))) return false
    return (await this.fs.statVerified(this.commentsPathFor(rel))) === null
  }

  /**
   * A folder opened empty is seeded in inbox mode without saying so in vault.json,
   * so its layout is still inferred when folders are copied in, and that turns to
   * root mode. What it must not leave behind is the system inbox as a lowercase
   * `inbox` folder holding a Welcome nobody asked for. The desktop's
   * settleSeededInbox (ZenNotes 4e8c13f8) does the same for its own seed.
   *
   * A vault.json that states inbox mode, or that states nothing but exists (this
   * app reads that as inbox mode), keeps its inbox however much is at the root:
   * that is what the banner is for. One that does not parse is not ours to act on.
   */
  async settleSeededInbox(): Promise<boolean> {
    const raw = await this.fs.readTextOrNull(`${INTERNAL_VAULT_DIR}/vault.json`)
    let parsed: { primaryNotesLocation?: unknown; systemFolderPaths?: unknown } | null = null
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        return false
      }
      if (parsed?.primaryNotesLocation !== 'root') return false
    }
    const paths = normalizeSystemFolderPaths(parsed?.systemFolderPaths)
    if ((await this.inferPrimaryNotesLocation(paths)) !== 'root') return false
    const removed = await this.removeSeedOnlyInbox(paths, { explicit: false })
    if (removed) this.settingsCache = null
    return removed
  }

  /** Markdown or a folder at the root that only root mode would show. */
  private rootHoldsLooseContent(
    entries: VaultDirEntry[],
    systemFolderPaths?: SystemFolderPaths | null
  ): boolean {
    // Remapped system folders are system directories, not loose user content:
    // without this, a vault whose inbox is `01 - Entry` reads as a flat
    // root-mode vault.
    const customDirs = new Set<string>()
    if (systemFolderPaths) {
      for (const value of Object.values(systemFolderPaths)) {
        if (value) customDirs.add(value.toLowerCase())
      }
    }
    return entries.some(
      (e) =>
        !e.name.startsWith('.') &&
        !RESERVED_ROOT_NAMES.has(e.name) &&
        !customDirs.has(e.name.toLowerCase()) &&
        (e.type === 'directory' || isMarkdownPath(e.name))
    )
  }

  async getVaultSettings(): Promise<VaultSettings> {
    if (this.settingsCache) return this.settingsCache
    const raw = await this.fs.readTextOrNull(`${INTERNAL_VAULT_DIR}/vault.json`)
    let parsed: unknown = null
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }
    const fallbackPrimary = parsed === null ? await this.inferPrimaryNotesLocation() : 'inbox'
    const normalized = this.normalizeVaultSettings(parsed, fallbackPrimary)
    warnAboutDiscardedFolderPaths(parsed, normalized)
    this.settingsCache = normalized
    return normalized
  }

  private normalizeVaultSettings(raw: unknown, fallbackPrimary: 'inbox' | 'root'): VaultSettings {
    const defaults: VaultSettings = JSON.parse(JSON.stringify(DEFAULT_VAULT_SETTINGS))
    if (!raw || typeof raw !== 'object') {
      return { ...defaults, primaryNotesLocation: fallbackPrimary }
    }
    const obj = raw as Record<string, unknown>
    const out: VaultSettings = {
      ...defaults,
      // Pass every key the file already carries through untouched, newer
      // desktop versions add settings (monthlyNotes in 2.11, …) that a
      // mobile write must never strip from a shared vault.json.
      ...(obj as Partial<VaultSettings>),
      primaryNotesLocation: obj.primaryNotesLocation === 'root' ? 'root' : 'inbox',
      dailyNotes: {
        ...defaults.dailyNotes,
        ...(obj.dailyNotes && typeof obj.dailyNotes === 'object'
          ? (obj.dailyNotes as object)
          : {})
      },
      weeklyNotes: {
        ...defaults.weeklyNotes,
        ...(obj.weeklyNotes && typeof obj.weeklyNotes === 'object'
          ? (obj.weeklyNotes as object)
          : {})
      },
      monthlyNotes: {
        ...defaults.monthlyNotes,
        ...(obj.monthlyNotes && typeof obj.monthlyNotes === 'object'
          ? (obj.monthlyNotes as object)
          : {})
      },
      folderIcons:
        obj.folderIcons && typeof obj.folderIcons === 'object'
          ? (obj.folderIcons as VaultSettings['folderIcons'])
          : {},
      folderColors:
        obj.folderColors && typeof obj.folderColors === 'object'
          ? (obj.folderColors as VaultSettings['folderColors'])
          : {},
      favorites: Array.isArray(obj.favorites)
        ? [...new Set(obj.favorites.filter((f): f is string => typeof f === 'string'))]
        : [],
      // Same validation as desktop: drop paths that collide, nest, or claim
      // another folder's default name, so every surface classifies alike.
      systemFolderPaths: normalizeSystemFolderPaths(obj.systemFolderPaths)
    }
    if (obj.view && typeof obj.view === 'object') out.view = obj.view as VaultSettings['view']
    // Harper's vault dictionary and ignored suggestions are written by desktop
    // and web; a save from this device must carry them through, or the next
    // sync erases what the user taught it. Phones never run Harper themselves.
    const harper = normalizeHarperVaultState(obj.harper)
    if (harper) out.harper = harper
    const tasks = normalizeTasksSettings(obj.tasks)
    if (tasks) out.tasks = tasks
    else delete out.tasks
    // A desktop user's template folder (#1024) rides through a save from this
    // device, normalized exactly as desktop main normalizes it: a usable
    // folder cleaned (`Templates/` reads `Templates`), only the folder kept,
    // and no stub left when there is none. The pass-through above would carry
    // it raw.
    const templates = normalizeTemplateFolderSettings(obj.templates)
    if (templates) out.templates = templates
    else delete out.templates
    return out
  }

  async setVaultSettings(next: VaultSettings): Promise<VaultSettings> {
    const before = await this.getVaultSettings()
    const normalized = this.normalizeVaultSettings(next, 'inbox')
    await this.fs.mkdir(INTERNAL_VAULT_DIR)
    await this.fs.writeText(
      `${INTERNAL_VAULT_DIR}/vault.json`,
      JSON.stringify(normalized, null, 2)
    )
    this.settingsCache = normalized
    if (normalized.primaryNotesLocation === 'inbox') {
      // The RESOLVED inbox, not the literal one (see ensureVaultLayout).
      await this.fs.mkdir(resolveFolderPath('inbox', normalized.systemFolderPaths))
    } else if (before.primaryNotesLocation === 'inbox') {
      await this.removeSeedOnlyInbox(normalized.systemFolderPaths, { explicit: true })
    }
    emitVaultChange({ kind: 'change', path: '.zennotes/vault.json', folder: 'inbox', scope: 'vault-settings' })
    return normalized
  }

  /**
   * Takes away `inbox/` when it only holds what an app put there, so it does not
   * sit among the notes as a plain folder in a vault that keeps them at its root.
   * Anything else in it stays, a Welcome someone edited or commented on included.
   * A folder the inbox was remapped to is theirs by name, and so is `Inbox/`.
   *
   * An empty inbox goes only when someone asked, by switching to root mode: with
   * no Welcome there is no sign this app made it. The Welcome goes only beside
   * something else to look at, since a vault switched to root mode before anything
   * is in it would otherwise open on nothing. Finder's .DS_Store says nothing
   * about the folder. The rmdir is not recursive, so a file landing after the
   * look stays, and so does the folder.
   */
  private async removeSeedOnlyInbox(
    systemFolderPaths: SystemFolderPaths | null | undefined,
    { explicit }: { explicit: boolean }
  ): Promise<boolean> {
    if (resolveFolderPath('inbox', systemFolderPaths) !== 'inbox') return false
    try {
      const top = await this.fs.readdir('')
      if (!top.some((entry) => entry.name === 'inbox' && entry.type === 'directory')) return false
      const inside = (await this.fs.readdir('inbox')).filter((entry) => entry.name !== '.DS_Store')
      if (inside.length > 1) return false
      const [only] = inside
      if (!only && !explicit) return false
      if (only) {
        if (!(await this.isUntouchedSeedAt('inbox', only))) return false
        if ((await this.inferPrimaryNotesLocation(systemFolderPaths)) !== 'root') return false
        if (!(await this.takeAwayUntouchedWelcome(only.name))) return false
        const rel = `inbox/${only.name}`
        const metadata = this.metadataPathFor(rel)
        if ((await this.fs.statVerified(metadata)) === 'file') await this.fs.deleteFile(metadata)
        this.invalidateMeta(rel)
        emitVaultChange({ kind: 'unlink', path: rel, folder: 'inbox', scope: 'content' })
      }
      if ((await this.fs.statVerified('inbox/.DS_Store')) === 'file') await this.fs.deleteFile('inbox/.DS_Store')
      await this.fs.rmdirIfEmpty('inbox')
      return true
    } catch {
      // Already gone, or something arrived: the folder simply stays as it is.
      return false
    }
  }

  /**
   * Deletes the Welcome if it is still a seed. It is hashed again where nothing can
   * save to it any more, since an edit landing between a hash and a delete would be
   * lost. A save after the rename makes a new file, which keeps the folder. An edit
   * the rename carried with it goes back, beside any newer file rather than over it.
   */
  private async takeAwayUntouchedWelcome(name: string): Promise<boolean> {
    const welcome = `inbox/${name}`
    const aside = `inbox/.Welcome.settling-${uuid()}`
    await this.fs.rename(welcome, aside)
    const text = await this.fs.readTextOrNull(aside)
    if (text !== null && isUntouchedInboxWelcome(name, await sha256OfText(text))) {
      await this.fs.deleteFile(aside)
      return true
    }
    const taken = (await this.fs.statVerified(welcome)) !== null
    await this.fs.rename(aside, taken ? `inbox/Welcome ${uuid()}.md` : welcome)
    return false
  }

  async rootContentHiddenByInboxMode(): Promise<boolean> {
    const settings = await this.getVaultSettings()
    if (settings.primaryNotesLocation !== 'inbox') return false
    // Not the inference: it trusts an inbox with notes in it, and this banner
    // is the only thing that says notes beside that inbox are out of view.
    return this.rootHoldsLooseContent(await this.fs.readdir(''), settings.systemFolderPaths)
  }

  /** The folder a vault-relative path belongs to, remap-aware. Settings are
   *  cached after the first read, so this is cheap on the hot paths. */
  private async folderOf(rel: string): Promise<NoteFolder | null> {
    return folderForRelativePath(rel, await this.getVaultSettings())
  }

  /** Vault-relative dir for a top folder ('' when inbox lives at root). */
  private async folderRootRel(folder: NoteFolder): Promise<string> {
    const settings = await this.getVaultSettings()
    if (folder === 'inbox' && settings.primaryNotesLocation === 'root') return ''
    return resolveFolderPath(folder, settings.systemFolderPaths)
  }

  // -------------------------------------------------------------------
  // Meta cache
  // -------------------------------------------------------------------

  private async loadMetaCache(): Promise<void> {
    const raw = await this.fs.readTextOrNull(META_CACHE_FILE)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { version: number; entries: Record<string, CachedMeta> }
      if (parsed.version === META_CACHE_VERSION && parsed.entries) {
        this.metaCache = new Map(Object.entries(parsed.entries))
      }
    } catch {
      // corrupt cache is disposable
    }
  }

  private scheduleMetaCachePersist(): void {
    if (!this.metaCacheDirty) return
    if (this.metaCachePersistTimer) return
    this.metaCachePersistTimer = setTimeout(() => {
      this.metaCachePersistTimer = null
      this.metaCacheDirty = false
      const entries = Object.fromEntries(this.metaCache)
      void this.fs
        .writeText(META_CACHE_FILE, JSON.stringify({ version: META_CACHE_VERSION, entries }))
        .catch(() => {})
    }, 2000)
  }

  private invalidateMeta(relPath: string): void {
    this.metaCache.delete(relPath)
    this.taskCache.delete(relPath)
    this.metaCacheDirty = true
  }

  // -------------------------------------------------------------------
  // Note meta
  // -------------------------------------------------------------------

  private async readMeta(
    relPath: string,
    folder: NoteFolder,
    stat: { mtime: number; ctime: number | null; size: number },
    siblingOrder: number
  ): Promise<NoteMeta> {
    const cached = this.metaCache.get(relPath)
    if (cached && cached.mtime === stat.mtime && cached.size === stat.size) {
      return { ...cached.meta, folder, siblingOrder }
    }
    let meta: NoteMeta
    if (isExcalidrawPath(relPath)) {
      meta = {
        path: relPath,
        title: stemName(relPath),
        folder,
        siblingOrder,
        createdAt: stat.ctime || stat.mtime,
        updatedAt: stat.mtime,
        size: stat.size,
        tags: [],
        wikilinks: [],
        assetEmbeds: [],
        hasAttachments: false,
        excerpt: ''
      }
    } else {
      const body = (await this.fs.readTextOrNull(relPath)) ?? ''
      meta = {
        path: relPath,
        title: stemName(relPath),
        folder,
        siblingOrder,
        createdAt: stat.ctime || stat.mtime,
        updatedAt: stat.mtime,
        size: stat.size,
        tags: extractTags(body),
        wikilinks: extractWikilinks(body),
        assetEmbeds: extractAssetEmbeds(body),
        hasAttachments: bodyHasLocalAsset(body),
        excerpt: buildExcerpt(body)
      }
    }
    this.metaCache.set(relPath, { mtime: stat.mtime, size: stat.size, meta })
    this.metaCacheDirty = true
    return meta
  }

  private async metaForPath(relPath: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const folder = await this.folderOf(rel)
    if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
    const stat = await this.fs.statOrNull(rel)
    if (!stat || stat.type !== 'file') throw new Error(`Note not found: ${rel}`)
    const order = await this.siblingOrderOf(rel)
    return await this.readMeta(rel, folder, stat, order)
  }

  private async siblingOrderOf(relPath: string): Promise<number> {
    const dir = dirName(relPath)
    const entries = await this.fs.readdir(dir)
    const name = relPath.slice(dir ? dir.length + 1 : 0)
    const idx = entries.findIndex((e) => e.name === name)
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
  }

  // -------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------

  /** Run one tree walk with listings shared between overlapping walks. */
  private async sharingListings<T>(walk: () => Promise<T>): Promise<T> {
    this.walksInFlight += 1
    if (this.sharedListingsTimer) {
      clearTimeout(this.sharedListingsTimer)
      this.sharedListingsTimer = null
    }
    try {
      return await walk()
    } finally {
      this.walksInFlight -= 1
      if (this.walksInFlight === 0) {
        this.sharedListingsTimer = setTimeout(() => {
          this.sharedListingsTimer = null
          if (this.walksInFlight === 0) this.sharedListings = null
        }, SHARED_LISTING_GRACE_MS)
      }
    }
  }

  private walkReaddir(dirRel: string): Promise<VaultDirEntry[]> {
    const generation = this.fs.writeGeneration
    if (this.sharedListings?.generation !== generation) {
      this.sharedListings = { generation, byDir: new Map() }
    }
    const byDir = this.sharedListings.byDir
    let listing = byDir.get(dirRel)
    if (!listing) {
      listing = this.fs.readdir(dirRel)
      byDir.set(dirRel, listing)
    }
    return listing
  }

  async listNotes(): Promise<NoteMeta[]> {
    return await this.sharingListings(async () => {
      const out: NoteMeta[] = []
      const settings = await this.getVaultSettings()
      const hidden = hiddenPrimaryRootNames(settings.systemFolderPaths)
      for (const folder of FOLDERS) {
        const topRel = await this.folderRootRel(folder)
        if (folder !== 'inbox' || topRel !== '') {
          const stat = await this.fs.statOrNull(topRel)
          if (!stat || stat.type !== 'directory') continue
        }
        await this.walkNotes(topRel, folder, topRel === '' || topRel === undefined, hidden, out)
      }
      this.scheduleMetaCachePersist()
      return out
    })
  }

  private async walkNotes(
    dirRel: string,
    folder: NoteFolder,
    isPrimaryRoot: boolean,
    hidden: Set<string>,
    out: NoteMeta[]
  ): Promise<void> {
    const entries = await this.walkReaddir(dirRel)
    for (const [index, entry] of entries.entries()) {
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (entry.name.startsWith('.')) continue
        if (isPrimaryRoot && hidden.has(entry.name)) continue
        await this.walkNotes(childRel, folder, false, hidden, out)
        continue
      }
      if (!isMarkdownPath(entry.name) && !isExcalidrawPath(entry.name)) continue
      out.push(
        await this.readMeta(
          childRel,
          folder,
          { mtime: entry.mtime, ctime: entry.ctime ?? null, size: entry.size },
          index
        )
      )
    }
  }

  async listFolders(): Promise<FolderEntry[]> {
    return await this.sharingListings(async () => {
      const out: FolderEntry[] = []
      const settings = await this.getVaultSettings()
      const hidden = hiddenPrimaryRootNames(settings.systemFolderPaths)
      for (const folder of FOLDERS) {
        const topRel = await this.folderRootRel(folder)
        const isPrimaryRoot = folder === 'inbox' && topRel === ''
        if (!isPrimaryRoot) {
          const stat = await this.fs.statOrNull(topRel)
          if (!stat || stat.type !== 'directory') continue
        }
        await this.walkFolders(topRel, folder, '', isPrimaryRoot, hidden, out)
      }
      return out
    })
  }

  private async walkFolders(
    dirRel: string,
    folder: NoteFolder,
    subpath: string,
    isPrimaryRoot: boolean,
    hidden: Set<string>,
    out: FolderEntry[]
  ): Promise<void> {
    const entries = await this.walkReaddir(dirRel)
    for (const [index, entry] of entries.entries()) {
      if (entry.type !== 'directory') continue
      if (entry.name.startsWith('.')) continue
      if (isPrimaryRoot && hidden.has(entry.name)) continue
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      const nextSub = subpath ? `${subpath}/${entry.name}` : entry.name
      out.push({ folder, subpath: nextSub, siblingOrder: index })
      if (isFormDirName(entry.name)) continue
      await this.walkFolders(childRel, folder, nextSub, false, hidden, out)
    }
  }

  async listAssets(): Promise<AssetMeta[]> {
    return await this.sharingListings(async () => {
      const out: AssetMeta[] = []
      await this.walkAssets('', true, out)
      out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
      return out
    })
  }

  private async walkAssets(dirRel: string, isRoot: boolean, out: AssetMeta[]): Promise<void> {
    const entries = await this.walkReaddir(dirRel)
    for (const [index, entry] of entries.entries()) {
      if (entry.name.startsWith('.')) continue
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (isRoot && entry.name === INTERNAL_VAULT_DIR) continue
        if (isFormDirName(entry.name)) continue
        await this.walkAssets(childRel, false, out)
        continue
      }
      if (isMarkdownPath(entry.name) || isExcalidrawPath(entry.name)) continue
      if (isDatabaseInternalPath(childRel)) continue
      out.push({
        path: childRel,
        name: entry.name,
        kind: classifyImportedAsset(entry.name),
        siblingOrder: index,
        size: entry.size,
        updatedAt: entry.mtime
      })
    }
  }

  async hasAssetsDir(): Promise<boolean> {
    for (const dir of ATTACHMENTS_DIRS) {
      const stat = await this.fs.statOrNull(dir)
      if (stat?.type === 'directory') return true
    }
    return false
  }

  // -------------------------------------------------------------------
  // Read / write
  // -------------------------------------------------------------------

  async readNote(relPath: string): Promise<NoteContent> {
    const rel = resolveSafeRel(relPath)
    const stat = await this.fs.statOrNull(rel)
    if (!stat || stat.type !== 'file') throw new Error(`Note not found: ${rel}`)
    const body = await this.fs.readText(rel)
    const folder = (await this.folderOf(rel)) ?? 'inbox'
    const order = await this.siblingOrderOf(rel)
    const meta = await this.readMeta(
      rel,
      folder,
      { mtime: stat.mtime, ctime: stat.ctime, size: stat.size },
      order
    )
    return { ...meta, body }
  }

  async writeNote(relPath: string, body: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    await this.fs.writeText(rel, body)
    this.invalidateMeta(rel)
    const folder = (await this.folderOf(rel)) ?? 'inbox'
    const isDb = isDatabaseInternalPath(rel)
    emitVaultChange({ kind: 'change', path: rel, folder, scope: isDb ? 'database' : 'content' })
    const stat = await this.fs.statOrNull(rel)
    const order = await this.siblingOrderOf(rel)
    return await this.readMeta(
      rel,
      folder,
      { mtime: stat?.mtime ?? Date.now(), ctime: stat?.ctime ?? null, size: stat?.size ?? body.length },
      order
    )
  }

  async appendToNote(relPath: string, body: string, position: 'start' | 'end'): Promise<NoteMeta> {
    const current = await this.readNote(relPath)
    const trimmed = body.replace(/\s+$/u, '')
    if (!trimmed) return current
    const next =
      position === 'end'
        ? `${current.body}${current.body.endsWith('\n') ? '' : '\n'}\n${trimmed}\n`
        : `${trimmed}\n\n${current.body}`
    return await this.writeNote(relPath, next)
  }

  private async uniqueTitle(dirRel: string, baseTitle: string, ext = '.md'): Promise<string> {
    let candidate = baseTitle
    let n = 1
    while (await this.fs.exists(joinPath(dirRel, `${candidate}${ext}`))) {
      n += 1
      candidate = `${baseTitle} ${n}`
    }
    return candidate
  }

  private async uniqueFilename(dirRel: string, filename: string): Promise<string> {
    const ext = extName(filename)
    const base = ext ? filename.slice(0, -ext.length) : filename
    let candidate = filename
    let n = 1
    while (await this.fs.exists(joinPath(dirRel, candidate))) {
      n += 1
      candidate = `${base} ${n}${ext}`
    }
    return candidate
  }

  async createNote(folder: NoteFolder, title?: string, subpath = ''): Promise<NoteMeta> {
    const base = sanitizeNoteTitle(title)
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    const topRel = await this.folderRootRel(folder)
    const dir = clean ? resolveSafeRel(joinPath(topRel, clean)) : topRel
    if (dir) await this.fs.mkdir(dir)
    const finalTitle = await this.uniqueTitle(dir, base)
    const rel = joinPath(dir, `${finalTitle}.md`)
    await this.removeOrphanAgentEdit(rel)
    await this.fs.writeText(rel, `# ${finalTitle}\n\n`)
    emitVaultChange({ kind: 'add', path: rel, folder, scope: 'content' })
    return await this.metaForPath(rel)
  }

  async createExcalidraw(folder: NoteFolder, subpath = '', title?: string): Promise<NoteMeta> {
    const base = title ? sanitizeNoteTitle(title) : 'Untitled drawing'
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    const topRel = await this.folderRootRel(folder)
    const dir = clean ? resolveSafeRel(joinPath(topRel, clean)) : topRel
    if (dir) await this.fs.mkdir(dir)
    const finalTitle = await this.uniqueTitle(dir, base, '.excalidraw')
    const rel = joinPath(dir, `${finalTitle}.excalidraw`)
    await this.removeOrphanAgentEdit(rel)
    await this.fs.writeText(rel, JSON.stringify(emptyExcalidrawDocument(), null, 2))
    emitVaultChange({ kind: 'add', path: rel, folder, scope: 'content' })
    return await this.metaForPath(rel)
  }

  private relocationIO(): VaultRelocationIO {
    return {
      stat: path => this.fs.statVerified(path),
      mkdir: path => this.fs.mkdir(path),
      rename: (from, to) => this.fs.rename(from, to)
    }
  }

  /**
   * Move a note with its comments, its creation date and an assistant's
   * unreviewed edit record, as desktop's note-sidecars.ts `relocateNote` does;
   * a sidecar the note lacks is not moved. A creation date or an edit record
   * already at a destination with no note beside it belongs to nobody (its
   * note left outside ZenNotes) and is discarded rather than inherited
   * (ZenNotes#839). Leftover comments there are another note's discussion:
   * taking it over and deleting it are both wrong, so the move is refused.
   */
  private async relocateNote(oldPath: string, newPath: string): Promise<void> {
    const comments = this.commentsPathFor(newPath)
    const metadata = this.metadataPathFor(newPath)
    const agentEdit = this.agentEditPathFor(newPath)
    if (await this.fs.statVerified(newPath) === null) {
      if (await this.fs.statVerified(comments) !== null) throw new Error(leftoverCommentsMessage(newPath))
      if (await this.fs.statVerified(metadata) === 'file') await this.fs.deleteFile(metadata)
      if (await this.fs.statVerified(agentEdit) === 'file') await this.fs.deleteFile(agentEdit)
    }
    await relocateVaultEntries(this.relocationIO(), [
      { from: oldPath, to: newPath, required: true },
      { from: this.commentsPathFor(oldPath), to: comments },
      { from: this.metadataPathFor(oldPath), to: metadata },
      { from: this.agentEditPathFor(oldPath), to: agentEdit }
    ])
    this.invalidateMeta(oldPath)
  }

  /** Detach the content and its sidecar trees (comments, creation dates,
   *  assistant edit records) before cleanup so a failed move can restore the
   *  original. A deleted note has nothing left to review. */
  private async detachContent(
    path: string,
    comments: string,
    metadata: string,
    agentEdits: string,
    required = true
  ): Promise<void> {
    const temporary = `${INTERNAL_VAULT_DIR}/delete-${uuid()}`
    const moves: VaultRelocation[] = [
      { from: path, to: `${temporary}/content`, required },
      { from: comments, to: `${temporary}/comments` },
      { from: metadata, to: `${temporary}/metadata` },
      { from: agentEdits, to: `${temporary}/agent-edits` }
    ]
    await relocateVaultEntries(this.relocationIO(), moves)
    try {
      if (await this.fs.statVerified(temporary) !== null) await this.fs.rmdir(temporary)
    } catch (error) {
      console.warn('Detached deleted content retained for cleanup', temporary, error)
    }
  }

  async renameNote(relPath: string, nextTitle: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const folder = await this.folderOf(rel)
    if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
    const dir = dirName(rel)
    const trimmed = sanitizeNoteTitle(nextTitle)
    const ext = isExcalidrawPath(rel) ? '.excalidraw' : '.md'
    const target = joinPath(dir, `${trimmed}${ext}`)
    if (target === rel) return await this.metaForPath(rel)
    if (await this.fs.exists(target)) {
      throw new Error(`A note named "${trimmed}" already exists in ${folder}`)
    }
    // Snapshot for inbound wikilink rewriting before the rename lands.
    const preNotes = await this.listNotes()
    await this.relocateNote(rel, target)
    emitVaultChange({ kind: 'unlink', path: rel, folder, scope: 'content' })
    emitVaultChange({ kind: 'add', path: target, folder, scope: 'content' })
    await this.updateInboundWikilinks(preNotes, rel, trimmed)
    return await this.metaForPath(target)
  }

  private async updateInboundWikilinks(
    preNotes: NoteMeta[],
    oldPath: string,
    newTitle: string
  ): Promise<void> {
    const refs: RenameNoteRef[] = preNotes.map((n) => ({
      path: n.path,
      title: n.title,
      folder: n.folder
    }))
    const oldTitle = stemName(oldPath)
    for (const note of preNotes) {
      if (note.folder === 'trash') continue
      if (note.path === oldPath) continue
      if (!note.wikilinks.length) continue
      const mightLink = note.wikilinks.some((target) => {
        const t = target.toLowerCase()
        return (
          t === oldTitle.toLowerCase() ||
          t.endsWith(`/${oldTitle.toLowerCase()}`) ||
          t.replace(/\.md$/i, '') === oldPath.replace(/\.md$/i, '').toLowerCase() ||
          oldPath.toLowerCase().endsWith(`${t.replace(/\.md$/i, '')}.md`)
        )
      })
      if (!mightLink) continue
      const body = await this.fs.readTextOrNull(note.path)
      if (body === null) continue
      const { body: nextBody, changed } = rewriteWikilinksForRename(body, refs, oldPath, newTitle)
      if (changed > 0) {
        await this.fs.writeText(note.path, nextBody)
        this.invalidateMeta(note.path)
        emitVaultChange({ kind: 'change', path: note.path, folder: note.folder, scope: 'content' })
      }
    }
  }

  private async folderSubpathOf(rel: string): Promise<string> {
    const folder = await this.folderOf(rel)
    if (!folder) return ''
    const topRel = await this.folderRootRel(folder)
    const dir = dirName(rel)
    if (!topRel) return dir
    if (dir === topRel) return ''
    return dir.startsWith(`${topRel}/`) ? dir.slice(topRel.length + 1) : ''
  }

  private async moveBetweenFolders(relPath: string, target: NoteFolder): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const sourceFolder = (await this.folderOf(rel)) ?? 'inbox'
    const filename = rel.slice(dirName(rel) ? dirName(rel).length + 1 : 0)
    const subpath = await this.folderSubpathOf(rel)
    const targetRoot = await this.folderRootRel(target)
    const destDir = subpath ? resolveSafeRel(joinPath(targetRoot, subpath)) : targetRoot
    if (destDir) await this.fs.mkdir(destDir)
    const ext = isExcalidrawPath(filename) ? '.excalidraw' : '.md'
    const baseTitle = stemName(filename)
    const finalTitle = await this.uniqueTitle(destDir, baseTitle, ext)
    const destRel = joinPath(destDir, `${finalTitle}${ext}`)
    await this.relocateNote(rel, destRel)
    emitVaultChange({ kind: 'unlink', path: rel, folder: sourceFolder, scope: 'content' })
    emitVaultChange({ kind: 'add', path: destRel, folder: target, scope: 'content' })
    return await this.metaForPath(destRel)
  }

  moveToTrash(relPath: string): Promise<NoteMeta> {
    return this.moveBetweenFolders(relPath, 'trash')
  }
  restoreFromTrash(relPath: string): Promise<NoteMeta> {
    return this.moveBetweenFolders(relPath, 'inbox')
  }
  archiveNote(relPath: string): Promise<NoteMeta> {
    return this.moveBetweenFolders(relPath, 'archive')
  }
  unarchiveNote(relPath: string): Promise<NoteMeta> {
    return this.moveBetweenFolders(relPath, 'inbox')
  }

  async emptyTrash(): Promise<void> {
    const trashDir = await this.folderRootRel('trash')
    await this.detachContent(
      trashDir,
      `${INTERNAL_VAULT_DIR}/${NOTE_COMMENTS_DIR}/${trashDir}`,
      `${INTERNAL_VAULT_DIR}/${NOTE_METADATA_DIR}/${trashDir}`,
      `${INTERNAL_VAULT_DIR}/${AGENT_EDITS_DIR}/${trashDir}`,
      false
    )
    for (const key of [...this.metaCache.keys()]) {
      if (key.startsWith(`${trashDir}/`)) this.invalidateMeta(key)
    }
    emitVaultChange({ kind: 'unlink', path: trashDir, folder: 'trash', scope: 'folder' })
  }

  async deleteNote(relPath: string): Promise<void> {
    const rel = resolveSafeRel(relPath)
    const folder = (await this.folderOf(rel)) ?? 'trash'
    await this.detachContent(rel, this.commentsPathFor(rel), this.metadataPathFor(rel), this.agentEditPathFor(rel))
    this.invalidateMeta(rel)
    emitVaultChange({ kind: 'unlink', path: rel, folder, scope: 'content' })
  }

  async duplicateNote(relPath: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const folder = (await this.folderOf(rel)) ?? 'inbox'
    const dir = dirName(rel)
    const ext = isExcalidrawPath(rel) ? '.excalidraw' : '.md'
    const copyTitle = await this.uniqueTitle(dir, `${stemName(rel)} copy`, ext)
    const destRel = joinPath(dir, `${copyTitle}${ext}`)
    const body = await this.fs.readText(rel)
    await this.removeOrphanAgentEdit(destRel)
    await this.fs.writeText(destRel, body)
    const comments = await this.readNoteComments(rel)
    if (comments.length > 0) {
      const now = Date.now()
      await this.writeCommentsFile(
        destRel,
        comments.map((c) => ({ ...c, id: uuid(), notePath: destRel, createdAt: now, updatedAt: now }))
      )
    }
    emitVaultChange({ kind: 'add', path: destRel, folder, scope: 'content' })
    return await this.metaForPath(destRel)
  }

  async moveNote(relPath: string, targetFolder: NoteFolder, targetSubpath: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const sourceFolder = (await this.folderOf(rel)) ?? 'inbox'
    const filename = rel.slice(dirName(rel) ? dirName(rel).length + 1 : 0)
    const targetRoot = await this.folderRootRel(targetFolder)
    const clean = (targetSubpath ?? '').replace(/^\/+|\/+$/g, '')
    const destDir = clean ? resolveSafeRel(joinPath(targetRoot, clean)) : targetRoot
    if (destDir) await this.fs.mkdir(destDir)
    const ext = extName(filename)
    const baseTitle = stemName(filename)
    const destRel = joinPath(
      destDir,
      `${await this.uniqueTitle(destDir, baseTitle, ext || '.md')}${ext || '.md'}`
    )
    if (destRel === rel) return await this.metaForPath(rel)
    await this.relocateNote(rel, destRel)
    emitVaultChange({ kind: 'unlink', path: rel, folder: sourceFolder, scope: 'content' })
    emitVaultChange({ kind: 'add', path: destRel, folder: targetFolder, scope: 'content' })
    return await this.metaForPath(destRel)
  }

  // -------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------

  async createFolder(folder: NoteFolder, subpath: string): Promise<void> {
    const topRel = await this.folderRootRel(folder)
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    if (!clean) return
    await this.fs.mkdir(resolveSafeRel(joinPath(topRel, clean)))
    emitVaultChange({ kind: 'add', path: joinPath(topRel, clean), folder, scope: 'folder' })
  }

  async renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string> {
    const topRel = await this.folderRootRel(folder)
    const oldClean = oldSubpath.replace(/^\/+|\/+$/g, '')
    const newClean = newSubpath.replace(/^\/+|\/+$/g, '')
    if (!oldClean || !newClean) throw new Error('Folder path required')
    if (newClean === oldClean) return oldClean
    if (`${newClean}/`.startsWith(`${oldClean}/`)) {
      throw new Error('Cannot move a folder into itself')
    }
    const oldRel = resolveSafeRel(joinPath(topRel, oldClean))
    const newRel = resolveSafeRel(joinPath(topRel, newClean))
    if (await this.fs.exists(newRel)) {
      throw new Error(`A folder named "${newClean}" already exists`)
    }
    const parent = dirName(newRel)
    if (parent) await this.fs.mkdir(parent)
    // Re-key folder icons/colors + drop stale meta cache entries under the old path.
    const settings = await this.getVaultSettings()
    const rekey = (map: Record<string, string>): Record<string, string> => {
      const out: Record<string, string> = {}
      const oldKey = `${folder}:${oldClean}`
      const newKey = `${folder}:${newClean}`
      for (const [k, v] of Object.entries(map)) {
        if (k === oldKey) out[newKey] = v
        else if (k.startsWith(`${oldKey}/`)) out[`${newKey}${k.slice(oldKey.length)}`] = v
        else out[k] = v
      }
      return out
    }
    const settingsPath = `${INTERNAL_VAULT_DIR}/vault.json`
    const hadSettings = await this.fs.statVerified(settingsPath) !== null
    const originalSettings = hadSettings ? await this.fs.readText(settingsPath) : null
    // A creation-date tree already at the destination refuses the rename, as
    // desktop's relocateFolderTrees does: only a single note's stale date is
    // discarded (relocateNote).
    await relocateVaultEntries(this.relocationIO(), [
      { from: oldRel, to: newRel, required: true },
      { from: `${INTERNAL_VAULT_DIR}/${NOTE_COMMENTS_DIR}/${oldRel}`,
        to: `${INTERNAL_VAULT_DIR}/${NOTE_COMMENTS_DIR}/${newRel}` },
      { from: `${INTERNAL_VAULT_DIR}/${NOTE_METADATA_DIR}/${oldRel}`,
        to: `${INTERNAL_VAULT_DIR}/${NOTE_METADATA_DIR}/${newRel}` },
      { from: `${INTERNAL_VAULT_DIR}/${AGENT_EDITS_DIR}/${oldRel}`,
        to: `${INTERNAL_VAULT_DIR}/${AGENT_EDITS_DIR}/${newRel}` }
    ], async () => {
      try {
      await this.setVaultSettings({
      ...settings,
      folderIcons: rekey(settings.folderIcons as Record<string, string>) as VaultSettings['folderIcons'],
      folderColors: rekey(settings.folderColors as Record<string, string>) as VaultSettings['folderColors'],
      // The Tasks folder lists name on-disk paths, so they follow the folder
      // too, as on desktop: a renamed Task folder (#962) left behind would
      // match nothing and empty Tasks.
      tasks: rewriteTasksFoldersForRename(settings.tasks, oldRel, newRel),
      // So does the template folder (#1024), or its templates would turn back
      // into notes and their checkboxes into tasks.
      templates: rewriteTemplateFolderForRename(settings.templates, oldRel, newRel)
      })
      } catch (error) {
        try {
          if (originalSettings !== null) await this.fs.writeText(settingsPath, originalSettings)
          else if (await this.fs.statVerified(settingsPath) !== null) await this.fs.deleteFile(settingsPath)
          this.settingsCache = settings
        } catch (rollback) {
          throw new AggregateError([error, rollback], 'FOLDER_STATE_UNCERTAIN: Could not restore vault settings')
        }
        throw error
      }
    })
    for (const key of [...this.metaCache.keys()]) {
      if (key.startsWith(`${oldRel}/`)) this.invalidateMeta(key)
    }
    emitVaultChange({ kind: 'unlink', path: oldRel, folder, scope: 'folder' })
    emitVaultChange({ kind: 'add', path: newRel, folder, scope: 'folder' })
    return newClean
  }

  async deleteFolder(folder: NoteFolder, subpath: string): Promise<void> {
    const topRel = await this.folderRootRel(folder)
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    if (!clean) return
    const rel = resolveSafeRel(joinPath(topRel, clean))
    await this.detachContent(
      rel,
      `${INTERNAL_VAULT_DIR}/${NOTE_COMMENTS_DIR}/${rel}`,
      `${INTERNAL_VAULT_DIR}/${NOTE_METADATA_DIR}/${rel}`,
      `${INTERNAL_VAULT_DIR}/${AGENT_EDITS_DIR}/${rel}`
    )
    for (const key of [...this.metaCache.keys()]) {
      if (key.startsWith(`${rel}/`)) this.invalidateMeta(key)
    }
    emitVaultChange({ kind: 'unlink', path: rel, folder, scope: 'folder' })
  }

  async duplicateFolder(folder: NoteFolder, subpath: string): Promise<string> {
    const topRel = await this.folderRootRel(folder)
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    if (!clean) throw new Error('Folder path required')
    const srcRel = resolveSafeRel(joinPath(topRel, clean))
    const parentSub = dirName(clean)
    const base = `${clean.split('/').pop()} copy`
    let candidate = base
    let n = 1
    while (await this.fs.exists(joinPath(topRel, parentSub, candidate))) {
      n += 1
      candidate = `${base} ${n}`
    }
    const destSub = parentSub ? `${parentSub}/${candidate}` : candidate
    await this.fs.copy(srcRel, resolveSafeRel(joinPath(topRel, destSub)))
    emitVaultChange({ kind: 'add', path: joinPath(topRel, destSub), folder, scope: 'folder' })
    return destSub
  }

  // -------------------------------------------------------------------
  // Comments: .zennotes/comments/<rel>.comments.json
  // -------------------------------------------------------------------

  private commentsPathFor(rel: string): string {
    return `${INTERNAL_VAULT_DIR}/${NOTE_COMMENTS_DIR}/${rel}${NOTE_COMMENTS_SUFFIX}`
  }

  /** `.zennotes/note-metadata/<rel>.metadata.json`, the creation date desktop
   *  keeps for the note (see NOTE_METADATA_DIR). */
  private metadataPathFor(rel: string): string {
    return `${INTERNAL_VAULT_DIR}/${NOTE_METADATA_DIR}/${rel}${NOTE_METADATA_SUFFIX}`
  }

  /** `.zennotes/agent-edits/<rel>.json`, what the note said before an
   *  assistant edited it through MCP, kept until the edit is reviewed in the
   *  desktop app (shared-domain agent-edits). This app does not review edits,
   *  but the record travels with its note and goes when the note does, so a
   *  move here leaves the review waiting on the note in the desktop app. */
  private agentEditPathFor(rel: string): string {
    return agentEditSidecarPath(INTERNAL_VAULT_DIR, rel)
  }

  /** A record with no note beside it belongs to nobody (its note left outside
   *  ZenNotes); a new note at that path must not inherit its review. */
  private async removeOrphanAgentEdit(rel: string): Promise<void> {
    const path = this.agentEditPathFor(rel)
    if (await this.fs.statVerified(path) === 'file') await this.fs.deleteFile(path)
  }

  async readNoteComments(relPath: string): Promise<NoteComment[]> {
    const rel = resolveSafeRel(relPath)
    const raw = await this.fs.readTextOrNull(this.commentsPathFor(rel))
    if (!raw) return []
    try {
      return normalizeNoteComments(JSON.parse(raw), rel)
    } catch {
      return []
    }
  }

  private async writeCommentsFile(rel: string, comments: NoteComment[]): Promise<void> {
    const path = this.commentsPathFor(rel)
    if (comments.length === 0) {
      await this.fs.deleteFile(path).catch(() => {})
      return
    }
    await this.fs.writeText(path, JSON.stringify({ version: 1, comments }, null, 2))
  }

  async writeNoteComments(relPath: string, inputs: NoteCommentInput[]): Promise<NoteComment[]> {
    const rel = resolveSafeRel(relPath)
    // Desktop's own normalizer (shared since app core 2.46). App-core always
    // hands over the whole list, so the writer must keep the optional `author`
    // and `parentId` a desktop or an assistant wrote, or one comment action on
    // the phone flattens every thread and drops every name in the sidecar.
    const comments = normalizeNoteComments(inputs, rel)
    await this.writeCommentsFile(rel, comments)
    emitVaultChange({
      kind: 'change',
      path: rel,
      folder: (await this.folderOf(rel)) ?? 'inbox',
      scope: 'comments'
    })
    return comments
  }

  // -------------------------------------------------------------------
  // Workspace state
  // -------------------------------------------------------------------

  async readWorkspaceState(): Promise<string | null> {
    return await this.fs.readTextOrNull(`${INTERNAL_VAULT_DIR}/workspace.json`)
  }

  async writeWorkspaceState(json: string): Promise<void> {
    if (typeof json !== 'string') return
    await this.fs.mkdir(INTERNAL_VAULT_DIR)
    await this.fs.writeText(`${INTERNAL_VAULT_DIR}/workspace.json`, json)
  }

  // -------------------------------------------------------------------
  // Search: builtin backend semantics (per line, fuzzy, trash excluded)
  // -------------------------------------------------------------------

  async searchVaultText(query: string, limit = 80): Promise<VaultTextSearchMatch[]> {
    const trimmed = query.trim()
    if (!trimmed) return []
    const candidates: SearchCandidate[] = []
    const settings = await this.getVaultSettings()
    const hidden = hiddenPrimaryRootNames(settings.systemFolderPaths)
    // Template notes (#1024) are placeholders nobody is searching for, so
    // their folder is never walked: desktop leaves them out before ranking so
    // the limit is spent on real notes, and not listing or reading them at
    // all is the cheaper way to get there on a document-provider folder,
    // where every listing and read is a query.
    const templateFolder = resolveTemplateFolder(settings)
    for (const folder of SEARCHABLE_TEXT_FOLDERS) {
      const topRel = await this.folderRootRel(folder)
      const isPrimaryRoot = folder === 'inbox' && topRel === ''
      if (!isPrimaryRoot) {
        if (isPathInTemplateFolder(topRel, templateFolder)) continue
        const stat = await this.fs.statOrNull(topRel)
        if (!stat || stat.type !== 'directory') continue
      }
      await this.collectSearchCandidates(topRel, folder, isPrimaryRoot, hidden, templateFolder, candidates)
    }
    const ranked: { score: number; c: SearchCandidate }[] = []
    for (const c of candidates) {
      const bodyScore = scoreMatch(trimmed, c.lineText)
      if (bodyScore <= 0) continue
      const titleScore = scoreMatch(trimmed, c.title) * 0.18
      const pathScore = scoreMatch(trimmed, c.path) * 0.1
      ranked.push({ score: bodyScore + titleScore + pathScore, c })
    }
    ranked.sort((a, b) => b.score - a.score)
    return ranked.slice(0, limit).map(({ c }) => ({
      path: c.path,
      title: c.title,
      folder: c.folder,
      lineNumber: c.lineNumber,
      offset: Math.min(c.offset + firstMatchColumn(trimmed, c.rawLine), c.offset + c.rawLine.length),
      lineText: c.lineText
    }))
  }

  private async collectSearchCandidates(
    dirRel: string,
    folder: NoteFolder,
    isPrimaryRoot: boolean,
    hidden: Set<string>,
    templateFolder: string | null,
    out: SearchCandidate[]
  ): Promise<void> {
    const entries = await this.fs.readdir(dirRel)
    for (const entry of entries) {
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (isPathInTemplateFolder(childRel, templateFolder)) continue
      if (entry.type === 'directory') {
        if (entry.name.startsWith('.')) continue
        if (isPrimaryRoot && hidden.has(entry.name)) continue
        await this.collectSearchCandidates(childRel, folder, false, hidden, templateFolder, out)
        continue
      }
      if (!isMarkdownPath(entry.name)) continue
      const body = await this.fs.readTextOrNull(childRel)
      if (body === null) continue
      const title = stemName(entry.name)
      let lineOffset = 0
      const lines = body.split('\n')
      for (const [index, rawLine] of lines.entries()) {
        const lineText = collapseSearchLine(rawLine).slice(0, 220)
        if (lineText) {
          out.push({
            path: childRel,
            title,
            folder,
            lineNumber: index + 1,
            offset: lineOffset,
            lineText,
            rawLine
          })
        }
        lineOffset += rawLine.length + 1
      }
    }
  }

  // -------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------

  /** A note's file-task (if its frontmatter tags it `#task`) first, so it
   *  heads the note's group in the Tasks list, then every inline `- [ ]`
   *  checkbox; mirrors desktop `apps/desktop/src/main/tasks.ts`. */
  private parseAllTasks(
    body: string,
    ctx: { path: string; title: string; folder: NoteFolder }
  ): VaultTask[] {
    const fileTask = parseTaskFile(body, ctx)
    const inline = parseTasksFromBody(body, ctx)
    return fileTask ? [fileTask, ...inline] : inline
  }

  /** The vault's Tasks folder lists from vault.json: the folders left out of
   *  Tasks (#458) and the Task folders it is narrowed to (#962), empty
   *  meaning the whole vault, with the template folder (#1024) left out too,
   *  even inside a Task folder: a template's checkboxes are placeholders for
   *  the note it will make. The shared helper desktop main and the Go server
   *  apply, so every scanner agrees. */
  private async tasksFolderLists(): Promise<{ excluded: string[]; included: string[] }> {
    return tasksFolderListsForSettings(await this.getVaultSettings())
  }

  async scanTasks(): Promise<VaultTask[]> {
    // The Tasks folder lists travel in vault.json, so a folder the desktop
    // left out (#458), or the Task folders it narrowed Tasks to (#962), apply
    // here too; the frontmatter `tasks:` opt-out comes free from the shared
    // parsers.
    const { excluded, included } = await this.tasksFolderLists()
    const notes = await this.listNotes()
    const out: VaultTask[] = []
    const scanned = new Set<string>()
    for (const note of notes) {
      if (note.folder === 'trash') continue
      if (isPathExcludedFromTasks(note.path, excluded, included)) continue
      if (!isMarkdownPath(note.path)) continue
      scanned.add(note.path)
      const cached = this.taskCache.get(note.path)
      if (
        cached &&
        cached.mtime === note.updatedAt &&
        cached.size === note.size &&
        cached.title === note.title &&
        cached.folder === note.folder
      ) {
        out.push(...cached.tasks)
        continue
      }
      const body = await this.fs.readTextOrNull(note.path)
      if (body === null) {
        this.taskCache.delete(note.path)
        continue
      }
      const tasks = this.parseAllTasks(body, { path: note.path, title: note.title, folder: note.folder })
      // A listing without a usable stamp cannot vouch for the next read.
      if (Number.isFinite(note.updatedAt) && Number.isFinite(note.size)) {
        this.taskCache.set(note.path, {
          mtime: note.updatedAt,
          size: note.size,
          title: note.title,
          folder: note.folder,
          tasks
        })
      }
      out.push(...tasks)
    }
    for (const path of this.taskCache.keys()) {
      if (!scanned.has(path)) this.taskCache.delete(path)
    }
    return out
  }

  async scanTasksForPath(relPath: string): Promise<VaultTask[]> {
    const rel = resolveSafeRel(relPath)
    const folder = await this.folderOf(rel)
    if (!folder || folder === 'trash') return []
    // Same folder lists the full scan applies (#458, #962), or a single-note
    // rescan would resurrect a left-out folder's tasks on every edit.
    const { excluded, included } = await this.tasksFolderLists()
    if (isPathExcludedFromTasks(rel, excluded, included)) return []
    if (!isMarkdownPath(rel)) return []
    const body = await this.fs.readTextOrNull(rel)
    if (body === null) return []
    return this.parseAllTasks(body, { path: rel, title: stemName(rel), folder })
  }

  // -------------------------------------------------------------------
  // Templates: .zennotes/templates/*.md
  // -------------------------------------------------------------------

  async listTemplates(): Promise<CustomTemplateFile[]> {
    const entries = await this.fs.readdir(TEMPLATES_DIR)
    const out: CustomTemplateFile[] = []
    for (const entry of entries) {
      if (entry.type !== 'file' || !isMarkdownPath(entry.name)) continue
      const sourcePath = `${TEMPLATES_DIR}/${entry.name}`
      const raw = await this.fs.readTextOrNull(sourcePath)
      if (raw !== null) out.push({ sourcePath, raw })
    }
    return out
  }

  async readTemplate(sourcePath: string): Promise<string> {
    const raw = await this.fs.readTextOrNull(resolveSafeRel(sourcePath))
    if (raw === null) throw new Error(`Template not found: ${sourcePath}`)
    return raw
  }

  async writeTemplate(input: WriteTemplateInput): Promise<CustomTemplateFile> {
    await this.fs.mkdir(TEMPLATES_DIR)
    const sourcePath = `${TEMPLATES_DIR}/${input.slug}.md`
    await this.fs.writeText(sourcePath, input.raw)
    if (input.previousSourcePath && input.previousSourcePath !== sourcePath) {
      await this.fs.deleteFile(resolveSafeRel(input.previousSourcePath)).catch(() => {})
    }
    return { sourcePath, raw: input.raw }
  }

  async deleteTemplate(sourcePath: string): Promise<void> {
    await this.fs.deleteFile(resolveSafeRel(sourcePath))
  }

  // -------------------------------------------------------------------
  // Demo tour
  // -------------------------------------------------------------------

  /** First-boot seed for brand-new vaults: one phone-focused welcome note
   *  (the desktop demo tour stays available via its command). */
  async seedWelcomeNote(body: string = WELCOME_NOTE_BODY): Promise<void> {
    await this.ensureVaultLayout()
    await this.fs.writeText(WELCOME_NOTE_PATH, body)
    this.invalidateMeta(WELCOME_NOTE_PATH)
    emitVaultChange({ kind: 'add', path: WELCOME_NOTE_PATH, folder: 'inbox', scope: 'content' })
  }

  /** Tour notes still on disk under their older names (see
   *  currentDemoTourPath), found the way desktop's vault.ts finds them
   *  (olderDemoTourNotePaths). Regenerate and Remove delete what this
   *  returns, so it takes only a file that shared-domain's exact older-name
   *  match maps onto one of the tour's own notes: a folder that happens to
   *  carry such a name is the user's and stays. */
  private async olderDemoTourNotePaths(): Promise<string[]> {
    const current = new Set(DEMO_TOUR_NOTES.map((note) => note.path))
    return (await this.fs.readdir(DEMO_TOUR_DIR))
      .filter((entry) => entry.type === 'file')
      .map((entry) => `${DEMO_TOUR_DIR}/${entry.name}`)
      .filter((rel) => rel !== currentDemoTourPath(rel) && current.has(currentDemoTourPath(rel)))
  }

  async generateDemoTour(): Promise<VaultDemoTourResult> {
    await this.ensureVaultLayout()
    // Regenerating replaces a tour seeded under the older names rather than
    // writing a second copy beside it.
    for (const rel of await this.olderDemoTourNotePaths()) {
      await this.fs.deleteFile(rel).catch(() => {})
      this.invalidateMeta(rel)
    }
    for (const note of DEMO_TOUR_NOTES) {
      const dir = dirName(note.path)
      if (dir) await this.fs.mkdir(dir)
      await this.fs.writeText(note.path, note.body)
      this.invalidateMeta(note.path)
    }
    for (const asset of DEMO_TOUR_ASSETS) {
      const dir = dirName(asset.path)
      if (dir) await this.fs.mkdir(dir)
      await this.fs.writeText(asset.path, asset.body)
    }
    emitVaultChange({ kind: 'add', path: 'inbox/demo', folder: 'inbox', scope: 'content' })
    return {
      notePaths: DEMO_TOUR_NOTES.map((n) => n.path),
      assetPaths: DEMO_TOUR_ASSETS.map((a) => a.path)
    }
  }

  async removeDemoTour(): Promise<VaultDemoTourResult> {
    const notePaths = [
      ...DEMO_TOUR_NOTES.map((note) => note.path),
      ...(await this.olderDemoTourNotePaths())
    ]
    for (const rel of notePaths) {
      await this.fs.deleteFile(rel).catch(() => {})
      this.invalidateMeta(rel)
    }
    for (const asset of DEMO_TOUR_ASSETS) {
      await this.fs.deleteFile(asset.path).catch(() => {})
    }
    // The sample database ships as a folder of its own (`Reading List.base`),
    // which has to go before the tour folder can. rmdir is recursive, so only
    // an empty one goes: record pages someone made in it stay.
    for (const dir of demoTourNestedDirs(DEMO_TOUR_ASSETS.map((asset) => asset.path))) {
      if ((await this.fs.readdir(dir)).length === 0) await this.fs.rmdir(dir).catch(() => {})
    }
    const remaining = await this.fs.readdir('inbox/demo')
    if (remaining.length === 0) await this.fs.rmdir('inbox/demo').catch(() => {})
    emitVaultChange({ kind: 'unlink', path: 'inbox/demo', folder: 'inbox', scope: 'content' })
    return {
      notePaths,
      assetPaths: DEMO_TOUR_ASSETS.map((a) => a.path)
    }
  }

  // -------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------

  async importPastedImage(input: PastedImageInput): Promise<ImportedAsset> {
    const bytes =
      input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data as ArrayBuffer)
    await this.fs.mkdir(ASSETS_DIR)
    const filename = await this.uniqueFilename(
      ASSETS_DIR,
      pastedImageFilename(
        { mimeType: input.mimeType, suggestedName: input.suggestedName },
        new Date()
      )
    )
    const rel = `${ASSETS_DIR}/${filename}`
    await this.fs.writeBase64(rel, bytesToBase64(bytes))
    emitVaultChange({ kind: 'add', path: rel, folder: 'inbox', scope: 'content' })
    return { name: filename, path: rel, markdown: `![[${rel}]]`, kind: 'image' }
  }

  /**
   * An attached file lands in `assets/`, the same folder a pasted image goes to
   * (`importPastedImage`) and the same one the cloud vault uploads to, linked
   * by vault-relative path.
   *
   * It used to be written to the vault ROOT and linked with a hand-built
   * `'../'.repeat(depth)` path, so attaching a file scattered images among the
   * notes and produced `![name](<../name.jpg>)` (reported on Discord by xenin
   * against Android; this app carried the identical code). Desktop had the same
   * bug and fixed it in ZenNotes#377, and the port here was missed.
   */
  async importDroppedFile(_notePath: string, file: File): Promise<ImportedAsset> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await this.fs.mkdir(ASSETS_DIR)
    const filename = await this.uniqueFilename(ASSETS_DIR, importedAssetFilename(file.name))
    const rel = importedAssetRelPath(filename)
    await this.fs.writeBase64(rel, bytesToBase64(bytes))
    const kind = classifyImportedAsset(filename)
    emitVaultChange({ kind: 'add', path: rel, folder: 'inbox', scope: 'content' })
    return { name: filename, path: rel, markdown: importedAssetMarkdown(rel, filename, kind), kind }
  }

  async renameAsset(relPath: string, nextName: string): Promise<AssetMeta> {
    const rel = resolveSafeRel(relPath)
    const dir = dirName(rel)
    const clean = nextName.replace(/[\\/:*?"<>|]/g, '-').trim()
    if (!clean) throw new Error('Asset name required')
    const target = joinPath(dir, clean)
    if (target !== rel && (await this.fs.exists(target))) {
      throw new Error(`A file named "${clean}" already exists`)
    }
    await this.fs.rename(rel, target)
    emitVaultChange({ kind: 'unlink', path: rel, folder: 'inbox', scope: 'content' })
    emitVaultChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    return await this.assetMetaFor(target)
  }

  async moveAsset(relPath: string, targetDir: string): Promise<AssetMeta> {
    const rel = resolveSafeRel(relPath)
    const cleanDir = targetDir ? resolveSafeRel(targetDir) : ASSETS_DIR
    await this.fs.mkdir(cleanDir)
    const name = rel.split('/').pop() as string
    const finalName = await this.uniqueFilename(cleanDir, name)
    const target = joinPath(cleanDir, finalName)
    await this.fs.rename(rel, target)
    emitVaultChange({ kind: 'unlink', path: rel, folder: 'inbox', scope: 'content' })
    emitVaultChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    return await this.assetMetaFor(target)
  }

  async duplicateAsset(relPath: string): Promise<AssetMeta> {
    const rel = resolveSafeRel(relPath)
    const dir = dirName(rel)
    const ext = extName(rel)
    const base = stemName(rel)
    const finalName = await this.uniqueFilename(dir, `${base} copy${ext}`)
    const target = joinPath(dir, finalName)
    await this.fs.copy(rel, target)
    emitVaultChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    return await this.assetMetaFor(target)
  }

  async deleteAsset(relPath: string): Promise<DeletedAsset> {
    const rel = resolveSafeRel(relPath)
    const name = rel.split('/').pop() as string
    const undoToken = uuid()
    const trashDir = `${INTERNAL_VAULT_DIR}/deleted-assets/${undoToken}`
    await this.fs.mkdir(trashDir)
    const deletedAt = new Date().toISOString()
    // Persist the original location so the asset can be listed + restored
    // from the Trash view even after a restart (desktop 2.11 parity).
    //
    // Metadata first, move last (upstream 11822cc). listDeletedAssets skips a
    // token dir carrying no metadata, so the old order (move, then write)
    // stranded the asset in a directory the Trash view ignores whenever the
    // write failed: gone from the vault, invisible in the app, and on iOS
    // there is no Finder to go dig it out. A failure now always leaves the
    // asset exactly where it was.
    try {
      await this.fs.writeText(
        `${trashDir}/${DELETED_ASSET_META}`,
        JSON.stringify({ path: rel, name, deletedAt }, null, 2)
      )
      await this.fs.rename(rel, `${trashDir}/${name}`)
    } catch (err) {
      await this.fs.rmdir(trashDir).catch(() => {})
      throw err
    }
    emitVaultChange({ kind: 'unlink', path: rel, folder: 'inbox', scope: 'content' })
    return { path: rel, name, undoToken, deletedAt }
  }

  /** Enumerate restorable assets in the deleted-assets store, newest first.
   *  Entries without metadata (pre-2.11 deletes) are skipped. */
  async listDeletedAssets(): Promise<DeletedAsset[]> {
    let tokens: Array<{ name: string; type: string }>
    try {
      tokens = await this.fs.readdir(`${INTERNAL_VAULT_DIR}/deleted-assets`)
    } catch {
      return []
    }
    const out: DeletedAsset[] = []
    for (const entry of tokens) {
      if (entry.type !== 'directory') continue
      const undoToken = entry.name
      try {
        const raw = await this.fs.readTextOrNull(
          `${INTERNAL_VAULT_DIR}/deleted-assets/${undoToken}/${DELETED_ASSET_META}`
        )
        if (raw === null) continue
        const meta = JSON.parse(raw) as { path?: unknown; name?: unknown; deletedAt?: unknown }
        if (typeof meta.path !== 'string' || typeof meta.name !== 'string') continue
        // The asset file itself must still be present to be restorable.
        const files = await this.fs.readdir(`${INTERNAL_VAULT_DIR}/deleted-assets/${undoToken}`)
        if (!files.some((f) => f.name === meta.name)) continue
        out.push({
          path: meta.path,
          name: meta.name,
          undoToken,
          deletedAt: typeof meta.deletedAt === 'string' ? meta.deletedAt : undefined
        })
      } catch {
        // Missing/invalid metadata: not listable from the Trash view.
      }
    }
    out.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
    return out
  }

  /** Permanently delete one asset from the deleted-assets store. */
  async purgeDeletedAsset(undoToken: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(undoToken)) throw new Error('Invalid restore token')
    await this.fs.rmdir(`${INTERNAL_VAULT_DIR}/deleted-assets/${undoToken}`).catch(() => {})
  }

  /** Permanently delete every asset in the deleted-assets store. */
  async emptyDeletedAssets(): Promise<void> {
    await this.fs.rmdir(`${INTERNAL_VAULT_DIR}/deleted-assets`).catch(() => {})
  }

  async restoreDeletedAsset(asset: DeletedAsset): Promise<AssetMeta> {
    if (!/^[0-9a-f-]{36}$/i.test(asset.undoToken)) throw new Error('Invalid restore token')
    const trashDir = `${INTERNAL_VAULT_DIR}/deleted-assets/${asset.undoToken}`
    // Only the token comes from the caller; the stored metadata decides what
    // is restored and where (upstream 11822cc). Trusting a caller-supplied
    // name once let a restore that named the metadata file move THAT into the
    // vault and then destroy the real bytes with the token-dir cleanup below.
    // The store is one on-disk contract shared with desktop and the server,
    // so mobile reads it the same defensive way.
    const raw = await this.fs.readTextOrNull(`${trashDir}/${DELETED_ASSET_META}`)
    let stored: { path: string; name: string }
    try {
      const parsed = JSON.parse(raw ?? '') as { path?: unknown; name?: unknown }
      if (typeof parsed.path !== 'string' || typeof parsed.name !== 'string') throw new Error()
      stored = { path: parsed.path, name: parsed.name }
    } catch {
      throw new Error('This deleted asset can no longer be restored.')
    }
    if (stored.name === DELETED_ASSET_META || /[\\/]/.test(stored.name) || !stored.name.trim()) {
      throw new Error('This deleted asset can no longer be restored.')
    }
    const source = `${trashDir}/${stored.name}`
    const dir = dirName(resolveSafeRel(stored.path))
    if (dir) await this.fs.mkdir(dir)
    const finalName = await this.uniqueFilename(dir, stored.name)
    const target = joinPath(dir, finalName)
    await this.fs.rename(source, target)
    await this.fs.rmdir(trashDir).catch(() => {})
    emitVaultChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    return await this.assetMetaFor(target)
  }

  private async assetMetaFor(rel: string): Promise<AssetMeta> {
    const stat = await this.fs.statOrNull(rel)
    if (!stat) throw new Error(`Asset not found: ${rel}`)
    const name = rel.split('/').pop() as string
    return {
      path: rel,
      name,
      kind: classifyImportedAsset(name),
      siblingOrder: await this.siblingOrderOf(rel),
      size: stat.size,
      updatedAt: stat.mtime
    }
  }

  /** Foreground rescan: re-stat the tree, emit change events for anything new. */
  async rescan(): Promise<void> {
    // Vault settings may have changed externally (desktop edit synced via
    // iCloud): drop the cache so the next read sees the file.
    this.settingsCache = null
    // Folders copied in while the app was away can leave a seeded inbox behind.
    await this.settleSeededInbox()
    const before = new Map<string, CachedMeta>(this.metaCache)
    const notes = await this.listNotes()
    const seen = new Set(notes.map((n) => n.path))
    for (const [path] of before) {
      if (!seen.has(path)) this.invalidateMeta(path)
    }
    // One 'resync' rather than a per-note event stream. A foreground IS the
    // change-feed gap that scope names, and mobile lives in it permanently:
    // there is no watch socket here (the auth header cannot ride a WebView
    // WebSocket), so everything that happened while backgrounded, edits made
    // on the Mac through iCloud, or by another client against the server,
    // arrives unannounced. The diff this replaced only ever spoke for notes,
    // and always as scope 'content': vault.json, assets, comment threads and
    // Excalidraw previews were never refreshed at all, and an edited `.base`
    // was mis-scoped so its grid kept the pre-background rows. app-core's
    // handler re-pulls every one of those, re-reads open notes that carry no
    // unsaved edits, and closes tabs for notes deleted while we were away.
    emitVaultChange({ kind: 'change', path: '', folder: 'inbox', scope: 'resync' })
  }
}

// Pasted image naming lives in @zennotes/shared-domain/pasted-image (upstream 80303bb), which
// is where the local copy that used to sit here went: the scrub of the
// characters that break the `![[...]]` embed a paste writes has to agree
// across desktop, web, the server and here, and one module is how it stays
// agreeing.

