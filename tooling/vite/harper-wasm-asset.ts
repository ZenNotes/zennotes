import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * The specifier the renderer imports Harper's WebAssembly binary through.
 * harper.js hides its `dist/` behind an exports map, so a plain `?url` import of
 * the wasm cannot resolve; this plugin resolves the package's `slimBinary`
 * entry (which the map does expose), finds the wasm next to it, and hands the
 * real file to Vite's own `?url` asset pipeline. The result is an emitted,
 * hashed asset in production and a `/@fs/` URL on the dev server, the same
 * treatment the Typst wasm gets, and nothing Harper's dist does at runtime is
 * relied on.
 */
export const HARPER_WASM_URL_SPECIFIER = 'harper.js/dist/harper_wasm_slim_bg.wasm?url'

export function harperWasmAsset(): Plugin {
  return {
    name: 'zennotes-harper-wasm-asset',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (id !== HARPER_WASM_URL_SPECIFIER) return null
      const entry = await this.resolve('harper.js/slimBinary', importer, { skipSelf: true })
      if (!entry) throw new Error('harper.js is not installed; cannot locate its wasm binary')
      const wasm = join(dirname(entry.id.split('?')[0]), 'harper_wasm_slim_bg.wasm')
      return `${wasm}?url`
    }
  }
}
