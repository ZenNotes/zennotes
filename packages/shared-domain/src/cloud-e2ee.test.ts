import { createCipheriv, createHash, hkdfSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { argon2id } from 'hash-wasm'
import { describe, expect, it } from 'vitest'
import {
  CloudE2eeError,
  CloudPathIndex,
  type CloudE2eeItemMeta,
  type CloudE2eeKdfParams,
  type Zne1Purpose,
  ZNE1_CHUNK_BYTES,
  ZNE1_HEADER_BYTES,
  ZNE1_SEALED_CHUNK_BYTES,
  beginZne1Encryption,
  canonicalCloudPath,
  createZne1ChunkDecryptor,
  createZne1ChunkEncryptor,
  createZne1Decryptor,
  createZne1Encryptor,
  decryptItemMeta,
  decryptVaultName,
  decryptZne1,
  decryptZne1Stream,
  derivePassphraseKey,
  derivePathIndexKey,
  encryptItemMeta,
  encryptVaultName,
  encryptZne1,
  encryptZne1Stream,
  fromBase64,
  fromHex,
  hkdfSha256,
  hmacSha256,
  newCloudE2eeKdfParams,
  recoveryKeyFromWords,
  recoveryKeyToWords,
  sha256Hex,
  toBase64,
  toHex,
  unwrapAccountKey,
  unwrapVaultKey,
  wrapAccountKey,
  wrapVaultKey,
  zne1CiphertextLength,
  zne1PlaintextLength,
  Zne1Purpose as Purpose
} from './cloud-e2ee'

const VECTORS_URL = new URL('../../../docs/specs/cloud-e2ee-vectors.json', import.meta.url)

/** Fixed inputs, so every implementation can reproduce the vectors. */
const PARENT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index)
const SALT = Uint8Array.from({ length: 32 }, (_, index) => 0x40 + index)
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index)
const SIZES = [0, 1, 65535, 65536, 65537, 131072, 200000]

/** Plaintext bytes for the vectors: byte i is i mod 251. */
function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251)
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof CloudE2eeError && error.code === code
  )
}

/**
 * A second implementation of ZNE1 encryption on node:crypto's own API, written
 * from the spec, so a misuse of WebCrypto (salt and info swapped, tag order,
 * nonce layout) cannot hide behind a round trip that agrees with itself.
 */
function referenceEncrypt(
  parentKey: Uint8Array,
  purpose: number,
  keyVersion: number,
  salt: Uint8Array,
  context: Uint8Array,
  plaintext: Uint8Array
): Buffer {
  const info = (label: string) => Buffer.concat([Buffer.from(label, 'latin1'), Buffer.from([purpose])])
  const objectKey = Buffer.from(hkdfSync('sha256', parentKey, salt, info('ZNE1 key'), 32))
  const commitment = Buffer.from(hkdfSync('sha256', parentKey, salt, info('ZNE1 commit'), 32))
  const header = Buffer.alloc(ZNE1_HEADER_BYTES)
  header.write('ZNE1', 0, 'latin1')
  header[4] = 0x01
  header[5] = purpose
  header.writeUInt32BE(keyVersion, 6)
  Buffer.from(salt).copy(header, 10)
  commitment.copy(header, 42)
  const aad = createHash('sha256').update(header).update(context).digest()
  const parts: Buffer[] = [header]
  const chunks = Math.max(1, Math.ceil(plaintext.byteLength / ZNE1_CHUNK_BYTES))
  for (let index = 0; index < chunks; index++) {
    const last = index === chunks - 1
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(index, 7)
    nonce[11] = last ? 1 : 0
    const cipher = createCipheriv('aes-256-gcm', objectKey, nonce)
    cipher.setAAD(aad)
    const chunk = plaintext.subarray(index * ZNE1_CHUNK_BYTES, (index + 1) * ZNE1_CHUNK_BYTES)
    parts.push(cipher.update(chunk), cipher.final(), cipher.getAuthTag())
  }
  return Buffer.concat(parts)
}

