import { promises as fsp } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newMcpScope, type McpScope, type McpScopeFlags } from '@shared/mcp-scope'
import { createBackend, type VaultBackend } from '../cli/backend'
import { readAgentEditRecord } from '../main/agent-edit-files'
import { RemoteRequestError } from '../main/remote/connection'
import { decodeAssetBase64 } from './asset-tools'
import { ScopedBackend } from './scoped-backend'
import { callTool, runMcpServer, stdioServerTransport } from './server'

// What the shared fixture (bridge-contract/fixtures/mcp-scope.json) does not
// reach for the attachment and work tools of ZenNotes/tui#34. zn's own tests
// (internal/mcp/assets_test.go, worktools_test.go, internal/backend/tasks_test.go
// in ZenNotes/tui) cover the same ground.

let root: string
const clients: Client[] = []

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, body, 'latin1')
  }
}

const file = (rel: string): Promise<string> =>
  fsp.readFile(path.join(root, ...rel.split('/')), 'utf8')

async function connect(flags?: McpScopeFlags): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const scope: McpScope | null = flags ? newMcpScope(flags) : null
  await runMcpServer({
    resolveTarget: async () => ({ kind: 'local', root }),
    scope,
    transport: serverTransport
  })
  const client = new Client({ name: 'claude-code', version: '0' })
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

interface Part {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: { uri: string; mimeType: string; blob: string }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<{ parts: Part[]; text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args })
  const parts = result.content as Part[]
  return { parts, text: parts[0]?.text ?? '', isError: !!result.isError }
}

async function ok(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const { text, isError } = await call(client, name, args)
  expect(isError, text).toBe(false)
  return text
}

async function refused(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const { text, isError } = await call(client, name, args)
  expect(isError, text).toBe(true)
  return text
}

/** The vault in `root` answering as a server does. `links` are marked in its
 *  listings, and a read of `folderLinks` answers 400. */
function serverVault(links: string[] = [], folderLinks: string[] = []): VaultBackend {
  const local = createBackend({ kind: 'local', root })
  return {
    ...local,
    kind: 'remote',
    root: '',
    readNote: async (rel: string) => {
      if (folderLinks.includes(rel)) throw new RemoteRequestError('is a directory', 400)
      return await local.readNote(rel).catch(() => {
        throw new RemoteRequestError('not found', 404)
      })
    },
    listAssets: async () =>
      (await local.listAssets()).map((asset) =>
        links.includes(asset.path) ? { ...asset, symlink: true } : asset
      )
  } as VaultBackend
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-tools-'))
  await seed({ '.zennotes/vault.json': '{"primaryNotesLocation":"root"}' })
  vi.stubEnv('ZENNOTES_CONFIG_DIR', path.join(root, '.config'))
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  vi.unstubAllEnvs()
  await fsp.rm(root, { recursive: true, force: true })
})

describe('list_assets', () => {
  it('lists every file that is not a note, as the server and the app do', async () => {
    await seed({
      'assets/pic.png': 'a',
      'attachements/old.png': 'a',
      'Projects/loose.pdf': 'a',
      'Projects/Note.md': '# Note\n',
      'Sketch.excalidraw': '{}',
      'Base.base/data.csv': 'a\n',
      '.zennotes/deleted-assets/x.png': 'a',
      '.hidden.png': 'a',
      'assets/note.1.1730000000000.tmp': 'a'
    })
    await fsp.symlink('../Projects/loose.pdf', path.join(root, 'assets/link.pdf'))
    const client = await connect()
    const paths = (JSON.parse(await ok(client, 'list_assets', {})) as { path: string }[])
      .map((a) => a.path)
      .sort()
    expect(paths).toEqual(['Projects/loose.pdf', 'assets/pic.png', 'attachements/old.png'])
  })
})

describe('read_asset', () => {
  it('answers in the content type a client can use', async () => {
    await seed({
      'assets/pic.png': 'png',
      'assets/song.mp3': 'mp3',
      'assets/words.txt': 'plain words\n',
      'assets/report.pdf': '%PDF',
      'assets/data.bin': 'a\u0000b',
      'assets/latin.txt': 'café'
    })
    const client = await connect()
    const parts = async (rel: string): Promise<Part[]> =>
      (await call(client, 'read_asset', { path: rel })).parts

    const image = await parts('assets/pic.png')
    expect(JSON.parse(image[0].text ?? '')).toEqual({
      path: 'assets/pic.png',
      name: 'pic.png',
      size: 3,
      mimeType: 'image/png'
    })
    expect(image[1]).toEqual({ type: 'image', data: 'cG5n', mimeType: 'image/png' })
    expect((await parts('assets/song.mp3'))[1]).toEqual({
      type: 'audio',
      data: 'bXAz',
      mimeType: 'audio/mpeg'
    })
    expect((await parts('assets/words.txt'))[1]).toEqual({ type: 'text', text: 'plain words\n' })
    expect((await parts('assets/report.pdf'))[1]).toEqual({
      type: 'resource',
      resource: {
        uri: 'zennotes://asset/assets%2Freport.pdf',
        mimeType: 'application/pdf',
        blob: 'JVBERg=='
      }
    })
    // Not valid UTF-8, or holding a NUL, is not text.
    for (const rel of ['assets/data.bin', 'assets/latin.txt']) {
      expect((await parts(rel))[1].resource?.mimeType).toBe('application/octet-stream')
    }
  })

  it('refuses a file past 5 MiB', async () => {
    await seed({ 'assets/big.bin': 'x'.repeat(5 * 1024 * 1024 + 1) })
    expect(await refused(await connect(), 'read_asset', { path: 'assets/big.bin' })).toBe(
      'Error: big.bin is 5.0 MiB; read_asset returns files up to 5 MiB.'
    )
  })
})

