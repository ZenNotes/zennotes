/**
 * WYSIWYG rendering for Obsidian-style `[[wikilinks]]`: hide the `[[ ]]`
 * brackets (and the `target|` part of an aliased link), show the label as a
 * clickable accent link, and navigate to the note on click. The raw `[[...]]`
 * source is revealed on whichever wikilink the cursor is in — matching how the
 * rest of live preview reveals the active token.
 *
 * Image/transclusion embeds (`![[...]]`) are left to the existing embed
 * handling and skipped here.
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateEffect } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { useStore } from '../store'
import { isSameFileBlockLink, isSameFileHeadingLink, resolveWikilinkTarget } from './wikilinks'
import { openDatabaseFromWikilink, openWikilinkTarget } from './wikilink-navigation'
import { createNoteFromLinkNow, offerCreateNoteFromLink } from './create-note-from-link'
import { openWikilinkAttachment } from './open-wikilink-attachment'
import { resolveAssetPathAmong } from './asset-path-resolution'
import { listDatabaseLinkTargets, resolveDatabaseWikilink } from './database-links'
import { setHoveredLink } from './hovered-link'

// Same shape as the Preview pipeline (remarkWikilinks).
const WIKILINK_RE = /(!?)\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g
const hide = Decoration.replace({})
// Quiet edit markers for the revealed `[[ ]]` / `|` when the cursor is in the
// wikilink (overrides the orange link highlight so brackets read as markers).
const bracketMark = Decoration.mark({ class: 'cm-wikilink-bracket' })

/** Dispatched when vault state a link's fate depends on changes (a note was
 *  created, the asset list arrived), so the decorations recompute without
 *  waiting for the next edit or scroll. */
const refreshWikilinksEffect = StateEffect.define<null>()

/**
 * Whether a wikilink target reaches something: a note, a spot in this note, a
 * `.base` database, or a file in the vault. Anything else would create a note
 * when followed, and is drawn as unresolved (#768). Mirrors the reading view's
 * `broken` decision in Preview.tsx.
 *
 * Decorations rebuild on every selection change, and note resolution scans
 * the whole notes list, so answers are memoized until any input changes.
 */
interface ResolverCache {
  notes: unknown
  folders: unknown
  vaultSettings: unknown
  assetFiles: unknown
  selectedPath: string | null
  databases: ReturnType<typeof listDatabaseLinkTargets>
  memo: Map<string, boolean>
}
let resolverCache: ResolverCache | null = null

function wikilinkResolves(target: string): boolean {
  const s = useStore.getState()
  // A surface that mounts the editor with a partial store (tests, the
  // standalone windows) has no vault lists to check against. A link there is
  // drawn live rather than crashing the plugin, which would disable every
  // wikilink decoration at once.
  const notes = Array.isArray(s.notes) ? s.notes : []
  const folders = Array.isArray(s.folders) ? s.folders : []
  const assetFiles = Array.isArray(s.assetFiles) ? s.assetFiles : []
  const selectedPath = s.selectedPath ?? null
  if (
    !resolverCache ||
    resolverCache.notes !== notes ||
    resolverCache.folders !== folders ||
    resolverCache.vaultSettings !== s.vaultSettings ||
    resolverCache.assetFiles !== assetFiles ||
    resolverCache.selectedPath !== selectedPath
  ) {
    let databases: ReturnType<typeof listDatabaseLinkTargets> = []
    try {
      databases = listDatabaseLinkTargets(folders, s.vaultSettings)
    } catch {
      databases = []
    }
    resolverCache = {
      notes,
      folders,
      vaultSettings: s.vaultSettings,
      assetFiles,
      selectedPath,
      databases,
      memo: new Map()
    }
  }
  const cached = resolverCache.memo.get(target)
  if (cached != null) return cached
  let resolves = true
  try {
    resolves =
      resolveWikilinkTarget(notes, target) != null ||
      isSameFileHeadingLink(target) ||
      isSameFileBlockLink(target) ||
      resolveDatabaseWikilink(resolverCache.databases, target) != null ||
      resolveAssetPathAmong(assetFiles, selectedPath ?? '', target) != null
  } catch {
    resolves = true
  }
  resolverCache.memo.set(target, resolves)
  return resolves
}

/**
 * True when `pos` sits inside a code span or code block — there `[[...]]` is
 * literal text, not a link, so it should render as code (matching the Preview
 * pipeline, whose remark transform never visits code nodes). (#248)
 */
function isInsideCode(state: EditorView['state'], pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    const n = node.name
    if (n === 'FencedCode' || n === 'CodeBlock' || n === 'InlineCode') return true
    if (!node.parent) break
    node = node.parent
  }
  return false
}

