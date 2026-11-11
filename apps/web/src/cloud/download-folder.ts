/**
 * "Download as a folder": the open browser vault as a zip of its plain files,
 * the way it would sit on disk (notes, attachments and `.zennotes/`), under
 * one folder named after the vault, so unzipping it gives a folder the
 * desktop app opens as a vault.
 *
 * Streams through fflate's Zip one file at a time: text is deflated, media
 * that is already compressed is stored as is.
 *
 * An attachment still only in ZenNotes Cloud downloads first. When it cannot
 * (offline, or a shared computer's sign-in ended) it is left out, and
 * `Not included.txt` beside the folder names it, so the notes still come out.
 */
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import type { VaultFileSystem } from '@zennotes/portable-vault/host'
import { CLOUD_STUB_MAX_BYTES, decodeCloudStub } from '@zennotes/portable-vault/cloud-stub-format'

const STORED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic',
  '.pdf', '.zip', '.gz', '.mp3', '.m4a', '.aac', '.ogg', '.flac',
  '.mp4', '.m4v', '.mov', '.webm', '.ogv', '.woff', '.woff2'
])

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** Every file in the vault, vault-relative, folders first-depth order. */
export async function listVaultFiles(fs: Pick<VaultFileSystem, 'readdirStrict'>, dir = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdirStrict(dir)) {
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.type === 'directory') out.push(...(await listVaultFiles(fs, path)))
    else out.push(path)
  }
  return out
}

/** A name a zip and every desktop file system accept for the top folder. */
export function archiveFolderName(vaultName: string): string {
  const cleaned = vaultName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned || 'ZenNotes vault'
}

export const NOT_INCLUDED_FILE = 'Not included.txt'

/** The file's bytes, or null when it is a Cloud stub that could not download. */
async function bytesOrLeftOut(
  fs: { readBytes(path: string): Promise<Uint8Array>; readStoredBytes?(path: string): Promise<Uint8Array> },
  path: string
): Promise<Uint8Array | null> {
  try {
    return await fs.readBytes(path)
  } catch (error) {
    if (!fs.readStoredBytes) throw error
    const stored = await fs.readStoredBytes(path)
    if (stored.byteLength <= CLOUD_STUB_MAX_BYTES && decodeCloudStub(stored)) return null
    throw error
  }
}

export async function buildVaultArchive(
  fs: Pick<VaultFileSystem, 'readdirStrict'> & {
    readBytes(path: string): Promise<Uint8Array>
    readStoredBytes?(path: string): Promise<Uint8Array>
  },
  vaultName: string
): Promise<{ blob: Blob; fileCount: number; leftOut: string[] }> {
  const folder = archiveFolderName(vaultName)
  const files = await listVaultFiles(fs)
  const chunks: Uint8Array[] = []
  let failure: unknown = null
  let finished!: () => void
  const done = new Promise<void>((resolve) => (finished = resolve))
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure = error
      finished()
      return
    }
    chunks.push(chunk)
    if (final) finished()
  })
  const leftOut: string[] = []
  for (const path of files) {
    const bytes = await bytesOrLeftOut(fs, path)
    if (!bytes) {
      leftOut.push(path)
      continue
    }
    const entryName = `${folder}/${path}`
    const entry = STORED_EXTENSIONS.has(extensionOf(path))
      ? new ZipPassThrough(entryName)
      : new ZipDeflate(entryName, { level: 6 })
    zip.add(entry)
    entry.push(bytes, true)
  }
  if (leftOut.length > 0) {
    const notice = new ZipDeflate(NOT_INCLUDED_FILE, { level: 6 })
    zip.add(notice)
    notice.push(
      new TextEncoder().encode(
        `These attachments of “${vaultName}” are only in ZenNotes Cloud and could not download, so this download leaves them out. They are safe in ZenNotes Cloud and in the apps.\n\n${leftOut.join('\n')}\n`
      ),
      true
    )
  }
  zip.end()
  await done
  if (failure) throw failure
  return { blob: new Blob(chunks as BlobPart[], { type: 'application/zip' }), fileCount: files.length - leftOut.length, leftOut }
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Long enough for the browser to start reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