describe('primitives against published vectors', () => {
  it('derives HKDF-SHA256 like RFC 5869 test cases 1 and 3', async () => {
    const ikm = new Uint8Array(22).fill(0x0b)
    const caseOne = await hkdfSha256(ikm, fromHex('000102030405060708090a0b0c'), fromHex('f0f1f2f3f4f5f6f7f8f9'), 42)
    expect(toHex(caseOne)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
    )
    const caseThree = await hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), 42)
    expect(toHex(caseThree)).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8'
    )
    // The path index key names 32 zero bytes as its salt; HMAC makes that the
    // same as the empty salt above.
    const zeros = await hkdfSha256(ikm, new Uint8Array(32), new Uint8Array(0), 42)
    expect(toHex(zeros)).toBe(toHex(caseThree))
  })

  it('computes HMAC-SHA256 like RFC 4231 test case 2', async () => {
    const mac = await hmacSha256(text('Jefe'), text('what do ya want for nothing?'))
    expect(toHex(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  })

  it('derives Argon2id keys that match OpenSSL 3.6', async () => {
    // Reference values from `openssl kdf ... ARGON2ID` (OpenSSL 3.6.5), an
    // implementation independent of hash-wasm. The first is the reference
    // implementation's own test vector; its 8-byte salt is below what
    // derivePassphraseKey accepts, so it checks hash-wasm directly.
    const salt = toBase64(fromHex('000102030405060708090a0b0c0d0e0f'))
    const reference = await argon2id({
      password: 'password',
      salt: 'somesalt',
      iterations: 2,
      parallelism: 1,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'hex'
    })
    expect(reference).toBe('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7')

    const defaults: CloudE2eeKdfParams = { ...newCloudE2eeKdfParams(), salt }
    expect(toHex(await derivePassphraseKey('correct horse battery staple', defaults))).toBe(
      '853b272a44db1421c02962669a55eb0994f3cab385ed1c4c79253eee19bab49e'
    )
    // U+212B ANGSTROM SIGN and U+FB01 LATIN SMALL LIGATURE FI only match after
    // NFKC, which every app applies before deriving.
    expect(toHex(await derivePassphraseKey('Ångström ☕ ﬁle', defaults))).toBe(
      '557b069f56e082ae2aecd39bbb2513634b549ab4215fdbf02974607c65e5462d'
    )
  }, 30_000)

  it('refuses key derivation settings outside safe bounds', async () => {
    const base = newCloudE2eeKdfParams()
    for (const kdf of [
      { ...base, memory_kib: 8 },
      { ...base, memory_kib: 4 * 1024 * 1024 },
      { ...base, iterations: 1 },
      { ...base, parallelism: 0 },
      { ...base, salt: toBase64(new Uint8Array(8)) },
      { ...base, algorithm: 'scrypt' as 'argon2id' }
    ]) {
      await expectCode(derivePassphraseKey('passphrase', kdf), 'invalid-kdf')
    }
  })
})

