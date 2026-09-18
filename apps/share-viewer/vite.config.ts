import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { zenNotesAssets } from '../../packages/app-core/build/vite.mjs'

// The Laravel share page references exactly two stable filenames -
// share-viewer.js and share-viewer.css (cache-busted by ?v=). Lazy
// chunks keep content hashes and load relative to the entry module.
export default defineConfig({
  root: __dirname,
  base: './',
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^(jsxgraph|function-plot)$/, replacement: resolve(__dirname, 'src/disabled-diagrams.ts') },
      { find: '@renderer', replacement: resolve(__dirname, '../../packages/app-core/src') },
      { find: '@shared', replacement: resolve(__dirname, '../../packages/shared-domain/src') },
      {
        find: '@bridge-contract',
        replacement: resolve(__dirname, '../../packages/bridge-contract/src')
      }
    ]
  },
  server: {
    port: 5179
  },
  plugins: [react(), zenNotesAssets({ harper: false })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 3500,
    sourcemap: false,
    // One stylesheet for the whole viewer (lazy chunks included) so the
    // Blade page only ever links share-viewer.css.
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'share-viewer.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (info) =>
          info.name?.endsWith('.css') ? 'share-viewer.css' : 'assets/[name]-[hash][extname]'
      }
    }
  }
})
