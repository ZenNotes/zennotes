import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RemoteServerClient } from '../remote/server-client'
import { SyncEngine } from './engine'
import { hashBytes } from './scan-local'

/** Minimal in-memory stand-in for the Go server. */
class FakeServer {
  files = new Map<string, string>()
  baseUrl = 'http://fake'

  async getSyncManifest(): Promise<{ path: string; hash: string; size: number; mtime: number }[]> {
    return [...this.files].map(([p, body]) => ({
      path: p,
      hash: hashBytes(Buffer.from(body, 'utf8')),
      size: Buffer.byteLength(body),
      mtime: 0
    }))
  }
  async readNote(p: string): Promise<{ path: string; body: string }> {
    return { path: p, body: this.files.get(p) ?? '' }
  }
  async writeNote(p: string, body: string): Promise<unknown> {
    this.files.set(p, body)
    return {}
  }
  async deleteNote(p: string): Promise<void> {
    this.files.delete(p)
  }
  watchVaultChanges(): () => void {
    return () => {}
  }
}

function makeEngine(root: string, server: FakeServer): SyncEngine {
  return new SyncEngine({
    root,
    client: server as unknown as RemoteServerClient,
    serverProfileId: 'p1',
    conflictPolicy: 'keep-both'
  })
}

async function writeLocal(root: string, rel: string, body: string): Promise<void> {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, 'utf8')
}
async function readLocal(root: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}
async function localNotePaths(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.name.endsWith('.md')) out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  await walk(root)
  return out.sort()
}

describe('SyncEngine — end to end (fake server, real local fs)', () => {
  let root: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-sync-'))
    await fs.mkdir(path.join(root, '.zennotes'), { recursive: true })
    await fs.mkdir(path.join(root, 'inbox'), { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('first sync = union merge of local + server', async () => {
    const server = new FakeServer()
    server.files.set('inbox/FromServer.md', 'server note')
    await writeLocal(root, 'inbox/FromLocal.md', 'local note')

    await makeEngine(root, server).runOnce()

    // Local gained the server note; server gained the local note.
    expect(await readLocal(root, 'inbox/FromServer.md')).toBe('server note')
    expect(server.files.get('inbox/FromLocal.md')).toBe('local note')
    expect(await localNotePaths(root)).toEqual(['inbox/FromLocal.md', 'inbox/FromServer.md'])
  })

  it('pulls a note added on the server after first sync', async () => {
    const server = new FakeServer()
    const engine = makeEngine(root, server)
    await engine.runOnce() // establish base (empty)
    server.files.set('inbox/New.md', 'remote-only')
    await engine.runOnce()
    expect(await readLocal(root, 'inbox/New.md')).toBe('remote-only')
  })

  it('pushes a local edit to the server', async () => {
    const server = new FakeServer()
    server.files.set('inbox/A.md', 'v1')
    const engine = makeEngine(root, server)
    await engine.runOnce() // pulls A=v1 to local, base set
    await writeLocal(root, 'inbox/A.md', 'v2')
    await engine.runOnce()
    expect(server.files.get('inbox/A.md')).toBe('v2')
  })

  it('propagates a local delete to the server', async () => {
    const server = new FakeServer()
    server.files.set('inbox/A.md', 'v1')
    const engine = makeEngine(root, server)
    await engine.runOnce() // local now has A
    await fs.rm(path.join(root, 'inbox/A.md'))
    await engine.runOnce()
    expect(server.files.has('inbox/A.md')).toBe(false)
  })

  it('keeps both on a concurrent conflicting edit (never loses data)', async () => {
    const server = new FakeServer()
    server.files.set('inbox/A.md', 'base')
    const engine = makeEngine(root, server)
    await engine.runOnce() // synced: local A = base
    // Edit differently on both sides before the next sync.
    await writeLocal(root, 'inbox/A.md', 'local edit')
    server.files.set('inbox/A.md', 'server edit')
    await engine.runOnce()

    // Local content is canonical at the path; the server edit is preserved as a copy.
    expect(await readLocal(root, 'inbox/A.md')).toBe('local edit')
    const paths = await localNotePaths(root)
    const conflictCopy = paths.find((p) => p.includes('(conflict'))
    expect(conflictCopy).toBeTruthy()
    expect(await readLocal(root, conflictCopy as string)).toBe('server edit')
    // Both files exist on the server too (converged).
    expect(server.files.get('inbox/A.md')).toBe('local edit')
    expect(server.files.get(conflictCopy as string)).toBe('server edit')
  })

  it('is idempotent: a second sync with no changes does nothing', async () => {
    const server = new FakeServer()
    server.files.set('inbox/A.md', 'x')
    const engine = makeEngine(root, server)
    await engine.runOnce()
    const before = new Map(server.files)
    await engine.runOnce()
    expect([...server.files]).toEqual([...before])
  })
})
