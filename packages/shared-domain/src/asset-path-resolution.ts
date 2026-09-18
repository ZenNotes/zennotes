/**
 * Resolves an href or wikilink target to the vault-relative path of an existing
 * asset, given the asset list. Store-free on purpose: surfaces that already
 * hold the list (the Connections panel's outgoing links, the follow-link path)
 * resolve without a store round trip, and the rules are unit-tested without
 * booting the store. `resolveAssetVaultRelativePath` in local-assets.ts wraps
 * this with the live `assetFiles`. Lives in shared-domain so the desktop main
 * process (which cannot import the renderer bundle) resolves asset references
 * identically when it rewrites them after an asset rename (#785).
 *
 * Three readings, tried in order, each matching a way people write links:
 * 1. Relative to the note's folder, the Markdown link reading.
 * 2. Relative to the vault root, the wikilink reading. Obsidian resolves
 *    wikilinks from the root, so a pasted `![[assets/img.png]]` inside a note
 *    under `Daily Notes/` still finds `assets/img.png`, and this is more precise
 *    than the basename fallback when several files share a name. (#459)
 * 3. A unique basename anywhere in the vault, for links written by hand.
 */
export interface AssetPathRef {
  path: string
}

export function stripQueryAndHash(href: string): string {
  return href.split('#')[0]?.split('?')[0] ?? href
}

export function decodeHrefPath(value: string): string {
  const cleaned = stripQueryAndHash(value)
  try {
    return decodeURIComponent(cleaned)
  } catch {
    return cleaned
  }
}

export function posixJoin(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  if (a.endsWith('/')) return `${a}${b}`
  return `${a}/${b}`
}

export function posixNormalize(input: string): string {
  const parts = input.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return '..'
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

/** Which of the three readings resolved a reference. Lets a rewrite keep the
 *  author's style: a note-relative href stays relative, a vault-root path stays
 *  rooted, a bare file name stays bare (#785). */
export type AssetReferenceReading = 'note-relative' | 'vault-root' | 'basename'

export interface AssetReferenceResolution {
  /** Vault-relative path of the asset the reference points at. */
  path: string
  reading: AssetReferenceReading
  /** The reference was written with a leading `/` (vault-root, spelled out). */
  absolute: boolean
}

export function resolveAssetReference(
  assets: ReadonlyArray<AssetPathRef>,
  notePath: string,
  href: string
): AssetReferenceResolution | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const decodedHref = decodeHrefPath(trimmed)
  const isAbsolute = decodedHref.startsWith('/')
  let target = isAbsolute
    ? decodedHref.replace(/^\/+/, '')
    : noteDir
      ? posixJoin(noteDir, decodedHref)
      : decodedHref
  target = posixNormalize(target)
  if (target.startsWith('../') || target === '..') return null

  if (assets.some((asset) => asset.path === target)) {
    return {
      path: target,
      reading: isAbsolute || !noteDir ? 'vault-root' : 'note-relative',
      absolute: isAbsolute
    }
  }

  if (!isAbsolute && noteDir) {
    const rootTarget = posixNormalize(decodedHref)
    if (
      rootTarget &&
      rootTarget !== target &&
      !rootTarget.startsWith('../') &&
      rootTarget !== '..' &&
      assets.some((asset) => asset.path === rootTarget)
    ) {
      return { path: rootTarget, reading: 'vault-root', absolute: false }
    }
  }

  const targetBase = target.split('/').filter(Boolean).pop()?.toLowerCase()
  if (!targetBase) return null

  const basenameMatches = assets.filter((asset) => {
    const assetBase = asset.path.split('/').filter(Boolean).pop()?.toLowerCase()
    return assetBase === targetBase
  })
  if (basenameMatches.length === 1) {
    return { path: basenameMatches[0]!.path, reading: 'basename', absolute: false }
  }

  return null
}

export function resolveAssetPathAmong(
  assets: ReadonlyArray<AssetPathRef>,
  notePath: string,
  href: string
): string | null {
  return resolveAssetReference(assets, notePath, href)?.path ?? null
}
