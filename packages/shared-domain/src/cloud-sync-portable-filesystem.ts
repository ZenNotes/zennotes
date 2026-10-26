import type {
  CloudSyncBootstrapConflictResolution,
  CloudSyncChange,
  CloudSyncContent
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
  CLOUD_SYNC_VAULT_SETTINGS_PATH,
  cloudSyncFreePath,
  cloudSyncPathKey,
  isCloudSyncVaultSettingsPath,
  normalizeCloudSyncPath,
  shouldSyncVaultPath,
  shouldTraverseCloudSyncDirectory
} from './cloud-sync'
import type { CloudSyncRepository, CloudSyncRepositoryConflict } from './cloud-sync-coordinator'
import type { CloudSyncLocalItem, CloudSyncTrackedItem } from './cloud-sync-engine'
import type { CloudSyncDownloadSource, CloudSyncStagedFile, CloudSyncStagedConflict } from './cloud-sync-content'
import { randomUUID } from './random-uuid'
import { cloudProtocolError } from './cloud-error-copy'

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

/** Where matchCase notes a respelling in progress. `zennotes-cloud-sync` is a
 *  local-only folder name, so scans never list it and it never syncs. */
const RESPELLING_RECORDS = '.zennotes/zennotes-cloud-sync/respellings'
const RESPELLING_RECORD_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i

export interface CloudSyncFileEntry {
  name: string
  type: 'file' | 'directory'
}

/** The minimal vault-relative filesystem surface implemented by both mobile shells. */
export interface PortableCloudSyncFileSystem {
  stageCloudContent?(source: CloudSyncDownloadSource): Promise<CloudSyncStagedFile>
  applyStagedCloudContent?(change: CloudSyncChange, previous: CloudSyncTrackedItem | undefined, file: CloudSyncStagedFile): Promise<CloudSyncRepositoryConflict | void>
  resolveStagedCloudConflict?(input: CloudSyncStagedConflict): Promise<void>
  readdir(directory: string): Promise<CloudSyncFileEntry[]>
  stat(path: string): Promise<'file' | 'directory' | null>
  readBase64(path: string): Promise<string>
  writeText(path: string, value: string): Promise<void>
  writeBase64(path: string, value: string): Promise<void>
  deleteFile(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Native hosts can fingerprint and copy large files without bridge-sized bodies. */
  readItem?(path: string): Promise<CloudSyncLocalItem>
  validateContent?(content: CloudSyncContent): Promise<void>
  /** Must preserve the previous file if a write fails, including partial native writes. */
  writeContent?(path: string, content: CloudSyncContent): Promise<void>
}

export class CloudSyncLocalEditConflictError extends Error {
  constructor(readonly relPath: string) {
    super(`Cloud sync stopped because ${relPath} has unsynced local edits`)
    this.name = 'CloudSyncLocalEditConflictError'
  }
}

/** Whether a local file is the exact bytes sync last agreed on with the server. */
function vouchedFor(
  current: CloudSyncLocalItem,
  previous: CloudSyncTrackedItem | undefined
): boolean {
  return Boolean(previous) && current.content.sha256 === previous?.sha256
}

function localConflict(
  path: string,
  local: CloudSyncLocalItem | null
): CloudSyncRepositoryConflict {
  return { code: 'LOCAL_EDIT_CONFLICT', path, conflict_copy_path: null, local }
}

/** Web-API implementation shared by iOS and Android Capacitor filesystems. */
export class PortableCloudSyncRepository implements CloudSyncRepository {
  readonly stageCloudContent?: CloudSyncRepository['stageCloudContent']
  readonly applyStagedCloudContent?: CloudSyncRepository['applyStagedCloudContent']
  readonly resolveStagedCloudConflict?: CloudSyncRepository['resolveStagedCloudConflict']

  constructor(private readonly fs: PortableCloudSyncFileSystem) {
    if (fs.stageCloudContent && fs.applyStagedCloudContent && fs.resolveStagedCloudConflict) {
      this.stageCloudContent = fs.stageCloudContent.bind(fs)
      this.applyStagedCloudContent = fs.applyStagedCloudContent.bind(fs)
      this.resolveStagedCloudConflict = fs.resolveStagedCloudConflict.bind(fs)
    }
  }

  async matchesCloudContent(path: string, reference: CloudSyncStagedFile['reference']): Promise<boolean> {
    if (!this.fs.readItem) return false
    const local = await this.readItemOrNull(this.path(path))
    return local?.content.sha256 === reference.sha256 && local.content.byte_length === reference.byte_length
  }

