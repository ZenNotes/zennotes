/**
 * ZenNotes Cloud end-to-end encryption: the ZNE1 object format, the key
 * hierarchy, path ids, item metadata, vault names and recovery words.
 *
 * docs/specs/cloud-e2ee.md is the normative description. The iPhone and
 * Android native chunk loops must produce the same bytes as these functions,
 * which docs/specs/cloud-e2ee-vectors.json pins; change the format only by
 * adding a new algorithm byte, never by editing what 0x01 means.
 */
import { argon2id } from 'hash-wasm'
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist as englishWords } from '@scure/bip39/wordlists/english.js'

export type Bytes = Uint8Array<ArrayBuffer>

export const ZNE1_ALGORITHM_AES_256_GCM = 0x01
export const ZNE1_HEADER_BYTES = 74
export const ZNE1_CHUNK_BYTES = 65536
export const ZNE1_TAG_BYTES = 16
export const ZNE1_SEALED_CHUNK_BYTES = ZNE1_CHUNK_BYTES + ZNE1_TAG_BYTES
export const CLOUD_E2EE_KEY_BYTES = 32

const MAGIC = [0x5a, 0x4e, 0x45, 0x31] as const

export const Zne1Purpose = {
  content: 0x01,
  itemMeta: 0x02,
  vaultName: 0x03,
  vaultKey: 0x04,
  accountKey: 0x05
} as const
export type Zne1Purpose = (typeof Zne1Purpose)[keyof typeof Zne1Purpose]

export type CloudE2eeErrorCode =
  | 'malformed'
  | 'unsupported'
  | 'wrong-purpose'
  | 'wrong-key-version'
  | 'wrong-key'
  | 'tampered'
  | 'invalid-key'
  | 'invalid-kdf'
  | 'invalid-recovery-key'
  | 'invalid-metadata'

export class CloudE2eeError extends Error {
  constructor(
    readonly code: CloudE2eeErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CloudE2eeError'
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function utf8(value: string): Bytes {
  return encoder.encode(value) as Bytes
}

/** A copy backed by its own ArrayBuffer, which WebCrypto's types require. */
function own(view: Uint8Array): Bytes {
  return new Uint8Array(view) as Bytes
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out as Bytes
}

function assertKey(key: Uint8Array, label: string): void {
  if (key.byteLength !== CLOUD_E2EE_KEY_BYTES) {
    throw new CloudE2eeError('invalid-key', `${label} must be ${CLOUD_E2EE_KEY_BYTES} bytes.`)
  }
}

/** Compares without an early exit, so the time taken says nothing about where two values differ. */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length) as Bytes
  crypto.getRandomValues(out)
  return out
}

export function toHex(data: Uint8Array): string {
  let hex = ''
  for (const byte of data) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new CloudE2eeError('malformed', 'Expected hexadecimal text.')
  }
  const out = new Uint8Array(hex.length / 2) as Bytes
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

export function toBase64(data: Uint8Array): string {
  let binary = ''
  // String.fromCharCode takes its arguments on the stack; 32 KiB slices keep
  // a 200 MB attachment from overflowing it.
  for (let offset = 0; offset < data.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function fromBase64(text: string): Bytes {
  let binary: string
  try {
    binary = atob(text)
  } catch {
    throw new CloudE2eeError('malformed', 'Expected base64 text.')
  }
  const out = new Uint8Array(binary.length) as Bytes
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', own(data))) as Bytes
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data))
}

export async function hkdfSha256(
  inputKey: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', own(inputKey), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: own(info) },
    key,
    length * 8
  )
  return new Uint8Array(bits) as Bytes
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const imported = await crypto.subtle.importKey(
    'raw',
    own(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, own(data))) as Bytes
}

// ---------------------------------------------------------------------------
// ZNE1 objects
// ---------------------------------------------------------------------------

export interface Zne1Header {
  algorithm: number
  purpose: number
  keyVersion: number
  salt: Bytes
  commitment: Bytes
  /** The 74 header bytes exactly as they appear in the object. */
  bytes: Bytes
}

