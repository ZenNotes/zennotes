import { describe, expect, it } from 'vitest'
import {
  CLOUD_OFFLINE_MESSAGE,
  CLOUD_SIGN_IN_BUSY_MESSAGE,
  CLOUD_SIGN_IN_OFFLINE_MESSAGE,
  CLOUD_SIGN_IN_TROUBLE_MESSAGE,
  CLOUD_SIGNED_OUT_MESSAGE,
  CLOUD_TIMEOUT_MESSAGE,
  CLOUD_UNEXPECTED_ANSWER_MESSAGE,
  CLOUD_UNEXPECTED_MESSAGE,
  CloudIssueError,
  cloudProtocolError,
  cloudSignInExchangeError,
  describeCloudError,
  encodeCloudErrorMessage
} from './cloud-error-copy'
import { CLOUD_VAULT_REMOVED_MESSAGE } from './cloud-vault-availability'
import { CloudE2eeError } from './cloud-e2ee'
import { CloudSyncTransportError } from './cloud-sync-stall'

/** The shape both the desktop client and the phone shells throw. */
function serviceError(
  message: string,
  status: number,
  code: string | null,
  details: Record<string, unknown> | null = null
): Error {
  return Object.assign(new Error(message), { name: 'CloudServiceRequestError', status, code, details })
}

/** What a renderer receives for a main-process rejection. */
function overIpc(channel: string, error: Error): Error {
  return new Error(`Error invoking remote method '${channel}': ${error.name}: ${error.message}`)
}