  async scan(): Promise<CloudSyncLocalItem[]> {
    const items: CloudSyncLocalItem[] = []
    await this.walk('', items)
    return items.sort((left, right) => left.path.localeCompare(right.path))
  }

  /**
   * The file at exactly this path, read as scan() reads it, found with one
   * listing per folder on the way down. Every name must match its listing
   * exactly; a case-only difference anywhere is left to the scan, which
   * reports the spelling on disk.
   */
  async readLocalItem(path: string): Promise<CloudSyncLocalItem | null> {
    const normalized = this.path(path)
    if (!shouldSyncVaultPath(normalized)) return null
    const segments = normalized.split('/')
    let directory = ''
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1
      let entries: CloudSyncFileEntry[]
      try {
        entries = await this.fs.readdir(directory)
      } catch {
        return null
      }
      const entry = entries.find((candidate) => candidate.name.normalize('NFC') === segment)
      if (!entry || entry.type !== (last ? 'file' : 'directory')) return null
      directory = directory ? `${directory}/${segment}` : segment
      if (!last && !shouldTraverseCloudSyncDirectory(directory)) return null
    }
    return this.readItem(normalized)
  }

  async pendingConflictPaths(): Promise<string[]> {
    return (await this.fs.stat(CLOUD_SYNC_SETTINGS_CONFLICT_PATH)) === 'file'
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

    if (change.type === 'delete') {
      const previousPath = this.path(previous?.path ?? change.previous_path ?? change.path)
      const current = await this.readItemOrNull(previousPath)
      if (!current) return
      // Nothing arrives with a delete to keep beside it, so the local file
      // itself is the version being preserved. The next push re-uploads it.
      if (!vouchedFor(current, previous)) return localConflict(previousPath, current)
      await this.fs.deleteFile(previousPath)
      return
    }

    if (change.type === 'move') {
      const previousPath = this.path(previous?.path ?? change.previous_path ?? change.path)
      const nextPath = this.path(change.path)
      if (previousPath === nextPath) return

      const [source, destination] = await Promise.all([
        this.readItemOrNull(previousPath),
        this.readItemOrNull(nextPath)
      ])
      if (!source) {
        if (destination && previous && destination.content.sha256 === previous.sha256) return
        // Nothing here to move; the next scan reconciles it.
        return
      }
      if (!vouchedFor(source, previous)) return localConflict(previousPath, source)
      if (destination) return localConflict(nextPath, destination)
      await this.fs.rename(previousPath, nextPath)
      return
    }

    if (!change.content) throw cloudProtocolError(`Upsert change ${change.sequence} did not include content`)
    await this.validateContent(change.content)

    const previousPath = this.path(previous?.path ?? change.previous_path ?? change.path)
    const nextPath = this.path(change.path)
    const [source, destination] =
      previousPath === nextPath
        ? [await this.readItemOrNull(previousPath), null]
        : await Promise.all([this.readItemOrNull(previousPath), this.readItemOrNull(nextPath)])
    const currentAtTarget = previousPath === nextPath ? source : destination
    const oneFile = source !== null && destination !== null && (await this.sameFile(previousPath, nextPath))

    if (currentAtTarget?.content.sha256 === change.content.sha256) {
      // Only the spelling is left to change: the file already holds the Cloud
      // bytes, so there is nothing of this device's to vouch for or lose.
      if (oneFile) return await this.matchCase(nextPath)
      if (previousPath !== nextPath && source) {
        if (!vouchedFor(source, previous)) return localConflict(previousPath, source)
        await this.fs.deleteFile(previousPath)
      }
      return
    }

    if (source && !vouchedFor(source, previous)) {
      if (isCloudSyncVaultSettingsPath(nextPath))
        return await this.keepBoth(nextPath, change.content)
      return localConflict(previousPath, source)
    }
    if (destination && !oneFile) {
      if (isCloudSyncVaultSettingsPath(nextPath))
        return await this.keepBoth(nextPath, change.content)
      return localConflict(nextPath, destination)
    }
    await this.write(nextPath, change.content)
    if (oneFile) await this.matchCase(nextPath)
    else if (previousPath !== nextPath && source) await this.fs.deleteFile(previousPath)
  }

