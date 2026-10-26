/**
 * Plain words for a Cloud failure, for people without a technical background
 * (Discord feedback: say what went wrong, why, and what to do).
 *
 * Every Cloud error a person can read goes through describeCloudError: the
 * desktop main process runs it before an error crosses into a window, because
 * IPC keeps only the text and the HTTP status and code are what tell most
 * failures apart; app-core runs it again, which leaves an already worded
 * message as it is and words the phones' errors, whose hosts run in-process
 * and keep status and code on the error. The original text, status and code
 * stay reachable as `detail` for a support conversation, never as the message.
 */
import { CLOUD_VAULT_SUPERSEDED_MESSAGE } from './cloud-vault-availability'

export type CloudErrorKind =
  /** Cloud could not be reached, or took too long: the status row says so. */
  | 'offline'
  /** Cloud no longer accepts this device's sign-in: the device signs out. */
  | 'signed-out'
  | 'other'

export interface CloudErrorCopy {
  /** What happened, why where it is known, and what to do. */
  message: string
  /** The technical line for Details and Copy details; null when the message is all there is. */
  detail: string | null
  kind: CloudErrorKind
}

/** What a CloudIssueError stands for. Each is worded once, below. */
export type CloudIssue =
  /** Cloud and this device disagree about the sync protocol. */
  | 'protocol'
  /** A download stopped part way or its link ran out. */
  | 'download-incomplete'
  /** Downloaded bytes did not match what Cloud promised. */
  | 'download-damaged'
  /** Cloud changed under a first sync that was still reading it. */
  | 'remote-changed'
  /** Two local files differ only by letter case or Unicode form. */
  | 'path-collision'

/**
 * A failure whose own message is for developers and logs. The message stays
 * as it was (tests and logs match it); people read the issue's sentence.
 */
export class CloudIssueError extends Error {
  constructor(
    readonly issue: CloudIssue,
    message: string,
    /** The vault file it concerns, when the sentence can name it. */
    readonly path: string | null = null
  ) {
    super(message)
    this.name = 'CloudIssueError'
  }
}

/** Shorthand for the most common issue: an internal sync check failed. */
export function cloudProtocolError(message: string): CloudIssueError {
  return new CloudIssueError('protocol', message)
}

/**
 * Where the technical line starts in a message the desktop main process
 * worded. Readable on its own, in case a surface shows the whole text.
 */
export const CLOUD_ERROR_DETAILS_MARKER = '\n\nDetails: '

const REPORT = 'If it keeps happening, copy the details and choose Report an Issue.'

export const CLOUD_OFFLINE_MESSAGE =
  "ZenNotes can't reach ZenNotes Cloud. Check that this device is online, then try again. Your notes are safe on this device, and sync picks up where it left off."
export const CLOUD_TIMEOUT_MESSAGE =
  'ZenNotes Cloud took too long to answer, which usually means a slow or unstable connection. Try again in a moment. Nothing was lost.'
export const CLOUD_SIGNED_OUT_MESSAGE =
  'This device was signed out of ZenNotes Cloud. That happens when it is removed from your account on the website, or when its sign-in is more than a year old. Choose Connect ZenNotes Cloud to sign in again. Your notes stay on this device.'
export const CLOUD_UNEXPECTED_ANSWER_MESSAGE =
  `ZenNotes Cloud sent something ZenNotes didn't expect, so ZenNotes stopped. Your notes on this device are safe. Try again. ${REPORT}`
export const CLOUD_UNEXPECTED_MESSAGE =
  `Something unexpected went wrong. Your notes on this device are safe. Try again. ${REPORT}`

const NOT_CLOUD_ANSWER =
  'ZenNotes got an unexpected answer instead of ZenNotes Cloud. This happens on public Wi-Fi that wants you to sign in first, or while Cloud is being updated. Try again in a few minutes.'
const SERVER_TROUBLE =
  'ZenNotes Cloud is having trouble right now. This is on our side, not yours. Your notes are safe on this device, and sync will try again in a few minutes.'
const SLOW_DOWN =
  'ZenNotes Cloud asked this device to slow down after a burst of requests. Sync continues on its own in a few minutes.'
