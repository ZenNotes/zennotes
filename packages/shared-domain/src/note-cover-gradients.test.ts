import { describe, expect, it } from 'vitest'
import { readNoteCover } from './note-cover'
import {
  NOTE_COVER_GRADIENTS,
  builtinGradientForAsset,
  gradientCoverDataUrl,
  gradientCoverSvg,
  readOnlyNoteCoverUrl
} from './note-cover-gradients'

const dusk = NOTE_COVER_GRADIENTS.find((gradient) => gradient.id === 'dusk')!

describe('builtinGradientForAsset', () => {
  it('knows a gradient by the file name the picker writes, in any folder', () => {
    expect(builtinGradientForAsset('assets/cover-gradient-dusk.svg')).toBe(dusk)
    expect(builtinGradientForAsset('attachements/Cover-Gradient-Dusk.SVG')).toBe(dusk)
    expect(builtinGradientForAsset('cover-gradient-dusk.svg?v=2')).toBe(dusk)
  })

  it('leaves every other file alone', () => {
    expect(builtinGradientForAsset('assets/cover-gradient-neon.svg')).toBeNull()
    expect(builtinGradientForAsset('assets/cover-gradient-dusk.png')).toBeNull()
    expect(builtinGradientForAsset('assets/my-cover-gradient-dusk.svg')).toBeNull()
  })
})

describe('readOnlyNoteCoverUrl', () => {
  const served = (href: string): string | null =>
    href === 'assets/lisbon.jpg' ? 'https://zennotes.org/s/x/assets/lisbon.jpg' : null

  it('uses the file the surface serves for a vault cover', () => {
    const cover = readNoteCover('---\nbanner: "![[assets/lisbon.jpg]]"\n---\n')
    expect(readOnlyNoteCoverUrl(cover, { resolveVault: served, remote: true })).toBe(
      'https://zennotes.org/s/x/assets/lisbon.jpg'
    )
  })

  it('redraws a built-in gradient the surface does not have, from the same SVG the vault holds', () => {
    const cover = readNoteCover('---\nbanner: "![[assets/cover-gradient-dusk.svg]]"\n---\n')
    const url = readOnlyNoteCoverUrl(cover, { resolveVault: () => null, remote: true })
    expect(url).toBe(gradientCoverDataUrl(dusk))
    expect(decodeURIComponent(url!.slice(url!.indexOf(',') + 1))).toBe(gradientCoverSvg(dusk))
  })

  it('loads a web cover only where the surface may go online', () => {
    const cover = readNoteCover('---\nbanner: https://example.com/a.jpg\n---\n')
    expect(readOnlyNoteCoverUrl(cover, { resolveVault: served, remote: true })).toBe('https://example.com/a.jpg')
    expect(readOnlyNoteCoverUrl(cover, { resolveVault: served, remote: false })).toBeNull()
  })

  it('draws nothing for a note without a cover or one the surface cannot find', () => {
    expect(readOnlyNoteCoverUrl(readNoteCover('# Plain\n'), { resolveVault: served, remote: true })).toBeNull()
    const missing = readNoteCover('---\nbanner: "![[assets/gone.png]]"\n---\n')
    expect(readOnlyNoteCoverUrl(missing, { resolveVault: served, remote: true })).toBeNull()
  })
})
