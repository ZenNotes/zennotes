/**
 * Typst math rendering: the Typst alternative to KaTeX for `$…$` / `$$…$$`.
 *
 * Selected by the "Math renderer" setting (see `mathRenderer` in the store).
 * When Typst is active, the math *body* between the dollar signs is parsed as
 * Typst markup rather than LaTeX, so a note authored for KaTeX will not render
 * the same under Typst and vice versa, which is inherent to the feature.
 *
 * How it works:
 *   - `@myriaddreamin/typst.ts` ships a WebAssembly Typst compiler (source →
 *     vector artifact) plus a WASM renderer (artifact → SVG). Both are heavy
 *     (~28 MB + ~1 MB) so they are dynamically imported and initialised lazily
 *     the first time a Typst formula is rendered, so a note without Typst math
 *     never pays for them. The WASM is bundled offline via Vite `?url` imports,
 *     and the compiler embeds the default Typst fonts (New Computer Modern Math
 *     et al.), so rendering never needs the network.
 *   - Each formula compiles a tiny auto-sized Typst document and the resulting
 *     SVG is post-processed: black glyph fills become `currentColor` (so the
 *     formula follows the active theme with no re-render on theme change) and
 *     the intrinsic pt dimensions become `em` sizes (so it scales with the
 *     surrounding font size, like KaTeX).
 *
 * The global `$typst` instance is stateful during a compile, so compiles are
 * serialised through a single queue. Results are memoised by (display, source).
 */

// Bundled offline: Vite emits these as asset URLs. On web / the desktop dev
// server they are fetched over http; the packaged desktop app (file://) routes
// them through the `zen-typst://` protocol (see `bundledAssetUrl`).
import { bundledAssetUrl } from './bundled-asset-url'
import compilerWasmUrl from '@myriaddreamin/typst-ts-web-compiler/wasm?url'
import rendererWasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'
// The New Computer Modern family (matching KaTeX's Computer Modern look). Bundled
// because the compiler ships no fonts of its own and its default is to fetch them
// from a CDN, which fails offline and under the desktop CSP.
import newCMRegularUrl from './typst-fonts/NewCM10-Regular.otf?url'
import newCMBoldUrl from './typst-fonts/NewCM10-Bold.otf?url'
import newCMItalicUrl from './typst-fonts/NewCM10-Italic.otf?url'
import newCMMathUrl from './typst-fonts/NewCMMath-Regular.otf?url'

const FONT_URLS = [newCMRegularUrl, newCMBoldUrl, newCMItalicUrl, newCMMathUrl]

/** Text size we compile every formula at; SVG dimensions come back in points,
 *  and are converted to `em` relative to this so the rendered math scales with
 *  the reader's font size (the pt→px factor cancels: `heightEm = ptHeight / 11`,
 *  times the KaTeX factor below). */
const BASE_TEXT_PT = 11

/** KaTeX draws Computer Modern at 1.21em of the surrounding text (its own
 *  stylesheet: `.katex { font-size: 1.21em }`), because the family sits small
 *  on its em square and a plain 1em reads undersized next to prose. New
 *  Computer Modern shares those metrics, so a Typst formula sized at 1em came
 *  out a fifth smaller than KaTeX's rendering of the same source (#746). Size
 *  it the way KaTeX does, so switching engines does not change the size. */
const KATEX_EM_SCALE = 1.21

export type TypstRenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string }

interface TypstInitOptions {
  getModule: () => unknown
  beforeBuild?: unknown[]
}

interface TypstSnippetLike {
  setCompilerInitOptions(options: TypstInitOptions): void
  setRendererInitOptions(options: TypstInitOptions): void
  svg(options: { mainContent: string }): Promise<string>
}

interface TypstModule {
  $typst: TypstSnippetLike
  initOptions: {
    disableDefaultFontAssets: () => unknown
    loadFonts: (fonts: string[]) => unknown
  }
}

let typstPromise: Promise<TypstSnippetLike> | null = null