describe('recovery words', () => {
  it('matches the BIP-39 reference vectors for 256-bit entropy', () => {
    expect(recoveryKeyToWords(new Uint8Array(32)).join(' ')).toBe(`${'abandon '.repeat(23)}art`)
    expect(recoveryKeyToWords(new Uint8Array(32).fill(0x7f)).join(' ')).toBe(
      'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'
    )
    expect(recoveryKeyToWords(new Uint8Array(32).fill(0xff)).join(' ')).toBe(`${'zoo '.repeat(23)}vote`)
  })

  it('reads words back with any case, spacing, numbering, or four-letter prefixes', () => {
    const key = fromHex('9e885d952ad362caeb4efe34a8e91bd2a3cbd94c7bd5b1e8f3cc1e3d7b3c6bc1')
    const words = recoveryKeyToWords(key)
    expect(toHex(recoveryKeyFromWords(words.join(' ')))).toBe(toHex(key))
    const numbered = words.map((word, index) => `${index + 1}. ${word.toUpperCase()}`).join('\n')
    expect(toHex(recoveryKeyFromWords(numbered))).toBe(toHex(key))
    const prefixes = words.map((word) => (word.length > 4 ? word.slice(0, 4) : word)).join('  ')
    expect(toHex(recoveryKeyFromWords(prefixes))).toBe(toHex(key))
  })

  it('rejects the wrong count, unknown words, and a failed checksum', () => {
    const words = recoveryKeyToWords(new Uint8Array(32).fill(0x7f))
    expect(() => recoveryKeyFromWords(words.slice(1).join(' '))).toThrow(/24 words/)
    expect(() => recoveryKeyFromWords([...words.slice(1), 'qqqq'].join(' '))).toThrow(/isn't a recovery key word/)
    const swapped = [...words]
    ;[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!]
    expect(() => recoveryKeyFromWords(swapped.join(' '))).toThrow(/mistyped word/)
  })
})

describe('ZNE1 objects', () => {
  it('encrypts to exactly the bytes an independent node:crypto implementation produces', async () => {
    for (const size of SIZES) {
      const plaintext = pattern(size)
      const context = text('context')
      const sealed = await encryptZne1(plaintext, {
        parentKey: PARENT_KEY,
        purpose: Purpose.content,
        keyVersion: 7,
        context,
        salt: SALT
      })
      const reference = referenceEncrypt(PARENT_KEY, Purpose.content, 7, SALT, context, plaintext)
      expect(sealed.byteLength).toBe(zne1CiphertextLength(size))
      expect(zne1PlaintextLength(sealed.byteLength)).toBe(size)
      expect(Buffer.from(sealed).equals(reference)).toBe(true)
      const opened = await decryptZne1(sealed, { parentKey: PARENT_KEY, purpose: Purpose.content, keyVersion: 7, context })
      expect(Buffer.from(opened).equals(Buffer.from(plaintext))).toBe(true)
    }
  })

  it('streams chunk by chunk to the same bytes as the one-shot functions', async () => {
    const plaintext = pattern(200000)
    const encryptor = await createZne1Encryptor({ parentKey: PARENT_KEY, purpose: Purpose.content, keyVersion: 1, salt: SALT })
    const parts: Uint8Array[] = [encryptor.header]
    for (let start = 0; start < plaintext.byteLength; start += ZNE1_CHUNK_BYTES) {
      const end = Math.min(start + ZNE1_CHUNK_BYTES, plaintext.byteLength)
      parts.push(await encryptor.encryptChunk(plaintext.subarray(start, end), end === plaintext.byteLength))
    }
    const streamed = Buffer.concat(parts)
    const oneShot = await encryptZne1(plaintext, { parentKey: PARENT_KEY, purpose: Purpose.content, keyVersion: 1, salt: SALT })
    expect(streamed.equals(Buffer.from(oneShot))).toBe(true)

    const decryptor = await createZne1Decryptor(streamed, { parentKey: PARENT_KEY, purpose: Purpose.content })
    const opened: Uint8Array[] = []
    for (let offset = ZNE1_HEADER_BYTES; offset < streamed.byteLength; offset += ZNE1_SEALED_CHUNK_BYTES) {
      const end = Math.min(offset + ZNE1_SEALED_CHUNK_BYTES, streamed.byteLength)
      opened.push(await decryptor.decryptChunk(streamed.subarray(offset, end), end === streamed.byteLength))
    }
    expect(Buffer.concat(opened).equals(Buffer.from(plaintext))).toBe(true)
  })

  it('streams any input chunking to the one-shot bytes and back', async () => {
    const plaintext = pattern(200000)
    const options = { parentKey: PARENT_KEY, purpose: Purpose.content, keyVersion: 1, salt: SALT } as const
    const oneShot = Buffer.from(await encryptZne1(plaintext, options))
    const pieces = (data: Uint8Array, sizes: number[]) => {
      const out: Uint8Array[] = []
      let offset = 0
      for (let index = 0; offset < data.byteLength; index++) {
        const size = sizes[index % sizes.length]!
        out.push(data.subarray(offset, offset + size))
        offset += size
      }
      return out
    }
    const collect = async (stream: AsyncGenerator<Uint8Array>) => {
      const parts: Uint8Array[] = []
      for await (const part of stream) parts.push(part)
      return Buffer.concat(parts)
    }
    for (const sizes of [[1], [1000, 7], [65536], [70000], [300000], [65535, 2]]) {
      const sizesForInput = sizes[0] === 1 ? [4096] : sizes
      expect((await collect(encryptZne1Stream(pieces(plaintext, sizesForInput), options))).equals(oneShot)).toBe(true)
      const opened = await collect(decryptZne1Stream(pieces(oneShot, sizes[0] === 1 ? [9001] : sizes), { parentKey: PARENT_KEY, purpose: Purpose.content }))
      expect(opened.equals(Buffer.from(plaintext))).toBe(true)
    }
    for (const size of [0, 65536, 131072]) {
      const data = pattern(size)
      const sealed = Buffer.from(await encryptZne1(data, options))
      expect((await collect(encryptZne1Stream([data], options))).equals(sealed)).toBe(true)
      expect((await collect(decryptZne1Stream([sealed], { parentKey: PARENT_KEY, purpose: Purpose.content }))).equals(Buffer.from(data))).toBe(true)
    }
  })

  it('stops a stream that ends early or carries no chunks', async () => {
    const options = { parentKey: PARENT_KEY, purpose: Purpose.content } as const
    const sealed = await encryptZne1(pattern(131072), { ...options, keyVersion: 1 })
    const drain = async (data: Uint8Array) => {
      for await (const _ of decryptZne1Stream([data], options)) void _
    }
    await expectCode(drain(sealed.subarray(0, ZNE1_HEADER_BYTES + ZNE1_SEALED_CHUNK_BYTES)), 'tampered')
    await expectCode(drain(sealed.subarray(0, ZNE1_HEADER_BYTES)), 'tampered')
    await expectCode(drain(sealed.subarray(0, 40)), 'malformed')
    await expectCode(drain(sealed.subarray(0, sealed.byteLength - 3)), 'tampered')
  })

  it('refuses chunk sizes the format never produces', async () => {
    const encryptor = await createZne1Encryptor({ parentKey: PARENT_KEY, purpose: Purpose.content, keyVersion: 1 })
    await expectCode(encryptor.encryptChunk(new Uint8Array(10), false), 'malformed')
    await encryptor.encryptChunk(new Uint8Array(ZNE1_CHUNK_BYTES), false)
    await expectCode(encryptor.encryptChunk(new Uint8Array(0), true), 'malformed')
    await encryptor.encryptChunk(new Uint8Array(1), true)
    await expectCode(encryptor.encryptChunk(new Uint8Array(1), true), 'malformed')
  })

  describe('tampering', () => {
    const plaintext = pattern(131072 + 100)
    const options: { parentKey: Uint8Array; purpose: Zne1Purpose; keyVersion: number; context: Uint8Array } = {
      parentKey: PARENT_KEY,
      purpose: Purpose.itemMeta,
      keyVersion: 3,
      context: text('ctx')
    }
    const seal = () => encryptZne1(plaintext, { ...options, salt: SALT })
    const open = (data: Uint8Array, overrides: Partial<typeof options> = {}) =>
      decryptZne1(data, { ...options, ...overrides })

    it('names each header field it rejects', async () => {
      const sealed = await seal()
      const flip = (offset: number) => {
        const copy = Uint8Array.from(sealed)
        copy[offset] ^= 0x01
        return copy
      }
      await expectCode(open(flip(0)), 'malformed') // magic
      await expectCode(open(flip(4)), 'unsupported') // algorithm
      await expectCode(open(flip(5)), 'wrong-purpose')
      await expectCode(open(flip(9)), 'wrong-key-version')
      await expectCode(open(flip(10)), 'wrong-key') // salt: the commitment no longer matches
      await expectCode(open(flip(73)), 'wrong-key') // commitment
    })

    it('rejects a flipped bit anywhere in a chunk or its tag', async () => {
      const sealed = await seal()
      for (const offset of [ZNE1_HEADER_BYTES, ZNE1_HEADER_BYTES + 65551, sealed.byteLength - 1, sealed.byteLength - 17]) {
        const copy = Uint8Array.from(sealed)
        copy[offset] ^= 0x80
        await expectCode(open(copy), 'tampered')
      }
    })

    it('rejects truncation, reordering, appended bytes, a wrong context, and a wrong key', async () => {
      const sealed = await seal()
      const twoChunks = sealed.subarray(0, ZNE1_HEADER_BYTES + 2 * ZNE1_SEALED_CHUNK_BYTES)
      await expectCode(open(twoChunks), 'tampered') // ends early on a chunk boundary
      await expectCode(open(sealed.subarray(0, sealed.byteLength - 5)), 'tampered') // ends inside the last chunk
      await expectCode(open(sealed.subarray(0, ZNE1_HEADER_BYTES + ZNE1_SEALED_CHUNK_BYTES + 3)), 'malformed')
      const swapped = Uint8Array.from(sealed)
      swapped.set(sealed.subarray(ZNE1_HEADER_BYTES + ZNE1_SEALED_CHUNK_BYTES, ZNE1_HEADER_BYTES + 2 * ZNE1_SEALED_CHUNK_BYTES), ZNE1_HEADER_BYTES)
      swapped.set(sealed.subarray(ZNE1_HEADER_BYTES, ZNE1_HEADER_BYTES + ZNE1_SEALED_CHUNK_BYTES), ZNE1_HEADER_BYTES + ZNE1_SEALED_CHUNK_BYTES)
      await expectCode(open(swapped), 'tampered')
      const appended = new Uint8Array(sealed.byteLength + 40)
      appended.set(sealed)
      await expectCode(open(appended), 'tampered')
      await expectCode(open(sealed, { context: text('other') }), 'tampered')
      await expectCode(open(sealed, { parentKey: OTHER_KEY }), 'wrong-key')
      await expectCode(open(sealed, { purpose: Purpose.content }), 'wrong-purpose')
      await expectCode(open(sealed.subarray(0, 80)), 'malformed')
    })

    it('rejects an empty last chunk after a full one', async () => {
      // The format seals 65536 bytes as one final chunk. A crafted object that
      // seals it as a full chunk plus an empty final chunk must not open.
      const params = await beginZne1Encryption({ ...options, salt: SALT })
      const key = await crypto.subtle.importKey('raw', params.objectKey, 'AES-GCM', false, ['encrypt'])
      const nonce = (index: number, last: boolean) => {
        const value = new Uint8Array(12)
        new DataView(value.buffer).setUint32(7, index)
        value[11] = last ? 1 : 0
        return value
      }
      const first = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(0, false), additionalData: params.aad }, key, new Uint8Array(ZNE1_CHUNK_BYTES)))
      const empty = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(1, true), additionalData: params.aad }, key, new Uint8Array(0)))
      await expectCode(open(Buffer.concat([params.header, first, empty])), 'malformed')
    })
  })
})

