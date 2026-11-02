/**
 * Keeps an Obsidian vault's links pointing at the same notes once it sits in a
 * folder inside another vault.
 *
 * Most links need nothing: ZenNotes reads `[[Note]]`, `[[folder/Note]]`,
 * `![[image.png]]` and relative Markdown links the way Obsidian does, and a note
 * nobody had to change stays byte for byte what it was. A link is rewritten only
 * where the move would change what it means: a title now shared with a note
 * already in the vault, an image name two folders use, or a path written from
 * the old vault's root. A link to nothing stays as it is, since in Obsidian that
 * is a note waiting to be written.
 */

export interface ObsidianLinkIndex {
  /** Notes coming over, relative to the vault's top, with `.md`. */
  notes: string[]
  /** Other files, relative to the vault's top. */
  assets: string[]
  /** Paths already in the destination vault, relative to its root. */
  existingNotes: string[]
  existingAssets: string[]
  /** Where the import lands, from the destination vault's root. */
  vaultFolder: string
}

export interface PreparedLinkIndex extends ObsidianLinkIndex {
  noteSet: Map<string, string>
  assetSet: Map<string, string>
  notesByName: Map<string, string[]>
  assetsByName: Map<string, string[]>
  titleCounts: Map<string, number>
  assetNameCounts: Map<string, number>
  allNotePaths: string[]
}

const lower = (value: string): string => value.toLowerCase()
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const stripMd = (path: string): string => path.replace(/\.md$/i, '')
const dirName = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function addTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

export function prepareLinkIndex(index: ObsidianLinkIndex): PreparedLinkIndex {
  const noteSet = new Map<string, string>()
  const notesByName = new Map<string, string[]>()
  const titleCounts = new Map<string, number>()
  for (const note of index.notes) {
    noteSet.set(lower(note), note)
    const title = lower(stripMd(baseName(note)))
    addTo(notesByName, title, note)
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }
  for (const note of index.existingNotes) {
    const title = lower(stripMd(baseName(note)))
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }
  const assetSet = new Map<string, string>()
  const assetsByName = new Map<string, string[]>()
  const assetNameCounts = new Map<string, number>()
  for (const asset of index.assets) {
    assetSet.set(lower(asset), asset)
    const name = lower(baseName(asset))
    addTo(assetsByName, name, asset)
    assetNameCounts.set(name, (assetNameCounts.get(name) ?? 0) + 1)
  }
  for (const asset of index.existingAssets) {
    const name = lower(baseName(asset))
    assetNameCounts.set(name, (assetNameCounts.get(name) ?? 0) + 1)
  }
  return {
    ...index,
    noteSet,
    assetSet,
    notesByName,
    assetsByName,
    titleCounts,
    assetNameCounts,
    allNotePaths: [
      ...index.notes.map((note) => lower(`${index.vaultFolder}/${note}`)),
      ...index.existingNotes.map(lower)
    ]
  }
}

function normalizeRelative(from: string, target: string): string | null {
  const parts = from ? from.split('/') : []
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/')
}

/** Obsidian's choice among notes with one name: the same folder, then the
 *  shortest path, then the first alphabetically. */
function pickClosest(candidates: string[], fromDir: string): string {
  const same = candidates.find((candidate) => dirName(candidate) === fromDir)
  if (same) return same
  return [...candidates].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0]
}