/** What a chunk cipher needs; the native iPhone and Android loops receive exactly this. */
export interface Zne1ChunkCipherParams {
  header: Bytes
  /** The per-object AES-256-GCM key. */
  objectKey: Bytes
  /** SHA-256 of the header followed by the context, used as AAD for every chunk. */
  aad: Bytes
}

interface Zne1KeyOptions {
  parentKey: Uint8Array
  purpose: Zne1Purpose
  context?: Uint8Array
}

export interface Zne1EncryptOptions extends Zne1KeyOptions {
  keyVersion: number
  /** Tests and vectors pin the salt; everything else must leave it random. */
  salt?: Uint8Array
}

export interface Zne1DecryptOptions extends Zne1KeyOptions {
  /** When set, a header naming another parent key version is refused. */
  keyVersion?: number
}

async function deriveObjectSecrets(
  parentKey: Uint8Array,
  salt: Uint8Array,
  purpose: number
): Promise<{ objectKey: Bytes; commitment: Bytes }> {
  assertKey(parentKey, 'The parent key')
  const [objectKey, commitment] = await Promise.all([
    hkdfSha256(parentKey, salt, concat(utf8('ZNE1 key'), Uint8Array.of(purpose)), 32),
    hkdfSha256(parentKey, salt, concat(utf8('ZNE1 commit'), Uint8Array.of(purpose)), 32)
  ])
  return { objectKey, commitment }
}

function buildHeader(purpose: number, keyVersion: number, salt: Uint8Array, commitment: Uint8Array): Bytes {
  if (!Number.isInteger(keyVersion) || keyVersion < 0 || keyVersion > 0xffffffff) {
    throw new CloudE2eeError('malformed', 'Key versions are 32-bit unsigned integers.')
  }
  if (salt.byteLength !== 32) throw new CloudE2eeError('malformed', 'ZNE1 salts are 32 bytes.')
  const header = new Uint8Array(ZNE1_HEADER_BYTES) as Bytes
  header.set(MAGIC, 0)
  header[4] = ZNE1_ALGORITHM_AES_256_GCM
  header[5] = purpose
  new DataView(header.buffer).setUint32(6, keyVersion)
  header.set(salt, 10)
  header.set(commitment, 42)
  return header
}

export function parseZne1Header(data: Uint8Array): Zne1Header {
  if (data.byteLength < ZNE1_HEADER_BYTES) {
    throw new CloudE2eeError('malformed', 'The encrypted data is shorter than a ZNE1 header.')
  }
  for (let index = 0; index < MAGIC.length; index++) {
    if (data[index] !== MAGIC[index]) {
      throw new CloudE2eeError('malformed', 'The data is not a ZNE1 object.')
    }
  }
  if (data[4] !== ZNE1_ALGORITHM_AES_256_GCM) {
    throw new CloudE2eeError('unsupported', `ZNE1 algorithm ${data[4]} is not supported by this version of ZenNotes.`)
  }
  const bytes = own(data.subarray(0, ZNE1_HEADER_BYTES))
  return {
    algorithm: bytes[4]!,
    purpose: bytes[5]!,
    keyVersion: new DataView(bytes.buffer).getUint32(6),
    salt: bytes.slice(10, 42) as Bytes,
    commitment: bytes.slice(42, 74) as Bytes,
    bytes
  }
}

/** The ciphertext size of an n-byte plaintext, known before encrypting. */
export function zne1CiphertextLength(plaintextLength: number): number {
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0) {
    throw new CloudE2eeError('malformed', 'Plaintext lengths are non-negative integers.')
  }
  const chunks = Math.max(1, Math.ceil(plaintextLength / ZNE1_CHUNK_BYTES))
  return ZNE1_HEADER_BYTES + plaintextLength + chunks * ZNE1_TAG_BYTES
}

