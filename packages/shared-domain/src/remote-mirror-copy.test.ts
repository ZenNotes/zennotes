import { describe, expect, it } from 'vitest'
import { describeRemoteMirrorError, isRemoteMirrorUnreachable, renameCloud } from './remote-mirror-copy'

class ServiceError extends Error {
  override name = 'CloudServiceRequestError'
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message)
  }
}

class Unreachable extends Error {
  override name = 'RemoteMirrorUnreachableError'
}

describe('describeRemoteMirrorError', () => {
  it('calls an unreachable server offline and names it', () => {
    const copy = describeRemoteMirrorError(new Unreachable('Could not connect'), 'Home server')
    expect(copy.kind).toBe('offline')
    expect(copy.message).toContain("Home server can't be reached")
    expect(isRemoteMirrorUnreachable(new TypeError('fetch failed'))).toBe(true)
  })

  it('says a vault switch stopped sync and kept the copy', () => {
    const copy = describeRemoteMirrorError(new ServiceError('x', 409, 'VAULT_MISMATCH'), 'Home server')
    expect(copy.message).toContain('now serves a different vault')
    expect(copy.detail).toContain('VAULT_MISMATCH')
  })

  it('names the release an old server needs', () => {
    expect(describeRemoteMirrorError(new ServiceError('404 page not found', 404, null), 'Home server').message).toContain('2.91.1')
  })

  it('never says Cloud about a server', () => {
    const copy = describeRemoteMirrorError(new Error('The Cloud version of this file is not available right now.'), 'Home server')
    expect(copy.message).toBe('The Home server version of this file is not available right now.')
  })
})

describe('renameCloud', () => {
  it('replaces every way the engine names Cloud', () => {
    expect(renameCloud('ZenNotes Cloud did not confirm. Another file in Cloud uses it.', 'NAS')).toBe(
      'NAS did not confirm. Another file on NAS uses it.'
    )
  })
})
