import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CloudSyncChange,
  CloudSyncContent,
  CloudSyncLocalConflict
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
  CLOUD_SYNC_VAULT_SETTINGS_PATH,
  cloudSyncConflictCopyPath,
  isCloudSyncVaultSettingsPath,
  normalizeCloudSyncPath,
  shouldSyncVaultPath,
  shouldTraverseCloudSyncDirectory
} from '@zennotes/shared-domain/cloud-sync'
import {
  CloudSyncCoordinator,
  type CloudSyncRemote,
  type CloudSyncRepository,
  type CloudSyncStateStore
} from '@zennotes/shared-domain/cloud-sync-coordinator'
import type {
  CloudSyncLocalItem,
  CloudSyncState,
  CloudSyncTrackedItem
} from '@zennotes/shared-domain/cloud-sync-engine'
import {
  CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES,
  rememberCloudSyncUploadSource
} from './cloud-sync-upload-source'

const TEXT_EXTENSIONS = new Set([
  '.base',
  '.css',
  '.csv',
  '.excalidraw',
  '.htm',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
])

const MEDIA_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.toml': 'application/toml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml'
}

export class CloudSyncLocalEditConflictError extends Error {
  constructor(readonly relPath: string) {
    super(`Cloud sync stopped because ${relPath} has unsynced local edits`)
    this.name = 'CloudSyncLocalEditConflictError'
  }
}

export class DesktopCloudSyncRepository implements CloudSyncRepository {
  constructor(private readonly root: string) {}

  async scan(): Promise<CloudSyncLocalItem[]> {
    const items: CloudSyncLocalItem[] = []
    await this.walk(this.root, '', items)
    return items.sort((left, right) => left.path.localeCompare(right.path))
  }

  async pendingConflictPaths(): Promise<string[]> {
    return (await exists(this.resolve(CLOUD_SYNC_SETTINGS_CONFLICT_PATH)))
      ? [CLOUD_SYNC_VAULT_SETTINGS_PATH]
      : []
  }

  async apply(
    change: CloudSyncChange,
    previous: CloudSyncTrackedItem | undefined
  ): Promise<CloudSyncLocalConflict | void> {
    const affectedPaths = [change.path, change.previous_path, previous?.path].filter(
      (path): path is string => typeof path === 'string'
    )
    if (affectedPaths.some((path) => !shouldSyncVaultPath(path))) return

    if (change.type === 'upsert') {
      if (!change.content) throw new Error(`Upsert change ${change.sequence} did not include content`)
      const atTarget = await this.readIfExists(change.path)
      // Already byte-for-byte what the change carries. There is nothing to
      // write and nothing to conflict over, so adopt the file and move on.
      // Without this, a file both sides already agree on stopped sync dead.
      if (atTarget && sha256(atTarget) === change.content.sha256) return

      const guardPath = previous?.path ?? change.path
      const unvouched = await this.firstUnvouchedPath(
        guardPath === change.path ? [change.path] : [guardPath, change.path],
        previous
      )
      if (unvouched) return await this.keepBoth(change.path, decodeContent(change.content))

      await this.write(change.path, decodeContent(change.content))
      return
    }

    const previousPath = previous?.path ?? change.previous_path ?? change.path
    const unvouched = await this.firstUnvouchedPath([previousPath], previous)
    // A delete or a move carries no content to park, so keeping the local file
    // where it is IS the preserved version. The next push re-uploads it.
    if (unvouched) return localConflict(unvouched, null)

    if (change.type === 'delete') {
      await fs.rm(this.resolve(previousPath), { force: true })
      return
    }

    const source = this.resolve(previousPath)
    const destination = this.resolve(change.path)
    if (source === destination) return
    if (!(await exists(source))) {
      // Nothing here to move. Either the move already landed, or the file is
      // gone locally and the next scan reconciles it.
      return
    }
    await fs.mkdir(path.dirname(destination), { recursive: true })

    if (await exists(destination)) return localConflict(change.path, null)
    await fs.rename(source, destination)
  }

