import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { atomicWriteTarget, renameWithRetry } from './atomic-write'
import type {
  CloudSyncBootstrapConflictResolution,
  CloudSyncChange,
  CloudSyncContent
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
  CLOUD_SYNC_VAULT_SETTINGS_PATH,
  cloudSyncPathKey,
  isCloudSyncVaultSettingsPath,
  normalizeCloudSyncPath,
  shouldSyncVaultPath,
  shouldTraverseCloudSyncDirectory
} from '@zennotes/shared-domain/cloud-sync'
import {
  CloudSyncCoordinator,
  type CloudSyncRemote,
  type CloudSyncRepository,
  type CloudSyncRepositoryConflict,
  type CloudSyncStateStore
} from '@zennotes/shared-domain/cloud-sync-coordinator'
import type {
  CloudSyncLocalItem,
  CloudSyncState,
  CloudSyncTrackedItem
} from '@zennotes/shared-domain/cloud-sync-engine'
import {
  CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES,
  cloudSyncUploadSource,
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
  ): Promise<CloudSyncRepositoryConflict | void> {
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
      if (unvouched) {
        if (isCloudSyncVaultSettingsPath(change.path)) {
          return await this.keepBoth(change.path, await decodeContent(change.content))
        }
        return localConflict(unvouched, await this.localItemOrNull(unvouched))
      }

      await this.write(change.path, await decodeContent(change.content))
      return
    }

    const previousPath = previous?.path ?? change.previous_path ?? change.path
    const unvouched = await this.firstUnvouchedPath([previousPath], previous)
    // A delete or a move carries no content to park, so keeping the local file
    // where it is IS the preserved version. The next push re-uploads it.
    if (unvouched) return localConflict(unvouched, await this.localItemOrNull(unvouched))

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

    if (await exists(destination)) {
      return localConflict(change.path, await this.localItemOrNull(change.path))
    }
    await fs.rename(source, destination)
  }

  async resolveBootstrapConflict(input: {
    path: string
    expectedLocalSha256: string
    cloudContent: CloudSyncContent
    resolution: CloudSyncBootstrapConflictResolution
  }): Promise<void> {
    const current = await this.readIfExists(input.path)
    if (!current || sha256(current) !== input.expectedLocalSha256) {
      throw new Error(
        'This file changed on this device. Sync again to compare the latest versions.'
      )
    }

    if (input.resolution.choice === 'cloud') {
      await this.write(input.path, await decodeContent(input.cloudContent))
      return
    }

    if (input.resolution.choice === 'merged') {
      if (input.cloudContent.encoding !== 'utf8' || input.resolution.merged_text === undefined) {
        throw new Error('Only text conflicts can be merged.')
      }
      await this.write(input.path, Buffer.from(input.resolution.merged_text, 'utf8'))
      return
    }

    if (input.resolution.choice !== 'both') return
    if (!input.resolution.keep_both_path) {
      throw new Error('Choose a filename for this device’s version.')
    }

    const originalPath = normalizeCloudSyncPath(input.path)
    const localCopyPath = normalizeCloudSyncPath(input.resolution.keep_both_path)
    if (
      !shouldSyncVaultPath(localCopyPath) ||
      cloudSyncPathKey(localCopyPath) === cloudSyncPathKey(originalPath)
    ) {
      throw new Error('Choose a different filename inside the synced vault.')
    }

    const source = this.resolve(originalPath)
    const destination = this.resolve(localCopyPath)
    if (await exists(destination)) throw new Error(`${localCopyPath} already exists.`)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rename(source, destination)
    try {
      await this.write(originalPath, await decodeContent(input.cloudContent))
    } catch (error) {
      await fs.rename(destination, source).catch(() => undefined)
      throw error
    }
  }

  async replaceConflictFile(input: {
    path: string
    expectedSha256: string | null
    content: CloudSyncContent | null
  }): Promise<void> {
    const current = await this.readIfExists(input.path)
    if ((current ? sha256(current) : null) !== input.expectedSha256) {
      throw new Error(
        'This file changed on this device. Review the latest changes before continuing.'
      )
    }
    if (input.content === null) {
      if (current) await fs.rm(this.resolve(input.path), { force: true })
      return
    }
    await this.write(input.path, await decodeContent(input.content))
  }

  async applyConflictResolutionFiles(input: {
    expected_path: string | null
    expected_sha256: string | null
    files: Array<{ path: string; content: CloudSyncContent }>
  }): Promise<void> {
    const expectedPath = input.expected_path ? normalizeCloudSyncPath(input.expected_path) : null
    const current = expectedPath ? await this.readIfExists(expectedPath) : null
    if ((current ? sha256(current) : null) !== input.expected_sha256) {
      throw new Error(
        'This file changed on this device. Review the latest changes before continuing.'
      )
    }

    const files = normalizedResolutionFiles(input.files)
    const expectedKey = expectedPath ? cloudSyncPathKey(expectedPath) : null
    for (const file of files) {
      if (cloudSyncPathKey(file.path) === expectedKey) continue
      if (await exists(this.resolve(file.path))) {
        throw new Error(`${file.path} already exists. Choose another filename.`)
      }
    }

    // Write new destinations first so the original remains recoverable if a
    // later filesystem operation fails. Each write itself is an atomic rename.
    const ordered = [...files].sort((left, right) =>
      cloudSyncPathKey(left.path) === expectedKey
        ? 1
        : cloudSyncPathKey(right.path) === expectedKey
          ? -1
          : 0
    )
    const newPaths: string[] = []
    try {
      for (const file of ordered) {
        if (cloudSyncPathKey(file.path) !== expectedKey) newPaths.push(file.path)
        await this.write(file.path, await decodeContent(file.content))
      }
      if (expectedPath && !files.some((file) => cloudSyncPathKey(file.path) === expectedKey)) {
        await fs.rm(this.resolve(expectedPath), { force: true })
      }
    } catch (error) {
      for (const createdPath of newPaths.reverse()) {
        await fs.rm(this.resolve(createdPath), { force: true }).catch(() => undefined)
      }
      throw error
    }
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

  private async localItemOrNull(relPath: string): Promise<CloudSyncLocalItem | null> {
    const absolutePath = this.resolve(relPath)
    if (!(await exists(absolutePath))) return null
    // Streams anything above the inline limit, the same as a scan, so a
    // conflicted attachment never has to fit in memory twice over.
    const content = await encodeFileContent(relPath, absolutePath)
    return {
      path: normalizeCloudSyncPath(relPath),
      kind: content.encoding === 'utf8' ? 'text' : 'binary',
      content
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
  private async keepBoth(relPath: string, bytes: Buffer): Promise<CloudSyncRepositoryConflict> {
    // Settings are answered, not merged: the newest cloud version replaces any
    // older pending one at a fixed path, and the app asks which side to keep.
    if (isCloudSyncVaultSettingsPath(relPath)) {
      await this.write(CLOUD_SYNC_SETTINGS_CONFLICT_PATH, bytes)
      return {
        code: 'SETTINGS_CONFLICT',
        path: relPath,
        conflict_copy_path: CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
        local: await this.localItemOrNull(relPath)
      }
    }
    return localConflict(relPath, await this.localItemOrNull(relPath))
  }

  private async write(relPath: string, bytes: Buffer): Promise<void> {
    // The same two rules as the vault's own writer: a symlinked note keeps
    // pointing at its target, and the file keeps its mode.
    const destination = await atomicWriteTarget(this.resolve(relPath))
    const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const existingMode = await fs
      .stat(destination)
      .then((stats) => stats.mode & 0o777)
      .catch(() => null)
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
      if (existingMode !== null) await fs.chmod(temporaryPath, existingMode)
      await renameWithRetry(temporaryPath, destination)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true })
      throw error
    }
  }
}

