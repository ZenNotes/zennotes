/**
 * Excalidraw lists its esm.sh CDN after EXCALIDRAW_ASSET_PATH in every font
 * face, and browsers check each listed source against the CSP when the face
 * is constructed: opening a drawing logged 230 `font-src` violations in the
 * browser app (cloud-in-browser-safari-report.md, failure C). Both browser
 * builds run Excalidraw's own chunk through `excalidrawFonts`, which must
 * leave no CDN behind.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'vitest'
import { excalidrawFonts } from '../../../vite.shared'

// The production build's copy (Node resolves the package to dist/dev).
const prodDir = join(
  dirname(createRequire(resolve(__dirname, '../../../package.json')).resolve('@excalidraw/excalidraw')),
  '..',
  'prod'
)
const chunkName = readdirSync(prodDir).find((name) => name.endsWith('.js') && readFileSync(join(prodDir, name), 'utf8').includes('ASSETS_FALLBACK_URL'))!
const chunkPath = join(prodDir, chunkName)
const chunk = readFileSync(chunkPath, 'utf8')

type TransformHook = (code: string, id: string) => { code: string } | null

function transform(plugin: ReturnType<typeof excalidrawFonts>, code: string): string {
  const hook = plugin.transform as unknown as TransformHook | undefined
  assert.ok(hook, 'excalidrawFonts rewrites the font fallback')
  const errors: string[] = []
  const result = hook.call({ error: (message: string) => errors.push(message) } as never, code, chunkPath)
  assert.deepEqual(errors, [])
  return result?.code ?? code
}

describe('Excalidraw’s font fallback in the browser builds', () => {
  it('points at the build’s own fonts, never esm.sh', () => {
    assert.match(chunk, /https:\/\/esm\.sh\//)
    const out = transform(excalidrawFonts('/tmp/out', '/vendor/cloud-web/releases/x/excalidraw-assets/'), chunk)
    assert.doesNotMatch(out, /esm\.sh/)
    assert.match(out, /EXCALIDRAW_ASSET_PATH/)
    assert.match(out, /\/vendor\/cloud-web\/releases\/x\/excalidraw-assets\//)
  })

  it('works out the same absolute base the page sets, as Excalidraw needs', () => {
    const out = transform(excalidrawFonts('/tmp/out'), chunk)
    const expression = out.slice(out.indexOf('"ASSETS_FALLBACK_URL",') + '"ASSETS_FALLBACK_URL",'.length)
    const fallback = expression.slice(0, expression.indexOf(');var '))
    const evaluate = (assetPath: string | undefined): string =>
      new Function('window', 'location', `return ${fallback}`)(
        assetPath === undefined ? {} : { EXCALIDRAW_ASSET_PATH: assetPath },
        { href: 'https://app.zennotes.org/try' }
      )
    assert.equal(evaluate('/sub/excalidraw-assets/'), 'https://app.zennotes.org/sub/excalidraw-assets/')
    assert.equal(evaluate('/sub/excalidraw-assets'), 'https://app.zennotes.org/sub/excalidraw-assets/')
    assert.equal(evaluate(undefined), 'https://app.zennotes.org/excalidraw-assets/')
  })

  it('fails the build when an Excalidraw upgrade reshapes the fallback', () => {
    const plugin = excalidrawFonts('/tmp/out')
    const hook = plugin.transform as unknown as TransformHook
    const errors: string[] = []
    hook.call({ error: (message: string) => errors.push(message) } as never, 'P(jn,"ASSETS_FALLBACK_URL","https://cdn.example/")', chunkPath)
    assert.equal(errors.length, 1)
  })
})
