# Spec: Cloud end-to-end encryption

> Status: design, October 12, 2026. Nothing here has shipped. The maintainer decided on October 12: encrypt note text, attachments, file and folder names, and vault names; ship as an opt-in beta first, then make it the default for new vaults; give every user a recovery key; launch the public security page together with the beta.

## Objective

ZenNotes Cloud stores what it syncs in a form the service can read. This spec makes Cloud vaults end-to-end encrypted: notes, attachments, file and folder names, and vault names are encrypted on the user's devices with keys the service never holds. The server keeps doing what it does today (sync, conflicts, backups, Restore from date, quotas) on opaque bytes.

The feature is complete when a user can turn encryption on, move an existing vault over, unlock a second device with a passphrase or the recovery key, and sync, back up and restore from all three apps, while the server holds no readable note content, file name, or vault name for that vault.

## What the service can and cannot see

| Data | Encrypted vault |
| --- | --- |
| Note text and attachment bytes | Cannot see |
| File and folder names, vault names | Cannot see |
| Hashes of note content | Cannot see |
| Account email, sign-in method, billing | Can see, needed to run the account |
| Number of vaults and items, each item's encrypted size (close to its real size), revision counts | Can see |
| When items change, and from which connected device | Can see |
| Device names and platforms, IP addresses in request logs | Can see |
| That two items' paths differ only in letter case | Can see (their path ids collide, by design) |

Non-goals for v1: hiding sizes (content is not padded), hiding access patterns, protecting a compromised device, and detecting a server that withholds or rolls back items (that needs a signed vault manifest; see Later).

## Threat model

Encryption protects against anyone who reads the service's database, object storage, backups, recovery copies or logs: ZenNotes staff, hosting providers, an attacker who breaches either, or a legal demand. They get ciphertext and the metadata above.

A malicious server can refuse service, delete data, roll an item back to an older revision, hide items, and guess the passphrase offline against the stored keyset at Argon2id cost per guess. Against the installed apps, whose code is a signed build that changes only when the person updates it, it cannot read or forge content, move content between files, attach one file's metadata to another path, or swap vault keys between vaults without the client noticing.

A browser session is weaker against a malicious server, and only against that. ZenNotes in the browser (app.zennotes.org) runs this same encryption code, but the browser downloads the code from the service whenever it changes, so the service delivers what handles the passphrase and the decrypted notes. A compromised service, or one compelled to, could serve a changed app that reads a vault once it is unlocked in a browser. Someone who only reads the service's stored data gets ciphertext, as with the apps. People who want protection from ZenNotes itself unlock encrypted vaults only in the installed apps: the first unlock in a browser says so and links to the security page. The app origin serves nothing but the app, from a release whose files are published with their hashes, and Settings shows the running release and the hash of its manifest. A page cannot prove its own integrity, so that display helps someone compare a release; it is not a defense.

Out of scope: an unlocked or compromised device (the vault on disk is plain Markdown by design), malware in the app process, and shoulder surfing. A browser's copy of a vault is plain files in the origin's private storage, as on a phone's disk: locking forgets the key and keeps the vault off the screen, and does not remove those files.

## Keys

```
passphrase --Argon2id--> PK ------- wraps --> AK  (account key, 32 random bytes)
recovery key (32 random bytes) -- wraps ----> AK
AK ------------------------------ wraps ----> VK  (one per vault, 32 random bytes)
VK -- parent of --> content objects, item metadata, the vault name
VK -- HKDF -------> K_path (path index key)
```

- PK = Argon2id(password = UTF-8 of the NFKC-normalized passphrase, salt = 16 random bytes, memory = 65536 KiB, iterations = 3, parallelism = 4, version 0x13, output 32 bytes). The parameters live in the keyset so they can be raised later.
- AK, every VK and the recovery key are 32 bytes from the platform CSPRNG.
- Changing the passphrase re-wraps AK. A new recovery key re-wraps AK. Nothing else is re-encrypted.
- Devices keep the unwrapped AK in the platform keychain: Electron safeStorage on desktop, a Keychain item with `WhenUnlockedThisDeviceOnly` on iOS, the Android Keystore. A browser has no keychain: it keeps AK in IndexedDB, sealed with AES-GCM under a key generated in that browser as non-extractable, or, with "Lock when I close this tab", only in that tab's memory. Vault keys are unwrapped when needed and kept in memory. Signing out deletes AK from the device.

