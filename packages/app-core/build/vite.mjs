import { createReadStream, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'

const require = createRequire(import.meta.url)
const harperWasm = 'harper.js/dist/harper_wasm_slim_bg.wasm?url'
const onigWasm = 'vscode-oniguruma/release/onig.wasm?url'

/** @type {typeof import('./vite').zenNotesAssets} */
export function zenNotesAssets(options = {}) {
  const onigVirtual = '\0zennotes-core:oniguruma'
  const harperVirtual = '\0zennotes-core:harper-disabled'
  const assets = {
    name: 'zennotes-core-assets',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (id === onigWasm) return onigVirtual
      if (options.harper === false && (id === 'harper.js' || id === harperWasm)) return harperVirtual
      if (id !== harperWasm) return null
      const entry = await this.resolve('harper.js/slimBinary', importer, { skipSelf: true })
      if (!entry) throw new Error('Cannot locate the installed Harper binary')
      return join(dirname(entry.id.split('?')[0]), 'harper_wasm_slim_bg.wasm') + '?url'
    },
    load(id) {
      if (id === harperVirtual) return 'export default ""'
      if (id !== onigVirtual) return null
      const bytes = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'))
      return `export default ${JSON.stringify(`data:application/wasm;base64,${bytes.toString('base64')}`)}`
    }
  }
  if (options.excalidraw === false) return [assets]

  const fonts = join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts')
  let base = '/'
  return [assets, {
    name: 'zennotes-core-drawing-fonts',
    configResolved(config) { base = config.base },
    configureServer(server) {
      const prefix = `${base === './' || base === '' ? '/' : base}excalidraw-assets/fonts/`
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        if (!path?.startsWith(prefix)) return next()
        let file
        try { file = resolve(fonts, decodeURIComponent(path.slice(prefix.length))) }
        catch { res.statusCode = 400; res.end(); return }
        if (!file.startsWith(fonts + sep) || !/\.(woff2?|otf|ttf)$/i.test(file)) {
          res.statusCode = 404; res.end(); return
        }
        const mime = file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.woff') ? 'font/woff' : file.endsWith('.otf') ? 'font/otf' : 'font/ttf'
        res.setHeader('Content-Type', mime)
        createReadStream(file).on('error', () => { res.statusCode = 404; res.end() }).pipe(res)
      })
    },
    generateBundle() {
      const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = join(directory, entry.name)
          if (entry.isDirectory()) walk(file)
          else if (entry.isFile() && /\.(woff2?|otf|ttf)$/i.test(file)) {
            this.emitFile({ type: 'asset', fileName: `excalidraw-assets/fonts/${relative(fonts, file).split(sep).join('/')}`, source: readFileSync(file) })
          }
        }
      }
      walk(fonts)
    }
  }]
}