function normalizedResolutionFiles(
  files: Array<{ path: string; content: CloudSyncContent }>
): Array<{ path: string; content: CloudSyncContent }> {
  const normalized = files.map((file) => ({
    ...file,
    path: normalizeCloudSyncPath(file.path)
  }))
  const keys = new Set<string>()
  for (const file of normalized) {
    if (!shouldSyncVaultPath(file.path)) {
      throw new Error('Choose a filename inside the synced vault.')
    }
    const key = cloudSyncPathKey(file.path)
    if (keys.has(key)) throw new Error('Choose a different filename for each version.')
    keys.add(key)
  }
  return normalized
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

async function decodeContent(content: CloudSyncContent): Promise<Buffer> {
  if (content.encoding !== 'utf8' && content.encoding !== 'base64') {
    throw new Error('Encrypted cloud sync content must be decrypted before filesystem apply')
  }
  if (content.data === '' && content.byte_length > 0) {
    // A scan snapshot of a file above the inline limit carries no bytes; the
    // file it was taken from is the source. Decoding it as empty once wrote a
    // 0-byte file over a 6 MB attachment.
    const source = cloudSyncUploadSource(content)
    if (!source) {
      throw new Error('This file is too large to copy from its sync snapshot. Sync again and retry.')
    }
    const bytes = await fs.readFile(source)
    if (bytes.byteLength !== content.byte_length || sha256(bytes) !== content.sha256) {
      throw new Error(
        'This file changed on this device. Review the latest changes before continuing.'
      )
    }
    return bytes
  }
  return Buffer.from(content.data, content.encoding)
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

function localConflict(
  path: string,
  local: CloudSyncLocalItem | null
): CloudSyncRepositoryConflict {
  return { code: 'LOCAL_EDIT_CONFLICT', path, conflict_copy_path: null, local }
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
