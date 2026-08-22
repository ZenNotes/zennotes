/**
 * Obsidian-style transclusion (#hisky YouTube request): `![[Note]]` embeds the
 * target note's rendered content inline, so a "master file" can pull in sub-notes
 * and export to PDF as one document.
 *
 * The markdown pipeline (`renderMarkdown`) is a synchronous singleton, and note
 * bodies load asynchronously — so we expand embeds into a flat markdown string
 * *before* rendering. Each embed is wrapped in a `<div class="note-embed">`; with
 * blank lines around it, CommonMark parses the inner markdown normally and
 * `rehypeRaw` keeps the wrapper (the same trick callouts rely on). Image embeds
 * (`![[pic.png]]`) resolve to no note and are left untouched for the image
 * pipeline.
 */

import { extractBlock } from './block-anchors'
import { wikilinkBlockAnchor } from './wikilinks'

export interface ExpandEmbedsCtx {
  /** Resolve an embed target (text inside `![[…]]`) to a note, or null when it
   *  isn't a note (image/unknown) — those are left as-is. */
  resolve: (target: string, fromPath: string) => { path: string; title: string } | null
  /** Load a note's raw markdown body by path (null if unreadable). */
  loadNote: (path: string) => Promise<string | null>
  /** Max embed nesting before we stop and show a notice. Default 6. */
  maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 6
const EMBED_RE = /!\[\[([^\]\n]+?)\]\]/g

/** Character ranges of fenced + inline code, so we never expand `![[…]]` there. */
function codeRanges(md: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  // Fenced code blocks (``` or ~~~), including indistinct fences.
  const fence = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*|$)/gm
  for (const m of md.matchAll(fence)) ranges.push([m.index!, m.index! + m[0].length])
  // Inline code spans (`…`), skipping ones already inside a fence.
  const inline = /`+[^`\n]*`+/g
  for (const m of md.matchAll(inline)) {
    const at = m.index!
    if (!ranges.some(([s, e]) => at >= s && at < e)) ranges.push([at, at + m[0].length])
  }
  return ranges
}

function inCode(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => index >= s && index < e)
}

/** Drop a leading YAML/TOML frontmatter block so it isn't embedded as text. */
function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?\s*---\n[\s\S]*?\n---\n?/, '').replace(/^﻿?\s*\+\+\+\n[\s\S]*?\n\+\+\+\n?/, '')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Wrap embedded content in a styled block with a link back to the source note. */
function wrapEmbed(target: string, title: string, inner: string): string {
  const label = title || target
  return (
    `\n\n<div class="note-embed" data-embed-src="${escapeAttr(target)}">\n\n` +
    `<div class="note-embed-title">\n\n[[${target}|${label}]]\n\n</div>\n\n` +
    `${inner.trim()}\n\n</div>\n\n`
  )
}

/** A non-recursing placeholder for cycles / too-deep / missing targets. */
function notice(
  target: string,
  kind: 'circular' | 'too-deep' | 'missing' | 'missing-block'
): string {
  const msg =
    kind === 'circular'
      ? `⚠ Circular embed skipped`
      : kind === 'too-deep'
        ? `⚠ Embed nesting too deep — stopped here`
        : kind === 'missing-block'
          ? `⚠ Embedded block not found`
          : `⚠ Embedded note not found`
  return `\n\n<div class="note-embed note-embed-notice" data-embed-src="${escapeAttr(target)}">\n\n*${msg}: [[${target}]]*\n\n</div>\n\n`
}

async function expand(
  md: string,
  fromPath: string,
  ctx: ExpandEmbedsCtx,
  stack: string[],
  depth: number
): Promise<string> {
  const maxDepth = ctx.maxDepth ?? DEFAULT_MAX_DEPTH
  const ranges = codeRanges(md)
  const matches = [...md.matchAll(EMBED_RE)].filter((m) => !inCode(m.index!, ranges))
  if (matches.length === 0) return md

  let out = ''
  let last = 0
  for (const m of matches) {
    out += md.slice(last, m.index)
    last = m.index! + m[0].length
    const target = (m[1].split('|', 1)[0] ?? '').trim() // strip any |label
    const note = target ? ctx.resolve(target, fromPath) : null
    if (!note) {
      out += m[0] // not a note (image/unknown) — leave the original syntax
      continue
    }
    if (stack.includes(note.path)) {
      out += notice(target, 'circular')
      continue
    }
    if (depth >= maxDepth) {
      out += notice(target, 'too-deep')
      continue
    }
    const body = await ctx.loadNote(note.path)
    if (body == null) {
      out += notice(target, 'missing')
      continue
    }
    // `![[Note^id]]` embeds just the block that id marks, not the whole
    // note. (#601)
    const blockId = wikilinkBlockAnchor(target)
    let source = stripFrontmatter(body)
    if (blockId) {
      const block = extractBlock(body, blockId)
      if (block == null) {
        out += notice(target, 'missing-block')
        continue
      }
      source = block
    }
    const inner = await expand(source, note.path, ctx, [...stack, note.path], depth + 1)
    out += wrapEmbed(target, blockId ? `${note.title || target} > ${blockId}` : note.title, inner)
  }
  out += md.slice(last)
  return out
}

/** Returns true when a note's markdown contains at least one note-embed. Cheap
 *  pre-check so callers can skip the async work entirely for the common case. */
export function hasNoteEmbeds(markdown: string, resolve: ExpandEmbedsCtx['resolve'], fromPath: string): boolean {
  if (!markdown.includes('![[')) return false
  const ranges = codeRanges(markdown)
  return [...markdown.matchAll(EMBED_RE)].some((m) => {
    if (inCode(m.index!, ranges)) return false
    const target = (m[1].split('|', 1)[0] ?? '').trim()
    return !!target && !!resolve(target, fromPath)
  })
}

/** Expand every `![[Note]]` note-embed in `markdown` into inline content,
 *  recursively, with cycle + depth guards. Non-note targets are left untouched. */
export async function expandEmbeds(
  markdown: string,
  sourcePath: string,
  ctx: ExpandEmbedsCtx
): Promise<string> {
  return expand(markdown, sourcePath, ctx, [sourcePath], 0)
}
