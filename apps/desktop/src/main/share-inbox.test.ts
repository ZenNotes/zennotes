import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  drainShareInbox,
  localShareKey,
  parseShareCapture,
  pendingShareFiles,
  remoteShareKey,
  resolveShareTarget,
  SHARE_UNREADABLE_FOLDER,
  shareCaptureBody,
  shareCaptureTitle,
  shareInboxFromInfoPlist,
  shareVaultsFile,
  withShareDestinations,
  writeShareVaults,
  type ShareCapture,
  type ShareConfig,
  type ShareInboxDeps
} from './share-inbox'

const NOW = new Date(2026, 9, 28, 9, 5)

function capture(fields: Partial<ShareCapture>): ShareCapture {
  return { id: 'a', createdAt: 1, vault: null, ...fields }
}

describe('parseShareCapture', () => {
  it('reads a share and drops what is not a web link', () => {
    const parsed = parseShareCapture(
      JSON.stringify({ version: 1, id: 'x1', createdAt: 5, vault: 'local:/v', url: 'https://a.example/p?q=1', title: '  Page \n Title ', text: ' hi ', note: '', sourceApp: 'com.apple.Safari' })
    )
    expect(parsed).toEqual({
      kind: 'capture',
      capture: { id: 'x1', createdAt: 5, vault: 'local:/v', url: 'https://a.example/p?q=1', title: 'Page Title', text: 'hi', sourceApp: 'com.apple.Safari' }
    })
    const local = parseShareCapture(JSON.stringify({ version: 1, id: 'x2', url: 'file:///etc/passwd', text: 'kept' }))
    expect(local).toEqual({ kind: 'capture', capture: { id: 'x2', createdAt: 0, vault: null, text: 'kept' } })
  })

  it('tells empty, newer and unreadable files apart', () => {
    expect(parseShareCapture(JSON.stringify({ version: 1, id: 'e', text: '   ' }))).toEqual({ kind: 'empty' })
    expect(parseShareCapture(JSON.stringify({ version: 2, id: 'n', text: 'later' }))).toEqual({ kind: 'newer' })
    expect(parseShareCapture('{not json')).toEqual({ kind: 'unreadable' })
    expect(parseShareCapture(JSON.stringify([1]))).toEqual({ kind: 'unreadable' })
    expect(parseShareCapture(JSON.stringify({ version: 1, text: 'no id' }))).toEqual({ kind: 'unreadable' })
    expect(parseShareCapture(JSON.stringify({ version: '1', id: 'v', text: 'x' }))).toEqual({ kind: 'unreadable' })
  })

  it('caps what a share may carry', () => {
    const parsed = parseShareCapture(JSON.stringify({ version: 1, id: 'big', text: 'x'.repeat(1_200_000), title: 't'.repeat(900) }))
    expect(parsed.kind).toBe('capture')
    if (parsed.kind !== 'capture') return
    expect(parsed.capture.text).toHaveLength(1_000_000)
    expect(parsed.capture.title).toHaveLength(500)
  })
})

describe('shareCaptureTitle', () => {
  it('prefers the supplied title, then the fetched one', () => {
    expect(shareCaptureTitle(capture({ url: 'https://a.example/', title: 'Given' }), 'Fetched', NOW)).toBe('Given')
    expect(shareCaptureTitle(capture({ url: 'https://a.example/', text: 'Some text' }), 'Fetched', NOW)).toBe('Fetched')
  })

  it('falls back to the text, the host, the note and a timestamp', () => {
    expect(shareCaptureTitle(capture({ url: 'https://a.example/x', text: '## First line\nmore' }), undefined, NOW)).toBe('First line')
    expect(shareCaptureTitle(capture({ url: 'https://docs.example.com/x' }), undefined, NOW)).toBe('docs.example.com')
    expect(shareCaptureTitle(capture({ note: '- remember this' }), undefined, NOW)).toBe('remember this')
    expect(shareCaptureTitle(capture({ text: '\n\n' }), undefined, NOW)).toBe('Quick capture 2026-10-28 0905')
  })
})

describe('shareCaptureBody', () => {
  it('quotes a page selection, then the note, then the link', () => {
    const shared = capture({ url: 'https://a.example/read', title: 'A [great] read', text: 'Line one\n\nLine two  ', note: 'my note' })
    expect(shareCaptureBody(shared, 'A [great] read')).toBe(
      '# A [great] read\n\n> Line one\n>\n> Line two\n\nmy note\n\n[A \\[great\\] read](https://a.example/read)\n'
    )
  })

  it('links with the fetched title, or the bare URL when there is none', () => {
    expect(shareCaptureBody(capture({ url: 'https://a.example/' }), 'Fetched', 'Fetched')).toBe('# Fetched\n\n[Fetched](https://a.example/)\n')
    expect(shareCaptureBody(capture({ url: 'https://a.example/' }), 'a.example')).toBe('# a.example\n\n<https://a.example/>\n')
  })

  it('keeps a parenthesis inside the link', () => {
    const body = shareCaptureBody(capture({ url: 'https://en.example.org/wiki/Foo_(bar)', title: 'Foo' }), 'Foo')
    expect(body).toContain('[Foo](https://en.example.org/wiki/Foo_%28bar%29)')
  })

  it('files text alone the Quick Capture way: its first line is the title', () => {
    const shared = capture({ text: 'Groceries\n- milk', note: 'for Sunday' })
    const title = shareCaptureTitle(shared, undefined, NOW)
    expect(title).toBe('Groceries')
    expect(shareCaptureBody(shared, title)).toBe('Groceries\n- milk\n\nfor Sunday\n')
    expect(shareCaptureBody(capture({ text: 'Body text', title: 'From Notes' }), 'From Notes')).toBe('# From Notes\n\nBody text\n')
  })
})

