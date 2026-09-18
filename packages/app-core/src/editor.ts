import { useSyncExternalStore } from 'react'
import { requestPaneMode } from './lib/pane-mode'
import type { EditorSelection, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { ImportedAsset, PastedImageInput, VaultInfo } from '@bridge-contract/ipc'
import { useStore } from './store'
import { formatImportedAssetsForInsertion } from './lib/editor-drops'
import { noteEditorMatches } from './lib/note-editor-context'
import { runNoteEditorCommand } from './lib/editor-commands'
import { installNoteEditorHost, requestNoteEditorReveal } from './lib/editor-host'

export interface EditorBounds {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
  readonly width: number
  readonly height: number
}

export interface EditorViewport {
  readonly editor: EditorBounds
  readonly scroll: EditorBounds
}

export interface EditorBottomInsets {
  /** Reserve physical space below the scroller, for native selection handles. */
  readonly layout?: number
  /** Additional clearance inside the remaining scroll viewport. */
  readonly scroll?: number
}

export interface EditorHostOptions {
  readonly nativeTyping?: boolean
  /** Read-only measurement callback. Return CSS pixels; do not change layout here. */
  readonly measureBottomInsets?: (viewport: EditorViewport) => EditorBottomInsets
}

export interface EditorHostRegistration {
  refresh(): void
  dispose(): void
}

/** Configure existing and future editors. The newest registration owns the configuration. */
export function installEditorHost(options: EditorHostOptions): EditorHostRegistration {
  return installNoteEditorHost(options)
}

/** Schedule a focused note's caret reveal after measuring host overlays. Never takes focus. */
export function revealEditorCaret(): boolean {
  const editor = currentNoteEditor()
  if (!editor || !editor.view.hasFocus) return false
  return requestNoteEditorReveal(editor.view, () => {
    const current = currentNoteEditor()
    return (
      current?.view === editor.view &&
      current.path === editor.path &&
      current.vault === editor.vault &&
      editor.view.hasFocus
    )
  })
}

/** Semantic toolbar actions. Hosts never receive the editor's command or view objects. */
export type EditorCommand =
  | 'undo'
  | 'redo'
  | 'open-search'
  | 'close-search'
  | 'toggle-bold'
  | 'toggle-italic'
  | 'toggle-strikethrough'
  | 'toggle-highlight'
  | 'toggle-inline-code'
  | 'set-bullet-list'
  | 'set-task-list'
  | 'cycle-heading'
  | 'insert-link'
  | 'insert-wikilink'
  | 'insert-tag'
  | 'indent'
  | 'outdent'

function currentNoteEditor(): { view: EditorView; path: string; vault: VaultInfo } | null {
  const {
    editorViewRef: view,
    selectedPath: path,
    vault,
    activeNote,
    activePaneId
  } = useStore.getState()
  if (
    !view ||
    !vault ||
    !path ||
    path.startsWith('zen://') ||
    !view.dom.isConnected ||
    activeNote?.path !== path ||
    !noteEditorMatches(view, path, activePaneId)
  )
    return null
  return { view, path, vault }
}

/** Run immediately against the active note. False means unavailable or not handled. */
export function runEditorCommand(command: EditorCommand): boolean {
  const editor = currentNoteEditor()
  return editor ? runNoteEditorCommand(editor.view, command) : false
}

/** Inspect text selections, including in read-only notes, without exposing them. */
export function hasEditorSelection(): boolean {
  const editor = currentNoteEditor()
  return editor ? editor.view.state.selection.ranges.some((range) => !range.empty) : false
}

/** Bind these operations to one host vault before opening a picker or reading a clipboard. */
export interface EditorAssetImporter {
  /** Check the host's actual vault identity, even while renderer state is catching up. */
  isCurrent(): boolean
  importFile(notePath: string, file: File): Promise<ImportedAsset>
  importPastedImage(input: PastedImageInput): Promise<ImportedAsset>
}

declare const insertionTarget: unique symbol
/** Opaque, single-use context. It contains no public editor or filesystem state. */
export interface EditorInsertionTarget {
  readonly [insertionTarget]: true
}

export type EditorInsertionResult =
  | { status: 'inserted' | 'stale' | 'saved-only' | 'empty'; assets: readonly ImportedAsset[] }
  | { status: 'failed'; assets: readonly ImportedAsset[]; error: string }

interface InsertionContext {
  view: EditorView
  path: string
  vault: VaultInfo
  document: Text
  selection: EditorSelection
  importer: EditorAssetImporter
  started: boolean
}
const insertions = new WeakMap<EditorInsertionTarget, InsertionContext>()

function hostIsCurrent(importer: EditorAssetImporter): boolean {
  try {
    return importer.isCurrent()
  } catch {
    return false
  }
}

/** Capture before asynchronous host work. Losing focus to a picker is allowed. */
export function captureEditorInsertion(
  importer: EditorAssetImporter,
  options: { requireFocus?: boolean } = {}
): EditorInsertionTarget | null {
  const editor = currentNoteEditor()
  if (!editor) return null
  const { view, path, vault } = editor
  if (view.state.readOnly || (options.requireFocus && !view.hasFocus) || !hostIsCurrent(importer))
    return null
  const target = Object.freeze({}) as EditorInsertionTarget
  insertions.set(target, {
    view,
    path,
    vault,
    document: view.state.doc,
    selection: view.state.selection,
    importer,
    started: false
  })
  return target
}

/** Invalidate insertion on dismissal/disposal. An in-flight host save cannot be undone. */
export function cancelEditorInsertion(target: EditorInsertionTarget): void {
  insertions.delete(target)
}

function isCurrent(target: EditorInsertionTarget, context: InsertionContext): boolean {
  const state = useStore.getState()
  const { view } = context
  return (
    insertions.get(target) === context &&
    state.vault === context.vault &&
    state.selectedPath === context.path &&
    state.activeNote?.path === context.path &&
    state.editorViewRef === view &&
    view.dom.isConnected &&
    noteEditorMatches(view, context.path, state.activePaneId) &&
    !view.state.readOnly &&
    view.state.doc === context.document &&
    view.state.selection.eq(context.selection) &&
    hostIsCurrent(context.importer)
  )
}

function staleResult(assets: ImportedAsset[]): EditorInsertionResult {
  return { status: assets.length ? 'saved-only' : 'stale', assets }
}

async function importAndInsert<T>(
  target: EditorInsertionTarget,
  inputs: readonly T[],
  save: (context: InsertionContext, input: T) => Promise<ImportedAsset>,
  replaceSelection: boolean
): Promise<EditorInsertionResult> {
  const context = insertions.get(target)
  if (!context || context.started) return { status: 'stale', assets: [] }
  context.started = true
  const assets: ImportedAsset[] = []
  try {
    if (!isCurrent(target, context)) return staleResult(assets)
    if (inputs.length === 0) return { status: 'empty', assets }
    for (const input of inputs) {
      if (!isCurrent(target, context)) return staleResult(assets)
      assets.push(await save(context, input))
      if (!isCurrent(target, context)) return staleResult(assets)
    }
    const { view, document, selection } = context
    const from = replaceSelection ? selection.main.from : selection.main.head
    const to = replaceSelection ? selection.main.to : from
    const before = from > 0 ? document.sliceString(from - 1, from) : ''
    const after = document.sliceString(to, to + 1)
    const insert = formatImportedAssetsForInsertion(assets, before, after)
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
    view.focus()
    return { status: 'inserted', assets }
  } catch (error) {
    return {
      status: 'failed',
      assets,
      error: error instanceof Error ? error.message : 'Could not import the attachment.'
    }
  } finally {
    insertions.delete(target)
  }
}

/** Import files serially and insert at the captured cursor only if its context still matches. */
export function attachFiles(
  target: EditorInsertionTarget,
  files: readonly File[]
): Promise<EditorInsertionResult> {
  return importAndInsert(
    target,
    [...files],
    (context, file) => context.importer.importFile(context.path, file),
    false
  )
}

/** Replace the captured selection after an asynchronous clipboard read. */
export function insertPastedImage(
  target: EditorInsertionTarget,
  input: PastedImageInput
): Promise<EditorInsertionResult> {
  return importAndInsert(
    target,
    [input],
    (context, image) => context.importer.importPastedImage(image),
    true
  )
}

export type EditorMode = 'edit' | 'preview' | 'split'
export interface EditorPresentation {
  readonly path: string | null
  readonly hasOpenNote: boolean
  readonly mode: EditorMode
}
let presentation: EditorPresentation | undefined
export function getEditorPresentation(): EditorPresentation {
  const state = useStore.getState()
  const path = state.selectedPath
  const sticky = state.paneStickyModes[state.activePaneId]
  const mode = state.keepViewModeAcrossNotes && sticky ? sticky
    : (path ? state.paneModes[state.activePaneId]?.[path] : undefined) ?? state.defaultPaneMode
  const hasOpenNote = !!path && state.activeNote?.path === path
  if (!presentation || presentation.path !== path || presentation.mode !== mode || presentation.hasOpenNote !== hasOpenNote)
    presentation = Object.freeze({ path, mode, hasOpenNote })
  return presentation
}
export function subscribeEditorPresentation(listener: () => void): () => void {
  let previous = getEditorPresentation()
  return useStore.subscribe(() => {
    const next = getEditorPresentation()
    if (next === previous) return
    previous = next; listener()
  })
}
export function useEditorPresentation(): EditorPresentation {
  return useSyncExternalStore(subscribeEditorPresentation, getEditorPresentation, getEditorPresentation)
}
export function setEditorMode(mode: EditorMode): void { requestPaneMode(mode) }
