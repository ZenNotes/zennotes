/**
 * ZenNotes in your browser (app.zennotes.org): the second build of apps/web,
 * from src/cloud/ into dist-cloud/. It shares the self-hosted build's plugins
 * and chunking rules (vite.shared.ts) and adds what this host needs:
 *
 * - its own service worker, src/cloud/sw.ts, built into `/sw.js` after the
 *   bundle with the generated precache list and a cache named for the build;
 * - TikZJax served at `tikzjax/` from @zennotes/portable-vault's assets;
 * - the spike-corrected Content Security Policy on local serving
 *   (`preview:cloud`), and `headers.json` in the artifact so the website's
 *   host-scoped route (Phase 3) sends the same headers;
 * - `/_vault/*` answered 404 by the server, so a request the service worker
 *   did not take never reaches the app shell.
 *
 * `npm run dev:cloud` sends no CSP: Vite's dev client needs inline script and
 * a websocket the policy refuses. `npm run build:cloud && npm run
 * preview:cloud` serves the built app under the real policy.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { build, defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { harperWasmAsset } from '../../tooling/vite/harper-wasm-asset'
import {
  excalidrawFonts,
  onigurumaDataUrl,
  rendererManualChunk,
  resolveRendererModulePreloads,
  sharedAliases,
  sharedOptimizeDepsExclude
} from './vite.shared'

const CLOUD_ROOT = resolve(__dirname, 'src/cloud')
const OUT_DIR = resolve(__dirname, 'dist-cloud')
/** Where the hashed release files are served from. `/` locally; Phase 3 sets
 *  the website's `/vendor/cloud-web/releases/<version>/`. */
const BASE = process.env.ZN_CLOUD_BASE ?? '/'
const TIKZJAX_DIR = dirname(
  createRequire(resolve(__dirname, 'package.json')).resolve('@zennotes/portable-vault/tikzjax/tikzjax.js')
)

/**
 * The policy every renderer was measured against (docs/ideas/cloud-in-browser.md,
 * "Hosting at app.zennotes.org"; spike 4). `'unsafe-eval'` is there for D2,
 * Typst and function-plot as shipped; dropping it is a later hardening pass.
 *
 * connect-src names only the app and production Cloud here. The website
 * serves this policy from headers.json and appends, at serve time, the API
 * origin (its APP_URL) and the sync bucket's origin (CLOUD_WEB_CONNECT_ORIGINS,
 * where signed uploads and downloads go), so neither is baked into a release.
 * A local preview against a local website names its origins in
 * ZN_CLOUD_CONNECT_ORIGINS (comma-separated) the same way.
 */
export const CLOUD_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://zennotes.org",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: https://www.youtube-nocookie.com https://player.vimeo.com",
  "object-src 'none'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** The policy with more origins in connect-src, as the website serves it. */