  async resolveBootstrapConflict(input: {
    path: string
    expectedLocalSha256: string
    cloudContent: CloudSyncContent
    resolution: CloudSyncBootstrapConflictResolution
  }): Promise<void> {
    const originalPath = this.path(input.path)
    await this.validateContent(input.cloudContent)
    const current = await this.readItemOrNull(originalPath)
    if (!current || current.content.sha256 !== input.expectedLocalSha256) {
      throw new Error(
        'This file changed on this device. Sync again to compare the latest versions.'
      )
    }

    if (input.resolution.choice === 'cloud') {
      await this.write(originalPath, input.cloudContent)
      return
    }

    if (input.resolution.choice === 'merged') {
      if (input.cloudContent.encoding !== 'utf8' || input.resolution.merged_text === undefined) {
        throw new Error('Only text conflicts can be merged.')
      }
      const bytes = new TextEncoder().encode(input.resolution.merged_text)
      await this.write(originalPath, {
        encoding: 'utf8', data: input.resolution.merged_text,
        sha256: await sha256(bytes), byte_length: bytes.byteLength,
        media_type: input.cloudContent.media_type
      })
      return
    }

    if (input.resolution.choice !== 'both') return
    if (!input.resolution.keep_both_path) {
      throw new Error('Choose a filename for this device’s version.')
    }

    const localCopyPath = this.path(input.resolution.keep_both_path)
    if (
      !shouldSyncVaultPath(localCopyPath) ||
      cloudSyncPathKey(localCopyPath) === cloudSyncPathKey(originalPath)
    ) {
      throw new Error('Choose a different filename inside the synced vault.')
    }
    if ((await this.fs.stat(localCopyPath)) !== null) {
      throw new Error(`A file named “${localCopyPath}” already exists. Choose another name.`)
    }

    await this.fs.rename(originalPath, localCopyPath)
    try {
      await this.write(originalPath, input.cloudContent)
    } catch (error) {
      await this.fs.rename(localCopyPath, originalPath).catch(() => undefined)
      throw error
    }
  }

  async replaceConflictFile(input: {
    path: string
    expectedSha256: string | null
    content: CloudSyncContent | null
  }): Promise<void> {
    const path = this.path(input.path)
    const current = await this.readItemOrNull(path)
    if ((current?.content.sha256 ?? null) !== input.expectedSha256) {
      throw new Error(
        'This file changed on this device. Review the latest changes before continuing.'
      )
    }
    if (input.content === null) {
      if (current) await this.fs.deleteFile(path)
      return
    }
    await this.write(path, input.content)
  }

  async applyConflictResolutionFiles(input: {
    expected_path: string | null
    expected_sha256: string | null
    files: Array<{ path: string; content: CloudSyncContent; displace_existing?: boolean }>
  }): Promise<void> {
    const expectedPath = input.expected_path ? this.path(input.expected_path) : null
    const current = expectedPath ? await this.readItemOrNull(expectedPath) : null
    if ((current?.content.sha256 ?? null) !== input.expected_sha256) {
      throw new Error(
        'This file changed on this device. Review the latest changes before continuing.'
      )
    }

    const files = normalizedResolutionFiles(input.files)
    // Validate every source before creating a copy or replacing the original.
    for (const file of files) await this.validateContent(file.content)
    const expectedKey = expectedPath ? cloudSyncPathKey(expectedPath) : null
    const reserved = new Set(files.map((file) => cloudSyncPathKey(file.path)))
    const displacements: Array<{ from: string; to: string }> = []
    for (const file of files) {
      if (cloudSyncPathKey(file.path) === expectedKey) continue
      const occupant = await this.fs.stat(file.path)
      if (occupant === null) continue
      if (!file.displace_existing || occupant !== 'file') {
        throw new Error(`A file named “${file.path}” already exists. Choose another name.`)
      }
      const to = await cloudSyncFreePath(file.path, async (candidate) =>
        reserved.has(cloudSyncPathKey(candidate)) || (await this.fs.stat(candidate)) !== null)
      reserved.add(cloudSyncPathKey(to))
      displacements.push({ from: file.path, to })
    }

    const ordered = [...files].sort((left, right) =>
      cloudSyncPathKey(left.path) === expectedKey
        ? 1
        : cloudSyncPathKey(right.path) === expectedKey
          ? -1
          : 0
    )
    const newPaths: string[] = []
    const displaced: Array<{ from: string; to: string }> = []
    let replacingExpected = false
    try {
      for (const move of displacements) {
        await this.fs.rename(move.from, move.to)
        displaced.push(move)
      }
      for (const file of ordered) {
        if (cloudSyncPathKey(file.path) === expectedKey) replacingExpected = true
        else newPaths.push(file.path)
        await this.write(file.path, file.content)
      }
      if (expectedPath && !files.some((file) => cloudSyncPathKey(file.path) === expectedKey)) {
        await this.fs.deleteFile(expectedPath)
      }
    } catch (error) {
      for (const createdPath of newPaths.reverse()) {
        await this.fs.deleteFile(createdPath).catch(() => undefined)
      }
      if (expectedPath && replacingExpected) {
        if (current) await this.write(expectedPath, current.content).catch(() => undefined)
        else await this.fs.deleteFile(expectedPath).catch(() => undefined)
      }
      for (const move of displaced.reverse()) {
        await this.fs.rename(move.to, move.from).catch(() => undefined)
      }
      throw error
    }
  }