describe('key hierarchy', () => {
  it('wraps the account key under the passphrase and the recovery key independently', async () => {
    const accountKey = OTHER_KEY
    const passphraseKey = PARENT_KEY
    const recoveryKey = fromHex('9e885d952ad362caeb4efe34a8e91bd2a3cbd94c7bd5b1e8f3cc1e3d7b3c6bc1')
    const byPassphrase = await wrapAccountKey(accountKey, passphraseKey, 'passphrase')
    const byRecovery = await wrapAccountKey(accountKey, recoveryKey, 'recovery')
    expect(toHex(await unwrapAccountKey(byPassphrase, passphraseKey, 'passphrase'))).toBe(toHex(accountKey))
    expect(toHex(await unwrapAccountKey(byRecovery, recoveryKey, 'recovery'))).toBe(toHex(accountKey))
    await expectCode(unwrapAccountKey(byPassphrase, recoveryKey, 'passphrase'), 'wrong-key')
    await expectCode(unwrapAccountKey(byPassphrase, passphraseKey, 'recovery'), 'tampered')
  })

  it('binds a vault key to its id and the account key version', async () => {
    const envelope = await wrapVaultKey(PARENT_KEY, OTHER_KEY, 1, 'a'.repeat(32))
    expect(toHex(await unwrapVaultKey(envelope, OTHER_KEY, 1, 'a'.repeat(32)))).toBe(toHex(PARENT_KEY))
    await expectCode(unwrapVaultKey(envelope, OTHER_KEY, 1, 'b'.repeat(32)), 'tampered')
    await expectCode(unwrapVaultKey(envelope, OTHER_KEY, 2, 'a'.repeat(32)), 'wrong-key-version')
  })
})

