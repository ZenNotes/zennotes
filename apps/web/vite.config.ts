import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function rendererManualChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined

  if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/zustand/')) {
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

  if (id.includes('/mermaid/') || id.includes('/cytoscape/') || id.includes('/dagre/')) {
    return 'vendor-mermaid'
  }

  if (id.includes('/jsxgraph/')) {
    return 'vendor-jsxgraph'
  }

  if (id.includes('/function-plot/')) {
    return 'vendor-function-plot'
  }

  if (id.includes('/d3')) {
    return 'vendor-d3'
  }

  return undefined
}

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(__dirname, '../../packages/app-core/src') },
      { find: '@shared', replacement: resolve(__dirname, '../../packages/shared-domain/src') },
      { find: '@bridge-contract', replacement: resolve(__dirname, '../../packages/bridge-contract/src') }
    ]
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
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 3500,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: rendererManualChunk
      }
    }
  }
})