/** The plaintext size a well-formed ciphertext of this size holds. */
export function zne1PlaintextLength(ciphertextLength: number): number {
  const body = ciphertextLength - ZNE1_HEADER_BYTES
  if (!Number.isSafeInteger(ciphertextLength) || body < ZNE1_TAG_BYTES) {
    throw new CloudE2eeError('malformed', 'The encrypted data is too short.')
  }
  const fullChunks = Math.floor(body / ZNE1_SEALED_CHUNK_BYTES)
  const rest = body % ZNE1_SEALED_CHUNK_BYTES
  if (rest === 0) return fullChunks * ZNE1_CHUNK_BYTES
  if (rest === ZNE1_TAG_BYTES && fullChunks === 0) return 0
  if (rest <= ZNE1_TAG_BYTES) {
    // A trailing piece of 16 bytes or fewer after a full chunk would be an
    // empty or partial last chunk, which the format never produces.
    throw new CloudE2eeError('malformed', 'The encrypted data has an impossible length.')
  }
  return fullChunks * ZNE1_CHUNK_BYTES + rest - ZNE1_TAG_BYTES
}

function chunkNonce(index: number, last: boolean): Bytes {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new CloudE2eeError('malformed', 'Too many ZNE1 chunks.')
  }
  const nonce = new Uint8Array(12) as Bytes
  // Bytes 0 to 10 are the chunk index as an 11-byte big-endian integer.
  new DataView(nonce.buffer).setUint32(7, index)
  nonce[11] = last ? 0x01 : 0x00
  return nonce
}

/** Starts an object: a fresh salt, its keys and header. Native chunk loops take it from here. */
export async function beginZne1Encryption(options: Zne1EncryptOptions): Promise<Zne1ChunkCipherParams> {
  const salt = options.salt ? own(options.salt) : randomBytes(32)
  const { objectKey, commitment } = await deriveObjectSecrets(options.parentKey, salt, options.purpose)
  const header = buildHeader(options.purpose, options.keyVersion, salt, commitment)
  const aad = await sha256(concat(header, options.context ?? new Uint8Array(0)))
  return { header, objectKey, aad }
}

/**
 * Checks an object's header against the key that should open it and returns
 * what its chunks need. Nothing is decrypted when the commitment does not
 * match: a wrong key and a wrong passphrase are reported as `wrong-key`.
 */
export async function beginZne1Decryption(
  data: Uint8Array,
  options: Zne1DecryptOptions
): Promise<Zne1ChunkCipherParams & { parsed: Zne1Header }> {
  const parsed = parseZne1Header(data)
  if (parsed.purpose !== options.purpose) {
    throw new CloudE2eeError('wrong-purpose', 'The encrypted data was made for a different purpose.')
  }
  if (options.keyVersion !== undefined && parsed.keyVersion !== options.keyVersion) {
    throw new CloudE2eeError('wrong-key-version', `The encrypted data needs key version ${parsed.keyVersion}.`)
  }
  const { objectKey, commitment } = await deriveObjectSecrets(options.parentKey, parsed.salt, parsed.purpose)
  if (!constantTimeEqual(commitment, parsed.commitment)) {
    throw new CloudE2eeError('wrong-key', 'The key does not open this encrypted data.')
  }
  const aad = await sha256(concat(parsed.bytes, options.context ?? new Uint8Array(0)))
  return { header: parsed.bytes, objectKey, aad, parsed }
}

