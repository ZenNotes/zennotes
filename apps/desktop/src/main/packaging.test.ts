import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { PACKAGED_CLI_RUNTIME_PACKAGES } from '../../electron.vite.config'
import desktopPackage from '../../package.json'

const require = createRequire(import.meta.url)

interface ExtraResource {
  from: string
  to: string
  filter?: string[]
}

describe('desktop packaging', () => {
  it('uses Electron and electron-builder releases with the current security fixes', () => {
    expect(desktopPackage.devDependencies.electron).toBe('41.10.7')
    expect(desktopPackage.build.electronVersion).toBe('41.10.7')
    expect(desktopPackage.devDependencies['electron-builder']).toBe('26.15.7')
  })

  it('applies the merged upstream cycle guard to electron-builder dependency collection', () => {
    // 26.15.7 includes the AppImage security fixes, but its new module
    // collector can recurse until OOM on cyclic package graphs. This is the
    // exact guard merged upstream in electron-builder#10070; remove the patch
    // after the first v26 release containing that change.
    const collector = readFileSync(
      require.resolve('app-builder-lib/out/node-module-collector/nodeModulesCollector.js'),
      'utf8'
    )
    expect(collector).toContain('if (child !== node)')
    expect(collector).toContain('if (ancestors.has(d))')
  })

  it('ships the CLI chunks beside the unpacked CLI launcher', () => {
    const resources = desktopPackage.build.extraResources as ExtraResource[]

    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'out/main/cli.js', to: 'cli.js' }),
        expect.objectContaining({ from: 'out/main/chunks', to: 'chunks' })
      ])
    )
  })

  it('bundles CLI-only package dependencies instead of resolving them from Resources', () => {
    expect(PACKAGED_CLI_RUNTIME_PACKAGES).toContain('@modelcontextprotocol/sdk')
  })

  // #524: shipped as an external in 2.20.2, so `zn` died on its first line with
  // `Cannot find module 'smol-toml'` for everyone. Resources/ has no
  // node_modules, so this list is the only thing keeping the CLI runnable. The
  // check that it is COMPLETE cannot live here, it needs the build output:
  // tooling/scripts/verify-packaged-cli.mjs runs the built CLI with nothing to
  // resolve from, and the desktop build gates on it.
  it('bundles the TOML parser the CLI reads config.toml with', () => {
    expect(PACKAGED_CLI_RUNTIME_PACKAGES).toContain('smol-toml')
  })

  it('ships the Raycast extension source without vendored dependencies', () => {
    const resources = desktopPackage.build.extraResources as ExtraResource[]
    const raycastResource = resources.find((resource) => resource.to === 'raycast/zennotes')

    expect(raycastResource).toMatchObject({
      from: '../../integrations/raycast',
      to: 'raycast/zennotes'
    })
    expect(raycastResource?.filter).toEqual(
      expect.arrayContaining(['package.json', 'package-lock.json', 'src/**', '!node_modules/**'])
    )
  })
})
