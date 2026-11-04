// Links inside a shared folder, on a vault behind a ZenNotes server. A local
// vault is covered by the shared fixture (scope-contract.test.ts); a server is
// not, because it lists a link to a note and its writes follow links to
// folders. zn's own tests are in internal/mcp/scope_server_contract_test.go
// (ZenNotes/tui).
//
// The same calls run twice: against a small HTTP server that answers the way
// znserver does, which always runs and can also answer what a real one will
// not (a 500, a 401), and against a real server when
// ZENNOTES_SERVER_CONTRACT_BINARY names one built from ZenNotes/znserver.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newMcpScope } from '@shared/mcp-scope'
import { createBackend, type VaultBackend } from '../cli/backend'
import { callTool } from './server'

const TOKEN = 'tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SCOPE = newMcpScope({ access: 'write', allow: ['Projects'] })
const REFUSAL = 'This assistant can create and move notes only inside: Projects.'
const DIARY = '# Diary\n\nprivate needle\n- [ ] call mum\n\nsee [[Plan]]\n'

/** Destinations through a link to a folder, in and out of the vault. */
const THROUGH_A_FOLDER_LINK: [string, Record<string, unknown>][] = [
  ['create_note', { folder: 'inbox', subpath: 'Projects/inner', title: 'Via' }],
  ['create_note', { folder: 'inbox', subpath: 'Projects/inner/Deeper', title: 'Via' }],
  ['create_note', { folder: 'inbox', subpath: 'Projects/out', title: 'Via' }],
  ['create_folder', { folder: 'inbox', subpath: 'Projects/inner/Made' }],
  ['create_folder', { folder: 'inbox', subpath: 'Projects/out/Made' }],
  ['move_note', { path: 'Projects/Plan.md', targetFolder: 'inbox', targetSubpath: 'Projects/inner' }],
  ['rename_folder', { folder: 'inbox', oldSubpath: 'Projects/Sub', newSubpath: 'Projects/inner/Sub' }],
  ['rename_folder', { folder: 'inbox', oldSubpath: 'Projects/Sub', newSubpath: 'Projects/inner' }]
]

/** Every call that names the link to a note directly. */
const AT_A_NOTE_LINK: [string, Record<string, unknown>][] = [
  ['read_note', { path: 'Projects/alias.md' }],
  ['write_note', { path: 'Projects/alias.md', body: '# Overwritten\n' }],
  ['append_to_note', { path: 'Projects/alias.md', text: 'more' }],
  ['delete_note', { path: 'Projects/alias.md', confirm: true }]
]

/** Listings that would otherwise show the link or what it points at. */
const LISTINGS: [string, Record<string, unknown>][] = [
  ['list_notes', {}],
  ['list_assets', {}],
  ['list_tasks', {}],
  ['search_text', { query: 'needle' }],
  ['search_by_title', { query: 'alias' }],
  ['backlinks', { path: 'Projects/Plan.md' }]
]

async function expectLinksRefused(backend: VaultBackend): Promise<void> {
  for (const [tool, args] of THROUGH_A_FOLDER_LINK) {
    await expect(callTool(tool, args, backend, SCOPE), `${tool} ${JSON.stringify(args)}`).rejects.toThrow(
      new Error(REFUSAL)
    )
  }
  for (const [tool, args] of AT_A_NOTE_LINK) {
    await expect(callTool(tool, args, backend, SCOPE), tool).rejects.toThrow(
      new Error('Note not found: Projects/alias.md')
    )
  }
  for (const [tool, args] of LISTINGS) {
    const text = JSON.stringify(await callTool(tool, args, backend, SCOPE))
    for (const leak of ['alias', 'needle', 'call mum']) {
      expect(text, `${tool} shows ${leak}`).not.toContain(leak)
    }
  }
}

