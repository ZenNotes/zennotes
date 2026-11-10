import { defineConfig } from 'vite'
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

export default defineConfig({
  root: __dirname,
  // Emit relative paths in index.html so the same bundle works at the
  // domain root and under a reverse-proxy subpath (e.g. /zennotes/).
  // Runtime API + WebSocket calls derive the prefix from
  // window.__ZN_BASE_PATH__, which the Go server injects into the SPA
  // shell when ZENNOTES_BASE_PATH is set.
  base: './',
  resolve: {
    alias: sharedAliases,
    // app-core is consumed as source (its `./main` export points at
    // packages/app-core/src), so its bare `react` / `react-dom` imports live
    // outside this app's Vite root and can resolve to a second React instance
    // from the app's own optimized copy — "Invalid hook call: more than one
    // copy of React". Pin every React import to the single hoisted copy.
    // electron-vite applies this for the desktop renderer by default; plain
    // Vite does not, so we set it explicitly to keep web and desktop in parity.
    dedupe: ['react', 'react-dom']
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true,
        ws: true
      },
      '/vault': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/fs': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/notes': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/comments': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/folders': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/assets': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/search': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/tasks': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/demo': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/watch': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true,
        ws: true
      },
      '/capabilities': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/version': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/platform': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/healthz': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      },
      '/assets-data': {
        target: 'http://127.0.0.1:7878',
        changeOrigin: true
      }
    }
  },
  plugins: [onigurumaDataUrl(), harperWasmAsset(), react(), excalidrawFonts()],
  // Typst ships a WASM compiler loaded lazily via `?url` + dynamic import; keep
  // it out of the esbuild dep pre-bundler so the wasm glue stays intact. The
  // same goes for Harper, whose worker is an inline blob the pre-bundler
  // would otherwise rewrite.
  optimizeDeps: {
    exclude: sharedOptimizeDepsExclude
  },
  build: {
    outDir: 'dist',
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