const BASE_CONFIG: ShareConfig = {
  workspaceMode: 'local',
  vaultRoot: '/vaults/Work',
  localVaults: [
    { root: '/vaults/Work', name: 'Work', lastOpenedAt: 2 },
    { root: '/vaults/Home', name: 'Home', lastOpenedAt: 1 }
  ],
  remoteWorkspaceProfileId: null,
  remoteWorkspaceProfiles: [{ id: 'p1', name: 'Team', baseUrl: 'https://notes.example.com:7878', lastConnectedAt: 3 }]
}

describe('share vaults', () => {
  it('lists local and remote vaults with the current one', () => {
    expect(shareVaultsFile(BASE_CONFIG)).toEqual({
      version: 1,
      vaults: [
        { id: localShareKey('/vaults/Work'), name: 'Work', kind: 'local' },
        { id: localShareKey('/vaults/Home'), name: 'Home', kind: 'local' },
        { id: 'remote:p1', name: 'Team', kind: 'remote', detail: 'notes.example.com:7878' }
      ],
      current: localShareKey('/vaults/Work')
    })
    const remote = shareVaultsFile({ ...BASE_CONFIG, workspaceMode: 'remote', remoteWorkspaceProfileId: 'p1' })
    expect(remote.current).toBe('remote:p1')
  })

  it('includes the open vault even before it is remembered', () => {
    const file = shareVaultsFile({ ...BASE_CONFIG, vaultRoot: '/vaults/New', localVaults: [] })
    expect(file.vaults[0]).toEqual({ id: localShareKey('/vaults/New'), name: 'New', kind: 'local' })
  })

  it('resolves only keys the app remembers, never a path from the share', () => {
    expect(resolveShareTarget(localShareKey('/vaults/Home'), BASE_CONFIG)).toEqual({ kind: 'local', key: localShareKey('/vaults/Home'), root: path.resolve('/vaults/Home') })
    expect(resolveShareTarget('remote:p1', BASE_CONFIG)).toEqual({ kind: 'remote', key: 'remote:p1', profileId: 'p1' })
    const current = { kind: 'local', key: localShareKey('/vaults/Work'), root: path.resolve('/vaults/Work') }
    expect(resolveShareTarget(localShareKey('/etc'), BASE_CONFIG)).toEqual(current)
    expect(resolveShareTarget('remote:gone', BASE_CONFIG)).toEqual(current)
    expect(resolveShareTarget(null, BASE_CONFIG)).toEqual(current)
    expect(resolveShareTarget(null, { ...BASE_CONFIG, vaultRoot: null, localVaults: [] })).toBeNull()
  })
})

describe('withShareDestinations', () => {
  it('names where each vault files a share, and skips a vault it cannot read', async () => {
    const file = await withShareDestinations(shareVaultsFile(BASE_CONFIG), async (choice) => {
      if (choice.kind === 'remote') return 'Quick Notes'
      if (choice.name === 'Home') throw new Error('gone')
      return 'Clippings'
    })
    expect(file.vaults.map((vault) => vault.destination)).toEqual(['Clippings', undefined, 'Quick Notes'])
    expect(file.current).toBe(localShareKey('/vaults/Work'))
  })
})

describe('shareInboxFromInfoPlist', () => {
  it('reads the inbox the extension was built with, inside the home folder only', () => {
    const plist = (value: string): string => `<key>ZenNotesShareInbox</key>\n  <string>${value}</string>`
    expect(shareInboxFromInfoPlist(plist('Library/Application Support/ZenNotes/Share Inbox'))).toBe('Library/Application Support/ZenNotes/Share Inbox')
    expect(shareInboxFromInfoPlist(plist('/etc'))).toBeNull()
    expect(shareInboxFromInfoPlist(plist('Library/../../etc'))).toBeNull()
    expect(shareInboxFromInfoPlist('<key>CFBundleName</key><string>x</string>')).toBeNull()
  })
})

