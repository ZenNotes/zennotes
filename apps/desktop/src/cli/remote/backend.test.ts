/**
 * The remote backend, driven against a real HTTP server on a real socket
 * (#493). A stubbed `fetch` would prove the composition and nothing else;
 * this also exercises the auth header, the JSON round trip, and both error
 * paths the way a user's server would.
 *
 * The fake server is deliberately dumb — it stores note bodies in a Map and
 * mirrors only the routes the CLI calls. What it must get right is the shape
 * of the responses, because that is the contract the CLI is coded against.
 */

import { createServer, type Server } from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBackend, type VaultBackend } from '../backend'
import {
  appendToNote,
  createNote as createNoteLocal,
  prependToNote,
  readNote as readNoteLocal,
  toggleTask as toggleTaskLocal,
  writeNote as writeNoteLocal
} from '../../mcp/vault-ops'

interface FakeVault {
  notes: Map<string, string>
  requests: { method: string; url: string; auth: string | null }[]
  /** Set to a status code to make the next request fail. */
  failWith: number | null
}

let server: Server
let baseUrl: string
let vault: FakeVault
const AUTH_TOKEN = 'test-token'

function metaFor(rel: string, body: string): Record<string, unknown> {
  const fileName = rel.split('/').pop() ?? rel
  const title = fileName.replace(/\.md$/, '')
  const top = rel.split('/')[0]
  const folder = ['inbox', 'quick', 'archive', 'trash'].includes(top) ? top : 'inbox'
  return {
    path: rel,
    title,
    folder,
    siblingOrder: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    size: Buffer.byteLength(body),
    tags: [...body.matchAll(/(?:^|\s)#([\w/-]+)/g)].map((m) => m[1]),
    wikilinks: [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]),
    hasAttachments: false,
    excerpt: body.slice(0, 40)
  }
}

/** The server's inline-task scan, matching the id scheme Go uses. */
function tasksFor(rel: string, body: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const lines = body.split('\n')
  let index = 0
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*[-*+]\s+\[([ xX>-])\](.*)$/)
    if (!match) continue
    out.push({
      id: `${rel}#${index}`,
      sourcePath: rel,
      noteTitle: rel,
      noteFolder: 'inbox',
      lineNumber: i + 1,
      taskIndex: index,
      rawText: lines[i],
      content: match[2].trim(),
      checked: match[1].toLowerCase() === 'x',
      cancelled: match[1] === '-',
      waiting: false,
      tags: [],
      kind: 'inline'
    })
    index += 1
  }
  return out
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<never> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return (raw ? JSON.parse(raw) : {}) as never
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    vault.requests.push({
      method: req.method ?? 'GET',
      url: url.pathname,
      auth: req.headers.authorization ?? null
    })

    if (vault.failWith) {
      const status = vault.failWith
      vault.failWith = null
      res.writeHead(status, { 'Content-Type': 'text/plain' })
      res.end('nope')
      return
    }

    const send = (payload: unknown): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const rel = url.searchParams.get('path') ?? ''

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/notes':
        return send([...vault.notes].map(([p, body]) => metaFor(p, body)))
      case 'GET /api/notes/read': {
        const body = vault.notes.get(rel)
        if (body == null) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        return send({ ...metaFor(rel, body), body })
      }
      case 'GET /api/folders':
        return send([{ folder: 'inbox', subpath: 'Work', siblingOrder: 0 }])
      case 'GET /api/tasks':
        return send([...vault.notes].flatMap(([p, body]) => tasksFor(p, body)))
      case 'GET /api/tasks/for':
        return send(tasksFor(rel, vault.notes.get(rel) ?? ''))
      case 'GET /api/search/text': {
        const needle = (url.searchParams.get('q') ?? '').toLowerCase()
        const matches: unknown[] = []
        for (const [p, body] of vault.notes) {
          body.split('\n').forEach((line, i) => {
            if (line.toLowerCase().includes(needle)) {
              matches.push({ path: p, title: p, folder: 'inbox', lineNumber: i + 1, lineText: line })
            }
          })
        }
        return send(matches)
      }
      case 'POST /api/notes/write': {
        const payload = await readJsonBody(req) as { path: string; body: string }
        vault.notes.set(payload.path, payload.body)
        return send(metaFor(payload.path, payload.body))
      }
      case 'POST /api/notes/create': {
        const payload = await readJsonBody(req) as {
          folder: string
          title?: string
          subpath?: string
        }
        const title = payload.title || 'Untitled'
        const rel = [payload.folder, payload.subpath, `${title}.md`].filter(Boolean).join('/')
        // The real server seeds a heading, and takes no body — which is why
        // the backend has to follow up with a write.
        const seeded = `# ${title}\n\n`
        vault.notes.set(rel, seeded)
        return send(metaFor(rel, seeded))
      }
      case 'POST /api/notes/rename': {
        const payload = await readJsonBody(req) as { path: string; title: string }
        const body = vault.notes.get(payload.path) ?? ''
        const dir = payload.path.slice(0, payload.path.lastIndexOf('/') + 1)
        const next = `${dir}${payload.title}.md`
        vault.notes.delete(payload.path)
        vault.notes.set(next, body)
        return send(metaFor(next, body))
      }
      case 'POST /api/notes/trash': {
        const payload = await readJsonBody(req) as { path: string }
        const body = vault.notes.get(payload.path) ?? ''
        const next = `trash/${payload.path.split('/').pop()}`
        vault.notes.delete(payload.path)
        vault.notes.set(next, body)
        return send(metaFor(next, body))
      }
      case 'POST /api/notes/delete': {
        const payload = await readJsonBody(req) as { path: string }
        vault.notes.delete(payload.path)
        res.writeHead(204)
        res.end()
        return
      }
      case 'POST /api/folders/rename':
        return send({ subpath: 'Renamed' })
      case 'GET /api/vault':
        return send({ root: '/srv/notes', name: 'notes' })
      case 'GET /api/vault/settings':
        return send({ primaryNotesLocation: 'root', systemFolderPaths: null })
      case 'GET /api/assets':
        return send([
          { path: 'assets/pic.png', name: 'pic.png', kind: 'image', siblingOrder: 0, size: 4, updatedAt: 9 }
        ])
      case 'POST /api/notes/empty-trash': {
        for (const key of [...vault.notes.keys()]) if (key.startsWith('trash/')) vault.notes.delete(key)
        res.writeHead(204)
        res.end()
        return
      }
      default:
        res.writeHead(404)
        res.end('no route')
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function remote(token: string | null = AUTH_TOKEN): VaultBackend {
  return createBackend({ kind: 'remote', name: 'test', baseUrl, authToken: token })
}