describe('upload_asset', () => {
  it('reads every base64 a client plausibly sends', () => {
    const want = 'hello?>'
    const std = Buffer.from(want).toString('base64')
    for (const encoded of [
      std,
      std.replace(/=+$/, ''),
      Buffer.from(want).toString('base64url'),
      `${std.slice(0, 4)}\n${std.slice(4)}\n`,
      `data:text/plain;base64,${std}`
    ]) {
      expect(Buffer.from(decodeAssetBase64(encoded)).toString()).toBe(want)
    }
    expect(() => decodeAssetBase64('!!!')).toThrow('content_base64 is not valid base64.')
    expect(() => decodeAssetBase64('A')).toThrow('content_base64 is not valid base64.')
    expect(() => decodeAssetBase64('====')).toThrow('content_base64 is empty.')
    expect(() => decodeAssetBase64('data:text/plain,hello')).toThrow('not base64')
  })

  it('takes exactly 16 MiB and refuses one byte more', async () => {
    const client = await connect()
    const limit = 16 * 1024 * 1024
    const at = await ok(client, 'upload_asset', {
      filename: 'at.bin',
      content_base64: Buffer.alloc(limit, 7).toString('base64')
    })
    expect(JSON.parse(at)).toMatchObject({ path: 'assets/at.bin', kind: 'file' })
    expect((await fsp.stat(path.join(root, 'assets/at.bin'))).size).toBe(limit)
    expect(
      await refused(client, 'upload_asset', {
        filename: 'over.bin',
        content_base64: Buffer.alloc(limit + 1, 7).toString('base64')
      })
    ).toContain('takes files up to 16 MiB')
    await expect(fsp.stat(path.join(root, 'assets/over.bin'))).rejects.toThrow()
  })

  it('writes the link the app and the server write', async () => {
    const client = await connect()
    const markdown = async (filename: string): Promise<string> =>
      (JSON.parse(await ok(client, 'upload_asset', { filename, content_base64: 'cG5n' })) as {
        markdown: string
      }).markdown
    expect(await markdown('a.png')).toBe('![[assets/a.png]]')
    expect(await markdown('a.pdf')).toBe('![[assets/a.pdf]]')
    expect(await markdown('a.mp3')).toBe('![[assets/a.mp3]]')
    expect(await markdown('a.mp4')).toBe('![[assets/a.mp4]]')
    expect(await markdown('a b.txt')).toBe('[a b.txt](<assets/a b.txt>)')
    expect(await markdown('we#ird [na]me?.png')).toBe('![[assets/we-ird -na-me-.png]]')
  })

  it('refuses a name the listing would not show afterwards', async () => {
    const client = await connect()
    for (const filename of ['a/b.png', 'a\\b.png', '.hidden', 'NOTE.MD', 'x.excalidraw', 'B.csv.base.json', 'a\u0000b.png']) {
      await refused(client, 'upload_asset', { filename, content_base64: 'cG5n' })
    }
    await refused(client, 'upload_asset', { filename: ' ', content_base64: 'cG5n' })
    await expect(fsp.stat(path.join(root, 'assets'))).rejects.toThrow()
  })
})

describe('the asset tools on files that are not theirs to change', () => {
  it('leaves a loose CSV database alone, and reads it', async () => {
    await seed({
      'Lists/Books.csv': 'Title\nDune\n',
      'Lists/Books.csv.base.json': '{}',
      'Lists/plain.csv': 'a\n1\n'
    })
    const client = await connect()
    for (const rel of ['Lists/Books.csv', 'Lists/Books.csv.base.json']) {
      for (const [tool, args] of [
        ['rename_asset', { path: rel, name: 'x.csv' }],
        ['move_asset', { path: rel, targetDir: 'Elsewhere' }],
        ['duplicate_asset', { path: rel }],
        ['delete_asset', { path: rel }]
      ] as const) {
        expect(await refused(client, tool, args)).toContain('belongs to a ZenNotes database')
      }
    }
    const read = await call(client, 'read_asset', { path: 'Lists/Books.csv' })
    expect(read.parts[1].text).toContain('Dune')
    expect(await ok(client, 'rename_asset', { path: 'Lists/plain.csv', name: 'renamed.csv' })).toContain(
      'Lists/renamed.csv'
    )
  })

  it('never moves a file into the trash, however it is spelled or remapped', async () => {
    await seed({
      '.zennotes/vault.json':
        '{"primaryNotesLocation":"root","systemFolderPaths":{"trash":"99 Bin"}}',
      'assets/pic.png': 'a'
    })
    const client = await connect()
    for (const targetDir of ['99 Bin', '99 bin/sub', '.zennotes/x', 'My.base', '../outside']) {
      expect(await refused(client, 'move_asset', { path: 'assets/pic.png', targetDir })).toBe(
        'Error: This assistant cannot put files there.'
      )
    }
    expect(await file('assets/pic.png')).toBe('a')
  })
})