function resolveNote(target: string, notePath: string, index: PreparedLinkIndex): string | null {
  const clean = stripMd(target.trim().replace(/^\.\//, ''))
  if (!clean) return null
  const fromDir = dirName(notePath)
  if (clean.startsWith('../') || target.trim().startsWith('./')) {
    const relative = normalizeRelative(fromDir, clean)
    return relative === null ? null : (index.noteSet.get(lower(`${relative}.md`)) ?? null)
  }
  if (clean.includes('/')) {
    const fromTop = index.noteSet.get(lower(`${clean.replace(/^\/+/, '')}.md`))
    if (fromTop) return fromTop
    const suffix = lower(`/${clean}.md`)
    const matches = index.notes.filter((note) => lower(`/${note}`).endsWith(suffix))
    return matches.length > 0 ? pickClosest(matches, fromDir) : null
  }
  const named = index.notesByName.get(lower(clean))
  return named ? pickClosest(named, fromDir) : null
}

function resolveAsset(target: string, notePath: string, index: PreparedLinkIndex): string | null {
  const clean = target.trim().replace(/^\.\//, '')
  if (!clean) return null
  const fromDir = dirName(notePath)
  const relative = normalizeRelative(fromDir, clean)
  if (relative !== null) {
    const hit = index.assetSet.get(lower(relative))
    if (hit) return hit
  }
  const fromTop = index.assetSet.get(lower(clean.replace(/^\/+/, '')))
  if (fromTop) return fromTop
  const named = index.assetsByName.get(lower(baseName(clean)))
  return named ? pickClosest(named, fromDir) : null
}

/** Whether a note link already lands on `note` once everything is in place. */
function noteLinkStillWorks(target: string, note: string, index: PreparedLinkIndex): boolean {
  const clean = stripMd(target.trim())
  if (clean.startsWith('.') || clean.startsWith('/')) return false
  if (!clean.includes('/')) {
    return lower(clean) === lower(stripMd(baseName(note))) && index.titleCounts.get(lower(clean)) === 1
  }
  const wanted = lower(`${index.vaultFolder}/${note}`)
  const suffix = lower(`/${clean}.md`)
  const matches = index.allNotePaths.filter((path) => `/${path}`.endsWith(suffix))
  return matches.length === 1 && matches[0] === wanted
}

function assetLinkStillWorks(target: string, asset: string, notePath: string, index: PreparedLinkIndex): boolean {
  const clean = target.trim().replace(/^\.\//, '')
  const relative = normalizeRelative(dirName(notePath), clean)
  if (relative !== null && lower(relative) === lower(asset)) return true
  return index.assetNameCounts.get(lower(baseName(clean))) === 1 && lower(baseName(clean)) === lower(baseName(asset))
}

/** Code blanked to spaces of the same length, so a match's offset is its offset
 *  in the note. `stripCodeContent` can't serve here: it shortens what it blanks. */
export function maskCodeKeepingOffsets(body: string): string {
  const lines = body.split('\n')
  let fence: { char: string; length: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const marker = /^[ \t>]*(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      const char = marker[1][0]
      if (!fence && (char === '~' || !marker[2].includes('`'))) {
        fence = { char, length: marker[1].length }
        lines[i] = ' '.repeat(line.length)
        continue
      }
      if (fence && char === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null
        lines[i] = ' '.repeat(line.length)
        continue
      }
    }
    if (fence) lines[i] = ' '.repeat(line.length)
  }
  return lines.join('\n').replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length))
}

export interface RewrittenNote {
  body: string
  /** Links changed so they keep their meaning. */
  rewritten: number
  /** Files this note embeds or links, whether or not the link had to change. */
  referencedAssets: string[]
  hasTasks: boolean
  dataviewBlocks: number
}

const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g
const MD_LINK = /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^()\s]+(?:\([^()\s]*\)[^()\s]*)*)((?:\s+"[^"\n]*")?)\)/g
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

function destination(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path
}

export function rewriteObsidianLinks(
  body: string,
  notePath: string,
  index: PreparedLinkIndex
): RewrittenNote {
  const masked = maskCodeKeepingOffsets(body)
  const edits: Array<{ from: number; to: number; text: string }> = []
  const referenced = new Set<string>()

  for (const match of masked.matchAll(WIKILINK)) {
    const [whole, bang, inner] = match
    const from = match.index
    // A table cell writes the alias separator as `\|`.
    const separator = inner.includes('\\|') ? '\\|' : '|'
    const pipe = inner.indexOf(separator)
    const targetFull = pipe < 0 ? inner : inner.slice(0, pipe)
    const alias = pipe < 0 ? null : inner.slice(pipe + separator.length)
    const anchorAt = targetFull.search(/[#^]/)
    const target = anchorAt < 0 ? targetFull : targetFull.slice(0, anchorAt)
    const anchor = anchorAt < 0 ? '' : targetFull.slice(anchorAt)
    if (!target.trim()) continue

    const note = resolveNote(target, notePath, index)
    if (note) {
      if (noteLinkStillWorks(target, note, index)) continue
      const shown = alias ?? targetFull.trim()
      edits.push({
        from,
        to: from + whole.length,
        text: `${bang}[[${index.vaultFolder}/${stripMd(note)}${anchor}${separator}${shown}]]`
      })
      continue
    }
    const asset = resolveAsset(target, notePath, index)
    if (asset) {
      referenced.add(asset)
      if (assetLinkStillWorks(target, asset, notePath, index)) continue
      const tail = alias === null ? '' : `${separator}${alias}`
      edits.push({ from, to: from + whole.length, text: `${bang}[[${index.vaultFolder}/${asset}${anchor}${tail}]]` })
    }
  }

  for (const match of masked.matchAll(MD_LINK)) {
    const [whole, bang, label, rawTarget, title] = match
    const from = match.index
    const bare = rawTarget.replace(/^<|>$/g, '')
    if (HAS_SCHEME.test(bare) || bare.startsWith('#')) continue
    const hashAt = bare.indexOf('#')
    const pathPart = hashAt < 0 ? bare : bare.slice(0, hashAt)
    const anchor = hashAt < 0 ? '' : bare.slice(hashAt)
    let decoded = pathPart
    try {
      decoded = decodeURIComponent(pathPart)
    } catch {
      // Written unencoded, with a stray percent sign.
    }
    if (!decoded) continue
    const fromDir = dirName(notePath)
    const relative = normalizeRelative(fromDir, decoded)
    const isNote = /\.md$/i.test(decoded)
    const relativeHit =
      relative !== null && (isNote ? index.noteSet.has(lower(relative)) : index.assetSet.has(lower(relative)))
    if (relativeHit) {
      if (!isNote) referenced.add(index.assetSet.get(lower(relative as string)) as string)
      continue
    }
    const resolved = isNote ? resolveNote(decoded, notePath, index) : resolveAsset(decoded, notePath, index)
    if (!resolved) continue
    if (!isNote) referenced.add(resolved)
    const moved = `${index.vaultFolder}/${resolved}${anchor}`
    edits.push({ from, to: from + whole.length, text: `${bang}[${label}](${destination(moved)}${title})` })
  }

  edits.sort((a, b) => b.from - a.from)
  let out = body
  for (const edit of edits) out = `${out.slice(0, edit.from)}${edit.text}${out.slice(edit.to)}`

  return {
    body: out,
    rewritten: edits.length,
    referencedAssets: [...referenced],
    hasTasks: /^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX/-]\]/m.test(masked),
    dataviewBlocks: (body.match(/^[ \t]*(`{3,}|~{3,})\s*dataview(?:js)?\b/gim) ?? []).length
  }
}