describe('describeCloudError', () => {
  it('words a network failure and keeps the runtime text as the detail', () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND zennotes.org'), { code: 'ENOTFOUND' }) })
    expect(describeCloudError(error)).toEqual({
      message: CLOUD_OFFLINE_MESSAGE,
      detail: 'TypeError · ENOTFOUND · fetch failed',
      kind: 'offline'
    })
  })

  it('recognises "fetch failed" that only survived IPC as text', () => {
    const copy = describeCloudError(overIpc('cloud-vault:sync', new TypeError('fetch failed')))
    expect(copy.message).toBe(CLOUD_OFFLINE_MESSAGE)
    expect(copy.kind).toBe('offline')
    expect(copy.detail).toBe('TypeError · fetch failed')
  })

  it('words the phones\' fetch failures the same way', () => {
    expect(describeCloudError(new TypeError('Load failed')).message).toBe(CLOUD_OFFLINE_MESSAGE)
    expect(describeCloudError(new TypeError('Failed to fetch')).message).toBe(CLOUD_OFFLINE_MESSAGE)
  })

  it('words a timeout', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(describeCloudError(timeout)).toMatchObject({ message: CLOUD_TIMEOUT_MESSAGE, kind: 'offline' })
    expect(describeCloudError(overIpc('cloud-vault:sync', timeout)).message).toBe(CLOUD_TIMEOUT_MESSAGE)
  })

  it('words a phone request that stalled or never connected, keeping the host\'s words as details', () => {
    const stalled = new CloudSyncTransportError('timeout', { stalled: true, code: 'SocketTimeoutException' })
    expect(describeCloudError(stalled)).toEqual({
      message: CLOUD_TIMEOUT_MESSAGE,
      detail: 'SocketTimeoutException · timeout',
      kind: 'offline'
    })
    const refused = new CloudSyncTransportError('Unable to resolve host', { code: 'UnknownHostException' })
    expect(describeCloudError(refused)).toMatchObject({ message: CLOUD_OFFLINE_MESSAGE, kind: 'offline' })
  })

  it('treats a refused sign-in as signed out, whatever the server says', () => {
    for (const error of [
      serviceError('Authentication is required.', 401, 'UNAUTHENTICATED'),
      serviceError('This access token is not bound to an active device.', 403, 'ACTIVE_DEVICE_REQUIRED'),
      serviceError('Invalid ability provided.', 403, null)
    ]) {
      expect(describeCloudError(error)).toMatchObject({ message: CLOUD_SIGNED_OUT_MESSAGE, kind: 'signed-out' })
    }
  })

  it('signs out only when Cloud\'s API refuses the sign-in, never a storage host or a proxy', () => {
    // A presigned upload the storage host answered 401: an upload that could not finish.
    const storage = describeCloudError(
      serviceError('ZenNotes Cloud object upload failed (401).', 401, 'DIRECT_UPLOAD_FAILED')
    )
    expect(storage.kind).toBe('other')
    expect(storage.message).toMatch(/^A large file couldn't be uploaded to ZenNotes Cloud\./)
    // A proxy or portal page: not Cloud's JSON, so not Cloud's answer.
    for (const text of ['ZenNotes Cloud returned an invalid JSON response.', 'ZenNotes Cloud request failed (401).', 'ZenNotes Cloud returned an unexpected response.']) {
      const proxy = describeCloudError(serviceError(text, 401, null))
      expect(proxy.kind).toBe('other')
      expect(proxy.message).toMatch(/public Wi-Fi/)
    }
    // Cloud's own refusals still sign out, with or without the code.
    expect(describeCloudError(serviceError('Unauthenticated.', 401, null)).kind).toBe('signed-out')
    expect(describeCloudError(serviceError('Authentication is required.', 401, 'UNAUTHENTICATED')).kind).toBe('signed-out')
    expect(describeCloudError(serviceError('Removed.', 403, 'ACTIVE_DEVICE_REQUIRED')).kind).toBe('signed-out')
    expect(describeCloudError(serviceError('Out of date.', 403, 'UNAUTHENTICATED')).kind).toBe('signed-out')
  })

  it('never signs out over a refusal from file storage', () => {
    const storage = Object.assign(new Error('Cloud object download failed.'), { status: 401 })
    expect(describeCloudError(storage).kind).not.toBe('signed-out')
  })

  it('words the 411 upload refusal and keeps status and code for support', () => {
    const copy = describeCloudError(
      serviceError('ZenNotes Cloud object upload failed (411).', 411, 'DIRECT_UPLOAD_FAILED')
    )
    expect(copy.message).toMatch(/^A large file couldn't be uploaded to ZenNotes Cloud\./)
    expect(copy.message).not.toMatch(/411/)
    expect(copy.detail).toBe('HTTP 411 · DIRECT_UPLOAD_FAILED · ZenNotes Cloud object upload failed (411).')
  })

  it('names the feature a plan lacks', () => {
    const copy = describeCloudError(
      serviceError('Your account does not include this feature.', 403, 'FEATURE_NOT_ENTITLED', { feature: 'sync' })
    )
    expect(copy.message).toBe(
      "Sync isn't part of your current plan, or your plan has ended. Choose a plan under Billing on zennotes.org to keep syncing. Your notes stay on this device."
    )
  })

  it('tells the vault limit, the publishing limit and storage apart', () => {
    expect(describeCloudError(serviceError('Your account has reached its synced vault limit.', 409, 'CAPACITY_EXCEEDED')).message)
      .toMatch(/limit on Cloud vaults/)
    expect(describeCloudError(serviceError('This publish operation would exceed account capacity.', 409, 'CAPACITY_EXCEEDED')).message)
      .toMatch(/publishing limit/)
    expect(describeCloudError(serviceError('Over capacity.', 409, 'CAPACITY_EXCEEDED')).message)
      .toMatch(/^Your ZenNotes Cloud plan is full/)
  })

  it('reads which limit from its dimension, and the service\'s current sentences too', () => {
    expect(describeCloudError(serviceError('Your plan\'s limit on Cloud vaults is reached.', 409, 'CAPACITY_EXCEEDED', { dimension: 'sync_active_vaults' })).message)
      .toMatch(/limit on Cloud vaults/)
    expect(describeCloudError(serviceError('An attachment in this note is larger than the publishing size limit.', 409, 'FILE_SIZE_LIMIT_EXCEEDED', { dimension: 'publish_max_asset_bytes' })).message)
      .toMatch(/^An attachment in this note/)
    const restoreLimit = 'Restoring this backup would go over your plan\'s Cloud storage.'
    expect(describeCloudError(serviceError(restoreLimit, 409, 'CAPACITY_EXCEEDED')).message).toBe(restoreLimit)
    const restoreFile = 'A file in this backup is larger than your plan\'s file-size limit, so the backup can\'t be restored to Cloud.'
    expect(describeCloudError(serviceError(restoreFile, 409, 'FILE_SIZE_LIMIT_EXCEEDED')).message).toBe(restoreFile)
  })

  it('treats a 403 asking to sign in again as signed out', () => {
    expect(describeCloudError(serviceError("This device's sign-in to ZenNotes Cloud is out of date.", 403, 'UNAUTHENTICATED')).kind)
      .toBe('signed-out')
  })

  it('words server trouble, rate limits and maintenance without a code', () => {
    expect(describeCloudError(serviceError('Server Error', 500, null)).message).toMatch(/having trouble right now/)
    expect(describeCloudError(serviceError('Service Unavailable', 503, null)).message).toMatch(/having trouble right now/)
    expect(describeCloudError(serviceError('Too many requests. Try again shortly.', 429, 'RATE_LIMITED')).message)
      .toMatch(/slow down/)
    expect(describeCloudError(serviceError('ZenNotes Cloud request failed (500).', 500, null)).message)
      .not.toMatch(/500/)
    expect(describeCloudError(serviceError('Server Error', 500, null)).detail).toBe('HTTP 500 · Server Error')
  })

  it('words a page that is not Cloud\'s answer', () => {
    expect(describeCloudError(serviceError('ZenNotes Cloud returned an invalid JSON response.', 200, null)).message)
      .toMatch(/public Wi-Fi/)
  })

  it('keeps developer wording from the server in the detail only', () => {
    const copy = describeCloudError(
      serviceError('This cursor is older than the retained change log. Rebuild this vault from its manifest.', 410, 'CURSOR_EXPIRED')
    )
    // Sync catches up from the manifest by itself, so the words reassure
    // instead of sending the person to Report an Issue.
    expect(copy.message).toMatch(/catching up/)
    expect(copy.message).not.toMatch(/Report an Issue|manifest/)
    expect(copy.detail).toContain('CURSOR_EXPIRED')
    expect(copy.detail).toContain('manifest')
  })

  it('lets the server\'s own plain restore sentences through', () => {
    const plain = 'The vault changed before this note could be restored. Sync and try again.'
    expect(describeCloudError(serviceError(plain, 409, 'VAULT_CHANGED'))).toEqual({ message: plain, detail: null, kind: 'other' })
  })

  it('words a vault name that is too long', () => {
    expect(describeCloudError(
      serviceError('The name field must not be greater than 255 characters.', 422, 'VALIDATION_FAILED')
    ).message).toBe('Use a Cloud vault name of 255 characters or fewer.')
  })

  it('words internal checks and keeps their text for support', () => {
    const copy = describeCloudError(cloudProtocolError('Expected sync sequence 41, received 43'))
    expect(copy).toEqual({
      message: CLOUD_UNEXPECTED_ANSWER_MESSAGE,
      detail: 'protocol · Expected sync sequence 41, received 43',
      kind: 'other'
    })
  })

  it('names the file a damaged download belongs to', () => {
    const copy = describeCloudError(
      new CloudIssueError('download-damaged', 'Cloud revision for Notes/Plan.md has an invalid hash. Retry sync.', 'Notes/Plan.md')
    )
    expect(copy.message).toMatch(/^“Plan\.md” arrived damaged/)
  })

  it('words damaged encrypted data and a newer encryption format', () => {
    expect(describeCloudError(new CloudE2eeError('tampered', 'The encrypted data was changed or is incomplete.')).message)
      .toMatch(/couldn't open an encrypted file/)
    expect(describeCloudError(new CloudE2eeError('unsupported', 'Vault key version 3 needs a newer ZenNotes.')).message)
      .toMatch(/newer version of ZenNotes/)
  })

  it('keeps encryption sentences already written for people', () => {
    const wrong = new CloudE2eeError('wrong-key', "That passphrase didn't work.")
    expect(describeCloudError(wrong)).toEqual({ message: "That passphrase didn't work.", detail: null, kind: 'other' })
  })

  it('words local disk errors', () => {
    const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    expect(describeCloudError(full).message).toMatch(/out of storage space/)
    const denied = Object.assign(new Error("EACCES: permission denied, open '/v/a.md'"), { code: 'EACCES' })
    expect(describeCloudError(denied).message).toMatch(/isn't allowed to change a file/)
  })

  it('words a program error instead of showing it', () => {
    const copy = describeCloudError(new TypeError("Cannot read properties of undefined (reading 'path')"))
    expect(copy.message).toBe(CLOUD_UNEXPECTED_MESSAGE)
    expect(copy.detail).toContain('Cannot read properties')
  })

  it('passes sentences written for people through untouched', () => {
    expect(describeCloudError(new Error(CLOUD_VAULT_REMOVED_MESSAGE))).toEqual({
      message: CLOUD_VAULT_REMOVED_MESSAGE,
      detail: null,
      kind: 'other'
    })
    expect(describeCloudError(overIpc('cloud-vault-link:set', new Error('That ZenNotes Cloud vault is not available to this account.'))).message)
      .toBe('That ZenNotes Cloud vault is not available to this account.')
  })

  it('uses the fallback only for an error with no text', () => {
    expect(describeCloudError(new Error(''), 'Sync didn\'t finish.').message).toBe('Sync didn\'t finish.')
    expect(describeCloudError(undefined, 'Sync didn\'t finish.').message).toBe('Sync didn\'t finish.')
  })

  it('round-trips a worded error through the desktop IPC boundary', () => {
    const inMain = describeCloudError(serviceError('Authentication is required.', 401, 'UNAUTHENTICATED'))
    const rejected = new Error(`Error invoking remote method 'cloud-vault:sync': Error: ${encodeCloudErrorMessage(inMain)}`)
    expect(describeCloudError(rejected)).toEqual(inMain)
    // Wording twice changes nothing.
    expect(describeCloudError(new Error(encodeCloudErrorMessage(inMain)))).toEqual(inMain)
  })

  it('words a failed sign-in exchange as connect again, not as a sync that retries', () => {
    const words = (error: unknown) => describeCloudError(cloudSignInExchangeError(error))
    expect(words(serviceError('Too many requests.', 429, 'RATE_LIMITED')).message).toBe(CLOUD_SIGN_IN_BUSY_MESSAGE)
    const trouble = words(serviceError('Server Error', 503, null))
    expect(trouble).toEqual({ message: CLOUD_SIGN_IN_TROUBLE_MESSAGE, detail: 'HTTP 503 · Server Error', kind: 'other' })
    expect(words(new TypeError('fetch failed')).message).toBe(CLOUD_SIGN_IN_OFFLINE_MESSAGE)
    for (const message of [CLOUD_SIGN_IN_BUSY_MESSAGE, CLOUD_SIGN_IN_TROUBLE_MESSAGE, CLOUD_SIGN_IN_OFFLINE_MESSAGE]) {
      expect(message).not.toMatch(/sync/i)
    }
    // A refused code is the host's to word.
    const refused = serviceError('Invalid or expired code.', 422, null)
    expect(cloudSignInExchangeError(refused)).toBe(refused)
  })

  it('reads an error sent as bare text', () => {
    expect(describeCloudError('fetch failed').message).toBe(CLOUD_OFFLINE_MESSAGE)
  })
})
