/**
 * What the two browser builds of apps/web share: the self-hosted web client
 * (vite.config.ts, dist/) and ZenNotes in your browser (vite.cloud.config.ts,
 * dist-cloud/). Moved here unchanged from vite.config.ts.
 */
import { createReadStream, readFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import type { Alias, Plugin } from 'vite'

// Excalidraw resolves its hand-drawn fonts from a base URL. With
// EXCALIDRAW_ASSET_PATH unset it falls back to the esm.sh CDN, which the
// self-hosted server's CSP (`font-src 'self' data:`) blocks, so changing an
// element's font never rendered on web (it works on desktop, which self-hosts
// the fonts via a custom protocol, #324). Serve the bundled woff2 files from a
// same-origin path so the existing `'self'` policy covers them; the renderer
// points EXCALIDRAW_ASSET_PATH here. URL shape: /excalidraw-assets/fonts/<Family>/<file>.
const excalidrawFontsDir = resolve(
  dirname(createRequire(resolve(__dirname, 'package.json')).resolve('@excalidraw/excalidraw')),
  'fonts'
)
export const EXCALIDRAW_FONTS_URL_PREFIX = '/excalidraw-assets/fonts/'

export function onigurumaDataUrl(): Plugin {
  const virtualId = '\0zennotes:oniguruma-wasm-data-url'
  const wasmPath = createRequire(resolve(__dirname, 'package.json')).resolve(
    'vscode-oniguruma/release/onig.wasm'
  )
  return {
    name: 'zennotes-oniguruma-data-url',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'vscode-oniguruma/release/onig.wasm?url') return virtualId
      return null
    },
    load(id) {
      if (id !== virtualId) return null
      const bytes = readFileSync(wasmPath)
      const url = `data:application/wasm;base64,${bytes.toString('base64')}`
      return `export default ${JSON.stringify(url)}`
    }
  }
}

function excalidrawFontMime(path: string): string {
  if (/\.woff2$/i.test(path)) return 'font/woff2'
  if (/\.woff$/i.test(path)) return 'font/woff'
  if (/\.otf$/i.test(path)) return 'font/otf'
  if (/\.ttf$/i.test(path)) return 'font/ttf'
  return 'application/octet-stream'
}

export function excalidrawFonts(outDir = resolve(__dirname, 'dist')): Plugin {
  return {
    name: 'zennotes-excalidraw-fonts',
    // Dev: serve the fonts straight from node_modules so the same URLs resolve
    // (Vite dev sets no CSP, but this keeps dev offline-capable and consistent
    // with the built app).
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (!url || !url.startsWith(EXCALIDRAW_FONTS_URL_PREFIX)) return next()
        const rel = decodeURIComponent(url.slice(EXCALIDRAW_FONTS_URL_PREFIX.length))
        const abs = resolve(excalidrawFontsDir, rel)
        if (
          (abs !== excalidrawFontsDir && !abs.startsWith(excalidrawFontsDir + sep)) ||
          !/\.(woff2?|otf|ttf)$/i.test(abs)
        ) {
          res.statusCode = 404
          res.end()
          return
        }
        res.setHeader('Content-Type', excalidrawFontMime(abs))
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        createReadStream(abs)
          .on('error', () => {
            res.statusCode = 404
            res.end()
          })
          .pipe(res)
      })
    },
    // Build: copy the fonts into the bundle so the server embeds and serves them.
    async closeBundle() {
      await cp(excalidrawFontsDir, resolve(outDir, 'excalidraw-assets/fonts'), {
        recursive: true
      })
    }
  }
}

