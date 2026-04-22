import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
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
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        external: ['keytar'],
        // The MCP server is an independent Node entry point bundled
        // alongside the main process. electron-vite\u2019s `main`
        // section is the only slot whose output is plain ESM that
        // `node` can execute directly, which is exactly what Claude
        // Code / Claude Desktop / Codex will spawn via stdio.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          mcp: resolve(__dirname, 'src/mcp/index.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, '../../packages/shared-domain/src'),
        '@bridge-contract': resolve(__dirname, '../../packages/bridge-contract/src')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, '../../packages/shared-domain/src'),
        '@bridge-contract': resolve(__dirname, '../../packages/bridge-contract/src')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'out/renderer',
      // This is a desktop app with multiple on-demand diagram stacks.
      // Some lazy chunks are intentionally larger than the web default.
      chunkSizeWarningLimit: 3500,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
        output: {
          manualChunks: rendererManualChunk
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, '../../packages/app-core/src'),
        '@shared': resolve(__dirname, '../../packages/shared-domain/src'),
        '@bridge-contract': resolve(__dirname, '../../packages/bridge-contract/src')
      }
    },
    plugins: [react()]
  }
})