const STOPPED = 'ZenNotes stopped this before it finished, for example because you signed out. Try again.'
const NOT_ALLOWED =`ZenNotes Cloud didn't allow that on this account. ${REPORT}`
const NOT_FOUND = 'ZenNotes Cloud couldn\'t find that. It may have been deleted on another device.'

const UPLOAD_REFUSED =
  `A large file couldn't be uploaded to ZenNotes Cloud. It is safe on this device, and sync will try it again. If this keeps happening, update ZenNotes, then copy the details and choose Report an Issue.`
const UPLOAD_CHANGED =
  'A file changed while ZenNotes was uploading it. The newer version goes up on the next sync.'
const UPLOAD_UNEXPECTED =
  'ZenNotes Cloud gave an unexpected answer while a file was uploading, so ZenNotes stopped to keep your data safe. Sync will try again.'
const UPLOAD_BROKEN =
  "A large file didn't arrive in ZenNotes Cloud in one piece. It is safe on this device, and sync will upload it again."
const DOWNLOAD_INCOMPLETE =
  "A file from ZenNotes Cloud didn't finish downloading. Nothing on this device was changed. Sync will try again."
const REMOTE_CHANGED =
  'Files in Cloud changed while this device was syncing. Choose Sync now to try again.'
// A current sync never shows this: the coordinator rebuilds from the manifest
// on this answer, and its next pull starts at a cursor Cloud still keeps. The
// words are for anything else that meets the code.
const CATCHING_UP =
  "This device was away longer than ZenNotes Cloud keeps its list of changes, so sync is catching up by comparing every file with Cloud. Edits made on this device are kept. Choose Sync now if it hasn't finished."
const CONTENT_UNAVAILABLE =
  `A file stored in ZenNotes Cloud is missing or damaged, so this device can't download it. Your copy on this device is unchanged. Copy the details and choose Report an Issue.`

const RESOURCE_BUSY = 'ZenNotes Cloud is busy with this vault, usually making a backup. Try again in a minute.'
const SUSPENDED =
  "This ZenNotes Cloud account is suspended, so it can't sync. Your notes stay on this device. Choose Report an Issue if you need help."
// Only in invite-only mode, where buying a plan does not open Cloud.
const ACCESS_NOT_ENABLED =
  "ZenNotes Cloud is invite-only right now, and this account hasn't been invited yet. Your notes stay on this device."
const VAULT_LIMIT =
  "Your plan's limit on Cloud vaults is reached. Delete a Cloud vault you no longer need, or change your plan under Billing on zennotes.org."
const CAPACITY_FULL =
  'Your ZenNotes Cloud plan is full, so some changes are waiting on this device. Delete files you no longer need, or change your plan under Billing on zennotes.org.'
const FILE_TOO_LARGE =
  "A file is larger than your plan's Cloud file-size limit, so it stays on this device. Remove it or make it smaller to finish syncing."
const PUBLISH_FULL =
  "Publishing this note would go over your plan's publishing limit. Unpublish notes you no longer need, or change your plan under Billing on zennotes.org."
const PUBLISH_FILE_TOO_LARGE =
  'An attachment in this note is larger than the publishing size limit. Remove it or make it smaller, then publish again.'
const VAULT_NAME_TOO_LONG = 'Use a Cloud vault name of 255 characters or fewer.'
export const CLOUD_VAULT_NAME_REQUIRED_MESSAGE = 'Give the new Cloud vault a name.'
export const CLOUD_NOT_SIGNED_IN_MESSAGE =
  "This device isn't signed in to ZenNotes Cloud. Choose Connect ZenNotes Cloud in Settings → Cloud."
export const CLOUD_NOT_LINKED_MESSAGE =
  "This vault isn't linked to a Cloud vault yet. Choose one under This vault in Settings → Cloud."
export const CLOUD_OTHER_ACCOUNT_MESSAGE =
  'This vault syncs with a different ZenNotes Cloud account than the one signed in. Sign in with that account, or unlink this device and choose a vault from this one.'
export const CLOUD_SIGN_IN_EXPIRED_MESSAGE =
  'This sign-in has expired. Sign-in requests last five minutes. Choose Connect ZenNotes Cloud to start again.'
