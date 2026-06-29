// Excalidraw drawings are stored as standalone `.excalidraw` files (the native
// Excalidraw JSON scene format). They are a first-class file type alongside
// Markdown notes and `.base` databases: listed in the sidebar with their own
// icon, opened in a dedicated editor tab, and saved back as JSON.

import { decompressFromBase64 } from 'lz-string'

export const EXCALIDRAW_EXT = '.excalidraw'

export function isExcalidrawPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.toLowerCase().endsWith(EXCALIDRAW_EXT)
}

/** Display title for a drawing (filename without the `.excalidraw` extension). */
export function excalidrawTitleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.toLowerCase().endsWith(EXCALIDRAW_EXT)
    ? base.slice(0, -EXCALIDRAW_EXT.length)
    : base
}

/** The on-disk Excalidraw scene shape (a subset of the official format). */
export interface ExcalidrawDocument {
  type: 'excalidraw'
  version: number
  source: string
  elements: unknown[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

export function emptyExcalidrawDocument(): ExcalidrawDocument {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'zennotes',
    elements: [],
    appState: {},
    files: {}
  }
}

/** Parse on-disk JSON into a scene, falling back to an empty doc when invalid. */
export function parseExcalidrawDocument(raw: string): ExcalidrawDocument {
  try {
    const parsed = JSON.parse(raw) as Partial<ExcalidrawDocument>
    return {
      ...emptyExcalidrawDocument(),
      ...parsed,
      type: 'excalidraw',
      elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      appState:
        parsed.appState && typeof parsed.appState === 'object' ? parsed.appState : {},
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {}
    }
  } catch {
    return emptyExcalidrawDocument()
  }
}

// ---------------------------------------------------------------------------
// Obsidian Excalidraw import (#266)
//
// Obsidian's Excalidraw plugin stores drawings as Markdown files (typically
// `*.excalidraw.md`, sometimes a plain `.md` with an `excalidraw-plugin`
// frontmatter key). The scene lives in a `## Drawing` section inside a fenced
// code block — either plain ```json or LZString-compressed ```compressed-json,
// the exact codec the plugin uses (`LZString.compressToBase64`). ZenNotes can't
// render that directly, so we recover the embedded scene and convert it into a
// native `.excalidraw` document.

/** Obsidian's default Excalidraw drawing filename suffix. */
export const OBSIDIAN_EXCALIDRAW_SUFFIX = '.excalidraw.md'

/** True for an Obsidian Excalidraw drawing by filename (`*.excalidraw.md`). */
export function isObsidianExcalidrawPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.toLowerCase().endsWith(OBSIDIAN_EXCALIDRAW_SUFFIX)
}

/**
 * True if the markdown carries Obsidian's `excalidraw-plugin` frontmatter marker.
 * Covers drawings saved as a plain `.md` (not only `*.excalidraw.md`).
 */
export function isObsidianExcalidrawMarkdown(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatter) return false
  return /^excalidraw-plugin:\s*\S/m.test(frontmatter[1])
}

interface DrawingCodeBlock {
  lang: 'compressed-json' | 'json'
  body: string
}

/** Locate the embedded scene code block — the one under `## Drawing` when present. */
function findExcalidrawDrawingBlock(markdown: string): DrawingCodeBlock | null {
  const fenceRe = /```(compressed-json|json)[^\n]*\r?\n([\s\S]*?)```/g
  const drawingHeadingIndex = markdown.search(/^#{1,6}[ \t]+Drawing[ \t]*$/m)
  let fallback: DrawingCodeBlock | null = null
  let afterHeading: DrawingCodeBlock | null = null
  let match: RegExpExecArray | null
  while ((match = fenceRe.exec(markdown)) !== null) {
    const block: DrawingCodeBlock = {
      lang: match[1] as 'compressed-json' | 'json',
      body: match[2]
    }
    if (!fallback) fallback = block
    if (drawingHeadingIndex !== -1 && match.index > drawingHeadingIndex && !afterHeading) {
      afterHeading = block
    }
  }
  return afterHeading ?? fallback
}

/**
 * Parse an Obsidian Excalidraw markdown file into a native ExcalidrawDocument,
 * or null if no embedded scene could be recovered (not an Excalidraw file, or
 * malformed / undecodable data).
 */
export function extractObsidianExcalidrawScene(
  markdown: string | null | undefined
): ExcalidrawDocument | null {
  if (typeof markdown !== 'string' || markdown.length === 0) return null
  const block = findExcalidrawDrawingBlock(markdown)
  if (!block) return null

  let json: string | null
  if (block.lang === 'compressed-json') {
    // The base64 payload may be wrapped across lines for readability; whitespace
    // is not part of the data and must be stripped before decompression.
    const cleaned = block.body.replace(/\s+/g, '')
    json = cleaned ? decompressFromBase64(cleaned) : null
  } else {
    json = block.body.trim()
  }
  if (!json) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const scene = parsed as Record<string, unknown>
  // Guard against converting an unrelated code block that happens to be JSON.
  if (scene.type !== 'excalidraw' && !Array.isArray(scene.elements)) return null

  return parseExcalidrawDocument(json)
}