function remote(baseUrl: string): VaultBackend {
  return createBackend({ kind: 'remote', name: '', baseUrl, authToken: TOKEN })
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a scoped client on a server that answers like znserver', () => {
  const meta = (rel: string, body: string, symlink = false): Record<string, unknown> => ({
    path: rel,
    title: path.posix.basename(rel, '.md'),
    folder: 'inbox',
    createdAt: 1,
    updatedAt: 2,
    size: body.length,
    tags: [],
    wikilinks: [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]),
    excerpt: body.slice(0, 40),
    ...(symlink ? { symlink: true } : {})
  })

  const NOTES: Record<string, string> = {
    'Projects/Plan.md': '# Plan\n',
    'Projects/Sub/Step.md': '# Step\n',
    'Journal/Diary.md': DIARY
  }

  let server: Server
  let baseUrl: string
  /** What a read of a path no listing knows answers, by path. */
  let reads: Record<string, number>
  let posts: string[]

  beforeEach(async () => {
    reads = {
      'Projects/inner': 400,
      'Projects/inner/Deeper': 400,
      'Projects/inner/Made': 400,
      'Projects/inner/Sub': 400,
      'Projects/out': 400,
      'Projects/out/Made': 400
    }
    posts = []
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST') {
        let raw = ''
        req.on('data', (chunk) => (raw += chunk))
        req.on('end', () => {
          posts.push(url.pathname)
          const body = JSON.parse(raw || '{}') as { title?: string; subpath?: string }
          const rel = `${body.subpath}/${body.title}.md`
          json(200, meta(rel, ''))
        })
        return
      }
      switch (url.pathname) {
        case '/api/vault/settings':
          return json(200, { primaryNotesLocation: 'root' })
        case '/api/notes':
          return json(200, [
            ...Object.entries(NOTES).map(([rel, body]) => meta(rel, body)),
            meta('Projects/alias.md', DIARY, true)
          ])
        case '/api/folders':
          return json(200, [
            { folder: 'inbox', subpath: 'Projects' },
            { folder: 'inbox', subpath: 'Projects/Sub' },
            { folder: 'inbox', subpath: 'Journal' }
          ])
        case '/api/assets':
          return json(200, [
            { path: 'Projects/real.png', name: 'real.png', size: 3, updatedAt: 2 },
            { path: 'Projects/alias.png', name: 'alias.png', size: 3, updatedAt: 2, symlink: true }
          ])
        case '/api/tasks':
          return json(200, [
            {
              id: 'Projects/alias.md#0',
              sourcePath: 'Projects/alias.md',
              noteTitle: 'alias',
              noteFolder: 'inbox',
              lineNumber: 4,
              taskIndex: 0,
              rawText: '- [ ] call mum',
              content: 'call mum',
              checked: false,
              cancelled: false,
              waiting: false,
              tags: []
            }
          ])
        case '/api/search/text':
          return json(200, [
            { path: 'Projects/alias.md', title: 'alias', folder: 'inbox', lineNumber: 3, lineText: 'private needle' }
          ])
        case '/api/notes/read': {
          const rel = url.searchParams.get('path') ?? ''
          if (rel in NOTES) return json(200, { ...meta(rel, NOTES[rel]), body: NOTES[rel] })
          res.writeHead(reads[rel] ?? 404)
          return res.end('no such note')
        }
        default:
          res.writeHead(404)
          return res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    baseUrl = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('refuses every destination through a link and every note that is one', async () => {
    await expectLinksRefused(remote(baseUrl))
    expect(posts).toEqual([])
  })

  it('still sees what is real and makes what is new', async () => {
    const backend = remote(baseUrl)
    const notes = (await callTool('list_notes', {}, backend, SCOPE)) as { path: string }[]
    expect(notes.map((n) => n.path).sort()).toEqual(['Projects/Plan.md', 'Projects/Sub/Step.md'])
    const assets = (await callTool('list_assets', {}, backend, SCOPE)) as { path: string }[]
    expect(assets.map((a) => a.path)).toEqual(['Projects/real.png'])
    await expect(
      callTool('create_note', { folder: 'inbox', subpath: 'Projects/Fresh/Deeper', title: 'New' }, backend, SCOPE)
    ).resolves.toMatchObject({ path: 'Projects/Fresh/Deeper/New.md' })
    expect(posts).toEqual(['/api/notes/create'])
  })

  // Only "nothing there" makes a path free, so a check that could not tell
  // refuses. A server from before 2.20 answers 500 for a missing file.
  it.each([500, 401, 403, 400])('takes a read that answers %i as something being there', async (status) => {
    reads['Projects/Unknown'] = status
    await expect(
      callTool('create_folder', { folder: 'inbox', subpath: 'Projects/Unknown' }, remote(baseUrl), SCOPE)
    ).rejects.toThrow(new Error(REFUSAL))
    expect(posts).toEqual([])
  })

  it('takes an unreachable server as something being there', async () => {
    const backend = remote(baseUrl)
    const read = vi.spyOn(backend, 'readNote').mockRejectedValue(new Error('fetch failed'))
    await expect(
      callTool('create_folder', { folder: 'inbox', subpath: 'Projects/Unknown' }, backend, SCOPE)
    ).rejects.toThrow(new Error(REFUSAL))
    expect(read).toHaveBeenCalledWith('Projects/Unknown')
    expect(posts).toEqual([])
  })

  it('leaves a client with no path scope alone', async () => {
    const whole = newMcpScope({ access: 'write' })
    const backend = remote(baseUrl)
    const notes = (await callTool('list_notes', {}, backend, whole)) as { path: string }[]
    expect(notes.map((n) => n.path)).toContain('Projects/alias.md')
  })
})

