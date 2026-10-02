import { createServer, type Server } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudSyncCoordinator } from '@zennotes/shared-domain/cloud-sync-coordinator'
import { DesktopCloudSyncRepository, DesktopCloudSyncStateStore } from './cloud-sync-filesystem'
import { createCloudSyncClient } from './cloud-sync-client'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function writePattern(filename: string, size: number, fill: number): Promise<string> {
  const file = await fs.open(filename, 'wx')
  const chunk = Buffer.alloc(65_536, fill)
  const hash = createHash('sha256')
  try {
    for (let offset = 0; offset < size; offset += chunk.length) {
      const bytes = chunk.subarray(0, Math.min(chunk.length, size - offset))
      await file.writeFile(bytes)
      hash.update(bytes)
    }
  } finally {
    await file.close()
  }
  return hash.digest('hex')
}

async function fingerprint(filename: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

type Mode =
  | 'ok'
  | 'expired'
  | 'expired-always'
  | 'interrupted'
  | 'wrong-length'
  | 'wrong-hash'
  | 'redirect'
  | 'slow'
  | 'wrong-instruction'
async function fixture(size = 1_048_576, mode: Mode = 'ok') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zennotes-download-test-'))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const vault = path.join(root, 'vault')
  const staging = path.join(root, 'staging')
  await fs.mkdir(vault)
  await fs.mkdir(staging)
  const target = path.join(vault, 'large.bin')
  const object = path.join(root, 'object.bin')
  const sha256 = await writePattern(object, size, 57)
  const reference = {
    item_id: 'large',
    revision: 1,
    encoding: 'base64' as const,
    sha256: mode === 'wrong-hash' ? '0'.repeat(64) : sha256,
    byte_length: size,
    media_type: 'application/octet-stream'
  }
  const requests: Array<{ url: string; authorization?: string }> = []
  let instructions = 0
  let onObject: (() => Promise<void>) | undefined
  let began!: () => void
  const objectStarted = new Promise<void>((resolve) => {
    began = resolve
  })
  let baseUrl = ''
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, baseUrl)
      requests.push({ url: request.url!, authorization: request.headers.authorization })
      const json = (body: unknown) => {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(body))
      }
      if (url.pathname.endsWith('/account'))
        return json({ data: { capabilities: { content_references: true } } })
      if (url.pathname.endsWith('/manifest'))
        return json({
          data: [
            {
              item_id: 'large',
              revision: 1,
              path: 'large.bin',
              kind: 'binary',
              sha256: reference.sha256,
              byte_length: size,
              media_type: reference.media_type,
              content_ref: reference
            }
          ],
          cursor: 1,
          next_page: null
        })
      if (url.pathname.endsWith('/changes')) return json({ data: [], cursor: 1, has_more: false })
      if (url.pathname.endsWith('/download')) {
        instructions++
        const objectPath =
          (mode === 'expired' && instructions === 1) || mode === 'expired-always'
            ? '/expired'
            : mode === 'redirect'
              ? '/redirect'
              : mode === 'interrupted'
                ? '/interrupted'
                : mode === 'slow'
                  ? '/slow'
                  : '/object'
        return json({
          data: {
            item_id: mode === 'wrong-instruction' ? 'other' : 'large',
            revision: 1,
            content: {
              encoding: reference.encoding,
              sha256: reference.sha256,
              byte_length: size,
              media_type: reference.media_type
            },
            download: {
              method: 'GET',
              url: `${baseUrl}${objectPath}`,
              headers: {},
              expires_at: new Date(Date.now() + 60_000).toISOString()
            }
          }
        })
      }
      if (url.pathname === '/expired') {
        response.statusCode = 403
        response.end()
        return
      }
      if (url.pathname === '/redirect') {
        response.writeHead(302, { Location: '/object' })
        response.end()
        return
      }
      await onObject?.()
      response.writeHead(200, {
        'Content-Length': String(mode === 'wrong-length' ? size + 1 : size),
        'Content-Type': 'application/octet-stream'
      })
      response.flushHeaders()
      began()
      if (url.pathname === '/slow' || url.pathname === '/interrupted') {
        response.write(Buffer.alloc(16_384, 57))
        if (url.pathname === '/interrupted') setImmediate(() => response.destroy())
        return
      }
      const stream = createReadStream(object)
      response.on('close', () => stream.destroy())
      stream.pipe(response)
    })().catch((error) => response.destroy(error))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const cancellation = new AbortController()
  const remote = createCloudSyncClient(baseUrl, 'private-api-token', fetch, {
    accountId: 'network-account',
    contentReferences: true,
    signal: cancellation.signal
  })
  const repository = new DesktopCloudSyncRepository(vault, { stagingDirectory: staging })
  const states = new DesktopCloudSyncStateStore(path.join(root, 'state'))
  const coordinator = new CloudSyncCoordinator('vault', remote, repository, states, {
    itemId: () => 'local-item',
    operationId: () => 'operation'
  })
  return {
    root,
    vault,
    staging,
    target,
    sha256,
    requests,
    cancellation,
    objectStarted,
    coordinator,
    repository,
    states,
    instructions: () => instructions,
    onObject: (callback: () => Promise<void>) => {
      onObject = callback
    }
  }
}