The passphrase is separate from the account password. Accounts that sign in with Google have no password, and the server receives the account password at every sign-in, so it cannot double as the secret.

## Algorithms

- AES-256-GCM with 96-bit nonces and 128-bit tags (WebCrypto, node:crypto, CryptoKit, javax.crypto).
- HKDF-SHA256 (RFC 5869), HMAC-SHA256, SHA-256.
- Argon2id (RFC 9106) through hash-wasm, the reference C implementation compiled to WebAssembly, so every platform runs the same code.
- Recovery keys use the BIP-39 English word list through @scure/bip39.

## ZNE1 object format

Every encrypted thing (content, item metadata, a vault name, a wrapped key) is one ZNE1 object. Integers are big-endian.

Header, 74 bytes:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Magic `ZNE1` (0x5A 0x4E 0x45 0x31) |
| 4 | 1 | Algorithm. 0x01 = AES-256-GCM, HKDF-SHA256 subkeys, 65536-byte chunks |
| 5 | 1 | Purpose (table below) |
| 6 | 4 | Version of the parent key, uint32 |
| 10 | 32 | Salt, random per object |
| 42 | 32 | Key commitment |

| Purpose | Byte | Parent key | Context | Parent key version |
| --- | --- | --- | --- | --- |
| Content | 0x01 | VK | Empty | Vault key version |
| Item metadata | 0x02 | VK | The path id, 64 ASCII bytes | Vault key version |
| Vault name | 0x03 | VK | Empty | Vault key version |
| Vault key | 0x04 | AK | The vault key id, 32 ASCII bytes | Account key version |
| Account key | 0x05 | PK or the recovery key | ASCII `passphrase` or `recovery` | 0 |

With `p` the purpose byte:

- object key = HKDF-SHA256(IKM = parent key, salt = header salt, info = ASCII `ZNE1 key` followed by `p`, L = 32)
- commitment = HKDF-SHA256(IKM = parent key, salt = header salt, info = ASCII `ZNE1 commit` followed by `p`, L = 32)
- AAD = SHA-256(header followed by context), the same 32 bytes for every chunk

Body: the plaintext is split into 65536-byte chunks. The last chunk holds 1 to 65536 bytes; an empty plaintext is one empty chunk. Chunk `i`, counting from 0, is AES-256-GCM(object key, nonce, AAD, chunk) with nonce = `i` as an 11-byte unsigned integer followed by 0x01 for the last chunk or 0x00 otherwise. Each chunk's ciphertext is followed by its 16-byte tag, and chunks follow the header in order.

An n-byte plaintext encrypts to exactly 74 + n + 16 × max(1, ceil(n / 65536)) bytes, known before encryption starts.

Decryption, in this order:

1. Check the length (at least 90 bytes), the magic, the algorithm, the expected purpose and a known parent key version.
2. Recompute the commitment and compare it in constant time. A mismatch means the wrong key; nothing is decrypted.
3. Decrypt chunk by chunk; the chunk that ends the input is the last chunk. Full chunks are 65552 bytes. An input that ends early on a chunk boundary, reordered chunks, appended bytes, or an empty last chunk after a full one all fail authentication. Streaming decryptors hold one chunk back so they know which chunk is last.

Why this shape: a fresh key per object removes GCM's limit on random nonces and lets nonces be counters; the commitment binds every ciphertext to one key, which defeats partitioning-oracle attacks and gives an exact "wrong passphrase" signal; 64 KiB chunks keep memory flat for 200 MB attachments and fit the streamed uploads and downloads that exist today.

## Path ids

The server enforces one live item per path, case-insensitively. Encrypted vaults keep that with a blind index:

