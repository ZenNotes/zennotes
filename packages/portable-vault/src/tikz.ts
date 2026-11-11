/**
 * On-device TikZ → SVG rendering via the browser TikZJax build (the same
 * WebAssembly TeX engine node-tikzjax wraps on desktop, in the single-file
 * form the Obsidian TikZJax plugin ships, proven inside iOS webviews).
 *
 * Vendored assets (this package's assets/tikzjax/, exported as
 * `@zennotes/portable-vault/tikzjax/*`; the host serves them at `tikzjax/`
 * beside its index.html, and they load lazily on first render so boot and
 * non-TikZ users never pay for the ~12 MB engine):
 *   - tikzjax.js: TeX wasm + core dump, inlined (artisticat1/obsidian-tikzjax)
 *   - fonts.css: inlined fonts for SVG text glyphs (their styles.css)
 *
 * The library API is DOM-driven: it watches for <script type="text/tikz">
 * nodes, replaces each with an SVG, and fires 'tikzjax-load-finished' on the
 * document. We wrap that into renderTikz(source) → { ok, svg } to satisfy
 * the bridge contract, and port the desktop main-process semantics
 * (apps/desktop/src/main/tikz.ts): source wrapping, package auto-detection,
 * per-source caching, and a serialized render queue (the TeX engine does not
 * tolerate concurrent runs).
 */
import type { TikzRenderResponse } from '@zennotes/shared-domain/ipc'
import { portableHost } from './host'

/** Where the host serves the vendored files: `tikzjax/` beside the page on
 *  the phones; the browser build serves them under its release base, which
 *  is not where the page is (HostShell.tikzAssetBase). */
function assetBase(): string {
  try {
    return portableHost().shell.tikzAssetBase ?? 'tikzjax/'
  } catch {
    return 'tikzjax/'
  }
}
// Generous: the first render on a cold device includes engine load + wasm
// init; subsequent blocks are sub-second. Past this, fall back to an error.
const RENDER_TIMEOUT_MS = 30000

let loadPromise: Promise<boolean> | null = null
let renderQueue: Promise<unknown> = Promise.resolve()

const cache = new Map<string, TikzRenderResponse>()
const CACHE_LIMIT = 100

function prune(): void {
  if (cache.size <= CACHE_LIMIT) return
  const drop = Math.ceil(CACHE_LIMIT / 2)
  let i = 0
  for (const key of cache.keys()) {
    if (i++ >= drop) break
    cache.delete(key)
  }
}

/** Inject the engine <script> and font stylesheet once, on first use.
 *  Availability is signalled by the script's own load/error events, the
 *  Capacitor local scheme doesn't reliably answer HEAD probes. */
function ensureLoaded(): Promise<boolean> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    if (!document.getElementById('zn-tikzjax-fonts')) {
      const link = document.createElement('link')
      link.id = 'zn-tikzjax-fonts'
      link.rel = 'stylesheet'
      link.href = `${assetBase()}fonts.css`
      document.head.appendChild(link)
    }
    if (!document.getElementById('zn-tikzjax')) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.id = 'zn-tikzjax'
        s.src = `${assetBase()}tikzjax.js`
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('tikzjax.js failed to load'))
        document.body.appendChild(s)
      })
    }
    return true
  })().catch(() => false)
  return loadPromise
}

/**
 * Ported from desktop tikz.ts: normalize user TikZ into preamble +
 * \begin{document}…\end{document}, stripping any \documentclass.
 */
function wrapSource(source: string): string {
  const trimmed = source.trim()
  if (!trimmed) return ''

  const withoutDocumentClass = trimmed
    .replace(/^\s*\\documentclass(?:\[[^\]]*])?\{[^}]+\}\s*$/gm, '')
    .trim()

  const hasBeginDocument = /\\begin\{document\}/.test(withoutDocumentClass)
  const hasEndDocument = /\\end\{document\}/.test(withoutDocumentClass)
  if (hasBeginDocument && hasEndDocument) return withoutDocumentClass

  const withoutDocumentWrappers = withoutDocumentClass
    .replace(/\\begin\{document\}/g, '')
    .replace(/\\end\{document\}/g, '')
    .trim()

  const bodyStart = findDocumentBodyStart(withoutDocumentWrappers)
  if (bodyStart > 0) {
    const preamble = withoutDocumentWrappers.slice(0, bodyStart).trim()
    const body = withoutDocumentWrappers.slice(bodyStart).trim()
    return `${preamble}\n\\begin{document}\n${body}\n\\end{document}`
  }
  return `\\begin{document}\n${withoutDocumentWrappers}\n\\end{document}`
}

function findDocumentBodyStart(source: string): number {
  const candidates = [
    /\\begin\{(?!document\b)[^}]+\}/,
    /\\tikz\b/,
    /\\draw\b/,
    /\\path\b/,
    /\\node\b/,
    /\\coordinate\b/,
    /\\matrix\b/,
    /\\graph\b/
  ]
  let earliest = -1
  for (const pattern of candidates) {
    const match = pattern.exec(source)
    if (!match || match.index < 0) continue
    if (earliest < 0 || match.index < earliest) earliest = match.index
  }
  return earliest
}

