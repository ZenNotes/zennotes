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
} from './cloud-sync'
import type { CloudSyncRepository } from './cloud-sync-coordinator'
import type {
  CloudSyncLocalItem,
  CloudSyncTrackedItem
} from './cloud-sync-engine'

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

export interface CloudSyncFileEntry {
  name: string
  type: 'file' | 'directory'
}

/** The minimal vault-relative filesystem surface implemented by both mobile shells. */
export interface PortableCloudSyncFileSystem {
  readdir(directory: string): Promise<CloudSyncFileEntry[]>
  stat(path: string): Promise<'file' | 'directory' | null>
  readBase64(path: string): Promise<string>
  writeText(path: string, value: string): Promise<void>
  writeBase64(path: string, value: string): Promise<void>
  deleteFile(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
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

function localConflict(path: string, conflictCopyPath: string | null): CloudSyncLocalConflict {
  return { code: 'LOCAL_EDIT_CONFLICT', path, conflict_copy_path: conflictCopyPath }
}

/** Web-API implementation shared by iOS and Android Capacitor filesystems. */
export class PortableCloudSyncRepository implements CloudSyncRepository {
  constructor(private readonly fs: PortableCloudSyncFileSystem) {}

  async scan(): Promise<CloudSyncLocalItem[]> {
    const items: CloudSyncLocalItem[] = []
    await this.walk('', items)
    return items.sort((left, right) => left.path.localeCompare(right.path))
  }

  async pendingConflictPaths(): Promise<string[]> {
    return (await this.fs.stat(CLOUD_SYNC_SETTINGS_CONFLICT_PATH)) === 'file'
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

    if (change.type === 'delete') {
      const previousPath = this.path(previous?.path ?? change.previous_path ?? change.path)
      const current = await this.readItemOrNull(previousPath)
      if (!current) return
      // Nothing arrives with a delete to keep beside it, so the local file
      // itself is the version being preserved. The next push re-uploads it.
      if (!vouchedFor(current, previous)) return localConflict(previousPath, null)
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
      if (!vouchedFor(source, previous)) return localConflict(previousPath, null)
      if (destination) return localConflict(nextPath, null)
      await this.fs.rename(previousPath, nextPath)
      return
    }

    if (!change.content) throw new Error(`Upsert change ${change.sequence} did not include content`)

    const previousPath = this.path(previous?.path ?? change.previous_path ?? change.path)
    const nextPath = this.path(change.path)
    const [source, destination] =
      previousPath === nextPath
        ? [await this.readItemOrNull(previousPath), null]
        : await Promise.all([
            this.readItemOrNull(previousPath),
            this.readItemOrNull(nextPath)
          ])
    const currentAtTarget = previousPath === nextPath ? source : destination

    if (currentAtTarget?.content.sha256 === change.content.sha256) {
      if (previousPath !== nextPath && source) {
        if (!vouchedFor(source, previous)) return localConflict(previousPath, null)
        await this.fs.deleteFile(previousPath)
      }
      return
    }

    if (source && !vouchedFor(source, previous)) return await this.keepBoth(nextPath, change.content)
    if (destination) return await this.keepBoth(nextPath, change.content)
    await this.write(nextPath, change.content)
    if (previousPath !== nextPath && source) await this.fs.deleteFile(previousPath)
  }

  /** Park the incoming version beside the local file rather than over it. */
  private async keepBoth(
    relPath: string,
    content: CloudSyncContent
  ): Promise<CloudSyncLocalConflict> {
    // Settings are answered, not merged: the newest cloud version replaces any
    // older pending one at a fixed path, and the app asks which side to keep.
    if (isCloudSyncVaultSettingsPath(relPath)) {
      await this.write(CLOUD_SYNC_SETTINGS_CONFLICT_PATH, content)
      return {
        code: 'SETTINGS_CONFLICT',
        path: relPath,
        conflict_copy_path: CLOUD_SYNC_SETTINGS_CONFLICT_PATH
      }
    }
    for (let attempt = 1; attempt <= 100; attempt++) {
      const candidate = cloudSyncConflictCopyPath(relPath, attempt)
      if ((await this.fs.stat(candidate)) !== null) continue
      await this.write(candidate, content)
      return localConflict(relPath, candidate)
    }
    // A hundred conflict copies of one file means something is looping. Keep
    // the local file and report it rather than filling the vault.
    return localConflict(relPath, null)
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
    if (content.encoding === 'utf8') {
      await this.fs.writeText(path, content.data)
      return
    }
    if (content.encoding === 'base64') {
      await this.fs.writeBase64(path, content.data)
      return
    }
    throw new Error('Encrypted cloud sync content must be decrypted before filesystem apply')
  }

  private path(value: string): string {
    return normalizeCloudSyncPath(value)
  }
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
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
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
