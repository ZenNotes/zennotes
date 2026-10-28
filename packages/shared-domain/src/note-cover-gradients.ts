// The gradient covers ZenNotes ships, and how a read-only surface (the public
// share page, Quick Look) turns a note's cover into an image URL.
//
// A gradient cover lands in the vault as an ordinary SVG file,
// `cover-gradient-<id>.svg`, so every tool shows it. A published note cannot
// carry that file: the share service refuses SVG uploads on purpose (a served
// SVG can run script). The file name names the gradient, though, and this
// spec travels with the share viewer, so the viewer draws the same picture
// from it and the publisher leaves the file out instead of refusing the note.
import type { NoteCover } from './note-cover'

export interface NoteCoverGradient {
  id: string
  title: string
  from: string
  to: string
  /** Soft light from one corner, so a two-stop gradient has some depth. */
  glow: string
}

export const NOTE_COVER_GRADIENTS: readonly NoteCoverGradient[] = [
  { id: 'dawn', title: 'Dawn', from: '#f6d365', to: '#fda085', glow: '#fff8e7' },
  { id: 'dusk', title: 'Dusk', from: '#2b5876', to: '#4e4376', glow: '#c9b6ff' },
  { id: 'lagoon', title: 'Lagoon', from: '#43cea2', to: '#185a9d', glow: '#e0fff4' },
  { id: 'moss', title: 'Moss', from: '#134e5e', to: '#71b280', glow: '#e9ffd9' },
  { id: 'ember', title: 'Ember', from: '#e96443', to: '#904e95', glow: '#ffd7c2' },
  { id: 'lilac', title: 'Lilac', from: '#a18cd1', to: '#fbc2eb', glow: '#ffffff' },
  { id: 'sand', title: 'Sand', from: '#f3e7d3', to: '#c8a27a', glow: '#ffffff' },
  { id: 'slate', title: 'Slate', from: '#232526', to: '#53585d', glow: '#9fb3c8' }
]

/** The file name a gradient lands under in the vault; a second pick reuses it. */
export function gradientCoverFileName(gradient: Pick<NoteCoverGradient, 'id'>): string {
  return `cover-gradient-${gradient.id}.svg`
}

/** A gradient cover as a standalone SVG file. `preserveAspectRatio="none"`
 *  lets it stretch to any banner shape, which a gradient can afford. */
export function gradientCoverSvg(gradient: NoteCoverGradient): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="480" viewBox="0 0 1600 480" preserveAspectRatio="none">',
    '<defs>',
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${gradient.from}"/><stop offset="1" stop-color="${gradient.to}"/></linearGradient>`,
    `<radialGradient id="l" cx="0.85" cy="0" r="0.9"><stop offset="0" stop-color="${gradient.glow}" stop-opacity="0.35"/><stop offset="1" stop-color="${gradient.glow}" stop-opacity="0"/></radialGradient>`,
    '</defs>',
    '<rect width="1600" height="480" fill="url(#g)"/>',
    '<rect width="1600" height="480" fill="url(#l)"/>',
    '</svg>',
    ''
  ].join('')
}

export function gradientCoverDataUrl(gradient: NoteCoverGradient): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(gradientCoverSvg(gradient))}`
}

/** The file name a vault reference ends in, the way a built-in cover is
 *  known by it: wherever the assets folder lives, lower-cased, decoded, and
 *  without a query or fragment. */
export function builtinCoverFileKey(ref: string): string {
  const path = ref.split(/[?#]/, 1)[0] ?? ref
  let name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  try {
    name = decodeURIComponent(name)
  } catch {
    // Keep the name as written.
  }
  return name
}

/** The built-in gradient a vault reference names by its file name, wherever
 *  the assets folder lives, or null for any other file. */
export function builtinGradientForAsset(ref: string): NoteCoverGradient | null {
  const name = builtinCoverFileKey(ref)
  return NOTE_COVER_GRADIENTS.find((gradient) => gradientCoverFileName(gradient) === name) ?? null
}

export interface ReadOnlyCoverOptions {
  /** The URL a vault image is served from on this surface, or null when the
   *  surface does not have it. */
  resolveVault: (href: string) => string | null
  /** Whether the surface may load an https cover: Quick Look has no network. */
  remote: boolean
}

/**
 * The image a read-only surface draws for a note's cover, or null to draw no
 * cover at all. Unlike the app, which says "Cover image not found" so the
 * author can fix it, a reader has nothing to act on, so a cover the surface
 * cannot show simply is not there.
 */
export function readOnlyNoteCoverUrl(cover: NoteCover | null, options: ReadOnlyCoverOptions): string | null {
  if (!cover) return null
  if (cover.target.kind === 'url') return options.remote ? cover.target.url : null
  const served = options.resolveVault(cover.target.href)
  if (served) return served
  const gradient = builtinGradientForAsset(cover.target.href)
  return gradient ? gradientCoverDataUrl(gradient) : null
}