export function rendererManualChunk(id: string): string | undefined {
  const normalizedId = id.split('\\').join('/')
  if (normalizedId.endsWith('/packages/app-core/src/lib/wikilinks.ts')) {
    return 'app-wikilinks'
  }
  if (normalizedId.endsWith('/packages/app-core/src/lib/local-assets.ts')) {
    return 'app-local-assets'
  }
  if (normalizedId.endsWith('/packages/app-core/src/store.ts')) {
    return 'app-store'
  }

  if (!id.includes('node_modules')) return undefined

  // `@xyflow/react` (and the zustand 4 nested under it) must NOT ride this
  // rule: `/react/` matches it as a substring, and vendor-react is the one
  // chunk the entry both statically imports and modulepreloads, so React Flow
  // was fetched and evaluated on every launch for a feature that is off by
  // default. No named chunk for it either (see the mermaid comment below):
  // left alone, it lands in the lazily-imported WorkflowsView chunk and is
  // fetched the first time a Workflows tab renders.
  if (
    (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/zustand/')) &&
    !id.includes('/@xyflow/')
  ) {
    return 'vendor-react'
  }

  if (id.includes('/@codemirror/language-data/')) {
    return 'vendor-editor-languages'
  }

  if (
    id.includes('/@codemirror/') ||
    id.includes('/codemirror/') ||
    id.includes('/@lezer/') ||
    id.includes('/@replit/codemirror-vim/')
  ) {
    return 'vendor-editor'
  }

  if (
    id.includes('/remark-') ||
    id.includes('/rehype-') ||
    id.includes('/unified/') ||
    id.includes('/unist-util-visit/') ||
    id.includes('/gray-matter/') ||
    id.includes('/katex/')
  ) {
    return 'vendor-markdown'
  }

  if (id.includes('/highlight.js/')) {
    return 'vendor-highlight'
  }

  if (id.includes('/vscode-textmate/') || id.includes('/vscode-oniguruma/')) {
    return 'vendor-textmate'
  }

  // No manualChunks rule for the diagram stacks on purpose. Mermaid fences are
  // drawn by Pele, reached only through `import("./pele-runtime")` in
  // mermaid-render.ts; mermaid.js itself (with cytoscape / dagre) now arrives
  // only with Excalidraw's Mermaid-to-Excalidraw dialog, also behind a dynamic
  // import. Both stay async only while Rollup is left to chunk them. When
  // mermaid's modules were forced into a named chunk, Rollup hoisted that chunk
  // into the entry's STATIC graph:
  // `index-*.js` ended up with `import{m as gt}from"./vendor-mermaid-*.js"`,
  // where gt is mermaid itself, so every launch fetched and evaluated 2.5MB of
  // diagram code (and vendor-markdown with it, which vendor-mermaid imports)
  // before the user opened a note. Narrowing the rule to just '/mermaid/' does
  // not help; the grouping itself is what breaks the async boundary. Left to
  // Rollup, mermaid lands in its own async chunks (mermaid.core-*.js and
  // friends) and is fetched the first time a diagram actually renders. Total
  // bundle size is unchanged; only the boot path is.
  if (id.includes('/jsxgraph/')) {
    return 'vendor-jsxgraph'
  }

  if (id.includes('/function-plot/')) {
    return 'vendor-function-plot'
  }

  // Keep the tiny `?url` wasm-locator modules out of this chunk so it stays a
  // pure dynamic import, only fetched when a Typst formula is actually rendered.
  if (id.includes('/@myriaddreamin/') && !id.includes('.wasm')) {
    return 'vendor-typst'
  }

  if (id.includes('/d3')) {
    return 'vendor-d3'
  }

  return undefined
}

export function resolveRendererModulePreloads(
  _filename: string,
  deps: string[],
  context: { hostType: 'html' | 'js' }
): string[] {
  if (context.hostType === 'html') {
    return deps.filter((dep) => dep.includes('vendor-react'))
  }
  return deps.filter((dep) => !isDeferredRendererPreload(dep))
}

function isDeferredRendererPreload(dep: string): boolean {
  return (
    dep.includes('NoteHoverPreview-') ||
    dep.includes('Preview-') ||
    dep.includes('WorkflowsView-') ||
    dep.includes('xyflow') ||
    dep.includes('wardley-') ||
    dep.includes('vendor-markdown') ||
    dep.includes('vendor-highlight') ||
    dep.includes('vendor-textmate') ||
    dep.includes('vendor-d3') ||
    // Pele, the mermaid-fence renderer: its runtime chunk, after which each
    // diagram type fetches a chunk of its own on first use.
    dep.includes('pele-runtime') ||
    // D2, the ```d2 renderer: one chunk of about 8 MB with its WebAssembly
    // compiler inside, fetched only when a note holds a d2 fence.
    dep.includes('d2-runtime') ||
    // mermaid.js (Excalidraw's Mermaid dialog only) splits into mermaid.core plus
    // a chunk per diagram type, with cytoscape/dagre alongside.
    dep.includes('mermaid') ||
    dep.includes('cytoscape') ||
    dep.includes('dagre') ||
    dep.includes('vendor-jsxgraph') ||
    dep.includes('vendor-function-plot') ||
    dep.includes('vendor-typst')
  )
}

export const sharedAliases: Alias[] = [
  { find: '@renderer', replacement: resolve(__dirname, '../../packages/app-core/src') },
  { find: '@shared', replacement: resolve(__dirname, '../../packages/shared-domain/src') },
  { find: '@bridge-contract', replacement: resolve(__dirname, '../../packages/bridge-contract/src') }
]

// Typst ships a WASM compiler loaded lazily via `?url` + dynamic import; keep
// it out of the esbuild dep pre-bundler so the wasm glue stays intact. The
// same goes for Harper, whose worker is an inline blob the pre-bundler
// would otherwise rewrite.
export const sharedOptimizeDepsExclude = [
  '@myriaddreamin/typst.ts',
  '@myriaddreamin/typst-ts-web-compiler',
  '@myriaddreamin/typst-ts-renderer',
  'harper.js'
]