- K_path = HKDF-SHA256(IKM = VK, salt = 32 zero bytes, info = ASCII `ZNE1 path-index`, L = 32). HMAC treats an empty salt the same way, but Java's `SecretKeySpec` refuses an empty key, so the spec names the zeros.
- canonical path = the path with `\` replaced by `/`, Unicode NFC, then lower-cased with JavaScript `toLowerCase`, mirroring the server's `path_key`
- path id = lowercase hex of HMAC-SHA256(K_path, UTF-8 of the canonical path), 64 characters

Clients send the path id wherever they send `path` today. To the server it is an ordinary single-segment path, so uniqueness, `PATH_CONFLICT`, moves, backups and restores keep working unchanged. Only clients compute path ids, and clients apply the server's path validation (`VaultPathService::normalize`) and sync rules to the real path before encrypting it.

## Item metadata

Every upsert and move carries `meta`: an item-metadata object whose context is the item's path id, over UTF-8 JSON padded with trailing spaces (0x20) to a multiple of 256 bytes:

```json
{"v":1,"path":"Projects/Plan.md","kind":"text","encoding":"utf8","media_type":"text/markdown","sha256":"<hex SHA-256 of the plaintext>","byte_length":1834}
```

`sha256` and `byte_length` tie a file's bytes to its name: every app already re-hashes decrypted content and refuses bytes that differ from the item's metadata, so content swapped in from another item, or an older revision served under newer metadata, never reaches the vault. A rename sends new metadata with the same `sha256` and never re-encrypts the file, which is why the metadata does not name the ciphertext. Readers ignore fields they do not know.

A decrypting client also checks that the path inside the metadata produces the item's path id, so the server's uniqueness rules really cover real paths.

## Vault names

The vault's `encryption.name` is a vault-name object over `{"v":1,"name":"..."}` padded with trailing spaces to a multiple of 64 bytes. The server stores the placeholder name `Encrypted vault`.

## Recovery key

32 random bytes, shown as 24 BIP-39 words (256 bits plus an 8-bit checksum). Input ignores case and extra spaces and accepts the first four letters of each word, which are unique in the list. The checksum catches a mistyped word before any key work runs.

## Wire protocol

### Account

`GET /api/v1/account` adds `capabilities.end_to_end_encryption` (true when the service accepts encrypted vaults for this account) and `encryption.keyset` (true when the account has a keyset). Apps that implement this spec send `X-ZenNotes-Encryption: zne1` on every API request.

### Keyset

- `GET /api/v1/encryption/keyset` returns `{ data: Keyset }`, or 404 with `KEYSET_NOT_FOUND`.
- `POST /api/v1/encryption/keyset` creates it, or 409 with `KEYSET_EXISTS`.
- `PUT /api/v1/encryption/keyset` replaces `kdf` and `passphrase_envelope` (a passphrase change) and/or `recovery_envelope` (a new recovery key), guarded by `expected_revision`, or 409 with `KEYSET_REVISION_CONFLICT`.

```ts
interface CloudEncryptionKeyset {
  format: 1
  account_key_version: number
  kdf: {
    algorithm: 'argon2id'
    version: 19
    memory_kib: number
    iterations: number
    parallelism: number
    salt: string // base64, 16 bytes
  }
  passphrase_envelope: string // base64 ZNE1, purpose 0x05, context "passphrase"
  recovery_envelope: string // base64 ZNE1, purpose 0x05, context "recovery"
  revision: number
  updated_at: string
}
```

Deleting a keyset (the reset for someone who lost both the passphrase and the recovery key) happens on the website behind password or two-factor confirmation. It deletes every encrypted vault's server data first. The user's devices keep their vaults and upload them into new encrypted vaults after setting up again.

### Vaults

`POST /api/v1/vaults` accepts `encryption: { scheme: 'zne1', key_id, key_version, vault_key_envelope, name }` and stores the placeholder name. Vault resources return the same object, or `null` for a readable vault. A vault's encryption is fixed when it is created and never changes.

### Items

For an encrypted vault, every upsert sends:

- `path`: the path id
- `kind`: `binary`
- `meta`: base64 item metadata
- `content`: `{ encoding: 'aes-gcm', data: <base64 ZNE1 content>, sha256: <hex SHA-256 of the ciphertext>, byte_length: <ciphertext length>, media_type: 'application/octet-stream' }`

Moves send the new path id and new `meta`. Deletes are unchanged. Direct-upload initiation sends the same fields as an upsert, without `data`.

Every response that describes an item adds `meta` next to `path`: manifest items, changes (with `previous_meta` next to `previous_path`), revisions, conflicts (`current_meta` next to `current_path`), backup snapshot items, and note-restore results.

`aes-gcm` is the encoding the protocol already reserved. Every app released before this spec refuses it before writing anything ("Encrypted cloud sync content must be decrypted before filesystem apply"), so an old app can never write ciphertext into a vault folder.

### Server rules for encrypted vaults

- Refuse a write with any other encoding, kind or media type, without `meta`, or whose `path` is not 64 lowercase hex characters: `E2EE_INVALID_WRITE`.
- Refuse content or metadata that does not begin with the ZNE1 magic, algorithm 0x01 and the matching purpose byte: `E2EE_INVALID_CONTENT`. Check direct uploads at completion, where the server already re-reads the object to hash it. This is the last guard against a client bug that labels plaintext as encrypted.
- Answer any sync, backup or restore request that lacks `X-ZenNotes-Encryption: zne1` with 409 `E2EE_CLIENT_REQUIRED` and the message "This vault is end-to-end encrypted. Update ZenNotes on this device to sync it."
- Readable vaults refuse `meta` and `aes-gcm`.
- Skip the server's own path rules (`shouldSync`, the `.zennotes/` allow list); clients apply them before encrypting.
- Store `meta` on items, revisions, changes, backup snapshot items and recovery manifests, and copy it wherever a path is copied (restores, note restores, incremental backups).
- Keep small encrypted bodies inline in Postgres as readable notes are kept today, so an encrypted vault does not turn every note into an object-storage request.

## Feature behavior on encrypted vaults

| Feature | Behavior |
| --- | --- |
| Sync, conflicts, merges, previews | Unchanged for the user. Merges and previews run in the app on decrypted bytes |
| Restore from date, full restore, single-note restore | Unchanged. The server copies encrypted rows |
| Backup list and search | The app fetches the list and searches names itself |
| Backup download | The app downloads the archive and decrypts it locally |
| Web ZIP export | Not offered. The dashboard says to export from a ZenNotes app |
| The 30-day download window after access ends | The apps can still pull the vault and download backups |
| Publishing | Allowed. The app says publishing makes a readable copy until the note is unpublished |
| Usage by file type | Encrypted items count as "Encrypted" |
| Dashboard and owner pages | Show "Encrypted vault" and path ids only |
| Operator recovery copies | Ciphertext plus metadata. Recovery restores into the customer's Cloud vault, where their apps decrypt it |

## Clients

One encryption layer, in shared-domain: `CloudSyncApiClient` takes a per-vault cipher and translates between the wire format and the plaintext-shaped items the coordinator handles today. The coordinator keeps comparing the plaintext hashes it reads from decrypted metadata, so change detection, rename detection, conflict detection, and first-sync adoption of identical files behave exactly as they do now.

- A vault whose resource carries `encryption` never syncs without its cipher. When the device holds no account key, the client stops with a "locked" error instead of falling back to plaintext; the service's rules refuse plaintext writes as a second guard.
- The sync engine attaches the moved file's kind and content metadata to every move it plans, so the cipher can seal the new path's metadata without another request. The client strips these hints before sending a move for a readable vault.
- A content reference for an encrypted item carries plaintext metadata for the coordinator plus `encrypted: { sha256, byte_length }` describing the stored ciphertext. A host checks the network bytes against `encrypted`, decrypts, then checks the plaintext against the reference as it does today. The validators accept `aes-gcm` instructions only for references that carry `encrypted`.
- `CloudSyncApiClient` adds `X-ZenNotes-Encryption: zne1` to every request it sends; host transports forward request headers.
- The inline-or-direct upload decision uses the ciphertext length, since encryption adds 74 bytes plus 16 per chunk and the service caps inline bodies at 5 MiB.

Streams that bypass the JSON layer encrypt and decrypt in chunks:

- Desktop direct uploads encrypt to a private temp file first, so the ciphertext's length and hash exist before the upload is initiated. Reference downloads decrypt in the network branch of `cloud-sync-download.ts`, before the plaintext hash check, never in the local-copy path.
- iPhone and Android do the same inside `ZenDirectUpload` with CryptoKit and javax.crypto. JavaScript parses the header, checks the commitment and derives the object key; native code runs only the chunk loop and the hashes. Shared test vectors keep the three implementations byte-identical.
- The browser does the same in its OPFS worker, with WebCrypto: the page parses the header, checks the commitment and derives the object key; the worker runs only the chunk loop and the hashes, into a private temp in the vault's storage. Argon2id runs in a worker of its own, ended after each derivation so its memory is freed.
- A browser downloads large attachments when they are opened. A stub for one in an encrypted vault records the stored ciphertext's hash and length as well as the plaintext's; hydrating checks the download against the first, decrypts, then checks the plaintext against the second.

Desktop keeps every key in the main process; the renderer asks for setup, unlock and status over IPC. Before it stores an account key, the desktop secret store must write atomically with 0600 permissions and must never treat an unreadable file as empty.

## User flows

- **Set up** (Settings, Cloud, End-to-end encryption, labeled beta): choose a passphrase (typed twice, with a strength meter and an enforced minimum), then see the 24-word recovery key with copy, save and print, and confirm it by typing three of its words. Setup ends by offering to encrypt the current vault.
- **Encrypt this vault**: needs a fully synced vault with no open conflicts. It warns that the old vault's Cloud version history and backups are not carried over and offers a backup download first. It creates a new encrypted vault with the same name, links the folder to it, uploads everything, then marks the old vault superseded and deletes it through the existing deletion path. Other devices linked to the old vault get 410 `VAULT_SUPERSEDED` with the new vault's id and offer to unlock and switch; files that already match are adopted without downloading.
- **New device**: linking an encrypted vault asks for the passphrase or the recovery key, once per device.
- **Browser**: an encrypted vault opens only once the tab holds the key, so a locked or signed-out browser asks first. The unlock screen offers "Lock when I close this tab"; the first unlock carries the notice from the threat model.
- **Change passphrase** and **New recovery key**: ask for the current passphrase or the recovery key, then re-wrap AK.
- **Lost both**: the website reset above.
- **Keyboard**: command palette entries for unlocking and for encrypting the current vault, reachable like every other Cloud action.

## Rollout

1. Service: schema, endpoints and rules behind `CLOUD_E2EE` (`off`, `internal` for an allow list, `beta`, `default`), deployed as `off`.
2. Desktop, iPhone and Android releases carry the client code. The UI appears only when the service advertises the capability.
3. `internal`: the maintainer's accounts, cross-device tests on real hardware.
4. `beta`, opt-in for everyone, together with the public security page and updated privacy pages.
5. `default` for new vaults once the beta has held up. An independent audit happens before the beta label comes off.

## Testing

- Known-answer vectors in `docs/specs/cloud-e2ee-vectors.json` (HKDF outputs, ZNE1 objects of 0, 1, 65535, 65536, 65537 and 200000 bytes with fixed salts, item metadata, path ids, Argon2id, recovery words), run by the TypeScript, Swift and Java tests.
- Tamper tests: a flipped bit in every header field and chunk, truncation at and between chunk boundaries, reordered and appended chunks, the wrong purpose, the wrong context, the wrong key.
- Service feature tests for every rule above, and for backups and restores carrying `meta`.
- Desktop driven over CDP with two isolated profiles: set up, encrypt a vault, unlock the second profile, sync both ways, rename, a conflict, a 50 MB attachment, Restore from date, a backup download.
- iPhone and Android against a local website: unlock, sync both ways, large files through the native path.
- The browser against a local website, in each engine: unlock, a wrong passphrase, sync both ways with a desktop profile, an attachment hydrating, "Lock when I close this tab", and removing the browser from Connected apps.

## Later

Device approval (adding a device from an existing one without typing the passphrase), vault key rotation after a device is lost, sharing a vault with another account (X25519 key pairs wrapped by AK), size padding, a signed vault manifest against rollback, and a decrypting import for operator recovery folders.