async function importChunkKey(objectKey: Uint8Array) {
  return crypto.subtle.importKey('raw', own(objectKey), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export interface Zne1Encryptor {
  readonly header: Bytes
  /**
   * Seals the next chunk. Every chunk but the last is exactly 65536 bytes; the
   * last holds 1 to 65536 bytes, or 0 when it is the only one.
   */
  encryptChunk(chunk: Uint8Array, last: boolean): Promise<Bytes>
}

export async function createZne1Encryptor(options: Zne1EncryptOptions): Promise<Zne1Encryptor> {
  return createZne1ChunkEncryptor(await beginZne1Encryption(options))
}

/**
 * The chunk loop alone, for a host whose keys were derived elsewhere: the
 * browser's vault worker gets exactly what the phones' native loops get
 * (`Zne1ChunkCipherParams`) and never sees a parent key.
 */
export async function createZne1ChunkEncryptor(params: Zne1ChunkCipherParams): Promise<Zne1Encryptor> {
  const key = await importChunkKey(params.objectKey)
  let index = 0
  let finished = false
  return {
    header: params.header,
    async encryptChunk(chunk, last) {
      if (finished) throw new CloudE2eeError('malformed', 'The last ZNE1 chunk was already sealed.')
      const size = chunk.byteLength
      const valid = last
        ? size <= ZNE1_CHUNK_BYTES && (size > 0 || index === 0)
        : size === ZNE1_CHUNK_BYTES
      if (!valid) throw new CloudE2eeError('malformed', `A ZNE1 chunk of ${size} bytes is not allowed here.`)
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: chunkNonce(index, last), additionalData: params.aad, tagLength: 128 },
        key,
        own(chunk)
      )
      index++
      finished = last
      return new Uint8Array(sealed) as Bytes
    }
  }
}

export interface Zne1Decryptor {
  readonly header: Zne1Header
  /**
   * Opens the next sealed chunk. Callers must say whether it is the last one;
   * a stream reader holds one chunk back to know.
   */
  decryptChunk(sealed: Uint8Array, last: boolean): Promise<Bytes>
}

export async function createZne1Decryptor(
  data: Uint8Array,
  options: Zne1DecryptOptions
): Promise<Zne1Decryptor> {
  const params = await beginZne1Decryption(data, options)
  const loop = await createZne1ChunkDecryptor(params)
  return { header: params.parsed, decryptChunk: loop.decryptChunk }
}

/** The chunk loop alone; see createZne1ChunkEncryptor. The caller has checked
 *  the object's header against its key (openContentHeader). */
export async function createZne1ChunkDecryptor(params: Zne1ChunkCipherParams): Promise<Pick<Zne1Decryptor, 'decryptChunk'>> {
  const key = await importChunkKey(params.objectKey)
  let index = 0
  let finished = false
  return {
    async decryptChunk(sealed, last) {
      if (finished) throw new CloudE2eeError('tampered', 'The encrypted data continues past its last chunk.')
      const size = sealed.byteLength
      const valid = last
        ? size >= ZNE1_TAG_BYTES && size <= ZNE1_SEALED_CHUNK_BYTES && (size > ZNE1_TAG_BYTES || index === 0)
        : size === ZNE1_SEALED_CHUNK_BYTES
      if (!valid) throw new CloudE2eeError('malformed', `A sealed ZNE1 chunk of ${size} bytes is not allowed here.`)
      let opened: ArrayBuffer
      try {
        opened = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: chunkNonce(index, last), additionalData: params.aad, tagLength: 128 },
          key,
          own(sealed)
        )
      } catch {
        throw new CloudE2eeError('tampered', 'The encrypted data was changed or is incomplete.')
      }
      index++
      finished = last
      return new Uint8Array(opened) as Bytes
    }
  }
}

export async function encryptZne1(plaintext: Uint8Array, options: Zne1EncryptOptions): Promise<Bytes> {
  const encryptor = await createZne1Encryptor(options)
  const out = new Uint8Array(zne1CiphertextLength(plaintext.byteLength)) as Bytes
  out.set(encryptor.header, 0)
  let offset = ZNE1_HEADER_BYTES
  let start = 0
  do {
    const end = Math.min(start + ZNE1_CHUNK_BYTES, plaintext.byteLength)
    const last = end === plaintext.byteLength
    const sealed = await encryptor.encryptChunk(plaintext.subarray(start, end), last)
    out.set(sealed, offset)
    offset += sealed.byteLength
    start = end
  } while (start < plaintext.byteLength)
  return out
}

