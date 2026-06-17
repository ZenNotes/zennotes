import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RemoteServerClient } from '../remote/server-client'
import { SyncEngine } from './engine'
import { hashBytes } from './scan-local'

/** Minimal in-memory stand-in for the Go server (stores raw bytes). */
class FakeServer {
  files = new Map<string, Buffer>()
  baseUrl = 'http://fake'

  async getSyncManifest(): Promise<{ path: string; hash: string; size: number; mtime: number }[]> {
    return [...this.files].map(([p, bytes]) => ({
      path: p,
      hash: hashBytes(bytes),
      size: bytes.length,
      mtime: 0
    }))
  }
  async readNote(p: string): Promise<{ path: string; body: string }> {
    return { path: p, body: (this.files.get(p) ?? Buffer.alloc(0)).toString('utf8') }
  }
  async writeNote(p: string, body: string): Promise<unknown> {
    this.files.set(p, Buffer.from(body, 'utf8'))
    return {}
  }
  async readSyncFile(p: string): Promise<Buffer> {
    return this.files.get(p) ?? Buffer.alloc(0)
  }
  async writeSyncFile(p: string, bytes: Buffer): Promise<void> {
    this.files.set(p, Buffer.from(bytes))
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
function serverText(server: FakeServer, p: string): string | undefined {
  const b = server.files.get(p)
  return b === undefined ? undefined : b.toString('utf8')
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
    server.files.set('inbox/FromServer.md', Buffer.from('server note'))
    await writeLocal(root, 'inbox/FromLocal.md', 'local note')

    await makeEngine(root, server).runOnce()

    // Local gained the server note; server gained the local note.
    expect(await readLocal(root, 'inbox/FromServer.md')).toBe('server note')
    expect(serverText(server, 'inbox/FromLocal.md')).toBe('local note')
    expect(await localNotePaths(root)).toEqual(['inbox/FromLocal.md', 'inbox/FromServer.md'])
  })

  it('pulls a note added on the server after first sync', async () => {
    const server = new FakeServer()
    const engine = makeEngine(root, server)
    await engine.runOnce() // establish base (empty)
    server.files.set('inbox/New.md', Buffer.from('remote-only'))
    await engine.runOnce()
    expect(await readLocal(root, 'inbox/New.md')).toBe('remote-only')
  })

  it('pushes a local edit to the server', async () => {
    const server = new FakeServer()
    server.files.set('inbox/A.md', Buffer.from('v1'))
    const engine = makeEngine(root, server)
    await engine.runOnce() // pulls A=v1 to local, base set
    await writeLocal(root, 'inbox/A.md', 'v2')
    await engine.runOnce()
    expect(serverText(server, 'inbox/A.md')).toBe('v2')
  })

  it('propagates a local delete to the server', async () => {
    const server = new FakeServer()
    server.files.set('inbox/A.md', Buffer.from('v1'))
    const engine = makeEngine(root, server)
    await engine.runOnce() // local now has A
    await fs.rm(path.join(root, 'inbox/A.md'))
    await engine.runOnce()
    expect(server.files.has('inbox/A.md')).toBe(false)
  })

  it('keeps both on a concurrent conflicting edit (never loses data)', async () => {
    const server = new FakeServer()
    server.files.set('inbox/A.md', Buffer.from('base'))
    const engine = makeEngine(root, server)
    await engine.runOnce() // synced: local A = base
    // Edit differently on both sides before the next sync.
    await writeLocal(root, 'inbox/A.md', 'local edit')
    server.files.set('inbox/A.md', Buffer.from('server edit'))
    await engine.runOnce()

    // Local content is canonical at the path; the server edit is preserved as a copy.
    expect(await readLocal(root, 'inbox/A.md')).toBe('local edit')
    const paths = await localNotePaths(root)
    const conflictCopy = paths.find((p) => p.includes('(conflict'))
    expect(conflictCopy).toBeTruthy()
    expect(await readLocal(root, conflictCopy as string)).toBe('server edit')
    // Both files exist on the server too (converged).
    expect(serverText(server, 'inbox/A.md')).toBe('local edit')
    expect(serverText(server, conflictCopy as string)).toBe('server edit')
  })

  it('is idempotent: a second sync with no changes does nothing', async () => {
    const server = new FakeServer()
    server.files.set('inbox/A.md', Buffer.from('x'))
    const engine = makeEngine(root, server)
    await engine.runOnce()
    const before = new Map(server.files)
    await engine.runOnce()
    expect([...server.files]).toEqual([...before])
  })

  it('syncs binary assets byte-for-byte (push and pull)', async () => {
    const server = new FakeServer()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
    server.files.set('assets/remote.png', png)
    await fs.mkdir(path.join(root, 'assets'), { recursive: true })
    const localBin = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff])
    await fs.writeFile(path.join(root, 'assets/local.bin'), localBin)

    await makeEngine(root, server).runOnce()

    // Pulled binary lands locally with identical bytes; local binary pushed up.
    expect(await fs.readFile(path.join(root, 'assets/remote.png'))).toEqual(png)
    expect(server.files.get('assets/local.bin')).toEqual(localBin)
  })

  it('syncs databases, comments, and settings (text under .base/.zennotes)', async () => {
    const server = new FakeServer()
    server.files.set('.zennotes/vault.json', Buffer.from('{"primaryNotesLocation":"inbox"}'))
    server.files.set('inbox/Books.base/data.csv', Buffer.from('id,Title\nr1,Dune\n'))
    server.files.set('.zennotes/comments/inbox/A.md.comments.json', Buffer.from('[{"id":"c1"}]'))

    await makeEngine(root, server).runOnce()

    expect(await readLocal(root, '.zennotes/vault.json')).toContain('primaryNotesLocation')
    expect(await readLocal(root, 'inbox/Books.base/data.csv')).toContain('Dune')
    expect(await readLocal(root, '.zennotes/comments/inbox/A.md.comments.json')).toContain('c1')
  })

  it('never syncs sync-state.json or the meta cache', async () => {
    const server = new FakeServer()
    await fs.writeFile(path.join(root, '.zennotes', 'note-meta-cache-v1.json'), '{"version":2}')
    await fs.writeFile(path.join(root, 'inbox', 'Real.md'), 'real')
    await makeEngine(root, server).runOnce()
    expect(server.files.has('.zennotes/sync-state.json')).toBe(false)
    expect(server.files.has('.zennotes/note-meta-cache-v1.json')).toBe(false)
    expect(server.files.has('inbox/Real.md')).toBe(true)
  })
})