async function loadTypst(): Promise<TypstSnippetLike> {
  if (!typstPromise) {
    typstPromise = (async () => {
      const mod = (await import('@myriaddreamin/typst.ts')) as unknown as TypstModule
      const $typst = mod.$typst
      // wasm-bindgen accepts a URL/Request/Response/BufferSource; a URL string
      // triggers `fetch()` and instantiates the streamed `application/wasm`
      // response (falling back to arrayBuffer instantiation if needed).
      //
      // Fonts: the compiler ships none and defaults to fetching its text fonts
      // from a jsdelivr CDN, which fails offline and is blocked by the desktop
      // CSP. `disableDefaultFontAssets()` turns that off and `loadFonts()`
      // supplies our bundled New Computer Modern family instead, so math renders
      // with no network access.
      $typst.setCompilerInitOptions({
        getModule: () => bundledAssetUrl(compilerWasmUrl, 'zen-typst'),
        beforeBuild: [
          mod.initOptions.disableDefaultFontAssets(),
          mod.initOptions.loadFonts(FONT_URLS.map((url) => bundledAssetUrl(url, 'zen-typst')))
        ]
      })
      $typst.setRendererInitOptions({ getModule: () => bundledAssetUrl(rendererWasmUrl, 'zen-typst') })
      return $typst
    })()
  }
  return typstPromise
}

/**
 * Wrap the user's math body in an auto-sized, margin-free Typst document.
 * Display math uses spaces inside the `$…$` (Typst's block-equation form);
 * inline omits them. The body is the raw Typst markup the user typed between
 * the dollar signs.
 */
function buildDocument(source: string, display: boolean, preamble: string): string {
  const body = source.trim()
  const equation = display ? `$ ${body} $` : `$${body}$`
  return [
    '#set page(width: auto, height: auto, margin: 0pt, fill: none)',
    // Pin the family to the one we bundle (also the closest match to KaTeX's
    // Computer Modern), so math resolves to New Computer Modern Math.
    `#set text(size: ${BASE_TEXT_PT}pt, font: "New Computer Modern")`,
    // Tag-driven definitions for the note this formula belongs to, ahead of the
    // formula so they can redefine anything it uses. Empty for most notes. (#486)
    ...(preamble ? [preamble] : []),
    equation
  ].join('\n')
}

/** Every spelling of black Typst's SVG export uses, on a fill or a stroke.
 *  Glyphs arrive as `fill="#000000"`; the rules a formula draws as shapes (a
 *  square root's bar, a fraction line) arrive as `stroke="#000"`, and a
 *  recolor that only knew fills left those black on a dark theme (#746). */
const BLACK_PAINT_RE = /\b(fill|stroke)="(?:#000000|#000|black|rgb\(0,\s*0,\s*0\))"/g

/**
 * Post-process Typst's SVG so it drops into a note: recolor black paint, fills
 * and strokes alike, to `currentColor` (theme-aware, no re-render on theme
 * switch) and swap the intrinsic pt width/height for `em` sizes that track the
 * surrounding font.
 */
export function styleSvg(rawSvg: string, display: boolean): string {
  let svg = rawSvg.replace(BLACK_PAINT_RE, '$1="currentColor"')

  const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  const widthPt = viewBox ? Number.parseFloat(viewBox[1]) : 0
  const heightPt = viewBox ? Number.parseFloat(viewBox[2]) : 0
  const widthEm = ((widthPt * KATEX_EM_SCALE) / BASE_TEXT_PT).toFixed(4)
  const heightEm = ((heightPt * KATEX_EM_SCALE) / BASE_TEXT_PT).toFixed(4)

  // The app's CSS reset makes every `svg` display:block; override that so inline
  // math flows in the text (centered on the line, since the SVG carries no
  // baseline metadata) and block math centers in its own row.
  const layout = display
    ? 'display: block; margin: 0 auto;'
    : 'display: inline-block; vertical-align: middle;'
  const style = `overflow: visible; width: ${widthEm}em; height: ${heightEm}em; ${layout}`

  return svg.replace(/<svg\b([^>]*)>/, (_match, attrs: string) => {
    const cleaned = attrs
      .replace(/\swidth="[^"]*"/, '')
      .replace(/\sheight="[^"]*"/, '')
      .replace(/\sstyle="[^"]*"/, '')
    return `<svg${cleaned} style="${style}">`
  })
}

// Memoise by (display, source): after the first compile every re-render (theme
// change, scroll into view, re-paint) is a Map lookup. Keyed the same way for
// the editor and the preview so they share one cache.
const svgCache = new Map<string, TypstRenderResult>()
const SVG_CACHE_LIMIT = 400

