import { describe, expect, it } from 'vitest'
import { PACKAGED_CLI_RUNTIME_PACKAGES } from '../../electron.vite.config'
import desktopPackage from '../../package.json'

interface ExtraResource {
  from: string
  to: string
  filter?: string[]
}

describe('desktop packaging', () => {
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

  it('ships the ZenNotes CLI skill source', () => {
    const resources = desktopPackage.build.extraResources as ExtraResource[]

    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: '../../integrations/skills/zennotes-cli',
          to: 'skills/zennotes-cli',
          filter: ['SKILL.md']
        })
      ])
    )
  })
})
