import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudSyncUpsertMutation } from '@zennotes/bridge-contract/cloud-sync'
import { createCloudSyncClient } from './cloud-sync-client'
import { rememberCloudSyncUploadSource } from './cloud-sync-upload-source'
import { createDesktopCloudSyncCoordinator } from './cloud-sync-filesystem'

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('disk-backed Cloud uploads over HTTP', () => {
  it('rebuilds an interrupted upload from disk after recreating the sync coordinator', async () => {
    const fixture = await setup(8_100_000, 'disconnect')
    const coordinator = () =>
      createDesktopCloudSyncCoordinator({
        root: fixture.localRoot,
        stateDirectory: fixture.stateDirectory,
        vaultId: 'vault',
        remote: fixture.client()
      })
    await expect(coordinator().sync()).rejects.toThrow()
    fixture.recover()
    // Recreate the repository, state store and client: no prior content object
    // or WeakMap upload source is reused, just the on-disk vault and sync state.
    expect((await coordinator().sync()).pushed).toBe(1)
    expect((await coordinator().sync()).pushed).toBe(0)
    expect(fixture.completions()).toBe(1)
    expect(sha256(await readFile(path.join(fixture.localRoot, 'assets/image.jpg')))).toBe(
      fixture.mutation.content.sha256
    )
    const downloaded = Buffer.from(await (await fetch(`${fixture.url}/object`)).arrayBuffer())
    expect(sha256(downloaded)).toBe(fixture.mutation.content.sha256)
  })

  it.each([8_100_000, 10_000_000])(
    'round-trips all %i bytes through a real upload and download',
    async (size) => {
      const fixture = await setup(size)
      const result = await fixture.client().mutate('vault', { mutations: [fixture.mutation] })
      expect(result.acknowledged).toHaveLength(1)
      const downloaded = Buffer.from(await (await fetch(`${fixture.url}/object`)).arrayBuffer())
      expect(downloaded.length).toBe(size)
      expect(sha256(downloaded)).toBe(fixture.mutation.content.sha256)
    }
  )

  it.each(['reject', 'disconnect', 'timeout'] as const)(
    'survives an upload %s and retries the same file with a fresh client',
    async (failure) => {
      const fixture = await setup(8_100_000, failure)
      await expect(
        fixture.client().mutate('vault', { mutations: [fixture.mutation] })
      ).rejects.toThrow()
      expect(fixture.aborts()).toBe(1)
      expect(fixture.completions()).toBe(0)
      fixture.recover()
      // A new client has no in-memory upload state, as after an app restart.
      const result = await fixture.client().mutate('vault', { mutations: [fixture.mutation] })
      expect(result.acknowledged).toHaveLength(1)
      const downloaded = Buffer.from(await (await fetch(`${fixture.url}/object`)).arrayBuffer())
      expect(sha256(downloaded)).toBe(fixture.mutation.content.sha256)
    }
  )
})

async function setup(
  size: number,
  initialFailure: 'reject' | 'disconnect' | 'timeout' | null = null
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'zennotes-upload-network-'))
  directories.push(directory)
  const localRoot = path.join(directory, 'vault')
  await mkdir(path.join(localRoot, 'assets'), { recursive: true })
  const source = path.join(localRoot, 'assets/image.jpg')
  const bytes = Buffer.alloc(size)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
  await writeFile(source, bytes)
  const mutation: CloudSyncUpsertMutation = {
    type: 'upsert',
    operation_id: 'upload-operation',
    item_id: 'image',
    base_revision: 0,
    path: 'assets/image.jpg',
    kind: 'binary',
    content: rememberCloudSyncUploadSource(
      {
        encoding: 'base64',
        data: '',
        byte_length: bytes.length,
        sha256: sha256(bytes),
        media_type: 'image/jpeg'
      },
      source
    )
  }
  let failure = initialFailure
  let stored: Buffer | null = null
  let aborts = 0
  let completions = 0
  let uploadMutation = mutation
  const server = createServer((request, response) => {
    request.on('error', () => {})
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.url?.endsWith('/uploads') && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        uploadMutation = JSON.parse(Buffer.concat(chunks).toString()) as CloudSyncUpsertMutation
        json(201, {
          data: {
            id: 'session',
            operation_id: uploadMutation.operation_id,
            expected_bytes: bytes.length,
            upload: {
              method: 'PUT',
              url: `${url}/object`,
              headers: { 'Content-Length': String(bytes.length) }
            }
          }
        })
      })
    } else if (request.url === '/object' && request.method === 'PUT') {
      if (failure === 'reject') {
        response.writeHead(403, { Connection: 'close' })
        response.end()
      } else if (failure === 'disconnect') {
        request.once('data', () => request.socket.destroy())
      } else if (failure === 'timeout') {
        request.pause()
      } else {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          stored = Buffer.concat(chunks)
          response.writeHead(200)
          response.end()
        })
      }
    } else if (request.method === 'DELETE') {
      aborts++
      response.writeHead(204)
      response.end()
    } else if (request.url?.endsWith('/complete')) {
      completions++
      request.resume()
      if (!stored || sha256(stored) !== mutation.content.sha256) {
        json(422, { error: { message: 'Upload is incomplete' } })
      } else {
        json(200, {
          data: {
            result: {
              acknowledged: [
                {
                  operation_id: uploadMutation.operation_id,
                  item_id: uploadMutation.item_id,
                  revision: 1,
                  sequence: 1
                }
              ],
              conflicts: [],
              cursor: 1
            }
          }
        })
      }
    } else if (request.url === '/object' && request.method === 'GET' && stored) {
      response.end(stored)
    } else if (request.url?.includes('/manifest')) {
      json(200, { data: [], cursor: 0, next_page: null })
    } else if (request.url?.includes('/changes')) {
      json(200, { data: [], cursor: stored ? 1 : 0, has_more: false })
    } else {
      json(404, {})
    }
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  const url = `http://127.0.0.1:${address.port}`
  // Exercise the real fetch cancellation path without waiting the production five-minute timeout.
  const transport: typeof fetch = (input, options) =>
    fetch(input, {
      ...options,
      ...(failure === 'timeout' && options?.method === 'PUT'
        ? { signal: AbortSignal.timeout(100) }
        : {})
    })
  return {
    url,
    localRoot,
    stateDirectory: path.join(directory, 'state'),
    mutation,
    client: () => createCloudSyncClient(url, 'test-token', transport),
    recover: () => {
      failure = null
    },
    aborts: () => aborts,
    completions: () => completions
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
