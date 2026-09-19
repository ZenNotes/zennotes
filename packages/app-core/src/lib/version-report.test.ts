import { describe, expect, it } from 'vitest'
import type { ZenAppInfo } from '@bridge-contract/bridge'
import { buildVersionReport } from './version-report'

const DESKTOP: ZenAppInfo = {
  name: 'zennotes',
  productName: 'ZenNotes',
  version: '2.53.0',
  description: 'notes',
  homepage: 'https://zennotes.org',
  runtime: 'desktop',
  hostKind: 'desktop',
  arch: 'x64',
  os: 'Ubuntu 24.04.1 LTS (kernel 6.8.0-45-generic)',
  engine: 'Electron 38.1.0 (Chromium 140.0.7339.133, Node 22.19.0)',
  install: 'AppImage'
}

describe('buildVersionReport', () => {
  it('prints every line a desktop bug report needs, in a fixed order', () => {
    expect(buildVersionReport({ app: DESKTOP })).toEqual([
      'ZenNotes 2.53.0 (desktop)',
      'OS: Ubuntu 24.04.1 LTS (kernel 6.8.0-45-generic), x64',
      'Engine: Electron 38.1.0 (Chromium 140.0.7339.133, Node 22.19.0)',
      'Install: AppImage'
    ])
  })

  it('omits the lines a host could not fill in instead of printing unknowns', () => {
    const web: ZenAppInfo = {
      name: 'zennotes',
      productName: 'ZenNotes',
      version: '2.53.0',
      description: 'notes',
      homepage: 'https://zennotes.org',
      runtime: 'web',
      hostKind: 'browser',
      engine: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0'
    }
    expect(buildVersionReport({ app: web })).toEqual([
      'ZenNotes 2.53.0 (browser)',
      'Engine: Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0'
    ])
  })

  it('keeps the arch when the OS name is missing, and vice versa', () => {
    expect(buildVersionReport({ app: { ...DESKTOP, os: undefined } })[1]).toBe('OS: x64')
    expect(buildVersionReport({ app: { ...DESKTOP, arch: undefined } })[1]).toBe(
      'OS: Ubuntu 24.04.1 LTS (kernel 6.8.0-45-generic)'
    )
    expect(buildVersionReport({ app: { ...DESKTOP, os: undefined, arch: undefined } })).not.toContain(
      expect.stringMatching(/^OS:/)
    )
  })

  it('falls back to the legacy runtime when hostKind is absent', () => {
    expect(buildVersionReport({ app: { ...DESKTOP, hostKind: undefined } })[0]).toBe(
      'ZenNotes 2.53.0 (desktop)'
    )
  })

  it('adds the server line only for a remote workspace', () => {
    expect(buildVersionReport({ app: DESKTOP, remoteServer: null })).toHaveLength(4)
    expect(
      buildVersionReport({
        app: DESKTOP,
        remoteServer: { baseUrl: 'https://notes.example.com', version: '2.52.0' }
      }).at(-1)
    ).toBe('Workspace: remote, server 2.52.0 at https://notes.example.com')
    expect(
      buildVersionReport({ app: DESKTOP, remoteServer: { baseUrl: null, version: null } }).at(-1)
    ).toBe('Workspace: remote, server')
  })
})