export async function decryptZne1(data: Uint8Array, options: Zne1DecryptOptions): Promise<Bytes> {
  const decryptor = await createZne1Decryptor(data, options)
  const plaintext = new Uint8Array(zne1PlaintextLength(data.byteLength)) as Bytes
  let offset = ZNE1_HEADER_BYTES
  let written = 0
  while (offset < data.byteLength) {
    const end = Math.min(offset + ZNE1_SEALED_CHUNK_BYTES, data.byteLength)
    const opened = await decryptor.decryptChunk(data.subarray(offset, end), end === data.byteLength)
    plaintext.set(opened, written)
    written += opened.byteLength
    offset = end
  }
  return plaintext
}

/**
 * Encrypts a byte stream of any chunking into a ZNE1 object: the header, then
 * one sealed chunk per 65536 plaintext bytes. A full chunk is sealed only once
 * more data follows it, because the last chunk must be marked as last; memory
 * stays near two chunks however large the file is.
 */
export async function* encryptZne1Stream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: Zne1EncryptOptions
): AsyncGenerator<Bytes> {
  const encryptor = await createZne1Encryptor(options)
  yield encryptor.header
  let pending: Uint8Array = new Uint8Array(0)
  for await (const piece of source) {
    pending = pending.byteLength === 0 ? piece : concat(pending, piece)
    while (pending.byteLength > ZNE1_CHUNK_BYTES) {
      yield await encryptor.encryptChunk(pending.subarray(0, ZNE1_CHUNK_BYTES), false)
      pending = pending.subarray(ZNE1_CHUNK_BYTES)
    }
  }
  yield await encryptor.encryptChunk(pending, true)
}

/**
 * Decrypts a ZNE1 byte stream of any chunking. It yields plaintext only for
 * chunks that authenticated, so a caller writing to disk never writes forged
 * bytes; a stream that stops early fails on its last chunk.
 */
