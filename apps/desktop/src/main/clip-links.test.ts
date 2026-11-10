import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clipTextSha256Hex } from '@shared/clip-link'
import type { ClipApplyRequest, ClipNotice } from '@zennotes/bridge-contract/clip'
import {
  createClipLinkHandler,
  matchClipVaults,
  writeClipLocally,
  type ClipLinkDeps,
  type ClipVaultIo,
  type ClipWindow
} from './clip-links'
import type { ShareConfig, ShareTarget } from './share-inbox'
import {
  createNote,
  getVaultSettings,
  invalidateVaultSettingsCache,
  listNotes,
  readNote,
  writeNote
} from './vault'

const NOW = new Date(2026, 10, 9, 14, 30)
const tempDirs: string[] = []

async function vault(settings: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-clip-'))
  tempDirs.push(root)
  await mkdir(path.join(root, '.zennotes'), { recursive: true })
  await writeFile(path.join(root, '.zennotes', 'vault.json'), JSON.stringify(settings))
  invalidateVaultSettingsCache(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const io: ClipVaultIo = {
  createNote: (root, folder, title, subpath) => createNote(root, folder, title, subpath),
  writeNote,
  readNote,
  listNotes,
  getVaultSettings,
  dailyTemplateBody: async () => ''
}

function request(fields: Partial<ClipApplyRequest>): ClipApplyRequest {
  return {
    vaultRoot: null,
    action: 'new',
    folder: '',
    name: null,
    text: null,
    position: 'create',
    silent: false,
    ...fields
  }
}

const read = (root: string, rel: string): Promise<string> => readFile(path.join(root, rel), 'utf8')

describe('writeClipLocally', () => {
  it('files a clip in a folder of the Inbox in an inbox-mode vault', async () => {
    const root = await vault({ primaryNotesLocation: 'inbox' })
    const outcome = await writeClipLocally(
      io,
      root,
      request({ folder: 'Clippings', name: 'My Article', text: '---\nsource: x\n---\n\n# My Article\n' }),
      NOW
    )
    expect(outcome).toEqual({ ok: true, path: 'inbox/Clippings/My Article.md' })
    expect(await read(root, 'inbox/Clippings/My Article.md')).toBe('---\nsource: x\n---\n\n# My Article\n')
  })

  it('files it at the vault top level in an Obsidian-style vault', async () => {
    const root = await vault({ primaryNotesLocation: 'root' })
    const outcome = await writeClipLocally(io, root, request({ folder: 'Clippings', name: 'Page', text: 'hi\n' }), NOW)
    expect(outcome).toEqual({ ok: true, path: 'Clippings/Page.md' })
  })

  it('never overwrites: a taken name gets the next free one', async () => {
    const root = await vault({ primaryNotesLocation: 'root' })
    await writeClipLocally(io, root, request({ folder: 'Clippings', name: 'Page', text: 'first\n' }), NOW)
    const second = await writeClipLocally(io, root, request({ folder: 'Clippings', name: 'Page', text: 'second\n' }), NOW)
    expect(second).toEqual({ ok: true, path: 'Clippings/Page 2.md' })
    expect(await read(root, 'Clippings/Page.md')).toBe('first\n')
  })

  it('names a note from its first line below the frontmatter', async () => {
    const root = await vault({ primaryNotesLocation: 'root' })
    const outcome = await writeClipLocally(
      io,
      root,
      request({ text: '---\ncreated: 2026-11-09\n---\n\n# Reading: list?\n\nbody\n' }),
      NOW
    )
    expect(outcome).toEqual({ ok: true, path: 'Reading- list-.md' })
  })

  it('appends to the note a link names, and prepends below its frontmatter', async () => {
    const root = await vault({ primaryNotesLocation: 'root' })
    await mkdir(path.join(root, 'Reading'), { recursive: true })
    await writeFile(path.join(root, 'Reading', 'Log.md'), '---\ntags: [log]\n---\n# Log\n\n- one\n')
    expect(
      await writeClipLocally(io, root, request({ folder: 'Reading', name: 'Log', text: '- two', position: 'append' }), NOW)
    ).toEqual({ ok: true, path: 'Reading/Log.md' })
    expect(
      await writeClipLocally(io, root, request({ folder: 'Reading', name: 'Log', text: 'Top', position: 'prepend' }), NOW)
    ).toEqual({ ok: true, path: 'Reading/Log.md' })
    expect(await read(root, 'Reading/Log.md')).toBe('---\ntags: [log]\n---\nTop\n\n# Log\n\n- one\n\n- two\n')
  })

  it('creates the note an append names when it is missing', async () => {
    const root = await vault({ primaryNotesLocation: 'root' })
    const outcome = await writeClipLocally(
      io,
      root,
      request({ folder: 'Reading', name: 'New Log', text: '- first\n', position: 'append' }),
      NOW
    )
    expect(outcome).toEqual({ ok: true, path: 'Reading/New Log.md' })
    expect(await read(root, 'Reading/New Log.md')).toBe('- first\n')
  })

  it('refuses a daily clip while daily notes are off', async () => {
    const root = await vault({ primaryNotesLocation: 'root' })
    const outcome = await writeClipLocally(io, root, request({ action: 'daily', text: 'x', position: 'append' }), NOW)
    expect(outcome.ok).toBe(false)
  })

  it("adds to today's daily note, creating it from the vault's settings", async () => {
    const root = await vault({ primaryNotesLocation: 'root', dailyNotes: { enabled: true } })
    const first = await writeClipLocally(io, root, request({ action: 'daily', text: '- clipped', position: 'append' }), NOW)
    expect(first).toEqual({ ok: true, path: 'Daily Notes/2026-11-09.md' })
    const second = await writeClipLocally(io, root, request({ action: 'daily', text: '- again', position: 'append' }), NOW)
    expect(second).toEqual(first)
    expect(await read(root, 'Daily Notes/2026-11-09.md')).toBe('# 2026-11-09\n\n- clipped\n\n- again\n')
  })
})

describe('matchClipVaults', () => {
  const cfg: ShareConfig = {
    workspaceMode: 'local',
    vaultRoot: '/v/Work',
    localVaults: [
      { root: '/v/Work', name: 'Work', lastOpenedAt: 1 },
      { root: '/v/notes', name: 'Personal', lastOpenedAt: 1 },
      { root: '/w/Personal', name: 'Old', lastOpenedAt: 1 }
    ],
    remoteWorkspaceProfileId: null,
    remoteWorkspaceProfiles: [{ id: 'p1', name: 'Home Server', baseUrl: 'https://h.example', lastConnectedAt: null }]
  }

  it('matches a name or a folder name, ignoring case, never a path', () => {
    expect(matchClipVaults('work', cfg)).toEqual([{ kind: 'local', key: 'local:/v/Work', root: '/v/Work' }])
    expect(matchClipVaults('NOTES', cfg)).toEqual([{ kind: 'local', key: 'local:/v/notes', root: '/v/notes' }])
    expect(matchClipVaults('/v/Work', cfg)).toEqual([])
    expect(matchClipVaults('home server', cfg)).toEqual([{ kind: 'remote', key: 'remote:p1', profileId: 'p1' }])
  })

  it('reports every vault a name could mean', () => {
    expect(matchClipVaults('personal', cfg)).toHaveLength(2)
  })
})

describe('createClipLinkHandler', () => {
  async function harness(
    options: { clipboard?: string; window?: ClipWindow | null; cfg?: Partial<ShareConfig>; root?: string } = {}
  ) {
    const root = options.root ?? (await vault({ primaryNotesLocation: 'root' }))
    const sent: Array<{ win: number; request: ClipApplyRequest }> = []
    const focused: number[] = []
    const problems: ClipNotice[] = []
    const landed: string[] = []
    const opened: string[] = []
    const targets: ShareTarget[] = []
    const deps: ClipLinkDeps = {
      loadConfig: async () => ({
        workspaceMode: 'local',
        vaultRoot: root,
        localVaults: [{ root, name: 'Test Vault', lastOpenedAt: 1 }],
        remoteWorkspaceProfileId: null,
        remoteWorkspaceProfiles: [],
        ...options.cfg
      }),
      readClipboard: () => options.clipboard ?? '',
      windowFor: async (target) => {
        targets.push(target)
        return options.window ?? null
      },
      sendClip: (win, req) => sent.push({ win: win.id, request: req }),
      focus: (win) => focused.push(win.id),
      io,
      openLocal: (_root, rel) => opened.push(rel),
      notifyProblem: (notice) => problems.push(notice),
      notifyLanded: (message) => landed.push(message),
      now: () => NOW
    }
    const handler = createClipLinkHandler(deps)
    return { root, handler, sent, focused, problems, landed, opened, targets }
  }

  it('holds links until startup completes', async () => {
    const h = await harness({ window: { id: 7 } })
    expect(h.handler.handle('zennotes://new?content=hello')).toBe('clip')
    await h.handler.idle()
    expect(h.sent).toEqual([])
    h.handler.start()
    await h.handler.idle()
    expect(h.sent).toHaveLength(1)
  })

  it('hands a clip for a vault a window shows to that window, and raises it', async () => {
    const text = '# Page\n\nbody\n'
    const hash = await clipTextSha256Hex(text)
    const h = await harness({ clipboard: text, window: { id: 3 } })
    h.handler.start()
    expect(h.handler.handle(`zennotes://new?vault=test%20vault&file=Clippings%2FPage&clipboard=${hash}`)).toBe('clip')
    await h.handler.idle()
    expect(h.targets).toEqual([{ kind: 'local', key: `local:${h.root}`, root: h.root }])
    expect(h.sent).toEqual([
      {
        win: 3,
        request: {
          vaultRoot: h.root,
          action: 'new',
          folder: 'Clippings',
          name: 'Page',
          text,
          position: 'create',
          silent: false
        }
      }
    ])
    expect(h.focused).toEqual([3])
  })

  it('raises nothing for a silent clip', async () => {
    const h = await harness({ window: { id: 3 } })
    h.handler.start()
    expect(h.handler.handle('zennotes://daily?content=x&silent')).toBe('clip-silent')
    await h.handler.idle()
    expect(h.sent).toHaveLength(1)
    expect(h.focused).toEqual([])
  })

  it('writes nothing when the clipboard does not match the link', async () => {
    const hash = await clipTextSha256Hex('what the extension copied')
    const h = await harness({ clipboard: 'a password you copied', window: { id: 3 } })
    h.handler.start()
    h.handler.handle(`zennotes://new?file=Note&clipboard=${hash}`)
    await h.handler.idle()
    expect(h.sent).toEqual([])
    expect(h.problems).toHaveLength(1)
    expect(h.problems[0].message).toMatch(/did not arrive/)
  })

  it('accepts a clipboard Windows stored with CRLF, filing the text as sent', async () => {
    const text = '# Page\n\nbody\n'
    const h = await harness({ clipboard: '# Page\r\n\r\nbody\r\n', window: { id: 3 } })
    h.handler.start()
    h.handler.handle(`zennotes://new?file=Page&clipboard=${await clipTextSha256Hex(text)}`)
    await h.handler.idle()
    expect(h.problems).toEqual([])
    expect(h.sent[0].request.text).toBe(text)
  })

  it('says why a malformed link was refused', async () => {
    const h = await harness({ window: { id: 3 } })
    h.handler.start()
    expect(h.handler.handle('zennotes://new?file=..%2Fescape&content=x')).toBe('clip')
    await h.handler.idle()
    expect(h.sent).toEqual([])
    expect(h.problems).toHaveLength(1)
  })

  it('leaves links that are not clips to the next parser', async () => {
    const h = await harness()
    expect(h.handler.handle('zennotes://open?path=a.md')).toBe('none')
    expect(h.handler.handle('zennotes://quick-capture')).toBe('none')
  })

  it('refuses a vault name it does not know', async () => {
    const h = await harness({ window: { id: 3 } })
    h.handler.start()
    h.handler.handle('zennotes://new?vault=Nope&content=x')
    await h.handler.idle()
    expect(h.sent).toEqual([])
    expect(h.problems[0].message).toMatch(/No vault is named "Nope"/)
  })

  it('writes a clip itself when no window shows the vault, then opens it', async () => {
    const h = await harness({ window: null })
    h.handler.start()
    h.handler.handle('zennotes://new?file=Clippings%2FPage&content=hello')
    await h.handler.idle()
    expect(h.opened).toEqual(['Clippings/Page.md'])
    expect(await read(h.root, 'Clippings/Page.md')).toBe('hello')
  })

  it('tells a silent clip it landed instead of opening it', async () => {
    const h = await harness({ window: null })
    h.handler.start()
    h.handler.handle('zennotes://new?file=Clippings%2FPage&content=hello&silent')
    await h.handler.idle()
    expect(h.opened).toEqual([])
    expect(h.landed).toEqual(['Clipped to Clippings/Page'])
  })

  it('asks for a server to be connected before clipping into it', async () => {
    const h = await harness({
      window: null,
      cfg: {
        workspaceMode: 'remote',
        remoteWorkspaceProfileId: 'p1',
        remoteWorkspaceProfiles: [{ id: 'p1', name: 'Home', baseUrl: 'https://h.example', lastConnectedAt: 1 }]
      }
    })
    h.handler.start()
    h.handler.handle('zennotes://new?content=x')
    await h.handler.idle()
    expect(h.problems[0].message).toMatch(/Connect to "Home"/)
  })

  it('handles clips one at a time, in order', async () => {
    const h = await harness({ window: null })
    h.handler.start()
    h.handler.handle('zennotes://new?file=Log&content=one&append')
    h.handler.handle('zennotes://new?file=Log&content=two&append')
    await h.handler.idle()
    expect(await read(h.root, 'Log.md')).toBe('one\n\ntwo\n')
  })
})
