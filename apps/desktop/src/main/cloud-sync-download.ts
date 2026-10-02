import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CloudSyncContentMetadata } from '@zennotes/bridge-contract/cloud-sync'
import {
  registerCloudSyncStagedFile,
  validateCloudSyncContentReference,
  validateCloudSyncDownloadInstruction,
  throwIfCloudSyncCancelled,
  type CloudSyncDownloadSource,
  type CloudSyncStagedFile
} from '@zennotes/shared-domain/cloud-sync-content'

export interface DesktopCloudDownloadOptions {
  fetchImplementation?: typeof fetch
  stagingDirectory?: string
}

export interface DesktopCloudStagedHandle {
  owner: object
  path: string
  signal?: AbortSignal
}

export async function stageDesktopCloudContent(
  source: CloudSyncDownloadSource,
  owner: object,
  options: DesktopCloudDownloadOptions = {}
): Promise<CloudSyncStagedFile> {
  const reference = validateCloudSyncContentReference(source.reference)
  throwIfCloudSyncCancelled(source.signal)
  const directory = await fs.mkdtemp(
    path.join(options.stagingDirectory ?? os.tmpdir(), 'zennotes-download-')
  )
  const destination = path.join(directory, 'content')
  try {
    await fs.chmod(directory, 0o700)
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfCloudSyncCancelled(source.signal)
      const instruction = validateCloudSyncDownloadInstruction(
        { data: await source.getInstruction() },
        reference,
        source.allowInsecureLoopback
      )
      if (Date.parse(instruction.download.expires_at) <= Date.now()) {
        if (attempt === 0) continue
        throw new Error('Cloud returned an expired download URL.')
      }
      const timeout = AbortSignal.timeout(300_000)
      const signal = source.signal ? AbortSignal.any([source.signal, timeout]) : timeout
      const response = await (options.fetchImplementation ?? fetch)(instruction.download.url, {
        method: 'GET',
        headers: { ...instruction.download.headers, 'Accept-Encoding': 'identity' },
        credentials: 'omit',
        redirect: 'error',
        signal
      })
      if (response.redirected || !response.ok) {
        await response.body?.cancel()
        if (!response.redirected && attempt === 0 && [401, 403].includes(response.status)) continue
        throw Object.assign(new Error('Cloud object download failed.'), { status: response.status })
      }
      const length = response.headers.get('content-length')
      if (length !== null && Number(length) !== reference.byte_length) {
        await response.body?.cancel()
        throw new Error('Cloud download length did not match its reference.')
      }
      const reader = response.body?.getReader()
      async function* chunks(): AsyncGenerator<Uint8Array> {
        if (!reader) return
        for (;;) {
          throwIfCloudSyncCancelled(signal)
          const chunk = await reader.read()
          if (chunk.done) return
          yield chunk.value
        }
      }
      try {
        await writeVerified(chunks(), destination, reference, signal)
      } finally {
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
      }
      throwIfCloudSyncCancelled(source.signal)
      const preview =
        reference.encoding === 'utf8' &&
        reference.byte_length <= Math.min(source.previewLimitBytes, 262_144)
          ? {
              encoding: 'utf8' as const,
              data: new TextDecoder('utf-8', { fatal: true }).decode(
                await fs.readFile(destination)
              ),
              sha256: reference.sha256,
              byte_length: reference.byte_length,
              media_type: reference.media_type
            }
          : undefined
      return registerCloudSyncStagedFile(
        reference,
        { owner, path: destination, signal: source.signal } satisfies DesktopCloudStagedHandle,
        () => fs.rm(directory, { recursive: true, force: true }),
        preview
      )
    }
    throw new Error('Cloud download could not be refreshed.')
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Bounded disk-to-disk copy, also used for large local conflict copies. */
export async function copyVerifiedCloudFile(
  source: string,
  destination: string,
  expected: CloudSyncContentMetadata,
  signal?: AbortSignal
): Promise<void> {
  await writeVerified(createReadStream(source), destination, expected, signal)
}

async function writeVerified(
  chunks: AsyncIterable<Uint8Array>,
  destination: string,
  expected: CloudSyncContentMetadata,
  signal?: AbortSignal
): Promise<void> {
  const file = await fs.open(destination, 'wx', 0o600)
  const hash = createHash('sha256')
  let length = 0
  try {
    for await (const chunk of chunks) {
      throwIfCloudSyncCancelled(signal)
      length += chunk.byteLength
      if (length > expected.byte_length)
        throw new Error('Cloud download exceeded its reference length.')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const written = await file.write(chunk, offset)
        if (written.bytesWritten === 0) throw new Error('Cloud staging write made no progress.')
        offset += written.bytesWritten
      }
    }
    if (length !== expected.byte_length || hash.digest('hex') !== expected.sha256) {
      throw new Error('Cloud download failed length or SHA-256 verification.')
    }
    await file.sync()
  } finally {
    await file.close()
  }
}
