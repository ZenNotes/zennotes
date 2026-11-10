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
 */
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
  readonly origin: string
  readonly source: { readonly url?: string } | null
}

const sw = self as unknown as {
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void
  addEventListener(type: 'message', listener: (event: ExtendableMessageEventLike) => void): void
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
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

sw.addEventListener('message', (event) => {
  // A service worker hears only its own origin's pages, so this is defense
  // in depth. The client's URL stands in where an engine leaves `origin`
  // empty, so the check never strands an update or a claim.
  const sourceUrl = event.source?.url
  const origin = event.origin || (sourceUrl ? new URL(sourceUrl).origin : '')
  if (origin !== sw.location.origin) return
  const type = (event.data as { type?: unknown } | null)?.type
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
    event.respondWith(serveVaultFile(vault.vaultKey, vault.segments, request))
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

async function serveVaultFile(vaultKey: string, segments: string[], request: Request): Promise<Response> {
  let file: File | null
  try {
    file = await locateVaultFile(vaultKey, segments)
  } catch {
    return new Response('This browser could not read the vault.', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  return vaultFileResponse(file, segments[segments.length - 1]!, request)
}
