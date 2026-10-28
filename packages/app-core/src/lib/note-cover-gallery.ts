/**
 * The covers ZenNotes ships with: gradients drawn as SVG and a handful of
 * public-domain photographs (The Met's Open Access works are CC0, NASA's are
 * public domain). Picking one copies it into the vault's `assets/` folder,
 * so the note's `banner` is an ordinary vault image that every other tool, a
 * remote workspace and Cloud sync already understand. Nothing in a note ever
 * names a built-in cover, which is why there is no `gradient:` value.
 *
 * The full photographs load on demand as inlined data (a dynamic import per
 * photo, so a pick costs one chunk). Fetching the bundled file would be the
 * obvious route, but on the packaged desktop app the renderer runs from
 * `file://`, whose CSP refuses that fetch; the inline chunk works on every
 * host without a privileged scheme. The grid shows small thumbnails only.
 */
import blueMarbleThumb from '../assets/covers/thumbs/blue-marble.webp'
import earthriseThumb from '../assets/covers/thumbs/earthrise.webp'
import greatWaveThumb from '../assets/covers/thumbs/great-wave.webp'
import oxbowThumb from '../assets/covers/thumbs/oxbow.webp'
import rockyMountainsThumb from '../assets/covers/thumbs/rocky-mountains.webp'
import wheatFieldThumb from '../assets/covers/thumbs/wheat-field.webp'
import {
  NOTE_COVER_GRADIENTS,
  builtinCoverFileKey,
  gradientCoverDataUrl,
  gradientCoverFileName,
  gradientCoverSvg
} from '@shared/note-cover-gradients'

export interface BuiltinCover {
  id: string
  title: string
  /** Shown under the tile and as its tooltip. */
  credit?: string
  /** The file name it lands under in the vault; a second pick reuses it. */
  fileName: string
  mimeType: string
  /** Shown in the picker's grid. */
  thumbUrl: string
  /** Focal point the picture reads best at. */
  y: number
  bytes: () => Promise<Uint8Array>
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  if (!meta.endsWith(';base64')) return new TextEncoder().encode(decodeURIComponent(payload))
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// The specs live in shared-domain: the share viewer redraws a published
// gradient cover from them (see note-cover-gradients.ts).
export const GRADIENT_COVERS: BuiltinCover[] = NOTE_COVER_GRADIENTS.map((spec) => {
  const svg = gradientCoverSvg(spec)
  return {
    id: `gradient-${spec.id}`,
    title: spec.title,
    fileName: gradientCoverFileName(spec),
    mimeType: 'image/svg+xml',
    thumbUrl: gradientCoverDataUrl(spec),
    y: 0.5,
    bytes: async () => new TextEncoder().encode(svg)
  }
})

function photo(
  id: string,
  title: string,
  credit: string,
  thumbUrl: string,
  y: number,
  load: () => Promise<{ default: string }>
): BuiltinCover {
  return {
    id,
    title,
    credit,
    fileName: `cover-${id}.webp`,
    mimeType: 'image/webp',
    thumbUrl,
    y,
    bytes: async () => dataUrlBytes((await load()).default)
  }
}

export const PHOTO_COVERS: BuiltinCover[] = [
  photo(
    'great-wave',
    'The Great Wave',
    'Katsushika Hokusai, ca. 1830-32. The Met, CC0',
    greatWaveThumb,
    0.45,
    () => import('../assets/covers/great-wave.webp?inline')
  ),
  photo(
    'wheat-field',
    'Wheat Field with Cypresses',
    'Vincent van Gogh, 1889. The Met, CC0',
    wheatFieldThumb,
    0.4,
    () => import('../assets/covers/wheat-field.webp?inline')
  ),
  photo(
    'rocky-mountains',
    "The Rocky Mountains, Lander's Peak",
    'Albert Bierstadt, 1863. The Met, CC0',
    rockyMountainsThumb,
    0.4,
    () => import('../assets/covers/rocky-mountains.webp?inline')
  ),
  photo(
    'oxbow',
    'The Oxbow',
    'Thomas Cole, 1836. The Met, CC0',
    oxbowThumb,
    0.5,
    () => import('../assets/covers/oxbow.webp?inline')
  ),
  photo(
    'earthrise',
    'Earthrise',
    'Apollo 8, 1968. NASA, public domain',
    earthriseThumb,
    0.5,
    () => import('../assets/covers/earthrise.webp?inline')
  ),
  photo(
    'blue-marble',
    'The Blue Marble',
    'Apollo 17, 1972. NASA, public domain',
    blueMarbleThumb,
    0.5,
    () => import('../assets/covers/blue-marble.webp?inline')
  )
]

/** The built-in cover a vault reference names by the file name a pick wrote,
 *  in whichever folder it landed, or null for any other image. */
export function builtinCoverForAsset(ref: string): BuiltinCover | null {
  const name = builtinCoverFileKey(ref)
  return [...GRADIENT_COVERS, ...PHOTO_COVERS].find((cover) => cover.fileName === name) ?? null
}
