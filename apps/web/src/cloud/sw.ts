/**
 * The service worker of ZenNotes in your browser, built from this file into
 * `/sw.js` by vite.cloud.config.ts (classic script, registered with scope
 * `/`). It differs from the self-hosted build's public/sw.js on purpose
 * (docs/ideas/cloud-in-browser.md, "Offline and updates"):
 *
 * - The file lists are generated at build time, under a cache named for the
 *   build. Install caches only the shell index.html loads, so a first visit
 *   never waits for the whole build; the rest is warmed in the background
 *   once the app is up, and the large lazy pieces are cached on first use.
 *   Notes, API and storage traffic are never cached.
 * - `/_vault/<vaultKey>/<path>` is answered from OPFS, with Range support,
 *   and never put in a cache: note content lives in OPFS only.
 * - No skipWaiting() on install: a new worker waits until the page agrees,
 *   so code never changes under an open editor.
 * - The page can ask the active worker to claim it (a hard reload leaves a
 *   page uncontrolled, spike F2).
 * - A vault file that is a Cloud stub (an attachment only in Cloud on this
 *   browser) is hydrated by the tab that owns the vault, then served. The
 *   owner registers itself; a frame's navigation (a PDF embed) has no client
 *   id, and Safari's first window client is any one of them (spike F1b), so
 *   the registered owner is asked first, then each window in turn, and only
 *   the owner answers yes. The worker never holds keys or credentials.
 */
import { CLOUD_STUB_MAX_BYTES, decodeCloudStub } from '@zennotes/portable-vault/cloud-stub-format'
import { parseVaultAssetUrl, VAULTS_DIR } from './opfs-paths'
import type { OpfsDirectoryHandle } from './opfs-handles'
import { vaultFileResponse } from './vault-response'

declare const __ZN_PRECACHE__: string[]
declare const __ZN_WARM__: string[]
declare const __ZN_BUILD_ID__: string
declare const __ZN_SHELL_URL__: string

interface FetchEventLike extends Event {
  readonly request: Request
  respondWith(response: Response | Promise<Response>): void
}

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void
}

interface ExtendableMessageEventLike extends ExtendableEventLike {
  readonly data: unknown
  readonly source: { id?: string } | null
}

interface FetchEventWithClient extends FetchEventLike {
  readonly clientId?: string
  readonly resultingClientId?: string
}