/** Cheap, stable hash so a preamble of any size costs a short cache key. */
function hashPreamble(preamble: string): string {
  if (!preamble) return ''
  let h = 0x811c9dc5
  for (let i = 0; i < preamble.length; i++) {
    h ^= preamble.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * The preamble is part of the key, not just the input: the cache is shared by
 * the editor and the preview, so without it `$vec(x)$` in a physics note and in
 * a maths note would collide and one would render with the other's definitions
 * (#486).
 */
function cacheKey(source: string, display: boolean, preamble: string): string {
  return `${display ? 'D' : 'I'}\n${hashPreamble(preamble)}\n${source}`
}

/**
 * Return an already-rendered result synchronously, or null if this formula has
 * not been compiled yet. Lets the editor widget paint a cached formula on the
 * first frame (no async flicker while scrolling or re-rendering).
 */
export function peekTypstMathSvg(
  source: string,
  display: boolean,
  preamble = ''
): TypstRenderResult | null {
  return svgCache.get(cacheKey(source, display, preamble)) ?? null
}

function rememberSvg(key: string, result: TypstRenderResult): TypstRenderResult {
  svgCache.set(key, result)
  while (svgCache.size > SVG_CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value
    if (oldest === undefined) break
    svgCache.delete(oldest)
  }
  return result
}

// The shared `$typst` instance mutates its own state during a compile, so only
// one compile may run at a time (mirrors the TikZ main-process render queue).
let renderQueue: Promise<unknown> = Promise.resolve()

/**
 * Render a Typst math body to a themed, em-sized SVG string. Never rejects:
 * syntax errors resolve to `{ ok: false, error }` so callers can show the raw
 * source instead (matching KaTeX's `throwOnError: false`).
 */
export function renderTypstMathToSvg(
  source: string,
  display: boolean,
  preamble = ''
): Promise<TypstRenderResult> {
  const key = cacheKey(source, display, preamble)
  const cached = svgCache.get(key)
  if (cached) return Promise.resolve(cached)

  const run = renderQueue.then(async (): Promise<TypstRenderResult> => {
    const existing = svgCache.get(key)
    if (existing) return existing
    try {
      const $typst = await loadTypst()
      const rawSvg = await $typst.svg({
        mainContent: buildDocument(source, display, preamble)
      })
      return rememberSvg(key, { ok: true, svg: styleSvg(rawSvg, display) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return rememberSvg(key, { ok: false, error: message })
    }
  })
  // Keep the queue alive even if a render throws unexpectedly.
  renderQueue = run.catch(() => undefined)
  return run
}

/**
 * Fill every `.zen-typst-math` placeholder inside `root` with its rendered SVG.
 * Called by the preview after each markdown render. Each placeholder carries the
 * raw Typst source in `data-typst-source` and its display flag in
 * `data-typst-display`; a `data-zen-typst-rendered` stamp makes re-runs on
 * unchanged content a no-op.
 */
export async function renderTypstMath(root: HTMLElement, preamble = ''): Promise<void> {
  const placeholders = Array.from(
    root.querySelectorAll<HTMLElement>('.zen-typst-math')
  )
  const tasks: Promise<void>[] = []

  for (const el of placeholders) {
    const source = el.getAttribute('data-typst-source') ?? el.textContent ?? ''
    const display = el.getAttribute('data-typst-display') === 'true'
    // The preamble is part of the stamp: editing a note's tags (or the preamble
    // note itself) must re-render formulas that already painted. (#486)
    const stamp = `${display ? 'D' : 'I'}|${hashPreamble(preamble)}|${source}`
    if (el.getAttribute('data-zen-typst-rendered') === stamp) continue
    el.setAttribute('data-zen-typst-rendered', stamp)
    if (!source.trim()) continue

    tasks.push(
      renderTypstMathToSvg(source, display, preamble).then((result) => {
        if (el.getAttribute('data-zen-typst-rendered') !== stamp) return
        if (result.ok) {
          el.innerHTML = result.svg
          el.classList.remove('zen-typst-error')
        } else {
          el.textContent = display ? `$$${source}$$` : `$${source}$`
          el.classList.add('zen-typst-error')
          el.setAttribute('title', `Typst error: ${result.error}`)
        }
      })
    )
  }

  await Promise.all(tasks)
}