  /**
   * Whether two spellings of one path key reach the same file. A
   * case-insensitive volume (Android's shared storage, an external drive, the
   * simulator on a Mac) answers both with one file, and deleting the old
   * spelling there deleted the only copy. A case-sensitive volume can hold
   * both as separate files, so finding a file under each spelling proves
   * nothing. This layer cannot compare inodes; it asks the directory where the
   * spellings part instead, since a listing names one file once, under its
   * stored name.
   */
  private async sameFile(left: string, right: string): Promise<boolean> {
    if (cloudSyncPathKey(left) !== cloudSyncPathKey(right)) return false
    const leftSegments = left.split('/')
    const rightSegments = right.split('/')
    const index = leftSegments.findIndex((segment, position) => segment !== rightSegments[position])
    if (index < 0) return true
    const names = new Set(
      (await this.fs.readdir(leftSegments.slice(0, index).join('/'))).map((entry) =>
        entry.name.normalize('NFC')
      )
    )
    return !(names.has(leftSegments[index]!) && names.has(rightSegments[index]!))
  }

  /**
   * Give the one file of a case-only rename its new spelling. The volume
   * keeps whatever case the file already had, and the next scan would report
   * that and push the rename back. A native rename that overwrites removes an
   * existing destination before moving onto it, and here that destination is
   * the file itself, so the rename detours through a name nothing else holds
   * and that sync ignores. A record written before the first step lets the
   * next run finish the rename if the app stops between the two
   * (recoverInterruptedWork); without it the note sat under the detour name
   * for good, out of sight of the app and of sync.
   */
  private async matchCase(path: string): Promise<void> {
    const slash = path.lastIndexOf('/')
    const name = path.slice(slash + 1)
    const entries = await this.fs.readdir(slash < 0 ? '' : path.slice(0, slash))
    if (entries.some((entry) => entry.name.normalize('NFC') === name)) return
    const id = randomUUID()
    const detour = `${path}.${id}.tmp`
    const record = `${RESPELLING_RECORDS}/${id}.json`
    await this.fs.writeText(record, JSON.stringify({ path, detour }))
    try {
      await this.fs.rename(path, detour)
    } catch (error) {
      await this.fs.deleteFile(record).catch(() => undefined)
      throw error
    }
    // A save that landed under the old spelling since the first step is the
    // note's newest version, and the second step would remove it as an
    // existing destination. It stays where it is, and the record is left for
    // the next run to settle the parked copy against it.
    if ((await this.fs.stat(path)) !== null) return
    await this.fs.rename(detour, path)
    await this.fs.deleteFile(record).catch(() => undefined)
  }

  /**
   * Finish the case-only renames (matchCase) an earlier run was stopped in
   * the middle of. The coordinator calls this before a run pulls or scans.
   * A parked note whose name is free goes back under it; one whose name holds
   * the same bytes again (a replay wrote them back) is a duplicate and goes;
   * anything else stays, since it may be the only copy of one side. A record
   * that cannot be trusted is dropped without touching any file.
   *
   * Never fails a run. The change that was being applied when the app stopped
   * was not saved as applied, so the run replays it and writes the note again
   * on its own; this only spares that rewrite and the parked duplicate. A
   * record that cannot be settled now is kept for the next run.
   */
  async recoverInterruptedWork(): Promise<void> {
    let entries: CloudSyncFileEntry[]
    try {
      if ((await this.fs.stat(RESPELLING_RECORDS)) !== 'directory') return
      entries = await this.fs.readdir(RESPELLING_RECORDS)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      const recordPath = `${RESPELLING_RECORDS}/${entry.name}`
      try {
        const respelling = await this.readRespelling(recordPath, entry.name)
        if (respelling) await this.finishRespelling(respelling)
        await this.fs.deleteFile(recordPath)
      } catch {
        // Kept for the next run.
      }
    }
  }