describe('a path scope and links', () => {
  it('keeps every write inside the scope', async () => {
    await seed({
      'Journal/Diary.md': '# Diary\n',
      'Shared/pic.png': 'png',
      '.zennotes/deleted-assets/11111111-1111-4111-8111-111111111111/.zn-deleted.json':
        '{"path":"Shared/inner/old.png","name":"old.png","deletedAt":"2026-01-01T00:00:00.000Z"}',
      '.zennotes/deleted-assets/11111111-1111-4111-8111-111111111111/old.png': 'old'
    })
    await fsp.symlink('../Journal', path.join(root, 'Shared/inner'))
    await fsp.symlink('Journal', path.join(root, 'assets'))
    const client = await connect({ access: 'write', allow: ['Shared', 'assets'] })
    expect(await refused(client, 'upload_asset', { filename: 'x.png', content_base64: 'cG5n' })).toContain(
      'assets folder is not shared'
    )
    expect(
      await refused(client, 'move_asset', { path: 'Shared/pic.png', targetDir: 'Shared/inner' })
    ).toContain('can put files only inside')
    expect(
      await refused(client, 'restore_asset', { undoToken: '11111111-1111-4111-8111-111111111111' })
    ).toContain('Deleted asset not found')
    expect(await fsp.readdir(path.join(root, 'Journal'))).toEqual(['Diary.md'])
  })

  it('refuses a duplicate whose name lands on a deny entry', async () => {
    await seed({ 'assets/a.png': 'a', 'assets/a copy.png': 'b' })
    const client = await connect({ access: 'write', deny: ['assets/a copy.png'] })
    expect(await refused(client, 'duplicate_asset', { path: 'assets/a.png' })).toBe(
      'Error: This assistant cannot give the file that name.'
    )
  })

  it('undoes an upload whose numbered name lands on a deny entry', async () => {
    await seed({ 'assets/x.png': 'a', 'assets/x 2.png': 'hidden' })
    const client = await connect({ access: 'write', deny: ['assets/x 2.png'] })
    // `x.png` is taken and `x 2.png` is taken, so this lands on `x 3.png`.
    expect(await ok(client, 'upload_asset', { filename: 'x.png', content_base64: 'cG5n' })).toContain(
      'assets/x 3.png'
    )
    expect(await file('assets/x 2.png')).toBe('hidden')
  })

  it('a path scope on a server cannot rename, move, read or copy a file', async () => {
    await seed({ 'assets/pic.png': 'png' })
    const remote = serverVault()
    const scoped = new ScopedBackend(remote, newMcpScope({ access: 'write', allow: ['assets'] }))
    const links = /rewrites links in every note/
    const bytes = 'Reading or copying attachments on a ZenNotes server is not available'
    await expect(scoped.renameAsset('assets/pic.png', 'b.png')).rejects.toThrow(links)
    await expect(scoped.moveAsset('assets/pic.png', 'assets/sub')).rejects.toThrow(links)
    await expect(scoped.readAsset('assets/pic.png')).rejects.toThrow(bytes)
    await expect(scoped.duplicateAsset('assets/pic.png')).rejects.toThrow(bytes)
    expect((await scoped.listAssets()).map((a) => a.path)).toEqual(['assets/pic.png'])
    await expect(scoped.readAsset('assets/gone.png')).rejects.toThrow('Asset not found: assets/gone.png')
    // A read-only whole-vault client on a server sees everything anyway.
    const whole = new ScopedBackend(remote, newMcpScope({ access: 'read' }))
    expect(Buffer.from(await whole.readAsset('assets/pic.png')).toString()).toBe('png')
  })
})