/**
 * Desktop injects packages/libraries through node-tikzjax options; the
 * browser build reads them from the preamble instead. Same auto-detection.
 */
function buildPreamble(source: string): string {
  const lines = ['\\usepackage{amsmath}', '\\usepackage{amssymb}']
  if (source.includes('pgfplots') || source.includes('axis') || source.includes('plot')) {
    lines.push('\\usepackage{pgfplots}', '\\pgfplotsset{compat=1.16}')
  }
  if (source.includes('circuitikz') || source.includes('ctikzset')) {
    lines.push('\\usepackage{circuitikz}')
  }
  lines.push(
    '\\usetikzlibrary{arrows.meta,calc,positioning,shapes,decorations.pathreplacing,intersections,patterns}'
  )
  return lines.join('\n')
}

/** The TikZJax library expects nbsp-free, trimmed, non-empty lines. */
function tidy(source: string): string {
  return source
    .replaceAll('&nbsp;', '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l)
    .join('\n')
}

/** Dark-theme legibility: match the Obsidian plugin's recolor pass. */
function recolor(svg: string): string {
  return svg
    .replaceAll(/("#000"|"black")/g, '"currentColor"')
    .replaceAll(/("#fff"|"white")/g, '"var(--z-tikz-bg, transparent)"')
}

/**
 * Puts one figure's source where TikZJax's MutationObserver sees it, once.
 * The observer queues a `text/tikz` script it is handed, and every one
 * inside any other element it is handed, so the host is built with its
 * script first and attached in one step. Attached first and filled in the
 * same task, the host and the script arrive as two records, the script is
 * queued twice, and the second pass renders into a detached copy whose
 * "finished" event never reaches the document: every figure then waited
 * out the timeout.
 */
export function mountTikzSource(wrapped: string): HTMLDivElement {
  const host = document.createElement('div')
  // Off-screen but rendered: display:none would suppress layout the SVG
  // text measurement depends on.
  host.style.cssText =
    'position:fixed;left:-10000px;top:0;width:1000px;pointer-events:none;opacity:0'
  const script = document.createElement('script')
  script.setAttribute('type', 'text/tikz')
  script.setAttribute('data-show-console', 'true')
  script.textContent = tidy(wrapped)
  host.appendChild(script)
  document.body.appendChild(host)
  return host
}

function renderOnce(wrapped: string): Promise<TikzRenderResponse> {
  return new Promise<TikzRenderResponse>((resolve) => {
    let host!: HTMLDivElement

    let settled = false
    const finish = (result: TikzRenderResponse): void => {
      if (settled) return
      settled = true
      document.removeEventListener('tikzjax-load-finished', onDone)
      window.clearTimeout(timer)
      host.remove()
      resolve(result)
    }

    const onDone = (ev: Event): void => {
      const target = ev.target as HTMLElement | null
      if (!target || !host.contains(target)) return
      const svg = target instanceof SVGElement ? target : host.querySelector('svg')
      if (svg) finish({ ok: true, svg: recolor(svg.outerHTML) })
      else finish({ ok: false, error: 'TikZ produced no output. Check the diagram source.' })
    }

    const timer = window.setTimeout(() => {
      finish({ ok: false, error: 'TikZ render timed out on this device.' })
    }, RENDER_TIMEOUT_MS)

    document.addEventListener('tikzjax-load-finished', onDone)
    host = mountTikzSource(wrapped)

    // Failure mode: the library replaces the node with a console dump and
    // never fires the finished event with an svg. Poll cheaply for that.
    const errPoll = window.setInterval(() => {
      if (settled) {
        window.clearInterval(errPoll)
        return
      }
      const dump = host.querySelector('[data-tikzjax-error], .tikzjax-error, pre')
      if (dump?.textContent && /error|!/i.test(dump.textContent)) {
        window.clearInterval(errPoll)
        finish({ ok: false, error: extractTexError(dump.textContent) })
      }
    }, 500)
  })
}

function extractTexError(consoleText: string): string {
  const lines = consoleText.split('\n')
  const bang = lines.map((l, i) => (l.startsWith('!') ? i : -1)).filter((i) => i >= 0)
  if (bang.length === 0) return 'TikZ failed to compile on this device.'
  const last = bang[bang.length - 1]!
  return lines.slice(last, last + 3).join('\n')
}

export async function renderTikzOnDevice(source: string): Promise<TikzRenderResponse> {
  if (!source.trim()) return { ok: false, error: 'Empty TikZ block' }
  const hit = cache.get(source)
  if (hit) return hit

  const available = await ensureLoaded()
  if (!available) {
    return {
      ok: false,
      error: 'TikZ renders on ZenNotes desktop; the source is shown here.'
    }
  }

  const wrapped = wrapSource(source)
  const withPreamble = /\\usepackage|\\usetikzlibrary/.test(wrapped)
    ? wrapped
    : `${buildPreamble(source)}\n${wrapped}`

  // The TeX engine cannot run concurrent jobs, serialize like desktop.
  const job = renderQueue.then(
    () => renderOnce(withPreamble),
    () => renderOnce(withPreamble)
  )
  renderQueue = job.then(
    () => undefined,
    () => undefined
  )
  const result = await job
  if (result.ok) {
    cache.set(source, result)
    prune()
  }
  return result
}