function selectionTouches(
  state: EditorView['state'],
  from: number,
  to: number
): boolean {
  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (range.from >= from && range.from <= to) return true
    } else if (Math.max(range.from, from) < Math.min(range.to, to)) {
      return true
    }
  }
  return false
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const pending: Array<{ from: number; to: number; deco: Decoration }> = []

  for (const { from, to } of view.visibleRanges) {
    const firstLine = state.doc.lineAt(from).number
    const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      if (!line.text.includes('[[')) continue
      WIKILINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = WIKILINK_RE.exec(line.text)) !== null) {
        if (m[1] === '!') continue // embed — handled elsewhere
        const target = m[2].trim()
        if (!target) continue
        const matchStart = line.from + m.index
        const matchEnd = matchStart + m[0].length
        // `[[...]]` inside a code span/block is literal code — leave it raw. (#248)
        if (isInsideCode(state, matchStart + 2)) continue
        const hasAlias = m[3] != null
        const labelStart = hasAlias
          ? matchStart + 2 + m[2].length + 1 // after `[[target|`
          : matchStart + 2 // after `[[`
        const labelEnd = matchEnd - 2 // before `]]`
        if (labelEnd <= labelStart) continue
        // Cursor inside this wikilink → reveal the raw `[[...]]`, but mute the
        // brackets / pipe so they read as quiet edit markers.
        if (selectionTouches(state, matchStart, matchEnd)) {
          pending.push({ from: matchStart, to: matchStart + 2, deco: bracketMark })
          if (hasAlias) {
            pending.push({ from: labelStart - 1, to: labelStart, deco: bracketMark })
          }
          pending.push({ from: matchEnd - 2, to: matchEnd, deco: bracketMark })
          continue
        }
        pending.push({ from: matchStart, to: labelStart, deco: hide })
        pending.push({
          from: labelStart,
          to: labelEnd,
          deco: Decoration.mark({
            class: wikilinkResolves(target) ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-broken',
            attributes: { 'data-target': target }
          })
        })
        pending.push({ from: labelEnd, to: matchEnd, deco: hide })
      }
    }
  }

  pending.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const p of pending) builder.add(p.from, p.to, p.deco)
  return builder.finish()
}

const wikilinkRenderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    unsubscribe: (() => void) | null = null
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
      // A link's resolved/unresolved look depends on vault state that moves
      // under the editor: the notes list arriving after mount, a note created
      // from the link itself, the asset list. Recompute when any of it changes.
      this.unsubscribe = useStore.subscribe((state, prev) => {
        if (
          state.notes !== prev.notes ||
          state.assetFiles !== prev.assetFiles ||
          state.folders !== prev.folders ||
          state.vaultSettings !== prev.vaultSettings ||
          state.selectedPath !== prev.selectedPath
        ) {
          view.dispatch({ effects: refreshWikilinksEffect.of(null) })
        }
      })
    }
    update(update: ViewUpdate): void {
      const refreshed = update.transactions.some((tr) =>
        tr.effects.some((effect) => effect.is(refreshWikilinksEffect))
      )
      if (refreshed || update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
    destroy(): void {
      this.unsubscribe?.()
      this.unsubscribe = null
    }
  },
  { decorations: (p) => p.decorations }
)

/**
 * Open the note a wikilink points to, scrolling to its `#heading` when the
 * target carries one (`[[Doc#Heading]]`). (#196) A dead link asks before
 * creating the note, unless `createWithoutAsking` (a modifier click) says the
 * suggested path is fine as it is (#768).
 */
function openWikilink(target: string, options: { createWithoutAsking?: boolean } = {}): void {
  const state = useStore.getState()
  const focusEditorSoon = (): void => {
    useStore.getState().setFocusedPanel('editor')
    requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
  }

  const resolved = resolveWikilinkTarget(state.notes, target)
  if (!resolved) {
    // `[[#heading]]` / `[[^block]]` (no note part) point within the note being
    // edited, so scroll there instead of hunting for a note by name. (#291, #601)
    if ((isSameFileHeadingLink(target) || isSameFileBlockLink(target)) && state.selectedPath) {
      void openWikilinkTarget(state.selectedPath, target).then(focusEditorSoon)
      return
    }
    // Not a note — maybe a `.base` database; otherwise offer to create the note
    // (with confirmation) so a link to a not-yet-existing note isn't a dead end.
    if (openDatabaseFromWikilink(target)) return
    // A file in the vault (an embedded image, a PDF) opens in its own tab. (#757)
    if (openWikilinkAttachment(target)) return
    if (options.createWithoutAsking) void createNoteFromLinkNow(target)
    else void offerCreateNoteFromLink(target)
    return
  }

  void openWikilinkTarget(resolved.path, target).then(focusEditorSoon)
}

// Click a rendered wikilink to jump. Intercept on mousedown so CodeMirror
// doesn't first drop the caret into the (hidden) source. With Cmd (macOS) or
// Ctrl held, a link at a note that does not exist yet creates it at once at
// the suggested path instead of asking (#768).
const wikilinkClick = EditorView.domEventHandlers({
  mousedown: (event) => {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('.cm-wikilink')
    const target = el?.dataset.target
    if (!target) return false
    event.preventDefault()
    // Following the link ends its status-bar hover; a tap never sends the
    // mouseleave that would (#820).
    setHoveredLink(null)
    openWikilink(target, {
      createWithoutAsking: event.button === 0 && (event.metaKey || event.ctrlKey)
    })
    return true
  }
})

export const wikilinkRenderExtension = [wikilinkRenderPlugin, wikilinkClick]