export const CLOUD_SIGN_IN_REFUSED_MESSAGE =
  "This sign-in didn't go through, usually because it took longer than five minutes or the approval page was used twice. Choose Connect ZenNotes Cloud to start again."
export const CLOUD_SIGN_IN_UNEXPECTED_MESSAGE =
  'ZenNotes Cloud sent an unexpected answer while signing you in. Try again in a few minutes.'
export const CLOUD_SIGN_IN_OFFLINE_MESSAGE =
  "ZenNotes couldn't reach ZenNotes Cloud to finish signing in. Check that this device is online, then choose Connect ZenNotes Cloud again."
export const CLOUD_SIGN_IN_BUSY_MESSAGE =
  'ZenNotes Cloud asked for a pause after several sign-in attempts. Wait a minute, then choose Connect ZenNotes Cloud again.'
export const CLOUD_SIGN_IN_TROUBLE_MESSAGE =
  "ZenNotes Cloud is having trouble right now, so sign-in didn't finish. This is on our side, not yours. Choose Connect ZenNotes Cloud again in a few minutes."

const KEYSET_CHANGED = 'Your encryption settings just changed on another device. Try again.'
const KEYSET_NOT_FOUND =
  "End-to-end encryption isn't set up for this account. Set it up in Settings → Cloud first."
const KEYSET_EXISTS =
  'End-to-end encryption is already set up for this account. Unlock it with your passphrase instead.'
const E2EE_NOT_AVAILABLE = "End-to-end encryption isn't available for this account yet."
const E2EE_DAMAGED =
  `ZenNotes couldn't open an encrypted file from Cloud. It may be damaged or incomplete, so your copy on this device was left as it is. Sync again. ${REPORT}`
const E2EE_NEWER =
  'This vault was encrypted by a newer version of ZenNotes. Update ZenNotes on this device to open it.'
const E2EE_CLIENT_REQUIRED = 'This vault is end-to-end encrypted. Update ZenNotes on this device to sync it.'

const BACKUP_UNAVAILABLE =
  "This backup can't be downloaded right now. Try Save archive again in a few minutes; if it keeps failing, choose another backup."
const BACKUP_NOT_RESTORABLE = "This backup isn't ready yet, or it has expired. Choose another backup."

const DISK_FULL =
  "This device is out of storage space, so sync couldn't save a file. Free up some space, then choose Sync now."
const NO_PERMISSION =
  "ZenNotes isn't allowed to change a file in this vault on this device. Check the vault folder's permissions, then choose Sync now."
const BAD_FILE_NAME =
  'That file name can\'t be used on every device. Avoid the characters : * ? " < > | and try another name.'
const LOCAL_FILE_FAILED =
  "ZenNotes couldn't read or write a file in this vault on this device. Choose Sync now to try again."

const FEATURE_NAMES: Record<string, string> = { sync: 'Sync', backup: 'Backups', publish: 'Publishing' }

/** Errors whose name says the code itself broke, not Cloud or the network. */
const PROGRAM_ERROR_NAMES = new Set([
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'OperationError',
  'DataError',
  'InvalidAccessError',
  'NotSupportedError'
])

const NETWORK_SYSTEM_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
])

/** Fetch failures as each runtime words them: undici, Chromium, WebKit, Firefox. */
const NETWORK_TEXT =
  /^fetch failed\b|^Failed to fetch\b|^Load failed$|NetworkError when attempting to fetch|network connection was lost|Internet connection appears to be offline|net::ERR_|^getaddrinfo\b|socket hang up|Could not connect to the server/i
const TIMEOUT_TEXT = /operation was aborted due to timeout|request timed out|signal timed out/i

/** Server codes whose own sentence is already written for people. */
const PLAIN_SERVER_CODES = new Set(['VAULT_CHANGED', 'BACKUP_QUOTA_EXCEEDED', 'RESTORE_ACCESS_REVOKED', 'GONE'])

interface RawCloudError {
  name: string
  text: string
  status: number | null
  code: string | null
  details: Record<string, unknown> | null
  causeCode: string | null
  issue: CloudIssue | null
  path: string | null
  stalled: boolean
}