export function cloudCspWithConnectOrigins(origins: readonly string[]): string {
  const extra = origins.map((origin) => origin.trim()).filter((origin) => /^https?:\/\/[^\s;,'"]+$/.test(origin))
  if (extra.length === 0) return CLOUD_CSP
  return CLOUD_CSP.replace(/connect-src ([^;]+)/, (_match, sources: string) => `connect-src ${sources} ${extra.join(' ')}`)
}

export const CLOUD_DOCUMENT_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CLOUD_CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
}

/** Files above this are cached on first use instead of precached: D2's
 *  8 MB chunk, the Typst and Harper wasm, TikZJax's 12 MB engine. */
const PRECACHE_MAX_BYTES = 1_500_000
const NEVER_PRECACHED = [/^sw\.js$/, /^headers\.json$/, /^THIRD_PARTY_NOTICES\.txt$/, /^excalidraw-assets\//, /^tikzjax\//]

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** The shell files the app host serves at its own root, never under the
 *  base: index.html at every app route, the web manifest at
 *  `/manifest.webmanifest` (and `/sw.js`, which is never precached). */
const ROOT_SHELL_URLS: Record<string, string> = {
  'index.html': '/',
  'manifest.webmanifest': '/manifest.webmanifest'
}

function publicUrl(file: string): string {
  const rel = relative(OUT_DIR, file).split(sep).join('/')
  return ROOT_SHELL_URLS[rel] ?? `${BASE}${rel}`
}

/**
 * The web manifest as the app host serves it: at the root, with its icons
 * under the base, where the hashed release files live (the website's
 * installer refuses an icon outside it). The icons in public/ are written
 * root-relative and joined to the base here.
 */
async function writeWebManifest(): Promise<void> {
  const file = resolve(OUT_DIR, 'manifest.webmanifest')
  const manifest = JSON.parse(await readFile(file, 'utf8')) as { icons?: Array<{ src: string }> }
  for (const icon of manifest.icons ?? []) {
    icon.src = `${BASE}${icon.src.replace(/^\/+/, '')}`
  }
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n')
}

async function serviceWorkerSource(defines: { precache: string[]; warm: string[]; buildId: string }): Promise<string> {
  const result = await build({
    configFile: false,
    root: CLOUD_ROOT,
    publicDir: false,
    logLevel: 'warn',
    resolve: { alias: sharedAliases },
    define: {
      __ZN_PRECACHE__: JSON.stringify(defines.precache),
      __ZN_WARM__: JSON.stringify(defines.warm),
      __ZN_BUILD_ID__: JSON.stringify(defines.buildId),
      __ZN_SHELL_URL__: JSON.stringify('/')
    },
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      lib: {
        entry: resolve(CLOUD_ROOT, 'sw.ts'),
        formats: ['iife'],
        name: 'ZenNotesServiceWorker',
        fileName: () => 'sw.js'
      }
    }
  })
  const outputs = (Array.isArray(result) ? result : [result]) as Array<{ output: Array<{ type: string; code?: string }> }>
  const chunk = outputs[0]?.output.find((item) => item.type === 'chunk')
  if (!chunk?.code) throw new Error('The service worker build produced no code')
  return chunk.code
}

function serveFile(res: ServerResponse, file: string, type: string): void {
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-cache')
  createReadStream(file)
    .on('error', () => {
      res.statusCode = 404
      res.end()
    })
    .pipe(res)
}

function vaultNotFound(req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction): void {
  if (!req.url?.startsWith('/_vault/')) return next()
  res.statusCode = 404
  res.setHeader('Cache-Control', 'no-store')
  res.end('Not found')
}

function cloudHost(): Plugin {
  return {
    name: 'zennotes-cloud-host',
    // Vite joins every root-relative href to the base; the web manifest is a
    // shell file the app host serves at its root, so its link goes back.
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replaceAll(`href="${BASE}manifest.webmanifest"`, 'href="/manifest.webmanifest"')
      }
    },
    configureServer(server) {
      server.middlewares.use(vaultNotFound)
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0]
        if (url === '/sw.js') {
          try {
            const code = await serviceWorkerSource({ precache: [], warm: [], buildId: 'dev' })
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Service-Worker-Allowed', '/')
            res.end(code)
          } catch (error) {
            next(error as Error)
          }
          return
        }
        if (url?.startsWith('/tikzjax/')) {
          const name = decodeURIComponent(url.slice('/tikzjax/'.length))
          const file = resolve(TIKZJAX_DIR, name)
          if (!file.startsWith(TIKZJAX_DIR + sep) || !/\.(js|css)$/.test(name)) return next()
          serveFile(res, file, name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
          return
        }
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use(vaultNotFound)
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/sw.js') res.setHeader('Cache-Control', 'no-cache')
        next()
      })
    },
    closeBundle: {
      // After every other plugin's closeBundle (Excalidraw's fonts), so the
      // precache list sees the finished tree.
      order: 'post',
      sequential: true,
      async handler() {
        await cp(TIKZJAX_DIR, resolve(OUT_DIR, 'tikzjax'), {
          recursive: true,
          filter: (source) => !source.endsWith('README.md')
        })
        await writeWebManifest()
        await writeFile(
          resolve(OUT_DIR, 'headers.json'),
          JSON.stringify({ schemaVersion: 1, document: CLOUD_DOCUMENT_HEADERS, serviceWorker: { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' } }, null, 2) + '\n'
        )
        const files = (await walk(OUT_DIR)).sort()
        const hash = createHash('sha256')
        const cached: string[] = []
        for (const file of files) {
          const rel = relative(OUT_DIR, file).split(sep).join('/')
          if (NEVER_PRECACHED.some((pattern) => pattern.test(rel))) continue
          if ((await stat(file)).size > PRECACHE_MAX_BYTES) continue
          cached.push(publicUrl(file))
          hash.update(rel).update('\0').update(await readFile(file)).update('\0')
        }
        // The install caches only the shell index.html loads (its scripts,
        // preloads, styles, icons and manifest), so a first visit is never
        // held behind the whole build; the rest is warmed in the background
        // once the app is up (sw.ts, 'warm').
        const html = await readFile(resolve(OUT_DIR, 'index.html'), 'utf8')
        const referenced = new Set([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]))
        const precache = cached.filter((url) => url === '/' || referenced.has(url))
        const warm = cached.filter((url) => !precache.includes(url))
        const buildId = hash.digest('hex').slice(0, 16)
        await writeFile(resolve(OUT_DIR, 'sw.js'), await serviceWorkerSource({ precache, warm, buildId }))
      }
    }
  }
}

export default defineConfig({
  root: CLOUD_ROOT,
  publicDir: resolve(CLOUD_ROOT, 'public'),
  base: BASE,
  envDir: __dirname,
  resolve: {
    alias: sharedAliases,
    // One React for app-core's source and this app (see vite.config.ts).
    dedupe: ['react', 'react-dom']
  },
  server: {
    port: 5175,
    host: '127.0.0.1'
  },
  preview: {
    port: 4175,
    host: '127.0.0.1',
    headers: {
      ...CLOUD_DOCUMENT_HEADERS,
      'Content-Security-Policy': cloudCspWithConnectOrigins((process.env.ZN_CLOUD_CONNECT_ORIGINS ?? '').split(','))
    }
  },
  plugins: [onigurumaDataUrl(), harperWasmAsset(), react(), excalidrawFonts(OUT_DIR, `${BASE}excalidraw-assets/`), cloudHost()],
  optimizeDeps: {
    exclude: sharedOptimizeDepsExclude
  },
  worker: {
    format: 'es'
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    chunkSizeWarningLimit: 3500,
    modulePreload: {
      resolveDependencies: resolveRendererModulePreloads
    },
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: rendererManualChunk
      }
    }
  }
})