interface WindowClientLike {
  readonly id: string
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const sw = self as unknown as {
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void
  addEventListener(type: 'message', listener: (event: ExtendableMessageEventLike) => void): void
  skipWaiting(): Promise<void>
  clients: {
    claim(): Promise<void>
    get(id: string): Promise<WindowClientLike | undefined>
    matchAll(options: { type: 'window'; includeUncontrolled?: boolean }): Promise<WindowClientLike[]>
  }
  location: Location
  registration: { scope: string }
}

/** What install caches: the shell index.html loads. */
const PRECACHE: string[] = typeof __ZN_PRECACHE__ === 'undefined' ? [] : __ZN_PRECACHE__
/** The rest of the build below the lazy-piece size, cached in the
 *  background once the page asks ('warm'), so the app opens offline after
 *  one visit without the first visit waiting for it. */
const WARM: string[] = typeof __ZN_WARM__ === 'undefined' ? [] : __ZN_WARM__
const BUILD_ID: string = typeof __ZN_BUILD_ID__ === 'undefined' ? 'dev' : __ZN_BUILD_ID__
const SHELL_URL: string = typeof __ZN_SHELL_URL__ === 'undefined' ? '/' : __ZN_SHELL_URL__
const CACHE_PREFIX = 'zn-cloud-'
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`
const LAZY_CACHE = `${CACHE_PREFIX}lazy-${BUILD_ID}`
const BUILD_FILES = new Set([...PRECACHE, ...WARM].map((url) => new URL(url, sw.location.origin).pathname))
const DEV = BUILD_ID === 'dev'

/** App routes: navigations to these get the shell. Files are everything else. */
function isAppRoute(pathname: string): boolean {
  if (pathname.startsWith('/_vault/')) return false
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return !last.includes('.')
}

sw.addEventListener('install', (event) => {
  if (DEV || PRECACHE.length === 0) return
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))
    )
  )
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== LAZY_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      // The first install takes the page that registered it in the same load.
      .then(() => sw.clients.claim())
  )
})

/** The tab that holds each vault's lock, by vault key: it hydrates stubs. */
const owners = new Map<string, string>()

sw.addEventListener('message', (event) => {
  const data = event.data as { type?: unknown; vaultKey?: unknown } | null
  const type = data?.type
  const sourceId = event.source?.id
  if (type === 'vault-owner' && typeof data?.vaultKey === 'string' && sourceId) owners.set(data.vaultKey, sourceId)
  if (type === 'vault-released' && typeof data?.vaultKey === 'string' && owners.get(data.vaultKey) === sourceId) {
    owners.delete(data.vaultKey)
  }
  if (type === 'claim') event.waitUntil(sw.clients.claim())
  if (type === 'warm') event.waitUntil(warmCache())
  // Only the page sends this, after the user chose to reload with nothing
  // unsaved (sw-register.ts).
  if (type === 'skip-waiting') event.waitUntil(sw.skipWaiting())
})

sw.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  const url = new URL(request.url)
  if (url.origin !== sw.location.origin) return

  const vault = parseVaultAssetUrl(url.pathname)
  if (vault) {
    const clientId = (event as FetchEventWithClient).clientId || undefined
    event.respondWith(serveVaultFile(vault.vaultKey, vault.segments, request, clientId))
    return
  }
  if (url.pathname.startsWith('/_vault/')) {
    event.respondWith(new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }))
    return
  }
  if (DEV) return

  if (request.mode === 'navigate' && isAppRoute(url.pathname)) {
    event.respondWith(shellResponse(request))
    return
  }
  event.respondWith(cachedOrFetched(request, url))
})

let warming: Promise<void> | null = null

/** Caches the build files not cached yet, a few at a time. */
function warmCache(): Promise<void> {
  if (DEV || WARM.length === 0) return Promise.resolve()
  warming ??= (async () => {
    const cache = await caches.open(SHELL_CACHE)
    const queue = [...WARM]
    const worker = async (): Promise<void> => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        if (await cache.match(url, { ignoreVary: true })) continue
        try {
          const response = await fetch(url, { cache: 'reload' })
          if (response.ok && response.status === 200) await cache.put(url, response)
        } catch {
          // Offline mid-warm: the next visit warms what is missing.
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
  })().finally(() => {
    warming = null
  })
  return warming
}

async function shellResponse(request: Request): Promise<Response> {
  const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE, ignoreVary: true })
  if (cached) return cached
  return fetch(request)
}

async function cachedOrFetched(request: Request, url: URL): Promise<Response> {
  // ignoreVary: the precache stored plain requests, while module scripts are
  // fetched with an Origin header, so a server that sends `Vary: Origin`
  // (Vite's preview does) would miss every cached chunk. Build files are
  // content-hashed; what they vary on cannot change them.
  const cached = await caches.match(request, { ignoreSearch: false, ignoreVary: true })
  if (cached) return cached
  const response = await fetch(request)
  // A build file is kept in the shell cache as it is used (the warm-up may
  // not have reached it yet); lazy pieces (the large wasm and renderer
  // chunks, TikZJax, Excalidraw's fonts) in the lazy cache after their first
  // use. A range answer, an error or a query string never.
  if (response.ok && response.status === 200 && response.type === 'basic' && !url.search) {
    const copy = response.clone()
    const target = BUILD_FILES.has(url.pathname) ? SHELL_CACHE : LAZY_CACHE
    void caches.open(target).then((cache) => cache.put(request, copy)).catch(() => undefined)
  }
  return response
}

// ---------------------------------------------------------------------------
// /_vault/<vaultKey>/<path>
// ---------------------------------------------------------------------------

async function locateVaultFile(vaultKey: string, segments: string[]): Promise<File | null> {
  try {
    const root = (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandle
    let dir = await (await root.getDirectoryHandle(VAULTS_DIR)).getDirectoryHandle(vaultKey)
    for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment)
    const handle = await dir.getFileHandle(segments[segments.length - 1]!)
    return (await handle.getFile()) as unknown as File
  } catch (error) {
    const name = (error as { name?: string } | null)?.name
    if (name === 'NotFoundError' || name === 'TypeMismatchError' || name === 'TypeError') return null
    throw error
  }
}

const NO_STORE = { 'Cache-Control': 'no-store' }
/** A hydration downloads the whole attachment; the owner answers when it is
 *  written (or fails), so the wait is long. A tab that is not the owner says
 *  so at once. */
const HYDRATE_TIMEOUT_MS = 10 * 60 * 1000

async function isStub(file: File): Promise<boolean> {
  if (file.size > CLOUD_STUB_MAX_BYTES) return false
  return decodeCloudStub(new Uint8Array(await file.arrayBuffer())) !== null
}

type HydrateAnswer = { ok: boolean; owner: boolean; error?: string }
/** How long a window has to say whether it owns a vault. A page that does
 *  not listen (the PDF export window) never answers. */
const OWNER_QUESTION_MS = 2000

function request<T>(client: WindowClientLike, message: unknown, timeoutMs: number, timedOut: T): Promise<T> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(timedOut), timeoutMs)
    channel.port1.onmessage = (event: MessageEvent<T>) => {
      clearTimeout(timer)
      resolve(event.data)
    }
    client.postMessage(message, [channel.port2])
  })
}

async function owns(client: WindowClientLike, vaultKey: string): Promise<boolean> {
  const answer = await request<{ owner?: boolean }>(client, { type: 'vault-owner?', vaultKey }, OWNER_QUESTION_MS, {})
  return answer?.owner === true
}

/** The registered owner, else the window that says it owns the vault (the
 *  requesting page first): only that one is asked to download. */
async function hydrateThroughOwner(vaultKey: string, path: string, clientId: string | undefined): Promise<HydrateAnswer> {
  let owner: WindowClientLike | undefined
  const registered = owners.get(vaultKey)
  if (registered) owner = await sw.clients.get(registered).catch(() => undefined)
  if (!owner) {
    // The worker restarted and forgot, or the owner went: ask around.
    const windows = await sw.clients.matchAll({ type: 'window' }).catch(() => [] as WindowClientLike[])
    windows.sort((left, right) => Number(right.id === clientId) - Number(left.id === clientId))
    for (const client of windows) {
      if (await owns(client, vaultKey)) {
        owner = client
        break
      }
    }
  }
  if (!owner) return { ok: false, owner: false }
  owners.set(vaultKey, owner.id)
  const answer = await request<HydrateAnswer | null>(owner, { type: 'hydrate', vaultKey, path }, HYDRATE_TIMEOUT_MS, null)
  if (!answer) return { ok: false, owner: true, error: 'ZenNotes took too long to download this attachment.' }
  return { ok: answer.ok === true, owner: answer.owner !== false, error: answer.error }
}

async function serveVaultFile(vaultKey: string, segments: string[], request: Request, clientId?: string): Promise<Response> {
  let file: File | null
  try {
    file = await locateVaultFile(vaultKey, segments)
    if (file && (await isStub(file))) {
      const answer = await hydrateThroughOwner(vaultKey, segments.join('/'), clientId)
      if (!answer.ok) {
        const reason = answer.owner
          ? answer.error ?? 'ZenNotes could not download this attachment.'
          : 'This attachment is in ZenNotes Cloud. Open its vault in ZenNotes, online, to download it.'
        return new Response(reason, { status: 503, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } })
      }
      file = await locateVaultFile(vaultKey, segments)
    }
  } catch {
    return new Response('This browser could not read the vault.', { status: 503, headers: NO_STORE })
  }
  if (file) notifyOpened(vaultKey, segments.join('/'))
  return vaultFileResponse(file, segments[segments.length - 1]!, request)
}

/** Tells the owner an attachment was shown, for the eviction order. */
function notifyOpened(vaultKey: string, path: string): void {
  const id = owners.get(vaultKey)
  if (!id) return
  void sw.clients.get(id).then((client) => client?.postMessage({ type: 'opened', vaultKey, path })).catch(() => undefined)
}