export async function* decryptZne1Stream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: Zne1DecryptOptions
): AsyncGenerator<Bytes> {
  let pending: Uint8Array = new Uint8Array(0)
  let decryptor: Zne1Decryptor | undefined
  for await (const piece of source) {
    pending = pending.byteLength === 0 ? piece : concat(pending, piece)
    if (!decryptor) {
      if (pending.byteLength < ZNE1_HEADER_BYTES) continue
      decryptor = await createZne1Decryptor(pending.subarray(0, ZNE1_HEADER_BYTES), options)
      pending = pending.subarray(ZNE1_HEADER_BYTES)
    }
    while (pending.byteLength > ZNE1_SEALED_CHUNK_BYTES) {
      yield await decryptor.decryptChunk(pending.subarray(0, ZNE1_SEALED_CHUNK_BYTES), false)
      pending = pending.subarray(ZNE1_SEALED_CHUNK_BYTES)
    }
  }
  if (!decryptor) throw new CloudE2eeError('malformed', 'The encrypted data is shorter than a ZNE1 header.')
  if (pending.byteLength < ZNE1_TAG_BYTES) {
    throw new CloudE2eeError('tampered', 'The encrypted data was changed or is incomplete.')
  }
  yield await decryptor.decryptChunk(pending, true)
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface CloudE2eeKdfParams {
  algorithm: 'argon2id'
  version: 19
  memory_kib: number
  iterations: number
  parallelism: number
  /** Base64 of 16 random bytes. */
  salt: string
}

export const CLOUD_E2EE_KDF_DEFAULTS = {
  algorithm: 'argon2id',
  version: 19,
  memory_kib: 65536,
  iterations: 3,
  parallelism: 4
} as const

// A keyset comes from the server. These bounds keep a hostile or broken one
// from exhausting a phone's memory, or from passing weak parameters off as
// real ones (it could not open the envelope anyway; this just fails early).
const KDF_BOUNDS = {
  memory_kib: [19456, 1048576],
  iterations: [2, 20],
  parallelism: [1, 16]
} as const

export function newCloudE2eeKdfParams(): CloudE2eeKdfParams {
  return { ...CLOUD_E2EE_KDF_DEFAULTS, salt: toBase64(randomBytes(16)) }
}

function assertKdfParams(kdf: CloudE2eeKdfParams): Bytes {
  const inRange = (value: number, [min, max]: readonly [number, number]) =>
    Number.isInteger(value) && value >= min && value <= max
  if (
    kdf.algorithm !== 'argon2id' ||
    kdf.version !== 19 ||
    !inRange(kdf.memory_kib, KDF_BOUNDS.memory_kib) ||
    !inRange(kdf.iterations, KDF_BOUNDS.iterations) ||
    !inRange(kdf.parallelism, KDF_BOUNDS.parallelism)
  ) {
    throw new CloudE2eeError('invalid-kdf', 'The encryption settings from ZenNotes Cloud are not usable.')
  }
  const salt = fromBase64(kdf.salt)
  if (salt.byteLength !== 16) throw new CloudE2eeError('invalid-kdf', 'The passphrase salt must be 16 bytes.')
  return salt
}

/** The passphrase key (PK): Argon2id over the NFKC-normalized passphrase. */
export async function derivePassphraseKey(passphrase: string, kdf: CloudE2eeKdfParams): Promise<Bytes> {
  const salt = assertKdfParams(kdf)
  const output = await argon2id({
    password: encoder.encode(passphrase.normalize('NFKC')),
    salt,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    memorySize: kdf.memory_kib,
    hashLength: 32,
    outputType: 'binary'
  })
  return own(output)
}

export function generateCloudE2eeKey(): Bytes {
  return randomBytes(CLOUD_E2EE_KEY_BYTES)
}

/** A vault key's public id: 16 random bytes as hex, bound into its envelope. */
export function newVaultKeyId(): string {
  return toHex(randomBytes(16))
}

export type AccountKeyWrapping = 'passphrase' | 'recovery'

export async function wrapAccountKey(
  accountKey: Uint8Array,
  wrappingKey: Uint8Array,
  wrapping: AccountKeyWrapping,
  salt?: Uint8Array
): Promise<string> {
  assertKey(accountKey, 'The account key')
  const sealed = await encryptZne1(accountKey, {
    parentKey: wrappingKey,
    purpose: Zne1Purpose.accountKey,
    keyVersion: 0,
    context: utf8(wrapping),
    salt
  })
  return toBase64(sealed)
}

export async function unwrapAccountKey(
  envelope: string,
  wrappingKey: Uint8Array,
  wrapping: AccountKeyWrapping
): Promise<Bytes> {
  const key = await decryptZne1(fromBase64(envelope), {
    parentKey: wrappingKey,
    purpose: Zne1Purpose.accountKey,
    keyVersion: 0,
    context: utf8(wrapping)
  })
  assertKey(key, 'The unwrapped account key')
  return key
}

export async function wrapVaultKey(
  vaultKey: Uint8Array,
  accountKey: Uint8Array,
  accountKeyVersion: number,
  vaultKeyId: string,
  salt?: Uint8Array
): Promise<string> {
  assertKey(vaultKey, 'The vault key')
  const sealed = await encryptZne1(vaultKey, {
    parentKey: accountKey,
    purpose: Zne1Purpose.vaultKey,
    keyVersion: accountKeyVersion,
    context: utf8(vaultKeyId),
    salt
  })
  return toBase64(sealed)
}

export async function unwrapVaultKey(
  envelope: string,
  accountKey: Uint8Array,
  accountKeyVersion: number,
  vaultKeyId: string
): Promise<Bytes> {
  const key = await decryptZne1(fromBase64(envelope), {
    parentKey: accountKey,
    purpose: Zne1Purpose.vaultKey,
    keyVersion: accountKeyVersion,
    context: utf8(vaultKeyId)
  })
  assertKey(key, 'The unwrapped vault key')
  return key
}

// ---------------------------------------------------------------------------
// Recovery key
// ---------------------------------------------------------------------------

export function recoveryKeyToWords(recoveryKey: Uint8Array): string[] {
  assertKey(recoveryKey, 'The recovery key')
  return entropyToMnemonic(own(recoveryKey), englishWords).split(' ')
}

const wordByPrefix = new Map<string, string>()
for (const word of englishWords) wordByPrefix.set(word.slice(0, 4), word)
const knownWords = new Set(englishWords)

/**
 * Reads a recovery key typed or pasted back in. Case, extra spaces, line
 * breaks and list numbering are ignored, and a word's first four letters are
 * enough (BIP-39 words are unique in their first four). The checksum catches
 * a mistyped word before any key work runs.
 */
export function recoveryKeyFromWords(input: string): Bytes {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '' && !/^\d+$/.test(token))
  if (tokens.length !== 24) {
    throw new CloudE2eeError('invalid-recovery-key', `A recovery key has 24 words, and this has ${tokens.length}. Check for a missing or extra word.`)
  }
  const words = tokens.map((token, index) => {
    if (knownWords.has(token)) return token
    const word = token.length >= 4 ? wordByPrefix.get(token.slice(0, 4)) : undefined
    if (!word) {
      throw new CloudE2eeError('invalid-recovery-key', `Word ${index + 1}, “${token}”, isn't a recovery key word. Check its spelling.`)
    }
    return word
  })
  try {
    return own(mnemonicToEntropy(words.join(' '), englishWords))
  } catch {
    throw new CloudE2eeError('invalid-recovery-key', 'These words are not a valid recovery key. Check for a mistyped word.')
  }
}