describe('path ids and metadata', () => {
  const meta: CloudE2eeItemMeta = {
    path: 'Projects/Café Plan.md',
    kind: 'text',
    encoding: 'utf8',
    media_type: 'text/markdown',
    sha256: 'a'.repeat(64),
    byte_length: 1834
  }

  it('gives paths that the server treats as one the same id, and others different ids', async () => {
    const index = await CloudPathIndex.forVaultKey(PARENT_KEY)
    const id = await index.id('Projects/Café Plan.md')
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(await index.id('projects/CAFÉ plan.md')).toBe(id)
    expect(await index.id('Projects\\Café Plan.md')).toBe(id) // backslash, decomposed accent
    expect(await index.id('Projects/Cafe Plan.md')).not.toBe(id)
    const otherVault = await CloudPathIndex.forVaultKey(OTHER_KEY)
    expect(await otherVault.id('Projects/Café Plan.md')).not.toBe(id)
    expect(canonicalCloudPath('A\\B/Ç.md')).toBe('a/b/ç.md')
  })

  it('round-trips item metadata padded to 256 bytes and bound to its path id', async () => {
    const index = await CloudPathIndex.forVaultKey(PARENT_KEY)
    const pathId = await index.id(meta.path)
    const envelope = await encryptItemMeta(meta, { vaultKey: PARENT_KEY, vaultKeyVersion: 1, pathId })
    expect((fromBase64(envelope).byteLength - ZNE1_HEADER_BYTES - 16) % 256).toBe(0)
    expect(await decryptItemMeta(envelope, { vaultKey: PARENT_KEY, pathId, pathIndex: index })).toEqual(meta)

    const otherId = await index.id('Elsewhere.md')
    await expectCode(decryptItemMeta(envelope, { vaultKey: PARENT_KEY, pathId: otherId, pathIndex: index }), 'tampered')

    // Metadata sealed under the right id but naming another path is refused.
    const mismatched = await encryptItemMeta({ ...meta, path: 'Elsewhere.md' }, { vaultKey: PARENT_KEY, vaultKeyVersion: 1, pathId })
    await expectCode(decryptItemMeta(mismatched, { vaultKey: PARENT_KEY, pathId, pathIndex: index }), 'invalid-metadata')
  })

  it('round-trips vault names', async () => {
    const envelope = await encryptVaultName('Journal 2026', { vaultKey: PARENT_KEY, vaultKeyVersion: 1 })
    expect(await decryptVaultName(envelope, { vaultKey: PARENT_KEY })).toBe('Journal 2026')
    await expectCode(decryptVaultName(envelope, { vaultKey: OTHER_KEY }), 'wrong-key')
  })
})

