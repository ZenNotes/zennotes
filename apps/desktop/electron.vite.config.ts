import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { harperWasmAsset } from '../../tooling/vite/harper-wasm-asset'

const INTERNAL_WORKSPACE_PACKAGES = [
  '@zennotes/app-core',
  '@zennotes/bridge-contract',
  '@zennotes/shared-domain',
  '@zennotes/shared-ui'
]

// Everything the `zen` CLI reaches at runtime, bundled rather than externalized.
//
// `cli.js` and its chunks are copied to `resources/` as extraResources, which
// puts them OUTSIDE the asar and therefore outside any node_modules: resolution
// walks up from `resources/chunks/` and finds nothing until the filesystem root.
// So an external here is not a layout that might be wrong, it is a require that
// cannot succeed. 2.20.2 shipped `smol-toml` as one and the CLI died on its
// first line for every user on every platform (#524).
//
// Anything new that main and the CLI share has to be added here. The check that
// this list is complete is `tooling/scripts/verify-packaged-cli.mjs`, which runs
// the built CLI from a directory with no node_modules above it, because that is
// the only place the failure is visible.
export const PACKAGED_CLI_RUNTIME_PACKAGES = ['@modelcontextprotocol/sdk', 'smol-toml']

// The markdown stack `note-docx.ts` parses with, bundled into main rather than
// left for Node to resolve at runtime.
//
// 2.20.0 shipped these as externals and crashed on launch on every platform:
// `micromark-util-sanitize-uri` sat at the top of the asar while the only copy
// of its `micromark-util-encode` dependency was nested under `micromark/`,
// where resolution walking up from the importer cannot see it. The repo's own
// node_modules has that package hoisted to the top and works, so nothing in
// development or in `electron out/main/index.js` can reproduce it: the broken
// layout is one electron-builder writes while collecting the tree, and it is
// only observable in a packaged build.
//
// Bundling is the fix rather than pinning the missing package as a direct
// dependency, because that only refills the one hole this crash happened to
// fall through. These are pure ESM libraries with no native pieces, so Rollup
// inlines them and everything below them, and main stops having a node_modules
// layout to be wrong about at all.
const MAIN_BUNDLED_MARKDOWN_PACKAGES = [
  'unified',
  'remark-parse',
  'remark-gfm',
  'remark-frontmatter',
  'remark-math'
]

const MAIN_EXTERNALIZE_EXCLUSIONS = [
  ...INTERNAL_WORKSPACE_PACKAGES,
  ...PACKAGED_CLI_RUNTIME_PACKAGES,
  ...MAIN_BUNDLED_MARKDOWN_PACKAGES
]

function onigurumaDataUrl(): Plugin {
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

function rendererManualChunk(id: string): string | undefined {
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

  // No manualChunks rule for mermaid / cytoscape / dagre on purpose. Mermaid is
  // only ever reached through a dynamic import (Preview.tsx does
  // `import("mermaid")`, behind LazyPreview), but forcing its modules into a
  // named chunk made Rollup hoist that chunk into the entry's STATIC graph:
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

function resolveRendererModulePreloads(
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
    // Mermaid is no longer one named chunk; it splits into mermaid.core plus a
    // chunk per diagram type, with cytoscape/dagre alongside.
    dep.includes('mermaid') ||
    dep.includes('cytoscape') ||
    dep.includes('dagre') ||
    dep.includes('vendor-jsxgraph') ||
    dep.includes('vendor-function-plot') ||
    dep.includes('vendor-typst')
  )
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: MAIN_EXTERNALIZE_EXCLUSIONS })],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        external: ['keytar'],
        // The MCP server and the `zen` CLI are independent Node entry
        // points bundled alongside the main process. electron-vite\u2019s
        // `main` section is the only slot whose output is plain ESM
        // that `node` can execute directly \u2014 which is what both
        // Claude Code / Claude Desktop / Codex (stdio MCP) and the
        // CLI wrapper script (build/zen) need.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          mcp: resolve(__dirname, 'src/mcp/index.ts'),
          cli: resolve(__dirname, 'src/cli/index.ts')
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
    plugins: [externalizeDepsPlugin({ exclude: INTERNAL_WORKSPACE_PACKAGES })],
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
    // Typst ships a WASM compiler loaded lazily via `?url` + dynamic import; keep
    // it out of the esbuild dep pre-bundler so the wasm glue stays intact. The
    // same goes for Harper, whose worker is an inline blob the pre-bundler
    // would otherwise rewrite.
    optimizeDeps: {
      exclude: [
        '@myriaddreamin/typst.ts',
        '@myriaddreamin/typst-ts-web-compiler',
        '@myriaddreamin/typst-ts-renderer',
        'harper.js'
      ]
    },
    build: {
      outDir: 'out/renderer',
      minify: 'esbuild',
      // This is a desktop app with multiple on-demand diagram stacks.
      // Some lazy chunks are intentionally larger than the web default.
      chunkSizeWarningLimit: 3500,
      modulePreload: {
        resolveDependencies: resolveRendererModulePreloads
      },
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
    plugins: [onigurumaDataUrl(), harperWasmAsset(), react()]
  }
})