/**
 * The words for `error`. `fallback` is the sentence for an error that carries
 * no text at all; anything else is worded from what it says about itself.
 */
export function describeCloudError(error: unknown, fallback = CLOUD_UNEXPECTED_MESSAGE): CloudErrorCopy {
  const raw = rawCloudError(error)

  // Already worded, by the desktop main process before IPC.
  const marker = raw.text.indexOf(CLOUD_ERROR_DETAILS_MARKER)
  if (marker >= 0) {
    const message = raw.text.slice(0, marker).trim()
    const detail = raw.text.slice(marker + CLOUD_ERROR_DETAILS_MARKER.length).trim()
    return { message, detail: detail || null, kind: cloudErrorKindOf(message) }
  }

  const worded = (message: string, kind: CloudErrorKind = 'other'): CloudErrorCopy => ({
    message,
    detail: technicalLine(raw),
    kind
  })

  if (raw.issue) return worded(issueMessage(raw.issue, raw.path))
  if (raw.name === 'AbortError') return worded(STOPPED)
  // A phone request that got no answer, after its retries: the host already
  // knows whether the connection went quiet or failed outright.
  if (raw.name === 'CloudSyncTransportError') {
    return worded(raw.stalled ? CLOUD_TIMEOUT_MESSAGE : CLOUD_OFFLINE_MESSAGE, 'offline')
  }
  if (isTimeout(raw)) return worded(CLOUD_TIMEOUT_MESSAGE, 'offline')
  if (isNetworkFailure(raw)) return worded(CLOUD_OFFLINE_MESSAGE, 'offline')

  // Status and code are what word a service error. One that crossed IPC
  // unworded kept neither, and its own sentence is all there is to show.
  if (raw.name === 'CloudServiceRequestError' && (raw.status !== null || raw.code !== null)) {
    const service = serviceMessage(raw)
    if (service === null) return { message: raw.text || fallback, detail: null, kind: 'other' }
    return worded(service.message, service.kind)
  }

  if (raw.name === 'CloudE2eeError') {
    const code = raw.code ?? ''
    if (['tampered', 'malformed', 'invalid-metadata', 'wrong-purpose'].includes(code)) return worded(E2EE_DAMAGED)
    if (['unsupported', 'wrong-key-version', 'invalid-kdf'].includes(code)) return worded(E2EE_NEWER)
    return { message: raw.text || fallback, detail: null, kind: 'other' }
  }

  if (raw.name === 'CloudSyncLocalEditConflictError' && raw.path) {
    return worded(
      `Sync stopped because “${fileName(raw.path)}” is a folder on this device but a file in Cloud. Rename one of them, then choose Sync now.`
    )
  }

  const system = systemErrorMessage(raw)
  if (system) return worded(system)
  // normalizeCloudSyncPath's refusal, met when a name is typed for a kept copy.
  if (raw.text.startsWith('Invalid sync path:')) return worded(BAD_FILE_NAME)

  if (PROGRAM_ERROR_NAMES.has(raw.name)) return worded(CLOUD_UNEXPECTED_MESSAGE)
  if (raw.text === '') return { message: fallback, detail: null, kind: 'other' }

  // Everything else was thrown with a sentence meant for people.
  return { message: raw.text, detail: null, kind: cloudErrorKindOf(raw.text) }
}

/**
 * A failed sign-in exchange, in sign-in words. Sign-in never retries by itself
 * and the request it answered is spent, so the sync sentences ("sync will try
 * again in a few minutes") would promise something that does not happen.
 * Unreachable, busy and broken service become "connect again"; anything else
 * (a refused code, an unexpected answer) is returned unchanged for the host to
 * word.
 */
export function cloudSignInExchangeError(error: unknown): unknown {
  const raw = rawCloudError(error)
  const copy = describeCloudError(error)
  const message =
    copy.kind === 'offline'
      ? CLOUD_SIGN_IN_OFFLINE_MESSAGE
      : raw.status === 429 || raw.code === 'RATE_LIMITED'
        ? CLOUD_SIGN_IN_BUSY_MESSAGE
        : raw.status !== null && raw.status >= 500
          ? CLOUD_SIGN_IN_TROUBLE_MESSAGE
          : null
  if (message === null) return error
  return new Error(encodeCloudErrorMessage({ message, detail: copy.detail, kind: 'other' }))
}

