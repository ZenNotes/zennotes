import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import type { VaultChangeEvent } from '@zennotes/bridge-contract/ipc'
import type { HttpTransportRequest } from './host'
import { onVaultChange } from './events'
import { createPortableBridge } from './portable-bridge'
import { RemoteVault } from './remote-vault'
import {
  connectionErrorMessage,
  localNetworkConnectionHint,
  userCertificateConnectionHint,
  type RemoteClient
} from './remote-client'
import { REMOTE_POLL_MS, activeRemote, connectRemote, disconnectRemote, listProfiles, saveProfile } from './remote-workspace'
import { RecordingHttp, installTestHost, type TestHost } from '../test/test-host'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A self-hosted server that answers the connect handshake and lists `notes`. */
function server(notes: () => unknown[] | Error) {
  return new RecordingHttp((request: HttpTransportRequest) => {
    const path = new URL(request.url).pathname
    if (path === '/api/capabilities') return { status: 200, headers: {}, data: { supportsAssetOps: true } }
    if (path === '/api/vault') return { status: 200, headers: {}, data: { root: '/srv/notes', name: 'Server' } }
    if (path === '/api/notes') {
      const listed = notes()
      if (listed instanceof Error) throw listed
      return { status: 200, headers: {}, data: listed }
    }
    return { status: 404, headers: {}, data: '' }
  })
}

const note = (path: string, updatedAt: number, size = 10) => ({
  path, title: path, folder: 'inbox', createdAt: 1, updatedAt, size, tags: [], wikilinks: [], hasAttachments: false, excerpt: ''
})

describe('live updates from a self-hosted server', () => {
  let host: TestHost
  let events: VaultChangeEvent[]
  let stop: () => void
  let listing: unknown[] | Error

  beforeEach(() => {
    vi.useFakeTimers()
    listing = [note('inbox/a.md', 1)]
    host = installTestHost({ http: server(() => listing) })
    events = []
    stop = onVaultChange((event) => events.push(event))
  })

  afterEach(async () => {
    await disconnectRemote()
    stop()
    vi.useRealTimers()
  })

  const listings = () => host.http.requests.filter((request) => request.url.endsWith('/api/notes')).length

  // A WebView WebSocket cannot send the Bearer header, so the shell polls
  // (Android's poller, now both phones'). The first poll takes the baseline.
  it('polls while connected, and emits nothing for an unchanged listing', async () => {
    await connectRemote('https://notes.example.test', 'test-only')
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 3)
    assert.ok(listings() >= 3)
    assert.deepEqual(events, [])
  })

  it('emits one event per note added, changed or gone', async () => {
    await connectRemote('https://notes.example.test', 'test-only')
    await vi.advanceTimersByTimeAsync(0)
    listing = [note('inbox/a.md', 2), note('inbox/b.md', 1)]
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS)
    assert.deepEqual(events.map((event) => [event.kind, event.path]), [['change', 'inbox/a.md'], ['add', 'inbox/b.md']])
    events.length = 0
    listing = [note('inbox/b.md', 1)]
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS)
    assert.deepEqual(events.map((event) => [event.kind, event.path]), [['unlink', 'inbox/a.md']])
  })

  it('backs off after a failed poll instead of asking every tick', async () => {
    await connectRemote('https://notes.example.test', 'test-only')
    await vi.advanceTimersByTimeAsync(0)
    listing = new Error('offline')
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS)
    const afterFailure = listings()
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 5)
    assert.equal(listings(), afterFailure)
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS)
    assert.equal(listings(), afterFailure + 1)
  })

  it('stops polling on disconnect', async () => {
    await connectRemote('https://notes.example.test', 'test-only')
    await vi.advanceTimersByTimeAsync(0)
    await disconnectRemote()
    const before = listings()
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 4)
    assert.equal(listings(), before)
  })

  // A foreground still announces the gap as one resync, as the iPhone always did.
  it('keeps the foreground rescan a single resync with no request', async () => {
    await connectRemote('https://notes.example.test', 'test-only')
    await vi.advanceTimersByTimeAsync(0)
    const before = host.http.requests.length
    await activeRemote()!.vault.rescan()
    assert.equal(host.http.requests.length, before)
    assert.deepEqual(events, [{ kind: 'change', path: '', folder: 'inbox', scope: 'resync' }])
  })

  // app-core's auto-sync controller asks every tick; a remote workspace has
  // no local vault to link, which is a null, not an error retried forever
  // (Android's copy threw).
  it('answers getCloudVaultLink with null in a remote workspace', async () => {
    await connectRemote('https://notes.example.test', 'test-only')
    const bridge = createPortableBridge(host)
    assert.equal(await bridge.getCloudVaultLink(), null)
  })
})

