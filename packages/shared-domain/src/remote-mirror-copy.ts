/**
 * Words for an offline copy of a self-hosted server's vault (#1108). Cloud's
 * engine syncs it, so most failures arrive worded for ZenNotes Cloud; these
 * name the server the person saved instead ("Home server"), and the few that
 * only a self-hosted server gives (an old server, a vault switch) get their
 * own sentence.
 */
import { describeCloudError, type CloudErrorCopy } from './cloud-error-copy'

/** The first server release whose sync protocol an offline copy needs. */
export const REMOTE_MIRROR_MIN_SERVER_VERSION = '2.91.1'

/** The disabled toggle's line against a server without the protocol. */
export const REMOTE_MIRROR_NEEDS_SERVER_MESSAGE = `Needs ZenNotes server ${REMOTE_MIRROR_MIN_SERVER_VERSION} or later.`

export function remoteMirrorOfflineMessage(serverName: string): string {
  return `${serverName} can't be reached. Your notes are safe in the offline copy on this computer, and they reach the server when it answers.`
}

export function remoteMirrorVaultMismatchMessage(serverName: string): string {
  return `${serverName} now serves a different vault than this offline copy was made from, so sync stopped. The copy is kept as it is.`
}

/** What an attachment that is not in the copy says while the server is away. */
export function remoteMirrorAttachmentOfflineMessage(serverName: string): string {
  return `Attachments stay on ${serverName} and are not in the offline copy. They open when the server can be reached.`
}

/** Whether an error means the server never answered. */
export function isRemoteMirrorUnreachable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  if (name === 'RemoteMirrorUnreachableError') return true
  return describeCloudError(error).kind === 'offline'
}

interface ServiceError {
  name?: unknown
  status?: unknown
  code?: unknown
  message?: unknown
}

/** `error` in words that name `serverName`, with the technical line kept. */
export function describeRemoteMirrorError(error: unknown, serverName: string): CloudErrorCopy {
  const raw = (error && typeof error === 'object' ? error : {}) as ServiceError
  const status = typeof raw.status === 'number' ? raw.status : null
  const code = typeof raw.code === 'string' ? raw.code : null
  const text = typeof raw.message === 'string' ? raw.message : String(error ?? '')
  const detail = [text, status !== null ? `HTTP ${status}` : null, code].filter(Boolean).join(' · ') || null
  const worded = (message: string, kind: CloudErrorCopy['kind'] = 'other'): CloudErrorCopy => ({ message, detail, kind })

  if (isRemoteMirrorUnreachable(error)) return worded(remoteMirrorOfflineMessage(serverName), 'offline')
  if (code === 'VAULT_MISMATCH') return worded(remoteMirrorVaultMismatchMessage(serverName))
  if (status === 401) {
    return worded(`${serverName} turned away this computer's token. Check the token for this remote, then choose Sync Remote Vault Now.`)
  }
  if (code === 'SYNC_RETRY' || code === 'SYNC_UNAVAILABLE' || (status !== null && status >= 500)) {
    return worded(`${serverName} could not sync just now. Your notes are safe in the offline copy, and sync tries again shortly.`)
  }
  if (code === 'REQUEST_TOO_LARGE' || status === 413) {
    return worded(`A note is larger than ${serverName} takes in one request, so it stays in the offline copy. Make it smaller to finish syncing.`)
  }
  if (status === 404 && code === null) {
    return worded(`${serverName} does not keep offline copies. Update it to ZenNotes server ${REMOTE_MIRROR_MIN_SERVER_VERSION} or later.`)
  }
  if (code === 'GATEWAY_REDIRECT') return worded(text)

  const cloud = describeCloudError(error)
  return { message: renameCloud(cloud.message, serverName), detail: cloud.detail, kind: cloud.kind }
}

/** A sentence written for Cloud, about `serverName` instead. */
export function renameCloud(text: string, serverName: string): string {
  return text
    .replace(/\bZenNotes Cloud\b/g, serverName)
    .replace(/\bin Cloud\b/g, `on ${serverName}`)
    .replace(/\bCloud\b/g, serverName)
}
