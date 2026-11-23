import { describe, expect, it } from 'vitest'
import {
  isNoteChangedOnServerError,
  noteChangedOnServerMessage,
  rewriteNoteOnServer,
  validBaseSha256
} from './remote-conditional-write'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

class StatusError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

describe('conditional note writes (#1108)', () => {
  it('recognizes a refusal by its status and, across IPC, by its sentence', () => {
    expect(isNoteChangedOnServerError(new StatusError('nope', 409))).toBe(true)
    expect(
      isNoteChangedOnServerError(
        new Error(
          `Error invoking remote method 'vault:write-note': RemoteRequestError: ${noteChangedOnServerMessage('inbox/A.md')}`
        )
      )
    ).toBe(true)
    expect(isNoteChangedOnServerError(new StatusError('gone', 404))).toBe(false)
    expect(isNoteChangedOnServerError(new Error('Could not connect'))).toBe(false)
  })

  it('passes on only a well-formed hash', () => {
    expect(validBaseSha256(HASH_A)).toBe(HASH_A)
    expect(validBaseSha256(HASH_A.toUpperCase())).toBe(HASH_A.toUpperCase())
    expect(validBaseSha256('abc')).toBeUndefined()
    expect(validBaseSha256(undefined)).toBeUndefined()
    expect(validBaseSha256({ toString: () => HASH_A })).toBeUndefined()
  })

  it('writes on the version it read, and redoes the change on a newer one', async () => {
    let server = { body: 'one\n', sha256: HASH_A }
    const writes: Array<{ body: string; base: string | undefined }> = []
    let raced = false
    const result = await rewriteNoteOnServer(
      {
        read: async () => server,
        write: async (body, base) => {
          if (!raced) {
            // Another device saves between this read and this write.
            raced = true
            server = { body: 'one\ntheirs\n', sha256: HASH_B }
          }
          if (base !== server.sha256) throw new StatusError('changed', 409)
          writes.push({ body, base })
          return body
        }
      },
      (body) => `${body}mine\n`
    )
    expect(result).toBe('one\ntheirs\nmine\n')
    expect(writes).toEqual([{ body: 'one\ntheirs\nmine\n', base: HASH_B }])
  })

  it('writes nothing when the change is empty, and gives up after a few refusals', async () => {
    let wrote = false
    expect(
      await rewriteNoteOnServer(
        {
          read: async () => ({ body: 'x', sha256: HASH_A }),
          write: async () => {
            wrote = true
          }
        },
        () => null
      )
    ).toBeNull()
    expect(wrote).toBe(false)

    let attempts = 0
    await expect(
      rewriteNoteOnServer(
        {
          read: async () => ({ body: 'x', sha256: HASH_A }),
          write: async () => {
            attempts += 1
            throw new StatusError('changed', 409)
          }
        },
        (body) => `${body}!`
      )
    ).rejects.toThrow('changed')
    expect(attempts).toBe(3)
  })

  it('sends no base to a server that returned no hash', async () => {
    const bases: Array<string | undefined> = []
    await rewriteNoteOnServer(
      {
        read: async () => ({ body: 'x' }),
        write: async (_body, base) => {
          bases.push(base)
        }
      },
      (body) => `${body}!`
    )
    expect(bases).toEqual([undefined])
  })
})