  private async walk(
    absoluteDirectory: string,
    relativeDirectory: string,
    items: CloudSyncLocalItem[]
  ): Promise<void> {
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = path.join(absoluteDirectory, entry.name)

      if (entry.isDirectory() && shouldTraverseCloudSyncDirectory(relPath)) {
        await this.walk(absolutePath, relPath, items)
      } else if (entry.isFile() && shouldSyncVaultPath(relPath)) {
        const content = await encodeFileContent(relPath, absolutePath)
        items.push({
          path: normalizeCloudSyncPath(relPath),
          kind: content.encoding === 'utf8' ? 'text' : 'binary',
          content
        })
      }
    }
  }

  private resolve(relPath: string): string {
    const normalized = normalizeCloudSyncPath(relPath)
    const root = path.resolve(this.root)
    const absolutePath = path.resolve(root, ...normalized.split('/'))

    if (!absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Cloud sync path escapes vault: ${relPath}`)
    }

    return absolutePath
  }

  private async readIfExists(relPath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(relPath))
    } catch (error) {
      if (isMissingFileError(error)) return null
      throw error
    }
  }

  /**
   * The first of these paths holding a file sync cannot vouch for, meaning it
   * is not the exact bytes we last agreed on with the server. A file that is
   * absent is fine: there is nothing there to lose.
   */
  private async firstUnvouchedPath(
    relPaths: readonly string[],
    previous: CloudSyncTrackedItem | undefined
  ): Promise<string | null> {
    for (const relPath of relPaths) {
      const bytes = await this.readIfExists(relPath)
      if (!bytes) continue
      if (!previous || sha256(bytes) !== previous.sha256) return relPath
    }
    return null
  }

  /** Park the incoming version beside the local file rather than over it. */
  private async keepBoth(relPath: string, bytes: Buffer): Promise<CloudSyncLocalConflict> {
    // Settings are answered, not merged: the newest cloud version replaces any
    // older pending one at a fixed path, and the app asks which side to keep.
    if (isCloudSyncVaultSettingsPath(relPath)) {
      await this.write(CLOUD_SYNC_SETTINGS_CONFLICT_PATH, bytes)
      return {
        code: 'SETTINGS_CONFLICT',
        path: relPath,
        conflict_copy_path: CLOUD_SYNC_SETTINGS_CONFLICT_PATH
      }
    }
    for (let attempt = 1; attempt <= 100; attempt++) {
      const candidate = cloudSyncConflictCopyPath(relPath, attempt)
      if (await exists(this.resolve(candidate))) continue
      await this.write(candidate, bytes)
      return localConflict(relPath, candidate)
    }
    // A hundred conflict copies of one file means something is looping. Keep
    // the local file and report it rather than filling the vault.
    return localConflict(relPath, null)
  }

  private async write(relPath: string, bytes: Buffer): Promise<void> {
    const destination = this.resolve(relPath)
    const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const handle = await fs.open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
    )

    try {
      await handle.writeFile(bytes)
      try {
        await handle.sync()
      } catch {
        // Some network filesystems cannot fsync. Atomic rename still prevents partial reads.
      }
    } finally {
      await handle.close()
    }

    try {
      await fs.rename(temporaryPath, destination)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true })
      throw error
    }
  }
}

export class DesktopCloudSyncStateStore implements CloudSyncStateStore {
  constructor(private readonly directory: string) {}

  async load(vaultId: string): Promise<CloudSyncState | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath(vaultId), 'utf8')) as unknown
      return isCloudSyncState(parsed, vaultId) ? parsed : null
    } catch (error) {
      if (isMissingFileError(error) || error instanceof SyntaxError) return null
      throw error
    }
  }

  async save(state: CloudSyncState): Promise<void> {
    const target = this.statePath(state.vault_id)
    const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temporaryPath, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' })

    try {
      await fs.rename(temporaryPath, target)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true })
      throw error
    }
  }

  private statePath(vaultId: string): string {
    return path.join(this.directory, `${sha256(Buffer.from(vaultId))}.json`)
  }
}

export function createDesktopCloudSyncCoordinator(options: {
  root: string
  stateDirectory: string
  vaultId: string
  remote: CloudSyncRemote
}): CloudSyncCoordinator {
  return new CloudSyncCoordinator(
    options.vaultId,
    options.remote,
    new DesktopCloudSyncRepository(options.root),
    new DesktopCloudSyncStateStore(options.stateDirectory),
    { itemId: randomUUID, operationId: randomUUID }
  )
}

function encodeContent(relPath: string, bytes: Buffer): CloudSyncContent {
  const text = isText(relPath, bytes)
  return {
    encoding: text ? 'utf8' : 'base64',
    data: text ? bytes.toString('utf8') : bytes.toString('base64'),
    sha256: sha256(bytes),
    byte_length: bytes.byteLength,
    media_type: mediaType(relPath, text)
  }
}

async function encodeFileContent(relPath: string, absolutePath: string): Promise<CloudSyncContent> {
  const stats = await fs.stat(absolutePath)
  if (stats.size <= CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES) {
    const bytes = await fs.readFile(absolutePath)
    if (bytes.byteLength <= CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES) {
      return encodeContent(relPath, bytes)
    }
    return directUploadContent(relPath, absolutePath, bytes)
  }

  const hash = createHash('sha256')
  let byteLength = 0
  let text = TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase())
  const decoder = text ? new TextDecoder('utf-8', { fatal: true }) : null

  for await (const chunk of createReadStream(absolutePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    hash.update(bytes)
    if (text && decoder) {
      try {
        decoder.decode(bytes, { stream: true })
      } catch {
        text = false
      }
    }
  }

  if (text && decoder) {
    try {
      decoder.decode()
    } catch {
      text = false
    }
  }

  if (byteLength <= CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES) {
    const bytes = await fs.readFile(absolutePath)
    return bytes.byteLength <= CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES
      ? encodeContent(relPath, bytes)
      : directUploadContent(relPath, absolutePath, bytes)
  }

  return rememberCloudSyncUploadSource(
    {
      encoding: text ? 'utf8' : 'base64',
      data: '',
      sha256: hash.digest('hex'),
      byte_length: byteLength,
      media_type: mediaType(relPath, text)
    },
    absolutePath
  )
}

function directUploadContent(relPath: string, absolutePath: string, bytes: Buffer): CloudSyncContent {
  const text = isText(relPath, bytes)
  return rememberCloudSyncUploadSource(
    {
      encoding: text ? 'utf8' : 'base64',
      data: '',
      sha256: sha256(bytes),
      byte_length: bytes.byteLength,
      media_type: mediaType(relPath, text)
    },
    absolutePath
  )
}

function decodeContent(content: CloudSyncContent): Buffer {
  if (content.encoding === 'utf8') return Buffer.from(content.data, 'utf8')
  if (content.encoding === 'base64') return Buffer.from(content.data, 'base64')
  throw new Error('Encrypted cloud sync content must be decrypted before filesystem apply')
}

function isText(relPath: string, bytes: Buffer): boolean {
  if (!TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function mediaType(relPath: string, text: boolean): string {
  return MEDIA_TYPES[path.extname(relPath).toLowerCase()] ??
    (text ? 'text/plain' : 'application/octet-stream')
}

function localConflict(path: string, conflictCopyPath: string | null): CloudSyncLocalConflict {
  return { code: 'LOCAL_EDIT_CONFLICT', path, conflict_copy_path: conflictCopyPath }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath)
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

function isCloudSyncState(value: unknown, vaultId: string): value is CloudSyncState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<CloudSyncState>
  return (
    state.version === 1 &&
    state.vault_id === vaultId &&
    typeof state.cursor === 'number' &&
    state.cursor >= 0 &&
    Boolean(state.items) &&
    typeof state.items === 'object' &&
    !Array.isArray(state.items)
  )
}