beforeEach(() => {
  vault = {
    notes: new Map([
      ['inbox/Daily.md', '# Daily\n\n- [ ] first\n- [ ] second\n'],
      ['inbox/Ref.md', '# Ref\n\nSee [[Daily]] for more. #work\n']
    ]),
    requests: [],
    failWith: null
  }
})

describe('RemoteBackend — reads', () => {
  it('lists notes and reads a body over HTTP', async () => {
    const backend = remote()
    const notes = await backend.listNotes()
    expect(notes.map((n) => n.path).sort()).toEqual(['inbox/Daily.md', 'inbox/Ref.md'])
    expect((await backend.readNote('inbox/Daily.md')).body).toContain('- [ ] first')
  })

  it('sends the auth token on every request', async () => {
    await remote().listNotes()
    expect(vault.requests.at(-1)?.auth).toBe(`Bearer ${AUTH_TOKEN}`)
  })

  it('sends no Authorization header when there is no token', async () => {
    await remote(null).listNotes()
    expect(vault.requests.at(-1)?.auth).toBeNull()
  })

  it('applies --limit itself, since the search route has no limit parameter', async () => {
    const matches = await remote().searchText('a', 1)
    expect(matches).toHaveLength(1)
    expect(vault.requests.at(-1)?.url).toBe('/api/search/text')
  })

  it('finds backlinks from the note listing', async () => {
    expect((await remote().backlinks('inbox/Daily.md')).map((n) => n.path)).toEqual([
      'inbox/Ref.md'
    ])
  })

  it('reports the vault as remote, and has no local root for `zn open`', () => {
    const backend = remote()
    expect(backend.kind).toBe('remote')
    expect(backend.root).toBe('')
    expect(backend.label).toBe(`test (${baseUrl})`)
  })
})