describe('verified Cloud downloads over HTTP', () => {
  it('copies a large host-owned local version for rename without decoding it into memory', async () => {
    const f = await fixture(6_000_000)
    const original = await writePattern(f.target, 6_000_000, 65)
    const [item] = await f.repository.scan()
    expect(item.content.data).toBe('')
    const readFile = vi.spyOn(fs, 'readFile')
    await f.repository.applyConflictResolutionFiles({
      expected_path: 'large.bin',
      expected_sha256: original,
      files: [{ path: 'renamed.bin', content: item.content }]
    })
    expect(await fingerprint(path.join(f.vault, 'renamed.bin'))).toBe(original)
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readFile.mock.calls.some(([filename]) => String(filename) === f.target)).toBe(false)
    expect(f.instructions()).toBe(0)
  })

  it.each([
    8_100_000,
    ...(process.env.CAPACITY_QUALIFICATION === '1' ? [50_000_000, 200_000_000] : [])
  ])(
    'streams all %i bytes to disk without a JSON/base64 file body',
    async (size) => {
      const f = await fixture(size)
      const readFile = vi.spyOn(fs, 'readFile')
      const result = await f.coordinator.sync()
      expect(result).toMatchObject({ pulled: 1, pushed: 0 })
      expect((await fs.stat(f.target)).size).toBe(size)
      expect(await fingerprint(f.target)).toBe(f.sha256)
      expect(await fs.readdir(f.staging)).toEqual([])
      expect(readFile.mock.calls.some(([filename]) => String(filename) === f.target)).toBe(false)
      expect(f.requests.filter((request) => request.url === '/object')).toEqual([
        { url: '/object', authorization: undefined }
      ])
      expect(
        f.requests.filter((request) => request.url.endsWith('/download'))[0].authorization
      ).toBe('Bearer private-api-token')
      expect((await f.states.load('vault'))?.items.large).not.toHaveProperty('content')
    },
    60_000
  )

  it.each(['interrupted', 'wrong-length', 'wrong-hash', 'redirect', 'wrong-instruction'] as const)(
    'keeps disk/state recoverable and discards private staging after %s',
    async (mode) => {
      const f = await fixture(1_048_576, mode)
      await expect(f.coordinator.sync()).rejects.toThrow()
      expect(await fs.readdir(f.vault)).toEqual([])
      expect(await fs.readdir(f.staging)).toEqual([])
      expect(await f.states.load('vault')).toBeNull()
      if (mode === 'redirect' || mode === 'wrong-instruction')
        expect(f.requests.some((request) => request.url === '/object')).toBe(false)
    }
  )

  it('refreshes an expired signed URL for the same immutable revision', async () => {
    const f = await fixture(1_048_576, 'expired')
    await f.coordinator.sync()
    expect(f.instructions()).toBe(2)
    expect(
      f.requests
        .filter((request) => request.url.endsWith('/download'))
        .map((request) => request.url)
    ).toEqual(Array(2).fill('/api/v1/vaults/vault/items/large/revisions/1/download'))
    expect(await fingerprint(f.target)).toBe(f.sha256)
    expect(await fs.readdir(f.staging)).toEqual([])
  })

  it('bounds expired-URL refresh and leaves no staging data behind', async () => {
    const f = await fixture(1_048_576, 'expired-always')
    await expect(f.coordinator.sync()).rejects.toThrow('Cloud object download failed')
    expect(f.instructions()).toBe(2)
    expect(await fs.readdir(f.staging)).toEqual([])
    expect(await f.states.load('vault')).toBeNull()
  })

  it('cancels an in-flight object GET and removes its partial staging file', async () => {
    const f = await fixture(1_048_576, 'slow')
    const syncing = f.coordinator.sync().catch((error) => error)
    await f.objectStarted
    f.cancellation.abort()
    expect(await syncing).toMatchObject({ name: 'AbortError' })
    expect(await fs.readdir(f.staging)).toEqual([])
    expect(await fs.readdir(f.vault)).toEqual([])
    expect(await f.states.load('vault')).toBeNull()
  })

  it('preserves a file created during bootstrap download as a durable conflict', async () => {
    const f = await fixture()
    f.onObject(() => fs.writeFile(f.target, 'new local edit'))
    const result = await f.coordinator.sync()
    expect(result.pendingConflicts).toHaveLength(1)
    expect(await fs.readFile(f.target, 'utf8')).toBe('new local edit')
    expect((await f.states.load('vault'))?.pending_conflicts?.large.cloud.content_ref?.sha256).toBe(
      f.sha256
    )
    expect(await fs.readdir(f.staging)).toEqual([])
  })

  it.each(['cloud', 'both'] as const)(
    'resolves a large %s conflict using guarded file copies',
    async (choice) => {
      const f = await fixture(6_000_000)
      const original = await writePattern(f.target, 6_000_000, 65)
      await f.coordinator.sync()
      await f.coordinator.getConflict('large')
      expect(f.instructions()).toBe(0)
      const readFile = vi.spyOn(fs, 'readFile')
      await f.coordinator.resolveConflict({
        conflict_id: 'large',
        choice,
        keep_both_path: 'mine.bin',
        expected_local_sha256: original,
        expected_cloud_revision: 1
      })
      expect(await fingerprint(f.target)).toBe(f.sha256)
      if (choice === 'both')
        expect(await fingerprint(path.join(f.vault, 'mine.bin'))).toBe(original)
      expect(readFile.mock.calls.some(([filename]) => String(filename) === f.target)).toBe(false)
      expect((await f.states.load('vault'))?.pending_conflicts).toEqual({})
      expect(await fs.readdir(f.staging)).toEqual([])
    }
  )

  it('rejects a conflict decision if local bytes change during its download', async () => {
    const f = await fixture(6_000_000)
    const original = await writePattern(f.target, 6_000_000, 65)
    await f.coordinator.sync()
    f.onObject(() => fs.writeFile(f.target, 'edited during review'))
    await expect(
      f.coordinator.resolveConflict({
        conflict_id: 'large',
        choice: 'both',
        keep_both_path: 'mine.bin',
        expected_local_sha256: original,
        expected_cloud_revision: 1
      })
    ).rejects.toThrow('changed on this device')
    expect(await fs.readFile(f.target, 'utf8')).toBe('edited during review')
    expect((await f.states.load('vault'))?.pending_conflicts?.large).toBeDefined()
    expect(await fs.readdir(f.staging)).toEqual([])
    expect(await fs.readdir(f.vault)).toEqual(['large.bin'])
  })

  it.each([false, true])('restores the Cloud version after the local conflict file has been deleted (moved: %s)', async (moved) => {
    const f = await fixture()
    await fs.writeFile(f.target, 'local version')
    await f.coordinator.sync()
    if (moved) {
      const state = (await f.states.load('vault'))!
      const conflict = state.pending_conflicts!.large
      conflict.kind = 'move'
      conflict.local.path = conflict.base.path = 'previous.bin'
      await f.states.save(state)
    }
    await fs.rm(f.target)

    await f.coordinator.resolveConflict({
      conflict_id: 'large', choice: 'cloud',
      expected_local_sha256: null, expected_cloud_revision: 1
    })

    expect(await fingerprint(f.target)).toBe(f.sha256)
    expect((await f.states.load('vault'))?.pending_conflicts).toEqual({})
    expect(await fs.readdir(f.staging)).toEqual([])
  })

  it('rolls back an unchanged keep-both copy when Cloud publication fails and permits the same retry', async () => {
    const f = await fixture()
    await fs.writeFile(f.target, 'local version')
    const original = await fingerprint(f.target)
    await f.coordinator.sync()
    const rename = fs.rename
    const failure = Object.assign(new Error('Disk full'), { code: 'ENOSPC' })
    const failPublish = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === f.target) throw failure
      await rename(from, to)
    })
    const decision = {
      conflict_id: 'large', choice: 'both' as const, keep_both_path: 'mine.bin',
      expected_local_sha256: original, expected_cloud_revision: 1
    }

    await expect(f.coordinator.resolveConflict(decision)).rejects.toBe(failure)

    expect(await fs.readdir(f.vault)).toEqual(['large.bin'])
    expect(await fingerprint(f.target)).toBe(original)
    expect((await f.states.load('vault'))?.pending_conflicts?.large).toBeDefined()
    expect(await fs.readdir(f.staging)).toEqual([])
    failPublish.mockRestore()
    await f.coordinator.resolveConflict(decision)
    expect(await fingerprint(f.target)).toBe(f.sha256)
    expect(await fingerprint(path.join(f.vault, 'mine.bin'))).toBe(original)
    expect((await f.states.load('vault'))?.pending_conflicts).toEqual({})
  })

  it.each(['edited copy', 'replaced copy', 'edited original', 'unreadable copy', 'cleanup denied'] as const)(
    'preserves both files after failed keep-both publication when rollback is unsafe: %s',
    async (scenario) => {
      const f = await fixture()
      const local = 'local version'
      await fs.writeFile(f.target, local)
      const original = await fingerprint(f.target)
      await f.coordinator.sync()
      const kept = path.join(f.vault, 'mine.bin')
      const rename = fs.rename
      const readFile = fs.readFile
      const remove = fs.rm
      const failure = Object.assign(new Error('Disk full'), { code: 'ENOSPC' })
      const denied = Object.assign(new Error('Access denied'), { code: 'EACCES' })
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (to !== f.target) return rename(from, to)
        expect(await fs.readFile(kept, 'utf8')).toBe(local)
        if (scenario === 'edited copy') await fs.writeFile(kept, 'subsequent edit')
        if (scenario === 'replaced copy') {
          const replacement = path.join(f.root, 'replacement')
          await fs.writeFile(replacement, local)
          await rename(replacement, kept)
        }
        if (scenario === 'edited original') await fs.writeFile(f.target, 'subsequent edit')
        if (scenario === 'unreadable copy') {
          vi.spyOn(fs, 'readFile').mockImplementation((...args) => {
            if (args[0] === kept) return Promise.reject(denied)
            return readFile(...args)
          })
        }
        if (scenario === 'cleanup denied') {
          vi.spyOn(fs, 'rm').mockImplementation((filename, options) => {
            if (filename === kept) return Promise.reject(denied)
            return remove(filename, options)
          })
        }
        throw failure
      })

      await expect(f.coordinator.resolveConflict({
        conflict_id: 'large', choice: 'both', keep_both_path: 'mine.bin',
        expected_local_sha256: original, expected_cloud_revision: 1
      })).rejects.toBe(failure)

      vi.restoreAllMocks()
      expect(await fs.readFile(kept, 'utf8')).toBe(scenario === 'edited copy' ? 'subsequent edit' : local)
      expect(await fs.readFile(f.target, 'utf8')).toBe(scenario === 'edited original' ? 'subsequent edit' : local)
      expect((await f.states.load('vault'))?.pending_conflicts?.large).toBeDefined()
      expect(await fs.readdir(f.staging)).toEqual([])
    }
  )

  it('preserves the keep-both copy when Cloud was published before temporary cleanup failed', async () => {
    const f = await fixture()
    await fs.writeFile(f.target, 'local version')
    const original = await fingerprint(f.target)
    await f.coordinator.sync()
    const remove = fs.rm
    const failure = Object.assign(new Error('Access denied'), { code: 'EACCES' })
    vi.spyOn(fs, 'rm').mockImplementation(async (filename, options) => {
      if (String(filename).startsWith(`${f.target}.`) && String(filename).endsWith('.tmp')) throw failure
      await remove(filename, options)
    })

    await expect(f.coordinator.resolveConflict({
      conflict_id: 'large', choice: 'both', keep_both_path: 'mine.bin',
      expected_local_sha256: original, expected_cloud_revision: 1
    })).rejects.toBe(failure)

    expect(await fingerprint(f.target)).toBe(f.sha256)
    expect(await fingerprint(path.join(f.vault, 'mine.bin'))).toBe(original)
    expect((await f.states.load('vault'))?.pending_conflicts?.large).toBeDefined()
    expect(await fs.readdir(f.staging)).toEqual([])
  })
})