describe('the chunk loop alone, as a host given only the object key runs it', () => {
  for (const size of SIZES) {
    it(`seals and opens ${size} bytes exactly as the whole-object functions do`, async () => {
      const plaintext = pattern(size)
      const options = { parentKey: PARENT_KEY, purpose: Purpose.content, keyVersion: 1, salt: SALT }
      const expected = await encryptZne1(plaintext, options)
      const params = await beginZne1Encryption(options)
      const sealer = await createZne1ChunkEncryptor(params)
      const parts: Uint8Array[] = [sealer.header]
      let start = 0
      do {
        const end = Math.min(start + ZNE1_CHUNK_BYTES, size)
        parts.push(await sealer.encryptChunk(plaintext.subarray(start, end), end === size))
        start = end
      } while (start < size)
      const sealed = Uint8Array.from(parts.flatMap((part) => [...part]))
      expect(toHex(sealed)).toBe(toHex(expected))

      const opener = await createZne1ChunkDecryptor(params)
      const opened: number[] = []
      for (let at = ZNE1_HEADER_BYTES; at < sealed.byteLength; at += ZNE1_SEALED_CHUNK_BYTES) {
        const end = Math.min(at + ZNE1_SEALED_CHUNK_BYTES, sealed.byteLength)
        opened.push(...(await opener.decryptChunk(sealed.subarray(at, end), end === sealed.byteLength)))
      }
      expect(toHex(Uint8Array.from(opened))).toBe(toHex(plaintext))
    })
  }

  it('refuses a tampered chunk and a chunk past the last one', async () => {
    const params = await beginZne1Encryption({ parentKey: PARENT_KEY, purpose: Purpose.content, keyVersion: 1, salt: SALT })
    const sealer = await createZne1ChunkEncryptor(params)
    const chunk = await sealer.encryptChunk(pattern(100), true)
    const flipped = chunk.slice()
    flipped[0]! ^= 1
    await expect((await createZne1ChunkDecryptor(params)).decryptChunk(flipped, true)).rejects.toMatchObject({ code: 'tampered' })
    const opener = await createZne1ChunkDecryptor(params)
    await opener.decryptChunk(chunk, true)
    await expect(opener.decryptChunk(chunk, true)).rejects.toMatchObject({ code: 'tampered' })
  })
})