/**
 * The message the desktop main process throws across IPC: the sentence, then
 * the technical line after a marker app-core splits off again.
 */
export function encodeCloudErrorMessage(copy: CloudErrorCopy): string {
  return copy.detail ? `${copy.message}${CLOUD_ERROR_DETAILS_MARKER}${copy.detail}` : copy.message
}

/** The kind of an already worded message, which is all IPC carries across. */
export function cloudErrorKindOf(message: string): CloudErrorKind {
  if (message === CLOUD_OFFLINE_MESSAGE || message === CLOUD_TIMEOUT_MESSAGE) return 'offline'
  if (message === CLOUD_SIGNED_OUT_MESSAGE) return 'signed-out'
  return 'other'
}

function issueMessage(issue: CloudIssue, path: string | null): string {
  switch (issue) {
    case 'download-incomplete':
      return DOWNLOAD_INCOMPLETE
    case 'download-damaged':
      return `${path ? `“${fileName(path)}”` : 'A file from ZenNotes Cloud'} arrived damaged, so ZenNotes didn't use it. Your copy on this device is unchanged. Choose Sync now to download it again.`
    case 'remote-changed':
      return REMOTE_CHANGED
    case 'path-collision':
      return `Two files in this vault have names that differ only in capital letters${path ? `, such as “${path}”` : ''}. Some devices can't tell them apart. Rename one of them, then choose Sync now.`
    case 'protocol':
      return CLOUD_UNEXPECTED_ANSWER_MESSAGE
  }
}

