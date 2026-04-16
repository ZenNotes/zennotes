/**
 * TikZ → SVG rendering via node-tikzjax.
 *
 * The rendering happens in the main process because node-tikzjax ships
 * with ~5 MB of pre-compiled TeX + a wasm engine — loading that in the
 * renderer would delay editor startup for everyone, including people
 * who never use a TikZ block. Running it on the main side means the
 * wasm/core dump is loaded once per app session, shared across all
 * open windows, and invisible to users who don't touch TikZ.
 *
 * Results are cached in-memory by source hash because re-rendering the
 * same block on every keystroke or theme switch is wasteful.
 */
import { createHash } from 'node:crypto'

type Tex2Svg = (
  input: string,
  options?: Record<string, unknown>
) => Promise<string>

let tex2svg: Tex2Svg | null = null
let loadPromise: Promise<Tex2Svg> | null = null
let renderQueue: Promise<void> = Promise.resolve()

async function load(): Promise<Tex2Svg> {
  if (tex2svg) return tex2svg
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const mod = await import('node-tikzjax')
    // node-tikzjax is a CJS module; its default export is itself `{ default: tex2svg }`.
    const candidate =
      (mod as unknown as { default?: { default?: Tex2Svg } | Tex2Svg }).default ??
      (mod as unknown as Tex2Svg)
    const fn =
      typeof candidate === 'function'
        ? candidate
        : (candidate as { default: Tex2Svg }).default
    if (typeof fn !== 'function') {
      throw new Error('Could not locate tex2svg in node-tikzjax')
    }
    tex2svg = fn
    return fn
  })()
  return loadPromise
}

const cache = new Map<string, { ok: true; svg: string }>()
const inFlight = new Map<string, Promise<TikzRenderResult | TikzRenderError>>()
const CACHE_LIMIT = 200

function cacheKey(source: string): string {
  return createHash('sha1').update(source).digest('hex')
}

function prune(): void {
  if (cache.size <= CACHE_LIMIT) return
  // Drop oldest half (Map preserves insertion order).
  const drop = Math.ceil(CACHE_LIMIT / 2)
  let i = 0
  for (const key of cache.keys()) {
    if (i++ >= drop) break
    cache.delete(key)
  }
}

/**
 * Wrap a bare TikZ fragment in a minimal LaTeX document so users don't
 * have to type the ceremony every time. We skip wrapping if they've
 * already provided `\documentclass` or `\begin{document}` themselves —
 * people pasting from a real paper still work.
 */
function wrapSource(source: string): string {
  const trimmed = source.trim()
  if (/\\begin\{document\}/.test(trimmed) || /\\documentclass\b/.test(trimmed)) {
    return trimmed
  }
  return `\\begin{document}\n${trimmed}\n\\end{document}`
}

export interface TikzRenderResult {
  ok: true
  svg: string
}

export interface TikzRenderError {
  ok: false
  error: string
}

export async function renderTikz(
  source: string
): Promise<TikzRenderResult | TikzRenderError> {
  if (!source.trim()) return { ok: false, error: 'Empty TikZ block' }
  const key = cacheKey(source)
  const hit = cache.get(key)
  if (hit) return hit
  const pending = inFlight.get(key)
  if (pending) return pending

  const run = enqueueRender(async () => {
    // node-tikzjax writes its TeX engine diagnostics via `console.log` only
    // when `showConsole: true`, and its own README warns against multiple
    // simultaneous renders. We serialize the TeX engine work here so
    // different preview blocks and windows don't stomp on the shared wasm
    // process or on this temporary console capture.
    const captured: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]): void => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
    }

    try {
      const fn = await load()
      const svg = await fn(wrapSource(source), {
        showConsole: true,
        // Enable the common TikZ libraries people reach for first. The
        // wasm build ships with everything already compiled, so toggling
        // these flags only changes which `\usetikzlibrary{…}` / `\usepackage{…}`
        // statements get injected — negligible runtime cost.
        texPackages: { pgfplots: '', amsmath: '', amssymb: '' },
        tikzLibraries:
          'arrows.meta,calc,positioning,shapes,decorations.pathreplacing,intersections,patterns'
      })
      console.log = originalLog
      const result = { ok: true as const, svg }
      cache.set(key, result)
      prune()
      return result
    } catch (err) {
      console.log = originalLog
      const base = err instanceof Error ? err.message : 'Unknown TikZ render error'
      // Pick the last "!" (TeX error banner) plus the two following lines —
      // they usually hold "! Package tikz Error: …" / "! Undefined control
      // sequence." and the offending line.
      const texDiag = extractTexError(captured.join('\n'))
      const message = texDiag ? `${base}\n\n${texDiag}` : base
      // Also mirror to the real stderr so dev terminals see it.
      originalLog('[tikz] render failed:', message)
      return { ok: false as const, error: message }
    }
  })
  inFlight.set(key, run)
  try {
    return await run
  } finally {
    inFlight.delete(key)
  }
}

function enqueueRender<T>(job: () => Promise<T>): Promise<T> {
  const next = renderQueue.then(job, job)
  renderQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function extractTexError(log: string): string {
  const lines = log.split(/\r?\n/)
  let idx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('!')) {
      idx = i
      break
    }
  }
  if (idx < 0) return ''
  return lines.slice(idx, Math.min(idx + 4, lines.length)).join('\n')
}
