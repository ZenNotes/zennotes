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

interface GradientSpec {
  id: string
  title: string
  from: string
  to: string
  /** Soft light from one corner, so a two-stop gradient has some depth. */
  glow: string
}

const GRADIENTS: GradientSpec[] = [
  { id: 'dawn', title: 'Dawn', from: '#f6d365', to: '#fda085', glow: '#fff8e7' },
  { id: 'dusk', title: 'Dusk', from: '#2b5876', to: '#4e4376', glow: '#c9b6ff' },
  { id: 'lagoon', title: 'Lagoon', from: '#43cea2', to: '#185a9d', glow: '#e0fff4' },
  { id: 'moss', title: 'Moss', from: '#134e5e', to: '#71b280', glow: '#e9ffd9' },
  { id: 'ember', title: 'Ember', from: '#e96443', to: '#904e95', glow: '#ffd7c2' },
  { id: 'lilac', title: 'Lilac', from: '#a18cd1', to: '#fbc2eb', glow: '#ffffff' },
  { id: 'sand', title: 'Sand', from: '#f3e7d3', to: '#c8a27a', glow: '#ffffff' },
  { id: 'slate', title: 'Slate', from: '#232526', to: '#53585d', glow: '#9fb3c8' }
]

/** A gradient cover as a standalone SVG file. `preserveAspectRatio="none"`
 *  lets it stretch to any banner shape, which a gradient can afford. */
export function gradientCoverSvg(spec: GradientSpec): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="480" viewBox="0 0 1600 480" preserveAspectRatio="none">',
    '<defs>',
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${spec.from}"/><stop offset="1" stop-color="${spec.to}"/></linearGradient>`,
    `<radialGradient id="l" cx="0.85" cy="0" r="0.9"><stop offset="0" stop-color="${spec.glow}" stop-opacity="0.35"/><stop offset="1" stop-color="${spec.glow}" stop-opacity="0"/></radialGradient>`,
    '</defs>',
    '<rect width="1600" height="480" fill="url(#g)"/>',
    '<rect width="1600" height="480" fill="url(#l)"/>',
    '</svg>',
    ''
  ].join('')
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
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

export const GRADIENT_COVERS: BuiltinCover[] = GRADIENTS.map((spec) => {
  const svg = gradientCoverSvg(spec)
  return {
    id: `gradient-${spec.id}`,
    title: spec.title,
    fileName: `cover-gradient-${spec.id}.svg`,
    mimeType: 'image/svg+xml',
    thumbUrl: svgDataUrl(svg),
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