describe('saving a server profile', () => {
  // iOS 15.0 to 15.3 WebViews have no crypto.randomUUID.
  it('works on a WebView without crypto.randomUUID', async () => {
    installTestHost()
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      const saved = await saveProfile({ baseUrl: 'https://notes.example.test', authToken: 'test-only' })
      assert.match(saved.id, V4)
      assert.deepEqual((await listProfiles()).map((profile) => profile.id), [saved.id])
    } finally {
      Reflect.deleteProperty(crypto, 'randomUUID')
    }
  })
})

describe('the connection error', () => {
  it('ends with the host\'s own hint', () => {
    installTestHost({ shell: { remoteConnectionHint: localNetworkConnectionHint } })
    const ios = connectionErrorMessage('http://192.168.1.20:7878', new Error('Failed to fetch'))
    assert.ok(ios.includes('Could not connect to the ZenNotes server at http://192.168.1.20:7878.'))
    assert.ok(ios.includes('Could not reach the server: Failed to fetch.'))
    assert.match(ios, /Local Network/)
  })

  it('never points an Android user at the iPhone Local Network setting', () => {
    installTestHost({ shell: { remoteConnectionHint: userCertificateConnectionHint } })
    for (const url of ['http://192.168.1.20:7878', 'https://notes.example.com']) {
      const text = connectionErrorMessage(url, new Error('Failed to fetch'))
      assert.doesNotMatch(text, /Local Network|Privacy & Security/)
      assert.ok(text.includes(`Could not connect to the ZenNotes server at ${url}.`))
    }
    assert.ok(connectionErrorMessage('https://notes.example.com', null).includes('Install a certificate'))
    assert.ok(!connectionErrorMessage('http://192.168.1.20:7878', null).includes('certificate'))
  })
})

describe('pasting an image into a remote vault', () => {
  async function paste(mimeType: string, suggestedName?: string) {
    installTestHost()
    const uploads: Array<{ name: string; data: string; directory: string }> = []
    const changes: VaultChangeEvent[] = []
    const stop = onVaultChange((event) => changes.push(event))
    const client = {
      baseUrl: 'https://notes.example.test',
      async uploadAsset(name: string, data: string, directory: string) {
        uploads.push({ name, data, directory })
        return { name, path: `${directory}/${name}` }
      }
    } as unknown as RemoteClient
    try {
      const result = await new RemoteVault(client, null, 'paste-test').importPastedImage({
        mimeType, suggestedName, data: new Uint8Array([1, 2, 3])
      })
      return { result, uploads, changes }
    } finally {
      stop()
    }
  }

  it('keeps a WebP paste\'s format and vault asset path', async () => {
    const { result, uploads, changes } = await paste('image/webp')
    assert.match(uploads[0]!.name, /^Pasted Image .*\.webp$/)
    assert.equal(uploads[0]!.data, 'AQID')
    assert.equal(uploads[0]!.directory, 'assets')
    assert.equal(result.markdown, `![[assets/${uploads[0]!.name}]]`)
    assert.equal(result.kind, 'image')
    assert.deepEqual(changes, [{ kind: 'add', path: result.path, folder: 'inbox', scope: 'content' }])
  })

  it('never lets a pasted name introduce a path or break the embed', async () => {
    const { result, uploads } = await paste('image/webp', '../picture [draft].webp')
    assert.equal(uploads[0]!.name, 'picture -draft-.webp')
    assert.equal(result.markdown, '![[assets/picture -draft-.webp]]')
  })

  it('keeps PNG, JPEG and GIF extensions', async () => {
    for (const [mime, extension] of [['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif']] as const) {
      const { uploads } = await paste(mime, 'clipboard')
      assert.equal(uploads[0]!.name, `clipboard${extension}`)
    }
  })
})