describe('a path scope on a server', () => {
  const BYTES = 'Reading or copying attachments on a ZenNotes server is not available to an assistant that sees only part of the vault.'

  it('answers a hidden file as missing before it refuses a visible one', async () => {
    await seed({ 'Projects/pic.png': 'png', 'Journal/secret.png': 'secret' })
    const scoped = new ScopedBackend(serverVault(), newMcpScope({ access: 'write', allow: ['Projects'] }))
    await expect(scoped.readAsset('Journal/secret.png')).rejects.toThrow('Asset not found: Journal/secret.png')
    await expect(scoped.duplicateAsset('Journal/secret.png')).rejects.toThrow('Asset not found: Journal/secret.png')
    await expect(scoped.readAsset('Projects/pic.png')).rejects.toThrow(BYTES)
    await expect(scoped.duplicateAsset('Projects/pic.png')).rejects.toThrow(BYTES)
  })

  it('answers a file the server marks as a link as missing, for every tool', async () => {
    await seed({ 'Projects/pic.png': 'png', 'Projects/alias.png': 'link', 'Journal/secret.png': 'secret' })
    const alias = 'Projects/alias.png'
    const scoped = new ScopedBackend(serverVault([alias]), newMcpScope({ access: 'write', allow: ['Projects'] }))
    const missing = `Asset not found: ${alias}`
    expect((await scoped.listAssets()).map((a) => a.path)).toEqual(['Projects/pic.png'])
    await expect(scoped.readAsset(alias)).rejects.toThrow(missing)
    await expect(scoped.duplicateAsset(alias)).rejects.toThrow(missing)
    await expect(scoped.renameAsset(alias, 'b.png')).rejects.toThrow(missing)
    await expect(scoped.moveAsset(alias, 'Projects/Sub')).rejects.toThrow(missing)
    await expect(scoped.deleteAsset(alias)).rejects.toThrow(missing)
    expect(await file(alias)).toBe('link')
  })

  it('keeps a marked file for a client with no paths in its scope, as for notes', async () => {
    await seed({ 'Projects/pic.png': 'png', 'Projects/alias.png': 'link' })
    const alias = 'Projects/alias.png'
    const scoped = new ScopedBackend(serverVault([alias]), newMcpScope({ access: 'read' }))
    expect((await scoped.listAssets()).map((a) => a.path).sort()).toEqual([alias, 'Projects/pic.png'])
    expect(Buffer.from(await scoped.readAsset(alias)).toString()).toBe('link')
  })

  it('finds where a file goes by what the server says is there', async () => {
    await seed({ 'Projects/pic.png': 'png', 'Projects/Sub/real.png': 'png' })
    const remote = serverVault([], ['Projects/inner'])
    const scoped = new ScopedBackend(remote, newMcpScope({ access: 'write', allow: ['Projects'] }))
    const refusal = 'This assistant can put files only inside: Projects.'
    const rewrites = /rewrites links in every note/
    await expect(scoped.moveAsset('Projects/pic.png', 'Projects/inner')).rejects.toThrow(refusal)
    await expect(scoped.moveAsset('Projects/pic.png', 'Projects/inner/deep')).rejects.toThrow(refusal)
    // What is known to be real, and what is not there at all, get past this check.
    await expect(scoped.moveAsset('Projects/pic.png', 'Projects/Sub')).rejects.toThrow(rewrites)
    await expect(scoped.moveAsset('Projects/pic.png', 'Projects/New')).rejects.toThrow(rewrites)
    expect(await file('Projects/pic.png')).toBe('png')
  })

  it('counts a destination it cannot read as taken', async () => {
    await seed({ 'Projects/pic.png': 'png' })
    const remote = {
      ...serverVault(),
      readNote: async () => {
        throw new RemoteRequestError('server down', 500)
      }
    } as VaultBackend
    const scoped = new ScopedBackend(remote, newMcpScope({ access: 'write', allow: ['Projects'] }))
    await expect(scoped.moveAsset('Projects/pic.png', 'Projects/New')).rejects.toThrow(
      'This assistant can put files only inside: Projects.'
    )
  })

  it('does not restore a file to a folder that has become a link', async () => {
    await seed({ 'Projects/inner/pic.png': 'png', 'Projects/Sub/kept.png': 'png' })
    const local = createBackend({ kind: 'local', root })
    const inner = await local.deleteAsset('Projects/inner/pic.png')
    const sub = await local.deleteAsset('Projects/Sub/kept.png')
    await seed({ 'Projects/Sub/other.png': 'png' })
    await fsp.rm(path.join(root, 'Projects', 'inner'), { recursive: true })
    const restore = vi.fn(local.restoreDeletedAsset)
    const remote = { ...serverVault([], ['Projects/inner']), restoreDeletedAsset: restore } as VaultBackend
    const scoped = new ScopedBackend(remote, newMcpScope({ access: 'write', allow: ['Projects'] }))
    await expect(scoped.restoreDeletedAsset(inner)).rejects.toThrow(
      `Deleted asset not found: ${inner.undoToken}`
    )
    expect(restore).not.toHaveBeenCalled()
    expect((await scoped.restoreDeletedAsset(sub)).path).toBe('Projects/Sub/kept.png')
  })

  it('uploads to the assets folder, which a listing does not show', async () => {
    await fsp.mkdir(path.join(root, 'assets'))
    const remote = serverVault([], ['assets'])
    const scoped = new ScopedBackend(remote, newMcpScope({ access: 'write', allow: ['assets'] }))
    expect((await scoped.importAsset('new.png', new Uint8Array([1]))).path).toBe('assets/new.png')
  })
})

describe('an assets folder that is not a folder', () => {
  it('refuses an upload the same way as one that is not shared', async () => {
    await seed({ assets: 'a file', 'Projects/Plan.md': '# Plan\n' })
    const client = await connect({ access: 'write', deny: ['Projects'] })
    expect(await refused(client, 'upload_asset', { filename: 'x.png', content_base64: 'cG5n' })).toContain(
      "This assistant cannot add files: the vault's assets folder is not shared with it."
    )
    expect(await file('assets')).toBe('a file')
  })
})

describe('a path with whitespace around it', () => {
  it('answers as missing for a name that does hold one', async () => {
    await seed({ ' x.png': 'shown', 'x.png': 'hidden' })
    const client = await connect({ access: 'read', deny: ['x.png'] })
    const { text, isError } = await call(client, 'read_asset', { path: ' x.png' })
    expect(isError, text).toBe(true)
    expect(text).toContain('Asset not found:  x.png')
  })

  it('answers as missing', async () => {
    await seed({ 'Projects/pic.png': 'png', 'Journal/secret.png': 'secret' })
    const client = await connect({ access: 'write', deny: ['Journal'] })
    const missing = 'Asset not found:  Journal/secret.png'
    expect(await refused(client, 'read_asset', { path: ' Journal/secret.png' })).toContain(missing)
    expect(await refused(client, 'delete_asset', { path: ' Journal/secret.png' })).toContain(missing)
    expect(await refused(client, 'read_asset', { path: 'Projects/pic.png ' })).toContain(
      'Asset not found: Projects/pic.png '
    )
    for (const targetDir of [' Journal', 'Journal ']) {
      expect(await refused(client, 'move_asset', { path: 'Projects/pic.png', targetDir })).toContain(
        'This assistant cannot put files there.'
      )
    }
    expect(await file('Projects/pic.png')).toBe('png')
    expect(await file('Journal/secret.png')).toBe('secret')
  })
})