  private async readRespelling(
    recordPath: string,
    fileName: string
  ): Promise<{ path: string; detour: string } | null> {
    const id = RESPELLING_RECORD_NAME.exec(fileName)?.[1]
    if (!id) return null
    try {
      const value: unknown = JSON.parse(
        new TextDecoder().decode(base64ToBytes(await this.fs.readBase64(recordPath)))
      )
      if (!value || typeof value !== 'object') return null
      const { path, detour } = value as Record<string, unknown>
      if (typeof path !== 'string' || detour !== `${path}.${id}.tmp`) return null
      if (!shouldSyncVaultPath(path) || this.path(path) !== path) return null
      return { path, detour }
    } catch {
      return null
    }
  }

  private async finishRespelling({ path, detour }: { path: string; detour: string }): Promise<void> {
    if ((await this.fs.stat(detour)) !== 'file') return
    const current = await this.fs.stat(path)
    if (current === null) {
      await this.fs.rename(detour, path)
      return
    }
    if (current !== 'file') return
    const [kept, parked] = await Promise.all([this.readItem(path), this.readItem(detour)])
    if (kept.content.sha256 === parked.content.sha256) await this.fs.deleteFile(detour)
  }

  /** Park the incoming version beside the local file rather than over it. */
  private async keepBoth(
    relPath: string,
    content: CloudSyncContent
  ): Promise<CloudSyncRepositoryConflict> {
    // Settings are answered, not merged: the newest cloud version replaces any
    // older pending one at a fixed path, and the app asks which side to keep.
    if (isCloudSyncVaultSettingsPath(relPath)) {
      await this.write(CLOUD_SYNC_SETTINGS_CONFLICT_PATH, content)
      return {
        code: 'SETTINGS_CONFLICT',
        path: relPath,
        conflict_copy_path: CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
        local: await this.readItemOrNull(relPath)
      }
    }
    return localConflict(relPath, await this.readItemOrNull(relPath))
  }

  private async walk(directory: string, items: CloudSyncLocalItem[]): Promise<void> {
    const entries = await this.fs.readdir(directory)
    for (const entry of entries) {
      const relPath = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (shouldTraverseCloudSyncDirectory(relPath)) await this.walk(relPath, items)
      } else if (shouldSyncVaultPath(relPath)) {
        items.push(await this.readItem(this.path(relPath)))
      }
    }
  }

  private async readItemOrNull(path: string): Promise<CloudSyncLocalItem | null> {
    const type = await this.fs.stat(path)
    if (type === null) return null
    if (type !== 'file') throw new CloudSyncLocalEditConflictError(path)
    return this.readItem(path)
  }

  private async readItem(path: string): Promise<CloudSyncLocalItem> {
    if (this.fs.readItem) return this.fs.readItem(path)
    const bytes = base64ToBytes(await this.fs.readBase64(path))
    const text = decodeText(path, bytes)
    return {
      path,
      kind: text === null ? 'binary' : 'text',
      content: {
        encoding: text === null ? 'base64' : 'utf8',
        data: text === null ? bytesToBase64(bytes) : text,
        sha256: await sha256(bytes),
        byte_length: bytes.byteLength,
        media_type: mediaType(path, text !== null)
      }
    }
  }

  private async write(path: string, content: CloudSyncContent): Promise<void> {
    await this.validateContent(content)
    if (this.fs.writeContent) return this.fs.writeContent(path, content)
    if (content.encoding === 'utf8') {
      await this.fs.writeText(path, content.data)
      return
    }
    if (content.encoding === 'base64') {
      await this.fs.writeBase64(path, content.data)
      return
    }
    throw cloudProtocolError('Encrypted cloud sync content must be decrypted before filesystem apply')
  }

  private async validateContent(content: CloudSyncContent): Promise<void> {
    if (content.data === '' && content.byte_length > 0 &&
        (!this.fs.validateContent || !this.fs.writeContent)) {
      throw cloudProtocolError('File content has no readable source bytes.')
    }
    await this.fs.validateContent?.(content)
  }

  private path(value: string): string {
    return normalizeCloudSyncPath(value)
  }
}

function normalizedResolutionFiles(
  files: Array<{ path: string; content: CloudSyncContent; displace_existing?: boolean }>
): Array<{ path: string; content: CloudSyncContent; displace_existing?: boolean }> {
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

function decodeText(path: string, bytes: Uint8Array): string | null {
  if (!TEXT_EXTENSIONS.has(extension(path))) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function mediaType(path: string, text: boolean): string {
  return MEDIA_TYPES[extension(path)] ?? (text ? 'text/plain' : 'application/octet-stream')
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = Uint8Array.from(bytes).buffer
  const digest = await crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
  const binary = atob(normalized.replace(/\s/g, ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
