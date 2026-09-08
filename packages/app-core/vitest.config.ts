import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import { harperWasmAsset } from '../../tooling/vite/harper-wasm-asset'

function onigurumaDataUrl(): Plugin {
  const virtualId = '\0zennotes:oniguruma-wasm-data-url'
  const wasmPath = createRequire(path.resolve(__dirname, 'package.json')).resolve(
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

export default defineConfig({
  plugins: [onigurumaDataUrl(), harperWasmAsset()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared-domain/src'),
      '@bridge-contract': path.resolve(__dirname, '../bridge-contract/src')
    }
  },
  test: {
    include: ['src/**/*.test.ts']
  }
})