// ---------------------------------------------------------------------------
// Path ids
// ---------------------------------------------------------------------------

/** The server's path_key, recomputed by the client: slashes, NFC, lower case. */
export function canonicalCloudPath(path: string): string {
  return path.replace(/\\/g, '/').normalize('NFC').toLowerCase()
}

export async function derivePathIndexKey(vaultKey: Uint8Array): Promise<Bytes> {
  assertKey(vaultKey, 'The vault key')
  return hkdfSha256(vaultKey, new Uint8Array(32), utf8('ZNE1 path-index'), 32)
}

/** Turns real paths into the 64-character ids the server stores in their place. */
export class CloudPathIndex {
  private constructor(private readonly key: Awaited<ReturnType<typeof crypto.subtle.importKey>>) {}

  static async forVaultKey(vaultKey: Uint8Array): Promise<CloudPathIndex> {
    const pathKey = await derivePathIndexKey(vaultKey)
    const key = await crypto.subtle.importKey('raw', pathKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return new CloudPathIndex(key)
  }

  async id(path: string): Promise<string> {
    const mac = await crypto.subtle.sign('HMAC', this.key, utf8(canonicalCloudPath(path)))
    return toHex(new Uint8Array(mac))
  }
}

export function isCloudPathId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

// ---------------------------------------------------------------------------
// Item metadata and vault names
// ---------------------------------------------------------------------------

export interface CloudE2eeItemMeta {
  path: string
  kind: 'text' | 'binary'
  encoding: 'utf8' | 'base64'
  media_type: string
  /** SHA-256 of the plaintext, hex. */
  sha256: string
  byte_length: number
}

function padWithSpaces(json: string, multiple: number): Bytes {
  const raw = encoder.encode(json)
  const padded = new Uint8Array(Math.ceil(Math.max(raw.byteLength, 1) / multiple) * multiple) as Bytes
  padded.fill(0x20)
  padded.set(raw, 0)
  return padded
}

function readPaddedJson(data: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(data))
  } catch {
    throw new CloudE2eeError('invalid-metadata', 'The encrypted metadata is not valid JSON.')
  }
}

const HEX_SHA256 = /^[0-9a-f]{64}$/