function serviceMessage(raw: RawCloudError): { message: string; kind: CloudErrorKind } | null {
  const status = raw.status ?? 0
  const code = raw.code
  const dimension = typeof raw.details?.dimension === 'string' ? raw.details.dimension : ''
  const other = (message: string) => ({ message, kind: 'other' as const })

  if (isRefusedSignIn(raw)) return { message: CLOUD_SIGNED_OUT_MESSAGE, kind: 'signed-out' }

  switch (code) {
    case 'RATE_LIMITED':
      return other(SLOW_DOWN)
    case 'FEATURE_NOT_ENTITLED':
      return other(featureMessage(raw.details?.feature))
    case 'ACCOUNT_SUSPENDED':
      return other(SUSPENDED)
    case 'CLOUD_ACCESS_NOT_ENABLED':
      return other(ACCESS_NOT_ENABLED)
    // The limit's dimension says which one; the sentences are the fallback for a
    // service that sent none, in its old words and its current ones.
    case 'SYNC_QUOTA_EXCEEDED':
    case 'QUOTA_EXCEEDED':
    case 'CAPACITY_EXCEEDED':
      if (dimension === 'sync_active_vaults' || raw.details?.limit === 'max_vaults' || /vault limit|limit on Cloud vaults/i.test(raw.text)) {
        return other(VAULT_LIMIT)
      }
      if (dimension.startsWith('publish') || /publish/i.test(raw.text)) return other(PUBLISH_FULL)
      if (/^Restoring this (note|backup)/i.test(raw.text)) return null
      return other(CAPACITY_FULL)
    case 'FILE_SIZE_LIMIT_EXCEEDED':
      if (dimension === 'publish_max_asset_bytes' || /published asset|publishing size limit/i.test(raw.text)) {
        return other(PUBLISH_FILE_TOO_LARGE)
      }
      if (/^(This backup note|A file in this backup)/i.test(raw.text)) return null
      return other(FILE_TOO_LARGE)
    case 'RESOURCE_BUSY':
      return other(RESOURCE_BUSY)
    case 'VALIDATION_FAILED':
      if (/^The name field must not be greater than/i.test(raw.text)) return other(VAULT_NAME_TOO_LONG)
      if (/^The name field is required/i.test(raw.text)) return other(CLOUD_VAULT_NAME_REQUIRED_MESSAGE)
      return other(CLOUD_UNEXPECTED_ANSWER_MESSAGE)
    case 'SYNC_CONTENT_UNAVAILABLE':
      return other(CONTENT_UNAVAILABLE)
    case 'CURSOR_EXPIRED':
      return other(CATCHING_UP)
    case 'UPLOAD_EXPIRED':
    case 'UPLOAD_NOT_RESTARTABLE':
    case 'UPLOAD_NOT_FOUND':
    case 'UPLOAD_SIZE_MISMATCH':
    case 'UPLOAD_HASH_MISMATCH':
    case 'UPLOAD_NOT_COMPLETABLE':
    case 'UPLOAD_FINALIZATION_FAILED':
      return other(UPLOAD_BROKEN)
    case 'DIRECT_UPLOAD_FAILED':
      return other(UPLOAD_REFUSED)
    case 'DIRECT_UPLOAD_SIZE_MISMATCH':
      return other(UPLOAD_CHANGED)
    case 'INVALID_DIRECT_UPLOAD_RESPONSE':
    case 'INSECURE_DIRECT_UPLOAD_URL':
      return other(UPLOAD_UNEXPECTED)
    case 'KEYSET_REVISION_CONFLICT':
      return other(KEYSET_CHANGED)
    case 'KEYSET_NOT_FOUND':
      return other(KEYSET_NOT_FOUND)
    case 'KEYSET_EXISTS':
      return other(KEYSET_EXISTS)
    case 'E2EE_NOT_AVAILABLE':
      return other(E2EE_NOT_AVAILABLE)
    case 'E2EE_CLIENT_REQUIRED':
      return other(E2EE_CLIENT_REQUIRED)
    case 'VAULT_SUPERSEDED':
      return other(CLOUD_VAULT_SUPERSEDED_MESSAGE)
    case 'BACKUP_NOT_AVAILABLE':
    case 'BACKUP_ARCHIVE_MISSING':
    case 'BACKUP_ARCHIVE_UNAVAILABLE':
      return other(BACKUP_UNAVAILABLE)
    case 'BACKUP_NOT_RESTORABLE':
      return other(BACKUP_NOT_RESTORABLE)
  }

  // The rest of the restore-a-note answers are written for people.
  if (code !== null && (PLAIN_SERVER_CODES.has(code) || code === 'PATH_CONFLICT') && raw.text) return null

  if (status === 429) return other(SLOW_DOWN)
  if (status >= 500) return other(SERVER_TROUBLE)
  if (!isCloudApiAnswer(raw)) return other(NOT_CLOUD_ANSWER)
  if (status === 404) return other(NOT_FOUND)
  if (status === 403) return other(NOT_ALLOWED)
  return other(CLOUD_UNEXPECTED_ANSWER_MESSAGE)
}

/**
 * Cloud's API refusing this device's sign-in. Only that answer signs the
 * device out, and signing out revokes the device on the service: a storage
 * host's 401 on a presigned upload (DIRECT_UPLOAD_FAILED) or a proxy's 401
 * page once revoked a device whose sign-in was fine.
 */
function isRefusedSignIn(raw: RawCloudError): boolean {
  if (raw.code === 'UNAUTHENTICATED' || raw.code === 'ACTIVE_DEVICE_REQUIRED') return true
  if (raw.code !== null || !isCloudApiAnswer(raw)) return false
  return raw.status === 401 || (raw.status === 403 && raw.text === 'Invalid ability provided.')
}

/** The clients' own words for a body that was not Cloud's JSON: a proxy or
 *  captive-portal page, an empty body, or a cut-off one. */
const NOT_CLOUD_BODY =
  /^ZenNotes Cloud request failed \(\d+\)\.$|invalid JSON response|returned an unexpected response/i

function isCloudApiAnswer(raw: RawCloudError): boolean {
  return raw.text !== '' && !NOT_CLOUD_BODY.test(raw.text)
}

