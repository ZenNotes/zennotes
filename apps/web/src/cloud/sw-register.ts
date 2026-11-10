/**
 * The page's half of the service worker (sw.ts).
 *
 * Control first: attachment URLs (`/_vault/...`) only work on a page the
 * worker controls, and two loads are not: the first visit, and a hard
 * reload (spike F2). Before the app resolves any attachment URL it waits for
 * control: it asks the active worker to claim the page, and if that does not
 * take, reloads once. The worker is registered as the absolute `/sw.js`; the
 * relative `sw.js` of the self-hosted build would resolve under `/try/`.
 *
 * Updates: a new worker installs and waits. The app offers "Reload to
 * update", and only when the user picks it, with no unsaved text, does it
 * let the new worker take over and reload.
 */

const RELOAD_FLAG = 'zn:sw-claim-reload'
const CLAIM_WAIT_MS = 3000

export type ServiceWorkerState = 'controlled' | 'unsupported' | 'uncontrolled'

function waitForController(timeoutMs: number): Promise<boolean> {
  if (navigator.serviceWorker.controller) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
      resolve(!!navigator.serviceWorker.controller)
    }, timeoutMs)
    const onChange = (): void => {
      clearTimeout(timer)
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
      resolve(true)
    }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
  })
}

function readFlag(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_FLAG) === '1'
  } catch {
    return false
  }
}

function writeFlag(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(RELOAD_FLAG, '1')
    else sessionStorage.removeItem(RELOAD_FLAG)
  } catch {
    // storage blocked: the reload guard is best-effort
  }
}

let registration: ServiceWorkerRegistration | null = null

export async function ensureServiceWorkerControl(): Promise<ServiceWorkerState> {
  if (!('serviceWorker' in navigator)) return 'unsupported'
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch (error) {
    console.warn('[zen] the service worker did not register', error)
    return 'unsupported'
  }
  if (navigator.serviceWorker.controller) {
    writeFlag(false)
    return 'controlled'
  }
  const ready = await navigator.serviceWorker.ready
  ready.active?.postMessage({ type: 'claim' })
  if (await waitForController(CLAIM_WAIT_MS)) {
    writeFlag(false)
    return 'controlled'
  }
  if (!readFlag()) {
    writeFlag(true)
    location.reload()
    // The reload replaces this page; nothing after it should run.
    await new Promise(() => {})
  }
  writeFlag(false)
  return 'uncontrolled'
}

export interface UpdatePrompt {
  /** Shows the "Reload to update" offer; `apply` runs when the user takes it. */
  offer(apply: () => Promise<void>): void
}

/**
 * Watches for a waiting worker and offers the update through `prompt`.
 * `canReload` answers whether reloading now loses nothing (no unsaved text,
 * no sync running); the offer is made again later when it says no.
 */
export function watchForUpdates(prompt: UpdatePrompt, canReload: () => Promise<boolean>): void {
  const reg = registration
  if (!reg) return
  let offered: ServiceWorker | null = null
  const offerFor = (waiting: ServiceWorker | null): void => {
    if (!waiting || !navigator.serviceWorker.controller || offered === waiting) return
    offered = waiting
    prompt.offer(async () => {
      if (!(await canReload())) {
        offered = null
        return
      }
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true })
      waiting.postMessage({ type: 'skip-waiting' })
    })
  }
  offerFor(reg.waiting)
  reg.addEventListener('updatefound', () => {
    const installing = reg.installing
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') offerFor(reg.waiting ?? installing)
    })
  })
  const check = (): void => {
    void reg.update().catch(() => undefined)
    offerFor(reg.waiting)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  setInterval(check, 60 * 60 * 1000)
}

/** Asks the worker to cache the rest of the build in the background, once
 *  the app is up, so the next visit opens offline. */
export function warmServiceWorkerCache(): void {
  navigator.serviceWorker?.controller?.postMessage({ type: 'warm' })
}