function assertItemMeta(value: unknown): CloudE2eeItemMeta {
  const meta = value as Partial<CloudE2eeItemMeta> & { v?: unknown }
  const valid =
    typeof value === 'object' &&
    value !== null &&
    meta.v === 1 &&
    typeof meta.path === 'string' &&
    meta.path !== '' &&
    (meta.kind === 'text' || meta.kind === 'binary') &&
    (meta.encoding === 'utf8' || meta.encoding === 'base64') &&
    typeof meta.media_type === 'string' &&
    typeof meta.sha256 === 'string' &&
    HEX_SHA256.test(meta.sha256) &&
    Number.isSafeInteger(meta.byte_length) &&
    meta.byte_length! >= 0
  if (!valid) throw new CloudE2eeError('invalid-metadata', 'The encrypted metadata is incomplete.')
  return {
    path: meta.path!,
    kind: meta.kind!,
    encoding: meta.encoding!,
    media_type: meta.media_type!,
    sha256: meta.sha256!,
    byte_length: meta.byte_length!
  }
}

export async function encryptItemMeta(
  meta: CloudE2eeItemMeta,
  options: { vaultKey: Uint8Array; vaultKeyVersion: number; pathId: string; salt?: Uint8Array }
): Promise<string> {
  assertItemMeta({ v: 1, ...meta })
  if (!isCloudPathId(options.pathId)) throw new CloudE2eeError('invalid-metadata', 'Expected a path id.')
  const json = JSON.stringify({
    v: 1,
    path: meta.path,
    kind: meta.kind,
    encoding: meta.encoding,
    media_type: meta.media_type,
    sha256: meta.sha256,
    byte_length: meta.byte_length
  })
  const sealed = await encryptZne1(padWithSpaces(json, 256), {
    parentKey: options.vaultKey,
    purpose: Zne1Purpose.itemMeta,
    keyVersion: options.vaultKeyVersion,
    context: utf8(options.pathId),
    salt: options.salt
  })
  return toBase64(sealed)
}

/**
 * Opens an item's metadata and checks that its real path is the one its path
 * id stands for, so the server's uniqueness rules really cover real paths.
 */
export async function decryptItemMeta(
  envelope: string,
  options: { vaultKey: Uint8Array; vaultKeyVersion?: number; pathId: string; pathIndex: CloudPathIndex }
): Promise<CloudE2eeItemMeta> {
  const plaintext = await decryptZne1(fromBase64(envelope), {
    parentKey: options.vaultKey,
    purpose: Zne1Purpose.itemMeta,
    keyVersion: options.vaultKeyVersion,
    context: utf8(options.pathId)
  })
  const meta = assertItemMeta(readPaddedJson(plaintext))
  if ((await options.pathIndex.id(meta.path)) !== options.pathId) {
    throw new CloudE2eeError('invalid-metadata', 'The encrypted metadata names a different path than its id.')
  }
  return meta
}

export async function encryptVaultName(
  name: string,
  options: { vaultKey: Uint8Array; vaultKeyVersion: number; salt?: Uint8Array }
): Promise<string> {
  const sealed = await encryptZne1(padWithSpaces(JSON.stringify({ v: 1, name }), 64), {
    parentKey: options.vaultKey,
    purpose: Zne1Purpose.vaultName,
    keyVersion: options.vaultKeyVersion,
    salt: options.salt
  })
  return toBase64(sealed)
}

export async function decryptVaultName(
  envelope: string,
  options: { vaultKey: Uint8Array; vaultKeyVersion?: number }
): Promise<string> {
  const plaintext = await decryptZne1(fromBase64(envelope), {
    parentKey: options.vaultKey,
    purpose: Zne1Purpose.vaultName,
    keyVersion: options.vaultKeyVersion
  })
  const value = readPaddedJson(plaintext) as { v?: unknown; name?: unknown }
  if (value?.v !== 1 || typeof value.name !== 'string') {
    throw new CloudE2eeError('invalid-metadata', 'The encrypted vault name is incomplete.')
  }
  return value.name
}