describe('drainShareInbox', () => {
  let dir: string
  let filed: Array<{ where: string; title: string; body: string }>
  let connected: string | null
  let directories: Set<string>

  async function write(name: string, value: unknown): Promise<void> {
    await fs.writeFile(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
  }

  function deps(overrides: Partial<ShareInboxDeps> = {}): ShareInboxDeps {
    return {
      capturesDir: dir,
      loadConfig: async () => BASE_CONFIG,
      fetchTitle: async (url) => (url.includes('titled') ? 'Fetched title' : undefined),
      fileLocal: async (root, title, body) => {
        filed.push({ where: root, title, body })
        return `quick/${title}.md`
      },
      fileRemote: async (profileId, title, body) => {
        if (connected !== profileId) return null
        filed.push({ where: `remote:${profileId}`, title, body })
        return `quick/${title}.md`
      },
      isDirectory: async (candidate) => directories.has(candidate),
      now: () => NOW,
      ...overrides
    }
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-share-inbox-'))
    filed = []
    connected = null
    directories = new Set([path.resolve('/vaults/Work'), path.resolve('/vaults/Home')])
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('files shares in order and deletes each once written', async () => {
    await write('200-b.json', { version: 1, id: 'b', vault: localShareKey('/vaults/Home'), text: 'Second' })
    await write('100-a.json', { version: 1, id: 'a', url: 'https://titled.example/' })
    await write('.300-c.json.tmp', { version: 1, id: 'c', text: 'half written' })
    const result = await drainShareInbox(deps())
    expect(filed.map((entry) => [entry.where, entry.title])).toEqual([
      [path.resolve('/vaults/Work'), 'Fetched title'],
      [path.resolve('/vaults/Home'), 'Second']
    ])
    expect(filed[0].body).toBe('# Fetched title\n\n[Fetched title](https://titled.example/)\n')
    expect(result.filed.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(await fs.readdir(dir)).toEqual(['.300-c.json.tmp'])
  })

  it('keeps a share whose server is not connected, and files it once it is', async () => {
    await write('100-r.json', { version: 1, id: 'r', vault: 'remote:p1', text: 'For the team' })
    expect((await drainShareInbox(deps())).waiting).toBe(1)
    expect(await pendingShareFiles(dir)).toEqual(['100-r.json'])
    connected = 'p1'
    const result = await drainShareInbox(deps())
    expect(result.filed).toEqual([{ id: 'r', title: 'For the team', path: 'quick/For the team.md', target: 'remote:p1' }])
    expect(await pendingShareFiles(dir)).toEqual([])
  })

  it('keeps a share when writing it fails', async () => {
    await write('100-a.json', { version: 1, id: 'a', text: 'Keep me' })
    const result = await drainShareInbox(deps({ fileLocal: async () => { throw new Error('disk full') } }))
    expect(result.waiting).toBe(1)
    expect(await pendingShareFiles(dir)).toEqual(['100-a.json'])
  })

  it('never recreates a vault folder that is gone', async () => {
    await write('100-a.json', { version: 1, id: 'a', vault: localShareKey('/vaults/Home'), text: 'Moved vault' })
    directories.delete(path.resolve('/vaults/Home'))
    await drainShareInbox(deps())
    expect(filed.map((entry) => entry.where)).toEqual([path.resolve('/vaults/Work')])
    filed = []
    await write('200-b.json', { version: 1, id: 'b', text: 'Nowhere to go' })
    directories.clear()
    expect((await drainShareInbox(deps())).waiting).toBe(1)
    expect(filed).toEqual([])
  })

  it('sets a capture over the 2 MB cap aside without filing it', async () => {
    const huge = { version: 1, id: 'big', text: 'x'.repeat(2 * 1024 * 1024 + 1) }
    await write('100-big.json', huge)
    const result = await drainShareInbox(deps())
    expect(result).toMatchObject({ setAside: 1, filed: [] })
    expect(filed).toEqual([])
    expect(await pendingShareFiles(dir)).toEqual([])
    expect(await fs.readdir(path.join(dir, SHARE_UNREADABLE_FOLDER))).toEqual(['100-big.json'])
  })

  it('sets unreadable files aside, leaves newer ones and drops empty ones', async () => {
    await write('100-a.json', '{broken')
    await write('200-b.json', { version: 9, id: 'b', text: 'from the future' })
    await write('300-c.json', { version: 1, id: 'c', text: ' ' })
    const result = await drainShareInbox(deps())
    expect(result).toMatchObject({ setAside: 1, waiting: 1, filed: [] })
    expect(await pendingShareFiles(dir)).toEqual(['200-b.json'])
    expect(await fs.readdir(path.join(dir, SHARE_UNREADABLE_FOLDER))).toEqual(['100-a.json'])
  })

  it('writes vaults.json for the sheet', async () => {
    await writeShareVaults(dir, shareVaultsFile(BASE_CONFIG))
    const written = JSON.parse(await fs.readFile(path.join(dir, 'vaults.json'), 'utf8'))
    expect(written.current).toBe(localShareKey('/vaults/Work'))
    expect(written.vaults).toHaveLength(3)
    expect(remoteShareKey('p1')).toBe(written.vaults[2].id)
  })
})
