/**
 * Client-side render loop for the three "math diagram" block types:
 * TikZ, JSXGraph, and function-plot.
 *
 * Preview.tsx calls `renderDiagrams(rootEl, { themeKey })` after each
 * markdown render (and again when the theme changes). Each function
 * below is a no-op when the root has no blocks of its type, so
 * loading a diagram library is pay-for-what-you-use: opening a note
 * without any JSXGraph fences never imports `jsxgraph`.
 *
 * Every library is loaded once, lazily, and memoized.
 */

// ---------------------------------------------------------------------------
// TikZ — main-process-compiled SVG
// ---------------------------------------------------------------------------

async function renderTikzBlock(el: HTMLElement): Promise<void> {
  const source =
    el.getAttribute('data-tikz-source') ?? el.textContent?.trim() ?? ''
  if (!source) return
  el.setAttribute('data-tikz-source', source)
  el.innerHTML =
    '<div class="zen-tikz-loading text-[11px] opacity-60">Rendering TikZ…</div>'
  if (typeof window.zen?.renderTikz !== 'function') {
    el.innerHTML = `<pre class="zen-diagram-error">TikZ renderer not loaded. Quit (⌘Q) and relaunch the app — the preload script is only attached when a window is first created, so a plain reload isn't enough.</pre>`
    return
  }
  try {
    const result = await window.zen.renderTikz(source)
    if (result.ok && result.svg) {
      el.innerHTML = result.svg
      // Make the SVG theme-aware: strokes that were explicitly black get
      // re-tinted to the current foreground color.
      for (const node of Array.from(el.querySelectorAll<SVGElement>('[stroke="#000"], [stroke="black"]'))) {
        node.setAttribute('stroke', 'currentColor')
      }
      for (const node of Array.from(el.querySelectorAll<SVGElement>('[fill="#000"], [fill="black"]'))) {
        node.setAttribute('fill', 'currentColor')
      }
    } else {
      el.innerHTML = `<pre class="zen-diagram-error">TikZ error: ${escapeHtml(result.error ?? 'Unknown error')}</pre>`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    el.innerHTML = `<pre class="zen-diagram-error">TikZ error: ${escapeHtml(message)}</pre>`
  }
}

// ---------------------------------------------------------------------------
// JSXGraph — interactive 2D geometry / function plots
// ---------------------------------------------------------------------------

// JSXGraph exposes the `JXG` namespace as its default export. Typed as
// `unknown` because the shipped types are a namespace, not a value.
type Jxg = {
  JSXGraph: {
    initBoard: (
      id: string,
      attributes: Record<string, unknown>
    ) => JxgBoard
  }
}
type JxgObject = { _zenId?: string; elementClass?: number }
type JxgBoard = {
  create: (
    type: string,
    args: unknown[],
    attributes?: Record<string, unknown>
  ) => JxgObject
  jc: { parse: (expr: string) => unknown }
}

let jsxgraphPromise: Promise<Jxg> | null = null
function loadJSXGraph(): Promise<Jxg> {
  if (!jsxgraphPromise) {
    jsxgraphPromise = import('jsxgraph').then((mod) => {
      const JXG =
        (mod as unknown as { default?: Jxg }).default ??
        (mod as unknown as Jxg)
      return JXG
    })
  }
  return jsxgraphPromise
}

interface JsxGraphConfig {
  boundingbox?: [number, number, number, number]
  axis?: boolean
  showCopyright?: boolean
  showNavigation?: boolean
  width?: number
  height?: number
  objects?: Array<{
    id?: string
    type: string
    args: unknown[]
    attributes?: Record<string, unknown>
  }>
}

/** Read a theme token (`--z-*` RGB triplet) as a hex string so JSXGraph
 *  attributes accept it. Missing tokens fall back to a neutral grey. */
function themeColor(cssVar: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(cssVar)
    .trim()
  if (!raw) return fallback
  const parts = raw.split(/[\s,]+/).map((n) => Number(n))
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return fallback
  const hex = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${hex(parts[0])}${hex(parts[1])}${hex(parts[2])}`
}

async function renderJsxGraphBlock(el: HTMLElement): Promise<void> {
  const source =
    el.getAttribute('data-jsxgraph-source') ?? el.textContent?.trim() ?? ''
  if (!source) return
  el.setAttribute('data-jsxgraph-source', source)

  let config: JsxGraphConfig
  try {
    config = JSON.parse(source) as JsxGraphConfig
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON'
    el.innerHTML = `<pre class="zen-diagram-error">JSXGraph config must be JSON: ${escapeHtml(message)}</pre>`
    return
  }

  try {
    const JXG = await loadJSXGraph()
    // JSXGraph binds to a real DOM id, so we mint one per render.
    const id = `zen-jxg-${Math.random().toString(36).slice(2, 10)}`
    const host = document.createElement('div')
    host.id = id
    host.className = 'zen-jxg-host'
    const width = config.width ?? 520
    const height = config.height ?? 320
    host.style.width = `${width}px`
    host.style.height = `${height}px`
    el.innerHTML = ''
    el.appendChild(host)

    // Pull theme colors from the same CSS vars the rest of the app uses
    // so axes / grid / labels sit naturally on light or dark backgrounds.
    const axisColor = themeColor('--z-grey-1', '#7c6f64')
    const textColor = themeColor('--z-fg-1', '#3c3836')
    const gridColor = themeColor('--z-grey-dim', '#bdae93')
    const axisAttributes = {
      strokeColor: axisColor,
      strokeOpacity: 0.85,
      highlightStrokeColor: axisColor,
      ticks: {
        strokeColor: axisColor,
        strokeOpacity: 0.6,
        label: { strokeColor: textColor, fillColor: textColor, fontSize: 11 }
      }
    }

    const board: JxgBoard = JXG.JSXGraph.initBoard(id, {
      boundingbox: config.boundingbox ?? [-5, 5, 5, -5],
      axis: config.axis ?? true,
      showCopyright: false,
      showNavigation: config.showNavigation ?? false,
      keepAspectRatio: false,
      pan: { enabled: true, needTwoFingers: false },
      zoom: { enabled: true, wheel: true },
      defaultAxes: { x: axisAttributes, y: axisAttributes },
      grid: { majorStep: [1, 1], strokeColor: gridColor, strokeOpacity: 0.25 }
    })

    // Track objects that declared an `id` in the config so later objects
    // can reference them via `"@id"` tokens in their `args`. JSXGraph's
    // declarative API otherwise requires real JS refs, which we can't get
    // out of JSON.
    const registry = new Map<string, JxgObject>()
    const resolveArg = (v: unknown): unknown => {
      if (typeof v === 'string' && v.length > 1 && v.startsWith('@')) {
        const ref = registry.get(v.slice(1))
        if (ref) return ref
      }
      if (Array.isArray(v)) return v.map(resolveArg)
      return v
    }

    for (const obj of config.objects ?? []) {
      try {
        const resolvedArgs = (obj.args as unknown[]).map(resolveArg)
        // Theme-aware defaults: any object without an explicit stroke
        // picks up the foreground color so geometry stays readable on
        // light and dark backgrounds.
        const attrs = { ...(obj.attributes ?? {}) }
        if (!('strokeColor' in attrs)) attrs.strokeColor = textColor
        if (obj.type === 'text' && !('fillColor' in attrs)) attrs.fillColor = textColor
        const created = board.create(obj.type, resolvedArgs, attrs)
        if (obj.id) registry.set(obj.id, created)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid object'
        const note = document.createElement('pre')
        note.className = 'zen-diagram-error'
        note.textContent = `JSXGraph object "${obj.type}": ${message}`
        el.appendChild(note)
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    el.innerHTML = `<pre class="zen-diagram-error">JSXGraph error: ${escapeHtml(message)}</pre>`
  }
}

// ---------------------------------------------------------------------------
// function-plot — Cartesian function plotting
// ---------------------------------------------------------------------------

type FunctionPlotModule = typeof import('function-plot')
let functionPlotPromise:
  | Promise<(options: Record<string, unknown>) => unknown>
  | null = null
function loadFunctionPlot(): Promise<(options: Record<string, unknown>) => unknown> {
  if (!functionPlotPromise) {
    functionPlotPromise = import('function-plot').then((mod) => {
      const fn =
        (mod as unknown as { default?: unknown }).default ??
        (mod as unknown as FunctionPlotModule)
      return fn as (options: Record<string, unknown>) => unknown
    })
  }
  return functionPlotPromise
}

async function renderFunctionPlotBlock(el: HTMLElement): Promise<void> {
  const source =
    el.getAttribute('data-function-plot-source') ??
    el.textContent?.trim() ??
    ''
  if (!source) return
  el.setAttribute('data-function-plot-source', source)

  let config: Record<string, unknown>
  try {
    config = JSON.parse(source) as Record<string, unknown>
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON'
    el.innerHTML = `<pre class="zen-diagram-error">function-plot config must be JSON: ${escapeHtml(message)}</pre>`
    return
  }

  try {
    const fn = await loadFunctionPlot()
    const host = document.createElement('div')
    host.className = 'zen-function-plot-host'
    el.innerHTML = ''
    el.appendChild(host)
    fn({
      target: host,
      width: 560,
      height: 320,
      grid: true,
      ...config
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    el.innerHTML = `<pre class="zen-diagram-error">function-plot error: ${escapeHtml(message)}</pre>`
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Find every diagram placeholder inside `root` and render into it.
 * Called after each markdown render and once more on theme change.
 * Each block is skipped if its source attribute hasn't changed since the
 * last render — that way a theme switch only triggers a re-render for
 * the currently-visible blocks, and a normal re-render of unchanged
 * blocks is a no-op (we stamp `data-zen-rendered-hash`).
 */
export async function renderDiagrams(
  root: HTMLElement,
  opts: { themeKey: string }
): Promise<void> {
  const tasks: Promise<void>[] = []

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.zen-tikz'))) {
    const source = el.getAttribute('data-tikz-source') ?? el.textContent ?? ''
    const stamp = `tikz|${source}`
    if (el.getAttribute('data-zen-rendered-hash') === stamp) continue
    el.setAttribute('data-zen-rendered-hash', stamp)
    tasks.push(renderTikzBlock(el))
  }

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.zen-jsxgraph'))) {
    const source = el.getAttribute('data-jsxgraph-source') ?? el.textContent ?? ''
    const stamp = `jsx|${opts.themeKey}|${source}`
    if (el.getAttribute('data-zen-rendered-hash') === stamp) continue
    el.setAttribute('data-zen-rendered-hash', stamp)
    tasks.push(renderJsxGraphBlock(el))
  }

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.zen-function-plot'))) {
    const source = el.getAttribute('data-function-plot-source') ?? el.textContent ?? ''
    const stamp = `fp|${opts.themeKey}|${source}`
    if (el.getAttribute('data-zen-rendered-hash') === stamp) continue
    el.setAttribute('data-zen-rendered-hash', stamp)
    tasks.push(renderFunctionPlotBlock(el))
  }

  await Promise.all(tasks)
}