function featureMessage(feature: unknown): string {
  const name = typeof feature === 'string' ? FEATURE_NAMES[feature] : undefined
  if (!name) {
    return "That isn't part of your current plan, or your plan has ended. Choose a plan under Billing on zennotes.org. Your notes stay on this device."
  }
  const keep = feature === 'sync' ? 'to keep syncing' : feature === 'backup' ? 'to keep making backups' : 'to publish notes'
  return `${name} isn't part of your current plan, or your plan has ended. Choose a plan under Billing on zennotes.org ${keep}. Your notes stay on this device.`
}

function systemErrorMessage(raw: RawCloudError): string | null {
  const code = raw.code
  if (code === null || !/^E[A-Z]+$/.test(code)) return null
  if (code === 'ENOSPC' || code === 'EDQUOT') return DISK_FULL
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return NO_PERMISSION
  return LOCAL_FILE_FAILED
}

function isTimeout(raw: RawCloudError): boolean {
  return raw.name === 'TimeoutError' || TIMEOUT_TEXT.test(raw.text) ||
    raw.causeCode === 'UND_ERR_CONNECT_TIMEOUT' || raw.causeCode === 'UND_ERR_HEADERS_TIMEOUT'
}

function isNetworkFailure(raw: RawCloudError): boolean {
  return NETWORK_TEXT.test(raw.text) ||
    (raw.code !== null && NETWORK_SYSTEM_CODES.has(raw.code)) ||
    (raw.causeCode !== null && NETWORK_SYSTEM_CODES.has(raw.causeCode))
}

/** "HTTP 411 · DIRECT_UPLOAD_FAILED · ZenNotes Cloud object upload failed (411)." */
function technicalLine(raw: RawCloudError): string {
  const parts: string[] = []
  if (raw.status !== null) parts.push(`HTTP ${raw.status}`)
  if (raw.code !== null) parts.push(raw.code)
  else if (raw.issue !== null) parts.push(raw.issue)
  // The status already says it came from the service; the class name is noise.
  else if (raw.name !== 'Error' && raw.name !== 'CloudServiceRequestError') parts.push(raw.name)
  if (raw.causeCode !== null && raw.causeCode !== raw.code) parts.push(raw.causeCode)
  parts.push(raw.text || '(no message)')
  return parts.join(' · ')
}

function rawCloudError(error: unknown): RawCloudError {
  const value = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown
    message?: unknown
    status?: unknown
    code?: unknown
    details?: unknown
    cause?: unknown
    issue?: unknown
    path?: unknown
    relPath?: unknown
    stalled?: unknown
  }
  const message =
    typeof error === 'string' ? error : typeof value.message === 'string' ? value.message : error == null ? '' : String(error)
  const { name: prefixName, text } = stripIpcPrefix(message)
  const ownName = typeof value.name === 'string' && value.name ? value.name : 'Error'
  const cause = value.cause as { code?: unknown } | null | undefined
  return {
    // A name that only survived IPC as a prefix ("TypeError: fetch failed").
    name: ownName === 'Error' && prefixName ? prefixName : ownName,
    text,
    status: typeof value.status === 'number' && Number.isInteger(value.status) && value.status > 0 ? value.status : null,
    code: typeof value.code === 'string' && value.code ? value.code : null,
    details:
      value.details && typeof value.details === 'object' && !Array.isArray(value.details)
        ? (value.details as Record<string, unknown>)
        : null,
    causeCode: cause && typeof cause === 'object' && typeof cause.code === 'string' ? cause.code : null,
    issue: ownName === 'CloudIssueError' && typeof value.issue === 'string' ? (value.issue as CloudIssue) : null,
    path: typeof value.path === 'string' ? value.path : typeof value.relPath === 'string' ? value.relPath : null,
    stalled: value.stalled === true
  }
}

/** Electron wraps a main-process rejection as "Error invoking remote method
 *  'x': <Name>: <message>"; the name is kept, since it tells some apart. */
function stripIpcPrefix(message: string): { name: string | null; text: string } {
  const unwrapped = message.replace(/^Error invoking remote method '[^']*':\s*/, '')
  const named = /^([A-Z][A-Za-z0-9]*)?Error:\s*/.exec(unwrapped)
  if (!named) return { name: null, text: unwrapped.trim() }
  return { name: `${named[1] ?? ''}Error`, text: unwrapped.slice(named[0].length).trim() }
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