const binary = process.env.ZENNOTES_SERVER_CONTRACT_BINARY

describe.skipIf(!binary)('a scoped client on a real server', () => {
  let base: string
  let root: string
  let child: ChildProcess
  let baseUrl: string

  const entries = async (dir: string): Promise<string[]> =>
    (await fsp.readdir(path.join(root, dir))).sort()

  beforeEach(async () => {
    base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-links-')))
    root = path.join(base, 'vault')
    const files: Record<string, string> = {
      '.zennotes/vault.json': '{"primaryNotesLocation":"root"}',
      'Projects/Plan.md': '# Plan\n',
      'Projects/Sub/Step.md': '# Step\n',
      'Journal/Diary.md': DIARY,
      'Journal/secret.png': 'png'
    }
    for (const [rel, body] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await fsp.writeFile(path.join(root, rel), body)
    }
    await fsp.mkdir(path.join(base, 'outside'))
    await fsp.symlink('../Journal', path.join(root, 'Projects', 'inner'))
    await fsp.symlink('../../outside', path.join(root, 'Projects', 'out'))
    await fsp.symlink('../Journal/Diary.md', path.join(root, 'Projects', 'alias.md'))
    await fsp.symlink('../Journal/secret.png', path.join(root, 'Projects', 'alias.png'))

    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer()
      probe.on('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        probe.close(() => resolve(address && typeof address === 'object' ? address.port : 0))
      })
    })
    baseUrl = `http://127.0.0.1:${port}`
    child = spawn(binary as string, [], {
      cwd: base,
      stdio: 'ignore',
      env: {
        ...process.env,
        ZENNOTES_BIND: `127.0.0.1:${port}`,
        ZENNOTES_VAULT_PATH: root,
        ZENNOTES_CONFIG_PATH: path.join(base, 'server.json'),
        ZENNOTES_AUTH_TOKEN: TOKEN
      }
    })
    for (let attempt = 0; ; attempt += 1) {
      const ready = await fetch(`${baseUrl}/healthz`).then(
        (res) => res.ok,
        () => false
      )
      if (ready) break
      if (attempt > 400) throw new Error('server did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  })

  afterEach(async () => {
    child.kill()
    await fsp.rm(base, { recursive: true, force: true })
  })

  it('refuses the same calls, and nothing reaches the hidden folder or outside', async () => {
    await expectLinksRefused(remote(baseUrl))
    expect(await entries('Journal')).toEqual(['Diary.md', 'secret.png'])
    expect(await fsp.readdir(path.join(base, 'outside'))).toEqual([])
    expect(await fsp.readFile(path.join(root, 'Journal', 'Diary.md'), 'utf8')).toBe(DIARY)
    expect(await entries('Projects')).toEqual(['Plan.md', 'Sub', 'alias.md', 'alias.png', 'inner', 'out'])
    expect(await entries('Projects/Sub')).toEqual(['Step.md'])
  })

  // The link is hidden from the client, so it can ask for that name.
  it('does not write through the link when a new note takes its name', async () => {
    const created = (await callTool(
      'create_note',
      { folder: 'inbox', subpath: 'Projects', title: 'alias', body: '# Mine\n' },
      remote(baseUrl),
      SCOPE
    )) as { path: string }
    expect(created.path).not.toBe('Projects/alias.md')
    expect(await fsp.readFile(path.join(root, 'Journal', 'Diary.md'), 'utf8')).toBe(DIARY)
  })

  it('answers a read of a missing path with 404, which is what makes a new folder work', async () => {
    const backend = remote(baseUrl)
    await expect(
      callTool('create_note', { folder: 'inbox', subpath: 'Projects/Fresh/Deeper', title: 'New' }, backend, SCOPE)
    ).resolves.toMatchObject({ path: 'Projects/Fresh/Deeper/New.md' })
    await expect(
      fsp.stat(path.join(root, 'Projects', 'Fresh', 'Deeper', 'New.md'))
    ).resolves.toBeTruthy()
  })
})