describe('shared vectors', () => {
  async function objectVector(purpose: Zne1Purpose, keyVersion: number, context: Uint8Array, size: number) {
    const plaintext = pattern(size)
    const params = await beginZne1Encryption({ parentKey: PARENT_KEY, purpose, keyVersion, context, salt: SALT })
    const sealed = await encryptZne1(plaintext, { parentKey: PARENT_KEY, purpose, keyVersion, context, salt: SALT })
    return {
      purpose,
      key_version: keyVersion,
      parent_key_hex: toHex(PARENT_KEY),
      salt_hex: toHex(SALT),
      context_hex: toHex(context),
      plaintext_length: size,
      object_key_hex: toHex(params.objectKey),
      aad_hex: toHex(params.aad),
      header_hex: toHex(params.header),
      ciphertext_length: sealed.byteLength,
      ciphertext_sha256: await sha256Hex(sealed),
      ...(sealed.byteLength <= 2048 ? { ciphertext_hex: toHex(sealed) } : {})
    }
  }

  async function buildVectors() {
    const objects = []
    for (const size of SIZES) objects.push(await objectVector(Purpose.content, 1, new Uint8Array(0), size))
    const index = await CloudPathIndex.forVaultKey(PARENT_KEY)
    const paths = ['Notes/Ideas.md', 'notes\\IDEAS.md', 'Journal/2026/Café.md', 'Journal/2026/Café.md', '.zennotes/vault.json']
    const pathIds = []
    for (const path of paths) pathIds.push({ path, canonical: canonicalCloudPath(path), path_id: await index.id(path) })
    const metaPathId = await index.id('Notes/Ideas.md')
    const meta: CloudE2eeItemMeta = {
      path: 'Notes/Ideas.md',
      kind: 'text',
      encoding: 'utf8',
      media_type: 'text/markdown',
      sha256: await sha256Hex(text('# Ideas\n')),
      byte_length: 8
    }
    const recoveryKey = fromHex('9e885d952ad362caeb4efe34a8e91bd2a3cbd94c7bd5b1e8f3cc1e3d7b3c6bc1')
    return {
      format: 'ZNE1',
      spec: 'docs/specs/cloud-e2ee.md',
      notes:
        'Generated by packages/shared-domain/src/cloud-e2ee.test.ts with UPDATE_E2EE_VECTORS=1, and checked there against an independent node:crypto implementation and OpenSSL 3.6 Argon2id. Plaintext for objects is byte i = i mod 251.',
      argon2id: [
        { passphrase: 'password', password_hex: toHex(text('password')), salt_hex: toHex(text('somesalt')), memory_kib: 65536, iterations: 2, parallelism: 1, output_hex: '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7' },
        { passphrase: 'correct horse battery staple', password_hex: toHex(text('correct horse battery staple')), salt_hex: '000102030405060708090a0b0c0d0e0f', memory_kib: 65536, iterations: 3, parallelism: 4, output_hex: '853b272a44db1421c02962669a55eb0994f3cab385ed1c4c79253eee19bab49e' },
        { passphrase: 'Ångström ☕ ﬁle', password_hex: toHex(text('Ångström ☕ ﬁle'.normalize('NFKC'))), salt_hex: '000102030405060708090a0b0c0d0e0f', memory_kib: 65536, iterations: 3, parallelism: 4, output_hex: '557b069f56e082ae2aecd39bbb2513634b549ab4215fdbf02974607c65e5462d' }
      ],
      objects,
      metadata_object: await objectVector(Purpose.itemMeta, 1, text(metaPathId), 256),
      path_index: { vault_key_hex: toHex(PARENT_KEY), path_index_key_hex: toHex(await derivePathIndexKey(PARENT_KEY)), paths: pathIds },
      item_meta: {
        vault_key_hex: toHex(PARENT_KEY),
        vault_key_version: 1,
        path_id: metaPathId,
        salt_hex: toHex(SALT),
        meta,
        envelope_base64: await encryptItemMeta(meta, { vaultKey: PARENT_KEY, vaultKeyVersion: 1, pathId: metaPathId, salt: SALT })
      },
      vault_name: {
        vault_key_hex: toHex(PARENT_KEY),
        name: 'Journal 2026',
        salt_hex: toHex(SALT),
        envelope_base64: await encryptVaultName('Journal 2026', { vaultKey: PARENT_KEY, vaultKeyVersion: 1, salt: SALT })
      },
      envelopes: {
        account_key_hex: toHex(OTHER_KEY),
        passphrase_key_hex: toHex(PARENT_KEY),
        recovery_key_hex: toHex(recoveryKey),
        salt_hex: toHex(SALT),
        by_passphrase_base64: await wrapAccountKey(OTHER_KEY, PARENT_KEY, 'passphrase', SALT),
        by_recovery_base64: await wrapAccountKey(OTHER_KEY, recoveryKey, 'recovery', SALT),
        vault_key_hex: toHex(PARENT_KEY),
        vault_key_id: 'a'.repeat(32),
        account_key_version: 1,
        vault_key_base64: await wrapVaultKey(PARENT_KEY, OTHER_KEY, 1, 'a'.repeat(32), SALT)
      },
      recovery_words: [
        { entropy_hex: '00'.repeat(32), words: recoveryKeyToWords(new Uint8Array(32)).join(' ') },
        { entropy_hex: toHex(recoveryKey), words: recoveryKeyToWords(recoveryKey).join(' ') }
      ]
    }
  }

  it('matches docs/specs/cloud-e2ee-vectors.json', async () => {
    const vectors = await buildVectors()
    const serialized = `${JSON.stringify(vectors, null, 2)}\n`
    if (process.env.UPDATE_E2EE_VECTORS === '1') writeFileSync(VECTORS_URL, serialized)
    expect(JSON.parse(readFileSync(VECTORS_URL, 'utf8'))).toEqual(JSON.parse(serialized))
  }, 30_000)
})
