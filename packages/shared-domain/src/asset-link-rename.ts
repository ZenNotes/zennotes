/**
 * Rewriting references to an asset when the asset file is renamed or moved
 * (#785).
 *
 * Renaming a note already rewrites its inbound `[[wikilinks]]`; renaming or
 * moving an asset used to leave every `![[assets/old.png]]` pointing at a file
 * that no longer exists. This walks a note body for the ways an asset gets
 * referenced, `![[embed]]` / `[[link]]` wikilinks and `![](href)` / `[](href)`
 * markdown destinations, resolves each exactly the way the renderer does
 * (`resolveAssetReference`: relative to the note, then to the vault root, then
 * a unique basename) and re-targets the ones that pointed at the asset. The
 * new reference is written in the author's own style: a note-relative href
 * stays relative, a vault-root path stays rooted (with its leading `/` if it
 * had one), a bare file name stays bare while it is still unique in the vault
 * and otherwise becomes the full path; a wikilink never gains `..` segments,
 * it is bare or vault-root like the ones people type. Everything else about
 * the reference
 * survives: `|alias` and `|300` size hints, `#page=3` fragments, `?` queries,
 * percent-encoding, `<angle brackets>` around a spaced path, and link titles.
 * Code spans and fenced blocks are skipped.
 *
 * Pure and store-free so the desktop main process (which cannot import the
 * renderer bundle) and app-core share one implementation; the Go server
 * carries a port in `internal/vault/asset_link_rename.go`.
 */
import {
  resolveAssetReference,
  type AssetPathRef,
  type AssetReferenceResolution
} from './asset-path-resolution'

// Code first so references inside spans and fences are left untouched, then a
// wikilink, then a markdown destination. The destination is matched from its
// `](` rather than from the link's opening bracket so the href of an image
// nested inside a link (`[![alt](a.png)](a.png)`) is found as readily as the
// outer link's own.
const TOKEN_RE =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(!?)\[\[([^\]\n]+?)\]\]|\]\(\s*(<[^>\n]*>|[^)\n]+?)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?)\s*\)/g

export interface AssetLinkRewrite {
  body: string
  /** Number of references rewritten. */
  changed: number
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A `#fragment` or `?query` belongs to the reference, not to the file name. */
function splitSuffix(reference: string): { path: string; suffix: string } {
  const cut = reference.search(/[#?]/)
  if (cut < 0) return { path: reference, suffix: '' }
  return { path: reference.slice(0, cut), suffix: reference.slice(cut) }
}

/** POSIX path from directory `fromDir` ('' = vault root) to `toPath`. */
function relativeTo(fromDir: string, toPath: string): string {
  const from = fromDir.split('/').filter(Boolean)
  const to = toPath.split('/').filter(Boolean)
  let shared = 0
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++
  return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/')
}

/** Percent-encode `next` per segment when the author wrote `original` encoded. */
function encodeLike(original: string, next: string): string {
  let decoded = original
  try {
    decoded = decodeURIComponent(original)
  } catch {
    /* not percent-encoded; keep the raw name */
  }
  if (decoded === original) return next
  return next
    .split('/')
    .map((segment) => (segment === '..' || segment === '.' ? segment : encodeURIComponent(segment)))
    .join('/')
}

/**
 * Rewrite every reference in `body` that resolves to the asset at `oldPath`
 * so it points at `newPath` (both vault-relative POSIX paths; a rename changes
 * the name, a move the directory, and a move into a folder that already holds
 * the name changes both). `assets` must be the pre-change listing, so
 * references resolve to the asset under the path they currently use.
 * `notePath` is the note holding `body`, since a markdown href resolves
 * relative to it.
 */
export function rewriteAssetReferences(
  body: string,
  assets: ReadonlyArray<AssetPathRef>,
  notePath: string,
  oldPath: string,
  newPath: string
): AssetLinkRewrite {
  if (!newPath || oldPath === newPath) return { body, changed: 0 }
  if (!body.includes('[[') && !body.includes('](')) return { body, changed: 0 }

  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  // The listing as it reads after the change decides whether a bare file name
  // still names exactly one asset.
  const assetsAfter = assets.map((asset) => (asset.path === oldPath ? { path: newPath } : asset))
  const newBase = basenameOf(newPath)
  const newBaseLower = newBase.toLowerCase()
  const bareStillUnique =
    assetsAfter.filter((asset) => basenameOf(asset.path).toLowerCase() === newBaseLower).length === 1

  const resolveOld = (reference: string): AssetReferenceResolution | null => {
    const trimmed = reference.trim()
    const inner =
      trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed
    const resolution = resolveAssetReference(assets, notePath, inner)
    return resolution && resolution.path === oldPath ? resolution : null
  }

  // Wikilinks and hrefs differ in one place: a wikilink is written as a bare
  // name or a vault-root path (Obsidian resolves them from the root), never
  // with `..`, so a wikilink that happened to resolve next to its note stays
  // bare while unique and otherwise gets the full path. A markdown href is a
  // real relative path, so it follows the file with `..` where needed.
  const retarget = (
    reference: string,
    resolution: AssetReferenceResolution,
    kind: 'wikilink' | 'href'
  ): string => {
    const angled = reference.startsWith('<') && reference.endsWith('>')
    const inner = angled ? reference.slice(1, -1) : reference
    const { path, suffix } = splitSuffix(inner)
    const bare = !path.includes('/')
    let next: string
    if (resolution.reading === 'basename' || (kind === 'wikilink' && bare)) {
      next = bareStillUnique ? newBase : newPath
    } else if (resolution.reading === 'note-relative' && kind === 'href') {
      next = relativeTo(noteDir, newPath)
    } else {
      next = resolution.absolute ? `/${newPath}` : newPath
    }
    const out = `${encodeLike(path, next)}${suffix}`
    return angled ? `<${out}>` : out
  }

  let changed = 0
  const next = body.replace(
    TOKEN_RE,
    (
      full: string,
      code: string | undefined,
      embed: string | undefined,
      wikiContent: string | undefined,
      href: string | undefined,
      title: string | undefined
    ) => {
      if (code !== undefined) return full
      if (wikiContent !== undefined) {
        const pipe = wikiContent.indexOf('|')
        const target = pipe >= 0 ? wikiContent.slice(0, pipe) : wikiContent
        const rest = pipe >= 0 ? wikiContent.slice(pipe) : ''
        const resolution = resolveOld(target)
        if (!resolution) return full
        const next = `${embed ?? ''}[[${retarget(target, resolution, 'wikilink')}${rest}]]`
        // A bare name that still resolves after a move reads exactly as before.
        if (next !== full) changed++
        return next
      }
      if (href === undefined) return full
      const resolution = resolveOld(href)
      if (!resolution) return full
      const next = `](${retarget(href, resolution, 'href')}${title ?? ''})`
      if (next !== full) changed++
      return next
    }
  )
  return { body: next, changed }
}