describe('RemoteBackend — writes composed from the routes that exist', () => {
  it('creates a note with a body as create-then-write', async () => {
    const meta = await remote().createNote('inbox', 'Fresh', '', '# Fresh\n\nhello\n')
    expect(meta.path).toBe('inbox/Fresh.md')
    expect(vault.notes.get('inbox/Fresh.md')).toBe('# Fresh\n\nhello\n')
    const posts = vault.requests.filter((r) => r.method === 'POST').map((r) => r.url)
    expect(posts).toEqual(['/api/notes/create', '/api/notes/write'])
  })

  it('creates a note without a body in a single call', async () => {
    await remote().createNote('inbox', 'Empty')
    expect(vault.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  it('refuses to create straight into trash, same as a local vault', async () => {
    await expect(remote().createNote('trash', 'Nope')).rejects.toThrow(/Refusing to create/)
  })

  it('toggles an inline task and returns the server-reparsed task', async () => {
    const task = await remote().toggleTask('inbox/Daily.md#1')
    expect(task?.checked).toBe(true)
    expect(task?.content).toBe('second')
    expect(vault.notes.get('inbox/Daily.md')).toBe('# Daily\n\n- [ ] first\n- [x] second\n')
  })

  it('returns null for a task that is no longer there', async () => {
    expect(await remote().toggleTask('inbox/Daily.md#9')).toBeNull()
  })

  it('passes through trash and delete', async () => {
    await remote().moveToTrash('inbox/Ref.md')
    expect(vault.notes.has('trash/Ref.md')).toBe(true)
    await remote().deleteNote('trash/Ref.md')
    expect(vault.notes.has('trash/Ref.md')).toBe(false)
  })

  it('unwraps the renamed subpath the server reports back', async () => {
    expect(await remote().renameFolder('inbox', 'Work', 'Renamed')).toBe('Renamed')
  })
})

describe('RemoteBackend — failures a user will actually hit', () => {
  it('names the token and the server on a 401', async () => {
    vault.failWith = 401
    await expect(remote().listNotes()).rejects.toThrow(
      new RegExp(`rejected the connection.*${baseUrl}`, 's')
    )
  })

  it('reports the status on any other error', async () => {
    vault.failWith = 500
    await expect(remote().listNotes()).rejects.toThrow(/Remote server request failed \(500/)
  })

  it('explains an unreachable server rather than leaking "fetch failed"', async () => {
    // Port 1 is reserved and nothing listens there.
    const dead = createBackend({
      kind: 'remote',
      name: '',
      baseUrl: 'http://127.0.0.1:1',
      authToken: null
    })
    await expect(dead.listNotes()).rejects.toThrow(
      /Could not connect to the ZenNotes server at http:\/\/127.0.0.1:1/
    )
  })
})

/**
 * The point of extracting the pure body transforms: an edit has to mean the
 * same thing on both sides of the wire. These run the *same* input through a
 * real local vault and the remote backend and compare the bytes.
 */
describe('local and remote edits produce identical bytes', () => {
  let tmpDir: string
  let root: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-parity-'))
    root = path.join(tmpDir, 'vault')
    await fsp.mkdir(path.join(root, 'inbox'), { recursive: true })
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  const cases: { name: string; seed: string; text: string; op: 'append' | 'prepend' }[] = [
    { name: 'append to a body ending in a newline', seed: '# A\n\nbody\n', text: 'added', op: 'append' },
    { name: 'append to a body with no trailing newline', seed: '# A\n\nbody', text: 'added', op: 'append' },
    { name: 'append to an empty body', seed: '', text: 'added', op: 'append' },
    { name: 'prepend above the content', seed: '# A\n\nbody\n', text: 'top', op: 'prepend' },
    {
      name: 'prepend below frontmatter',
      seed: '---\ntags: [a]\n---\n# A\n\nbody\n',
      text: 'top',
      op: 'prepend'
    },
    { name: 'append text carrying its own trailing newlines', seed: '# A\n', text: 'x\n\n\n', op: 'append' }
  ]

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const rel = 'inbox/Note.md'
      await writeNoteLocal(root, rel, testCase.seed)
      vault.notes.set(rel, testCase.seed)

      if (testCase.op === 'append') {
        await appendToNote(root, rel, testCase.text)
        await remote().appendToNote(rel, testCase.text)
      } else {
        await prependToNote(root, rel, testCase.text)
        await remote().prependToNote(rel, testCase.text)
      }

      const local = (await readNoteLocal(root, rel)).body
      expect(vault.notes.get(rel)).toBe(local)
    })
  }

  it('toggles a checkbox to the same bytes', async () => {
    const rel = 'inbox/Tasks.md'
    const seed = '# Tasks\n\n- [ ] one\n  - [x] nested\n\n```\n- [ ] fenced\n```\n- [ ] three\n'
    await writeNoteLocal(root, rel, seed)
    vault.notes.set(rel, seed)

    // Index 2 is `three`: the fenced line must not be counted.
    await toggleTaskLocal(root, `${rel}#2`)
    await remote().toggleTask(`${rel}#2`)

    const local = (await readNoteLocal(root, rel)).body
    expect(vault.notes.get(rel)).toBe(local)
    expect(local).toContain('- [x] three')
    expect(local).toContain('- [ ] fenced')
  })

  it('creates the same body from `zn capture` input', async () => {
    const composed = '# Captured\n\n#idea\n\nthought\n'
    const localMeta = await createNoteLocal(root, 'inbox', 'Captured', '', composed)
    const remoteMeta = await remote().createNote('inbox', 'Captured', '', composed)

    expect(remoteMeta.path).toBe(localMeta.path)
    expect(vault.notes.get(remoteMeta.path)).toBe((await readNoteLocal(root, localMeta.path)).body)
  })
})

describe('RemoteBackend: what the MCP needs beyond the CLI (#688)', () => {
  it('describes the server vault from /api/vault and its layout settings', async () => {
    expect(await remote().describe()).toEqual({
      kind: 'remote',
      baseUrl,
      name: 'test',
      vaultPath: '/srv/notes',
      vaultName: 'notes',
      primaryNotesLocation: 'root',
      authConfigured: true
    })
    expect(await remote(null).describe()).toMatchObject({ authConfigured: false })
  })

  it('lists assets in the local shape', async () => {
    expect(await remote().listAssets()).toEqual([
      { path: 'assets/pic.png', name: 'pic.png', size: 4, updatedAt: 9 }
    ])
  })

  it('empties the trash through the server route', async () => {
    vault.notes.set('trash/Old.md', '# Old')
    await remote().emptyTrash()
    expect(vault.requests.at(-1)?.url).toBe('/api/notes/empty-trash')
    expect(vault.notes.has('trash/Old.md')).toBe(false)
  })

  it('inserts at a line as read-then-write', async () => {
    await remote().insertAtLine('inbox/Daily.md', 2, '- zero')
    expect(vault.notes.get('inbox/Daily.md')).toBe('# Daily\n\n- zero\n- [ ] first\n- [ ] second\n')
  })

  it('replaces in a note, and skips the write when nothing matched', async () => {
    const backend = remote()
    expect((await backend.replaceInNote('inbox/Daily.md', 'first', '1st', 'first')).replacements).toBe(1)
    expect(vault.notes.get('inbox/Daily.md')).toContain('- [ ] 1st')
    const before = vault.requests.length
    const miss = await backend.replaceInNote('inbox/Daily.md', 'absent', 'x', 'all')
    expect(miss.replacements).toBe(0)
    expect(miss.meta.path).toBe('inbox/Daily.md')
    expect(vault.requests.slice(before).map((r) => r.url)).not.toContain('/api/notes/write')
  })
})

describe('RemoteBackend: renaming a record page keeps its row in step (#691)', () => {
  it('updates the sidecar page pointer and the title cell after the server renames the file', async () => {
    vault.notes.set('inbox/Meetings.base/data.csv', 'id,Name,Project\nrow-1,Kickoff,\n')
    vault.notes.set(
      'inbox/Meetings.base/schema.json',
      JSON.stringify({
        version: 1,
        idFieldId: 'f_id',
        fields: [
          { id: 'f_id', name: 'id', type: 'text', hidden: true },
          { id: 'f_name', name: 'Name', type: 'text' },
          { id: 'f_project', name: 'Project', type: 'text' }
        ],
        views: [{ id: 'v1', name: 'Table', type: 'table', filters: [], sorts: [] }],
        activeViewId: 'v1',
        pages: { 'row-1': 'Kickoff.md' }
      })
    )
    vault.notes.set('inbox/Meetings.base/Kickoff.md', '---\nProject:\n---\n# Kickoff\n\nagenda\n')

    const meta = await remote().renameNote('inbox/Meetings.base/Kickoff.md', 'Kickoff notes')
    expect(meta.path).toBe('inbox/Meetings.base/Kickoff notes.md')
    expect(vault.notes.has('inbox/Meetings.base/Kickoff.md')).toBe(false)

    const schema = JSON.parse(vault.notes.get('inbox/Meetings.base/schema.json') ?? '{}') as {
      pages?: Record<string, string>
    }
    expect(schema.pages).toEqual({ 'row-1': 'Kickoff notes.md' })
    expect(vault.notes.get('inbox/Meetings.base/data.csv')).toContain('row-1,Kickoff notes,')
  })
})