describe('the asset routes on a server', () => {
  it('sends what the server expects, and keeps its link mark', async () => {
    const requests: { method: string; url: string; auth?: string; type?: string; body: string }[] = []
    const answers: Record<string, unknown> = {
      '/api/assets': [
        { path: 'a.png', name: 'a.png', size: 1, updatedAt: 2, kind: 'image', siblingOrder: 0 },
        { path: 'l.png', name: 'l.png', size: 1, updatedAt: 2, kind: 'image', symlink: true }
      ],
      '/api/assets/deleted': null,
      '/api/templates': null,
      '/api/assets/rename': { path: 'b.png', name: 'b.png', size: 1, updatedAt: 2, kind: 'image' },
      '/api/assets/move': { path: 'd/a.png', name: 'a.png', size: 1, updatedAt: 2 },
      '/api/assets/duplicate': { path: 'a copy.png', name: 'a copy.png', size: 1, updatedAt: 2 },
      '/api/assets/delete': { path: 'a.png', name: 'a.png', undoToken: 't', deletedAt: 'x' },
      '/api/assets/restore': { path: 'a.png', name: 'a.png', size: 1, updatedAt: 2 },
      '/api/assets/upload': { name: 'u.png', path: 'assets/u.png', markdown: '![[assets/u.png]]', kind: 'image' }
    }
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = new URL(req.url ?? '/', 'http://x')
      requests.push({
        method: req.method ?? '',
        url: `${url.pathname}${url.search}`,
        auth: req.headers.authorization,
        type: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('latin1')
      })
      if (url.pathname === '/api/assets/raw') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(Buffer.from([0, 200, 255]))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(answers[url.pathname] ?? null))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const remote = createBackend({
        kind: 'remote',
        name: '',
        baseUrl: `http://127.0.0.1:${port}`,
        authToken: 'tok'
      } as Parameters<typeof createBackend>[0])
      expect(await remote.listAssets()).toEqual([
        { path: 'a.png', name: 'a.png', size: 1, updatedAt: 2 },
        { path: 'l.png', name: 'l.png', size: 1, updatedAt: 2, symlink: true }
      ])
      expect([...(await remote.readAsset('a b.png'))]).toEqual([0, 200, 255])
      expect(requests.at(-1)?.url).toBe('/api/assets/raw?path=a%20b.png')
      expect(requests.at(-1)?.auth).toBe('Bearer tok')

      expect(await remote.renameAsset('a.png', 'b.png')).toEqual({ path: 'b.png', name: 'b.png', size: 1, updatedAt: 2 })
      expect(JSON.parse(requests.at(-1)?.body ?? '')).toEqual({ path: 'a.png', name: 'b.png' })
      await remote.moveAsset('a.png', 'd')
      expect(JSON.parse(requests.at(-1)?.body ?? '')).toEqual({ path: 'a.png', targetDir: 'd' })
      await remote.duplicateAsset('a.png')
      expect(requests.at(-1)?.url).toBe('/api/assets/duplicate')
      const deleted = await remote.deleteAsset('a.png')
      expect(requests.at(-1)?.url).toBe('/api/assets/delete')
      await remote.restoreDeletedAsset(deleted)
      expect(JSON.parse(requests.at(-1)?.body ?? '')).toEqual(deleted)

      // A server with nothing to list may answer null.
      expect(await remote.listDeletedAssets()).toEqual([])
      expect(await remote.listTemplates()).toEqual([])

      expect((await remote.importAsset('u.png', new Uint8Array([1, 2, 3]))).path).toBe('assets/u.png')
      const upload = requests.at(-1)
      expect(upload?.url).toBe('/api/assets/upload')
      expect(upload?.type).toContain('multipart/form-data')
      expect(upload?.body).toContain('name="notePath"')
      expect(upload?.body).toContain('name="file"; filename="u.png"')
      expect(upload?.body).toContain('\u0001\u0002\u0003')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('rename_asset and move_asset', () => {
  it('keeps every kind of link pointing at the file, and a plain Markdown link a link', async () => {
    await seed({
      'assets/report.pdf': '%PDF',
      'notes/N.md': '![[report.pdf]] [x](../assets/report.pdf) [y](<../assets/report.pdf>) `[z](../assets/report.pdf)`\n'
    })
    const client = await connect()
    await ok(client, 'rename_asset', { path: 'assets/report.pdf', name: 'new report.pdf' })
    expect(await file('notes/N.md')).toBe(
      '![[new report.pdf]] [x](<../assets/new report.pdf>) [y](<../assets/new report.pdf>) `[z](../assets/report.pdf)`\n'
    )
    await ok(client, 'move_asset', { path: 'assets/new report.pdf', targetDir: 'files' })
    expect(await file('notes/N.md')).toBe(
      '![[new report.pdf]] [x](<../files/new report.pdf>) [y](<../files/new report.pdf>) `[z](../assets/report.pdf)`\n'
    )
  })

  it('rewrites links only in notes a path scope can see', async () => {
    await seed({
      'assets/a.png': 'a',
      'Projects/P.md': '![[assets/a.png]]\n',
      'Journal/J.md': '![[assets/a.png]]\n'
    })
    const client = await connect({ access: 'write', allow: ['assets', 'Projects'] })
    await ok(client, 'move_asset', { path: 'assets/a.png', targetDir: 'Projects/Files' })
    expect(await file('Projects/P.md')).toBe('![[Projects/Files/a.png]]\n')
    expect(await file('Journal/J.md')).toBe('![[assets/a.png]]\n')
    await ok(client, 'rename_asset', { path: 'Projects/Files/a.png', name: 'b.png' })
    expect(await file('Projects/P.md')).toBe('![[Projects/Files/b.png]]\n')
    expect(await file('Journal/J.md')).toBe('![[assets/a.png]]\n')
  })

  it('refuses a name that is taken, and numbers one in a new folder', async () => {
    await seed({ 'assets/a.png': 'a', 'assets/b.png': 'b', 'files/a.png': 'c' })
    const client = await connect()
    expect(await refused(client, 'rename_asset', { path: 'assets/a.png', name: 'b.png' })).toBe(
      'Error: an asset named "b.png" already exists in this folder'
    )
    expect(await ok(client, 'move_asset', { path: 'assets/a.png', targetDir: 'files' })).toContain(
      'files/a 2.png'
    )
  })
})

describe('delete_asset and restore_asset', () => {
  it('uses the store the app reads, and a taken name comes back numbered', async () => {
    await seed({ 'assets/a.png': 'a' })
    const client = await connect()
    const deleted = JSON.parse(await ok(client, 'delete_asset', { path: 'assets/a.png' })) as {
      undoToken: string
    }
    const dir = path.join(root, '.zennotes/deleted-assets', deleted.undoToken)
    expect(JSON.parse(await fsp.readFile(path.join(dir, '.zn-deleted.json'), 'utf8'))).toMatchObject({
      path: 'assets/a.png',
      name: 'a.png'
    })
    expect(JSON.parse(await ok(client, 'list_assets', { deleted: true }))).toMatchObject([
      { path: 'assets/a.png', undoToken: deleted.undoToken }
    ])
    await seed({ 'assets/a.png': 'new' })
    expect(await ok(client, 'restore_asset', { undoToken: deleted.undoToken })).toContain(
      'assets/a 2.png'
    )
    await expect(fsp.stat(dir)).rejects.toThrow()
    expect(await file('assets/a.png')).toBe('new')
    expect(await file('assets/a 2.png')).toBe('a')
  })
})

describe('update_task', () => {
  const NOTE = 'inbox/N.md'

  it('edits only what it was asked', async () => {
    await seed({ [NOTE]: '- [ ] one due:2026-01-01 !low #tag\n- [x] two\n- [>] sent\n' })
    const client = await connect()
    const first = JSON.parse(
      await ok(client, 'update_task', { id: `${NOTE}#0`, due: '2026-02-02' })
    ) as { due: string; priority: string }
    expect(first).toMatchObject({ due: '2026-02-02', priority: 'low' })
    await ok(client, 'update_task', { id: `${NOTE}#0`, priority: '', waiting: true, status: 'doing' })
    await ok(client, 'update_task', { id: `${NOTE}#1`, state: 'open' })
    expect(await file(NOTE)).toBe(
      '- [ ] one #tag due:2026-02-02 @waiting @status:doing\n- [ ] two\n- [>] sent\n'
    )
    expect(await refused(client, 'update_task', { id: `${NOTE}#2`, state: 'done' })).toBe(
      'Error: That task was forwarded to another note; change it there.'
    )
    for (const [state, mark] of [
      ['in-progress', '/'],
      ['cancelled', '-'],
      ['done', 'x'],
      ['open', ' ']
    ]) {
      await ok(client, 'update_task', { id: `${NOTE}#1`, state })
      expect(await file(NOTE)).toContain(`- [${mark}] two\n`)
    }
    const renamed = JSON.parse(
      await ok(client, 'update_task', { id: `${NOTE}#1`, text: 'renamed !high' })
    ) as { priority: string }
    expect(renamed.priority).toBe('high')
    expect(await ok(client, 'update_task', { id: `${NOTE}#42`, due: '2026-02-02' })).toBe('null')
  })

  it('refuses a bad value before it touches the note', async () => {
    await seed({ [NOTE]: '- [ ] one\n' })
    const client = await connect()
    for (const [args, message] of [
      [{}, 'update_task needs at least one of due, priority, waiting, state, status, text'],
      [{ due: 'tomorrow' }, 'due must be YYYY-MM-DD, or empty to clear it'],
      [{ due: '2026-02-30' }, 'due must be YYYY-MM-DD, or empty to clear it'],
      [{ priority: 'urgent' }, 'priority must be high, med or low, or empty to clear it'],
      [{ state: 'gone' }, 'state must be open, done, in-progress or cancelled'],
      [{ status: 'two words' }, 'status must be one word (letters, digits, /, _ or -), or empty to clear it'],
      [{ text: 'two\nlines' }, 'text must be one line, and not empty'],
      [{ text: '  ' }, 'text must be one line, and not empty']
    ] as const) {
      expect(await refused(client, 'update_task', { id: `${NOTE}#0`, ...args })).toBe(`Error: ${message}`)
    }
    expect(await file(NOTE)).toBe('- [ ] one\n')
  })

  // The line setters count tasks with their own fence rule, and an id comes from
  // the scan's. Where they could disagree, the edit follows the line the scan
  // pointed at.
  it('follows the scan, not a second count', async () => {
    await seed({ [NOTE]: '- [ ] first\n```\n- [ ] in code\n```\n- [ ] second\n' })
    const client = await connect()
    await ok(client, 'update_task', { id: `${NOTE}#1`, due: '2026-02-02' })
    expect(await file(NOTE)).toBe('- [ ] first\n```\n- [ ] in code\n```\n- [ ] second due:2026-02-02\n')
  })

  it('answers null, and writes nothing, when the line is not the one the scan read', async () => {
    await seed({ [NOTE]: '- [ ] one\n- [ ] two\n' })
    const local = createBackend({ kind: 'local', root })
    const stale: VaultBackend = {
      ...local,
      scanTasksForPath: async (rel, opts) =>
        (await local.scanTasksForPath(rel, opts)).map((task) => ({ ...task, rawText: '- [ ] old' }))
    }
    expect(await callTool('update_task', { id: `${NOTE}#0`, due: '2026-02-02' }, stale)).toBeNull()
    expect(await file(NOTE)).toBe('- [ ] one\n- [ ] two\n')
  })

  it('reads and writes a task note through its frontmatter', async () => {
    await seed({ [NOTE]: '---\ntags: [task]\nstatus: open\n---\n# Do it\n' })
    const client = await connect()
    const task = JSON.parse(
      await ok(client, 'update_task', {
        id: `${NOTE}#task`,
        due: '2026-02-02',
        priority: 'med',
        state: 'done'
      })
    ) as { due: string; checked: boolean }
    expect(task).toMatchObject({ due: '2026-02-02', checked: true })
    const body = await file(NOTE)
    expect(body).toContain('due: 2026-02-02')
    expect(body).toContain('status: done')
    expect(body).toContain('priority: normal')
    expect(await refused(client, 'update_task', { id: `${NOTE}#task`, text: 'x' })).toContain(
      'A task note has no line of text'
    )
  })
})

describe('daily_note', () => {
  it('starts from the vault template, unless the client sees only part of the vault', async () => {
    await seed({
      '.zennotes/vault.json':
        '{"primaryNotesLocation":"root","dailyNotes":{"enabled":true,"directory":"Days","titlePattern":"yyyy-MM-dd","templateId":"custom:day"}}',
      '.zennotes/templates/day.md': '---\nname: Day\n---\n# {{title}}\n\n## Log\n',
      'Days/2026-03-04.md': '# old\n',
      'Elsewhere/Plan.md': '# Plan\n'
    })
    const full = await connect()
    const missing = JSON.parse(await ok(full, 'daily_note', { date: '2026-03-05' })) as {
      exists: boolean
      enabled: boolean
      createWith: { subpath: string; title: string; body: string; folder: string }
    }
    expect(missing).toMatchObject({
      kind: 'daily',
      date: '2026-03-05',
      enabled: true,
      exists: false,
      createWith: { folder: 'inbox', subpath: 'Days', title: '2026-03-05' }
    })
    expect(missing.createWith.body).toContain('# 2026-03-05')
    expect(missing.createWith.body).toContain('## Log')
    expect(JSON.parse(await ok(full, 'daily_note', { date: '2026-03-04' }))).toMatchObject({
      exists: true,
      path: 'Days/2026-03-04.md',
      note: { path: 'Days/2026-03-04.md' }
    })

    // A hidden daily note reads as absent, in the same shape, with no template.
    const narrow = await connect({ access: 'read', allow: ['Elsewhere'] })
    const hidden = await ok(narrow, 'daily_note', { date: '2026-03-04' })
    expect(JSON.parse(hidden)).toMatchObject({ exists: false })
    expect(hidden).not.toContain('## Log')

    const read = await connect({ access: 'read' })
    expect(await ok(read, 'daily_note', { date: '2026-03-05' })).toContain('## Log')
    await expect(fsp.stat(path.join(root, 'Days/2026-03-05.md'))).rejects.toThrow()
  })

  it('finds a note under an older pattern, even with daily notes turned off', async () => {
    await seed({
      '.zennotes/vault.json':
        '{"primaryNotesLocation":"root","dailyNotes":{"enabled":false,"directory":"New","titlePattern":"yyyy-MM-dd","legacyPatterns":[{"directory":"Old","titlePattern":"yyyy.MM.dd"}]}}',
      'Old/2026.03.04.md': '# old pattern\n'
    })
    expect(JSON.parse(await ok(await connect(), 'daily_note', { date: '2026-03-04' }))).toMatchObject({
      enabled: false,
      exists: true,
      path: 'Old/2026.03.04.md'
    })
  })

  it('names the weekly and monthly note holding a date', async () => {
    const client = await connect()
    expect(
      JSON.parse(await ok(client, 'daily_note', { kind: 'weekly', date: '2026-01-01' }))
    ).toMatchObject({ kind: 'weekly', date: '2026-01-01', createWith: { title: '2026-W01' } })
    expect(
      JSON.parse(await ok(client, 'daily_note', { kind: 'monthly', date: '2026-02-14' }))
    ).toMatchObject({ kind: 'monthly', createWith: { title: '2026-02' } })
    expect(await refused(client, 'daily_note', { kind: 'yearly' })).toBe(
      'Error: kind must be daily, weekly or monthly'
    )
  })
})

describe('note_sections and edit_section', () => {
  const NOTE = 'inbox/N.md'
  const BODY =
    '---\ntitle: x\n---\n# N\n\nIntro\n\n## Actions\n\n- [ ] one\n\n### Detail\n\nfine print\n\n```\n# not a heading\n```\n\nSetext\n---\n\nunder\n'

  it('lists headings with zero-based lines, and reads the part under one', async () => {
    await seed({ [NOTE]: BODY })
    const client = await connect()
    const outline = JSON.parse(await ok(client, 'note_sections', { path: NOTE })) as {
      headings: { text: string; level: number; lineNumber: number; endLineNumber: number }[]
    }
    expect(outline.headings).toEqual([
      { level: 1, text: 'N', lineNumber: 3, endLineNumber: 24 },
      { level: 2, text: 'Actions', lineNumber: 7, endLineNumber: 19 },
      { level: 3, text: 'Detail', lineNumber: 11, endLineNumber: 19 },
      { level: 2, text: 'Setext', lineNumber: 19, endLineNumber: 24 }
    ])
    expect(JSON.parse(await ok(client, 'note_sections', { path: NOTE, heading: '## actions' }))).toEqual({
      path: NOTE,
      heading: 'Actions',
      level: 2,
      lineNumber: 7,
      endLineNumber: 19,
      body: '- [ ] one\n\n### Detail\n\nfine print\n\n```\n# not a heading\n```'
    })
    expect(JSON.parse(await ok(client, 'note_sections', { path: NOTE, heading: 'Setext' }))).toMatchObject({
      body: 'under'
    })
  })

  it('grows a list by one item, above any subheading, and keeps the rest', async () => {
    await seed({ [NOTE]: BODY })
    const client = await connect()
    await ok(client, 'edit_section', { path: NOTE, heading: 'Actions', mode: 'append', text: '- [ ] two' })
    expect(await file(NOTE)).toBe(BODY.replace('- [ ] one\n', '- [ ] one\n- [ ] two\n'))
  })

  it('gives anything else its own paragraph, and can replace or clear a section', async () => {
    await seed({ [NOTE]: '# N\n\nText\n\n## B\n\nOld\n\n### C\n\nDeep\n\n## D\n\nEnd\n' })
    const client = await connect()
    await ok(client, 'edit_section', { path: NOTE, heading: 'N', mode: 'prepend', text: 'First' })
    await ok(client, 'edit_section', { path: NOTE, heading: 'B', mode: 'replace', text: 'New' })
    await ok(client, 'edit_section', { path: NOTE, heading: 'D', mode: 'append', text: 'More' })
    expect(await file(NOTE)).toBe('# N\n\nFirst\n\nText\n\n## B\n\nNew\n\n## D\n\nEnd\n\nMore\n')
    await ok(client, 'edit_section', { path: NOTE, heading: 'B', mode: 'replace', text: '' })
    expect(await file(NOTE)).toBe('# N\n\nFirst\n\nText\n\n## B\n\n## D\n\nEnd\n\nMore\n')
  })

  it('picks by line when a heading repeats, and says what it can', async () => {
    await seed({ [NOTE]: '# N\n\n## A\n\n## A\n' })
    const client = await connect()
    const args = { path: NOTE, heading: 'A', mode: 'append', text: 'x' }
    expect(await refused(client, 'edit_section', args)).toBe(
      'Error: Heading "A" appears more than once, on lines 2, 4; pass lineNumber to pick one.'
    )
    await ok(client, 'edit_section', { ...args, lineNumber: 4 })
    expect(await file(NOTE)).toBe('# N\n\n## A\n\n## A\n\nx\n')
    expect(await refused(client, 'edit_section', { ...args, heading: 'Nope' })).toBe(
      'Error: No heading "Nope". Headings: N | A | A.'
    )
    expect(await refused(client, 'edit_section', { ...args, heading: 'N', text: ' ' })).toBe(
      'Error: text is empty; only replace can clear a section'
    )
    expect(await refused(client, 'edit_section', { ...args, heading: 'N', mode: 'rewrite' })).toBe(
      'Error: mode must be append, prepend or replace'
    )
    await seed({ 'inbox/Flat.md': 'no headings\n' })
    expect(await refused(client, 'note_sections', { path: 'inbox/Flat.md', heading: 'x' })).toBe(
      'Error: No heading "x": this note has no headings.'
    )
  })
})

describe('agent edit review', () => {
  it('records the new edit tools', async () => {
    await seed({ 'inbox/N.md': '# N\n\n## A\n\n- [ ] one\n' })
    const client = await connect()
    await ok(client, 'edit_section', { path: 'inbox/N.md', heading: 'A', mode: 'append', text: '- [ ] two' })
    await ok(client, 'update_task', { id: 'inbox/N.md#0', due: '2026-02-02' })
    const record = await readAgentEditRecord(root, 'inbox/N.md')
    expect(record?.edits.map((edit) => edit.tool)).toEqual(['edit_section', 'update_task'])
    expect(record?.before).toBe('# N\n\n## A\n\n- [ ] one\n')
  })
})

describe('the stdio transport', () => {
  // The SDK closes the whole session on a message past 10 MiB by default, which a
  // legal upload is well past, and an in-memory client never hits that limit.
  it('carries a message as large as the largest upload_asset can be', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const transport = stdioServerTransport(stdin, stdout)
    const received = new Promise<unknown>((resolve) => {
      transport.onmessage = resolve
    })
    const closed = vi.fn()
    transport.onclose = closed
    await transport.start()
    const padding = 'A'.repeat(45 * 1024 * 1024)
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { padding } })}\n`)
    expect(await received).toMatchObject({ id: 1, method: 'x' })
    expect(closed).not.toHaveBeenCalled()
    await transport.close()
  })
})
