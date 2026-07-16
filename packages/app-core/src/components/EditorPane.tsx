/**
 * Single pane of the editor split view. Each leaf in the pane-layout
 * tree renders an `EditorPane` — owning its own CodeMirror view, tab
 * strip, breadcrumb + toolbar, preview surface, and drag-drop zones.
 *
 * The store keeps per-path note content (`noteContents`) shared across
 * all panes, so the same note open in two panes stays in sync on edit.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  tooltips
} from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import type { AssetMeta, ImportedAsset, NoteComment, NoteFolder } from '@shared/ipc'
import {
  history,
  historyKeymap,
  indentWithTab,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  undo
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { isImeComposing } from '../lib/ime'
import { resolveCodeLanguage } from '../lib/cm-code-languages'
import { markdownListIndentPlugin } from '../lib/cm-markdown-list-indent'
import { forwardOnCheckboxArrow } from '../lib/cm-forward-task'
import { completionNavKeymap } from '../lib/cm-completion-nav'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap } from '../lib/cm-vim-default-keymap'
import { toCodeMirrorKey, vimHalfPageKeymap } from '../lib/vim-half-page-keymap'
import { scrollOff } from '../lib/cm-scrolloff'
import { offerCreateNoteFromLink } from '../lib/create-note-from-link'
import {
  setYankToClipboardEnabled,
  setPasteFromClipboardEnabled,
  vimClipboardPasteExtension,
} from '../lib/cm-vim-clipboard'
import { wireYankHighlight, yankHighlightExtension } from '../lib/cm-yank-highlight'
import { frontmatterStyle } from '../lib/cm-frontmatter'
import { codeBlockFontPlugin } from '../lib/cm-code-block-font'
import {
  orderedListRenumber,
  skipOrderedListRenumber
} from '../lib/cm-ordered-list-renumber'
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from '@codemirror/language'
import { headingFolding } from '../lib/cm-heading-fold'
import { tags as t } from '@lezer/highlight'
import { searchKeymap } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { useStore } from '../store'
import type { LineNumberMode } from '../store'
import type { PaneEdge, PaneLeaf } from '../lib/pane-layout'
import { findLeaf, inferPaneDropEdge } from '../lib/pane-layout'
import { livePreviewPlugin } from '../lib/cm-live-preview'
import { codeBlockFlairPlugin } from '../lib/cm-code-block-flair'
import { tablePlugin, tableVimEntry } from '../lib/cm-table'
import { wysiwygBlocksPlugin } from '../lib/cm-wysiwyg-blocks'
import { hashtagExtension } from '../lib/cm-hashtags'
import { applyHighlight, HIGHLIGHT_COLORS, highlightExtension } from '../lib/cm-highlight'
import { wikilinkRenderExtension } from '../lib/cm-wikilink-render'
import { mathRenderExtension } from '../lib/cm-math-render'
import { mathBlockArrowKeymap } from '../lib/cm-math-nav'
import { slashCommandSource, slashCommandRender } from '../lib/cm-slash-commands'
import { calloutTypeSource } from '../lib/cm-callouts'
import { dateShortcutSource } from '../lib/cm-date-shortcuts'
import { wikilinkSource, wikilinkHeadingSource, atNoteSource } from '../lib/cm-wikilinks'
import { resolveWikilinkTarget, wikilinkHeadingAnchor } from '../lib/wikilinks'
import { openDatabaseFromWikilink, openWikilinkHeading } from '../lib/wikilink-navigation'
import {
  externalLinkUrl,
  extractLinkAtCursor,
  markdownLinkAt,
  resolveInternalNoteHref
} from '../lib/internal-links'
import { setBlockType, toggleWrap, wrapLink } from '../lib/cm-format'
import { EditorSelectionToolbar } from './EditorSelectionToolbar'
import { appMarkdownSnippetExtension } from '../lib/markdown-snippets-config'
import { LazyDiagramTabView, LazyPreview as Preview } from './LazyPreview'
import { ConnectionsPanel } from './ConnectionsPanel'
import { OutlinePanel } from './OutlinePanel'
import { CalendarPanel } from './CalendarPanel'
import { CommentsPanel, type CommentDraft } from './CommentsPanel'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { promptApp } from '../lib/prompt-requests'
import { TasksView } from './TasksView'
import { DatabaseView } from './DatabaseView'
import { LazyExcalidrawView } from './LazyExcalidrawView'
import { ObsidianExcalidrawPrompt } from './ObsidianExcalidrawPrompt'
import { HomeView } from './HomeView'
import {
  isExcalidrawPath,
  isObsidianExcalidrawMarkdown,
  isObsidianExcalidrawPath
} from '@shared/excalidraw'
import { TagView } from './TagView'
import { HelpView } from './HelpView'
import { ArchiveView } from './ArchiveView'
import { TrashView } from './TrashView'
import { AssetsView } from './AssetsView'
import { QuickNotesView } from './QuickNotesView'
import { isTasksTabPath } from '@shared/tasks'
import { isDatabaseTabPath, databaseTitleFromTab, databaseTabPath, isDatabaseCsvPath } from '@shared/databases'
import { isTagsTabPath } from '@shared/tags'
import { isHelpTabPath } from '@shared/help'
import { isArchiveTabPath } from '@shared/archive'
import { isTrashTabPath } from '@shared/trash'
import { isAssetsViewTabPath } from '@shared/assets-view'
import { isQuickNotesTabPath } from '@shared/quick-notes'
import {
  hasZenAssetItem,
  hasZenItem,
  readDragPayload,
  setDragPayload,
  type DragPayload
} from '../lib/dnd'
import {
  getImageBlockDropPlacement,
  hasImageBlockDragPayload,
  moveImageBlockInEditor,
  readImageBlockDragPayload
} from '../lib/image-block-dnd'
import { useSettledMarkdown } from '../lib/use-rendered-markdown'
import {
  isEditorReadyForContent,
  shouldDeferEditorHydration,
  type EditorHydrationState
} from '../lib/editor-hydration'
import { recordRendererPerf } from '../lib/perf'
import {
  rememberTabScroll,
  recallTabScroll,
  type TabScrollPosition
} from '../lib/tab-scroll-memory'
import { parseOutline } from '../lib/outline'
import {
  findRenderedHeadingForOutlineLine,
  nextOutlinePreviewSyncLockUntil,
  outlineHeadingTextOffset,
  previewScrollTopForHeading,
  scrollTopForElementRelativeTop,
  scrollTopForScrollRatio,
  shouldSyncPreviewFromEditorViewport
} from '../lib/preview-outline-jump'
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CalendarIcon,
  CheckSquareIcon,
  CloseIcon,
  PaperclipIcon,
  DocumentIcon,
  FileDownIcon,
  FeedbackIcon,
  HighlighterIcon,
  ListTreeIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PinIcon,
  TagIcon,
  TrashIcon,
  ZapIcon
} from './icons'
import { focusEditorNormalMode } from '../lib/editor-focus'
import {
  getSystemFolderLabel,
  resolveSystemFolderLabels
} from '../lib/system-folder-labels'
import {
  classifyDateNote,
  isPrimaryNotesAtRoot,
  noteFolderSubpath,
  normalizeVaultSettings
} from '../lib/vault-layout'
import {
  dragHasAttachmentFile,
  droppedPathsFromTransfer,
  formatImportedAssetsForInsertion,
  hasDroppedFiles,
  importedAssetForExistingVaultAsset
} from '../lib/editor-drops'
import {
  pastedImageFilesFromClipboard,
  pastedImageInputFromFile
} from '../lib/editor-paste-images'
import {
  paneModeForPath,
  ZEN_SET_PANE_MODE_EVENT,
  type PaneMode,
  type PaneModesByPath
} from '../lib/pane-mode'
import { resolveCommentAnchor, selectionToCommentAnchor } from '../lib/comments'
import { ZEN_OPEN_EDITOR_CONTEXT_MENU_EVENT } from '../lib/keyboard-context-menu'
import {
  assetPathFromTab,
  assetTitleFromPath,
  isAssetTabPath
} from '../lib/asset-tabs'
import {
  diagramFromTabPath,
  diagramTitleFromTabPath,
  isDiagramTabPath
} from '../lib/diagram-tabs'
import { classifyLocalAssetHref } from '../lib/local-assets'
import {
  formatKeyToken,
  getKeymapBinding,
  getKeymapDisplay,
  type KeymapId,
  type KeymapOverrides
} from '../lib/keymaps'
import { isTabStripOverflowing } from '../lib/tab-strip-overflow'

const MODE_OPTIONS: Array<{
  mode: PaneMode
  label: string
  tooltipLabel: string
  keymapId: KeymapId
}> = [
  { mode: 'edit', label: 'Edit', tooltipLabel: 'Editor mode', keymapId: 'global.modeEdit' },
  { mode: 'split', label: 'Split', tooltipLabel: 'Split mode', keymapId: 'global.modeSplit' },
  {
    mode: 'preview',
    label: 'Preview',
    tooltipLabel: 'Preview mode',
    keymapId: 'global.modePreview'
  }
]

const LARGE_DOC_LIVE_PREVIEW_DEFER_CHARS = 120_000
const LARGE_DOC_LIVE_PREVIEW_DEFER_MS = 3_000
const LARGE_DOC_EDITOR_HYDRATE_DELAY_MS = 180

// The editor keymap depends on Vim mode: in Vim mode the macOS emacs-style
// chords are stripped from `defaultKeymap` so Vim's `<C-d>` & co. work (see
// cm-vim-default-keymap). Built behind a compartment and reconfigured on Vim
// toggle or keymap-override changes.
function buildEditorKeymap(vimMode: boolean, overrides: KeymapOverrides): Extension {
  return keymap.of([
    {
      key: 'Mod-f',
      run: () => {
        const state = useStore.getState()
        if (state.vimMode) return false
        state.setSearchOpen(true)
        return true
      }
    },
    // Move the current line (or selection) up/down — reorders the markdown so
    // it persists in the file. Listed before defaultKeymap so the configured
    // binding wins; works in Vim normal/insert and non-Vim alike.
    {
      key: toCodeMirrorKey(getKeymapBinding(overrides, 'editor.moveLineUp')),
      run: moveLineUp
    },
    {
      key: toCodeMirrorKey(getKeymapBinding(overrides, 'editor.moveLineDown')),
      run: moveLineDown
    },
    ...vimHalfPageKeymap(vimMode, overrides),
    // Step arrows into rendered $$…$$ blocks (insert mode + non-Vim); Vim's
    // j/k get the same treatment inside the display-line motion.
    ...mathBlockArrowKeymap,
    indentWithTab,
    ...vimAwareDefaultKeymap(vimMode),
    ...historyKeymap,
    ...searchKeymap,
    ...completionKeymap
  ])
}

function markdownEditingExtensions(): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage, addKeymap: false }),
    vimAwareMarkdownKeymap,
    markdownListIndentPlugin,
    frontmatterStyle,
    orderedListRenumber,
    forwardOnCheckboxArrow,
    headingFolding(),
    codeBlockFontPlugin
  ]
}

function markdownSyntaxHighlightExtensions(): Extension[] {
  return [
    syntaxHighlighting(paperHighlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true })
  ]
}

/**
 * Live-preview ("WYSIWYG") rendering bundle: the base marker-hiding/inline
 * plugin plus block-level renderers — tables, blockquote bars, list
 * bullets, horizontal rules, fenced-code cards, hashtag chips, and
 * wikilink rendering. Loaded by the livePreview compartment (gated by the
 * `livePreview` setting); cleared to `[]` when off.
 *
 * Ported from the WYSIWYG work in PR #185 (author: songgnqing). That PR's
 * frontmatter-properties panel is intentionally excluded — it depends on
 * the PR's breaking database restructure.
 */
function wysiwygExtensions(renderTables: boolean): Extension[] {
  return [
    livePreviewPlugin,
    codeBlockFlairPlugin,
    // Table widgets are gated on a setting — off keeps tables as plain editable
    // markdown for full keyboard/Vim editing (#232).
    ...(renderTables ? [tablePlugin, tableVimEntry] : []),
    wysiwygBlocksPlugin,
    ...hashtagExtension,
    ...highlightExtension,
    ...wikilinkRenderExtension,
    mathRenderExtension
  ]
}

const paperHighlight = HighlightStyle.define([
  // Markdown-level tokens
  { tag: t.heading1, class: 'tok-heading1' },
  { tag: t.heading2, class: 'tok-heading2' },
  { tag: t.heading3, class: 'tok-heading3' },
  { tag: t.heading4, class: 'tok-heading4' },
  { tag: t.heading5, class: 'tok-heading5' },
  { tag: t.heading6, class: 'tok-heading6' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.strikethrough, class: 'tok-strikethrough' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.monospace, class: 'tok-monospace' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: t.list, class: 'tok-list' },
  { tag: t.meta, class: 'tok-meta' },
  // Code-syntax tokens (JS/TS/Python/Go/…) inside fenced blocks.
  // Keep this roster broad so minority grammars (Python module/builtin
  // keywords, Go package names, Rust lifetimes) don't fall back to an
  // unstyled default.
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.controlKeyword, class: 'tok-keyword' },
  { tag: t.definitionKeyword, class: 'tok-keyword' },
  { tag: t.moduleKeyword, class: 'tok-keyword' },
  { tag: t.modifier, class: 'tok-keyword' },
  { tag: t.operatorKeyword, class: 'tok-keyword' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.special(t.string), class: 'tok-string' },
  { tag: t.regexp, class: 'tok-string' },
  { tag: t.character, class: 'tok-string' },
  { tag: t.escape, class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.lineComment, class: 'tok-comment' },
  { tag: t.blockComment, class: 'tok-comment' },
  { tag: t.docComment, class: 'tok-comment' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.integer, class: 'tok-number' },
  { tag: t.float, class: 'tok-number' },
  { tag: t.bool, class: 'tok-atom' },
  { tag: t.atom, class: 'tok-atom' },
  { tag: t.null, class: 'tok-atom' },
  { tag: t.self, class: 'tok-atom' },
  { tag: t.special(t.variableName), class: 'tok-atom' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.logicOperator, class: 'tok-operator' },
  { tag: t.arithmeticOperator, class: 'tok-operator' },
  { tag: t.bitwiseOperator, class: 'tok-operator' },
  { tag: t.compareOperator, class: 'tok-operator' },
  { tag: t.updateOperator, class: 'tok-operator' },
  { tag: t.definitionOperator, class: 'tok-operator' },
  { tag: t.typeOperator, class: 'tok-operator' },
  { tag: t.controlOperator, class: 'tok-keyword' },
  { tag: t.typeName, class: 'tok-type' },
  { tag: t.className, class: 'tok-type' },
  { tag: t.namespace, class: 'tok-type' },
  { tag: t.standard(t.variableName), class: 'tok-type' },
  { tag: t.function(t.variableName), class: 'tok-function' },
  { tag: t.function(t.definition(t.variableName)), class: 'tok-function' },
  { tag: t.function(t.propertyName), class: 'tok-function' },
  { tag: t.definition(t.variableName), class: 'tok-variable-def' },
  { tag: t.definition(t.propertyName), class: 'tok-variable-def' },
  { tag: t.variableName, class: 'tok-variable' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.labelName, class: 'tok-label' },
  { tag: t.punctuation, class: 'tok-punct' },
  { tag: t.separator, class: 'tok-punct' },
  { tag: t.bracket, class: 'tok-bracket' },
  { tag: t.paren, class: 'tok-bracket' },
  { tag: t.brace, class: 'tok-bracket' },
  { tag: t.squareBracket, class: 'tok-bracket' },
  { tag: t.angleBracket, class: 'tok-bracket' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: t.attributeName, class: 'tok-attr' },
  { tag: t.attributeValue, class: 'tok-string' },
  { tag: t.annotation, class: 'tok-meta-code' },
  { tag: t.processingInstruction, class: 'tok-meta-code' },
  { tag: t.invalid, class: 'tok-invalid' }
])

/** Annotation marking programmatic doc replacements (external sync / note
 *  switch) so the update listener skips the save schedule. */
const programmatic = Annotation.define<boolean>()
const OUTLINE_JUMP_TOP_MARGIN = 24
const OUTLINE_JUMP_SCROLL_SYNC_LOCK_MS = 450
const OUTLINE_JUMP_SCROLL_SYNC_SETTLE_MS = 120
const TASK_JUMP_HIGHLIGHT_MS = 1400
const EMPTY_COMMENTS: NoteComment[] = []
const taskJumpHighlightEffect = StateEffect.define<number | null>()
const taskJumpHighlightDecoration = Decoration.line({ class: 'cm-task-jump-highlight' })
const commentDecorationEffect = StateEffect.define<{
  comments: NoteComment[]
  activeId: string | null
}>()

function buildCommentDecorations(
  comments: NoteComment[],
  activeId: string | null,
  doc: string
): DecorationSet {
  const lineMarkerCounts = new Map<number, number>()
  const decoratedLines = new Set<number>()
  const ranges = comments
    .filter((comment) => comment.resolvedAt == null)
    .flatMap((comment) => {
      const anchor = resolveCommentAnchor(comment, doc)
      if (anchor.to <= anchor.from) return []
      const active = activeId === comment.id
      const lineFrom = doc.lastIndexOf('\n', Math.max(0, anchor.from - 1)) + 1
      const nextNewline = doc.indexOf('\n', lineFrom)
      const lineEnd = nextNewline === -1 ? doc.length : nextNewline
      const markerIndex = lineMarkerCounts.get(lineFrom) ?? 0
      lineMarkerCounts.set(lineFrom, markerIndex + 1)
      const ranges = [
        Decoration.widget({
          widget: new CommentMarkerWidget(comment.id, active, markerIndex),
          side: 1
        }).range(lineEnd)
      ]
      if (!decoratedLines.has(lineFrom)) {
        decoratedLines.add(lineFrom)
        ranges.unshift(Decoration.line({ class: 'cm-comment-line' }).range(lineFrom))
      }
      if (active) {
        ranges.unshift(
          Decoration.mark({ class: 'cm-comment-anchor-active', inclusiveStart: true }).range(anchor.from, anchor.to)
        )
      }
      return ranges
    })
  return Decoration.set(ranges, true)
}

class CommentMarkerWidget extends WidgetType {
  constructor(
    private readonly commentId: string,
    private readonly active: boolean,
    private readonly markerIndex: number
  ) {
    super()
  }

  eq(other: CommentMarkerWidget): boolean {
    return (
      other.commentId === this.commentId &&
      other.active === this.active &&
      other.markerIndex === this.markerIndex
    )
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-comment-marker-wrap'
    wrap.style.setProperty('--z-comment-marker-offset', `${this.markerIndex * 26}px`)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = this.active
      ? 'cm-comment-marker cm-comment-marker-active'
      : 'cm-comment-marker'
    button.dataset.commentId = this.commentId
    button.title = 'Open comment'
    button.tabIndex = -1
    button.setAttribute('aria-label', 'Open comment')

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('width', '14')
    icon.setAttribute('height', '14')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.8')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z')
    icon.appendChild(path)
    button.appendChild(icon)
    wrap.appendChild(button)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

const commentDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(commentDecorationEffect)) continue
      next = buildCommentDecorations(
        effect.value.comments,
        effect.value.activeId,
        tr.state.doc.toString()
      )
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})
const taskJumpHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(taskJumpHighlightEffect)) continue
      if (effect.value == null) {
        next = Decoration.none
        continue
      }
      const pos = Math.max(0, Math.min(tr.state.doc.length, effect.value))
      next = Decoration.set([taskJumpHighlightDecoration.range(tr.state.doc.lineAt(pos).from)])
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

function lineNumberExtension(mode: LineNumberMode): Extension {
  if (mode === 'off') return []
  return [
    lineNumbers({
      formatNumber: (lineNo, state) => {
        if (mode === 'absolute') return String(lineNo)
        const activeLine = state.doc.lineAt(state.selection.main.head).number
        return lineNo === activeLine ? String(lineNo) : String(Math.abs(lineNo - activeLine))
      }
    }),
    highlightActiveLineGutter()
  ]
}

type TabDropIndicator = { path: string; position: 'before' | 'after' } | null
type SelectionCommentAction = { x: number; y: number } | null
// The selection bubble toolbar is centered over the selection (translateX -50%),
// so we only need a rough half-width to keep it on screen.
const SELECTION_TOOLBAR_HALF_WIDTH = 140
const SELECTION_TOOLBAR_HEIGHT = 112

function clampViewport(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function selectionEdgeCoords(view: EditorView): {
  left: number
  right: number
  top: number
  bottom: number
} | null {
  const sel = view.state.selection.main
  const head = sel.head
  const forward = head >= sel.anchor
  return (
    view.coordsAtPos(head, forward ? -1 : 1) ??
    view.coordsAtPos(sel.to, -1) ??
    view.coordsAtPos(sel.from, 1)
  )
}

function getSelectionCommentAction(view: EditorView): SelectionCommentAction {
  const sel = view.state.selection.main
  const active = document.activeElement
  // Keep the toolbar up while the editor holds the selection OR while the user
  // has tabbed into the toolbar itself (keyboard navigation).
  const inToolbar = active instanceof Element && active.closest('[data-selection-toolbar]') != null
  const hasFocus =
    view.hasFocus || (active instanceof Node && view.dom.contains(active)) || inToolbar
  if (sel.empty || !hasFocus) return null
  const start = view.coordsAtPos(sel.from, 1)
  const end = view.coordsAtPos(sel.to, -1)
  if (!start || !end) return null
  // Center the bubble horizontally over the selection; sit it just above the
  // top of the selection, flipping below when there isn't room.
  const centerX = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2
  const gap = 8
  const above = Math.min(start.top, end.top) - SELECTION_TOOLBAR_HEIGHT - gap
  const below = Math.max(start.bottom, end.bottom) + gap
  const y = above < 8 ? below : above
  return {
    x: clampViewport(
      centerX,
      SELECTION_TOOLBAR_HALF_WIDTH + 8,
      window.innerWidth - SELECTION_TOOLBAR_HALF_WIDTH - 8
    ),
    y: clampViewport(y, 8, window.innerHeight - SELECTION_TOOLBAR_HEIGHT - 8)
  }
}

function getEditorContextMenuPosition(view: EditorView): { x: number; y: number } {
  const sel = view.state.selection.main
  const coords = sel.empty
    ? view.coordsAtPos(sel.head, 1)
    : selectionEdgeCoords(view)
  const editorRect = view.dom.getBoundingClientRect()
  return {
    x: clampViewport((coords?.right ?? coords?.left ?? editorRect.left + 28) + 8, 8, window.innerWidth - 12),
    y: clampViewport((coords?.bottom ?? editorRect.top + 32) + 6, 8, window.innerHeight - 12)
  }
}

/**
 * Follow a link target extracted from the editor (Cmd/Ctrl-click): an external
 * URL opens in the browser; a Markdown link to another note or a `[[wikilink]]`
 * navigates, scrolling to its `#heading` when present. Returns false when the
 * target resolves to nothing (so the click falls through to normal behavior). (#201)
 */
function followEditorLink(target: string): boolean {
  const external = externalLinkUrl(target)
  if (external) {
    window.open(external, '_blank')
    return true
  }
  const state = useStore.getState()
  const focusSoon = (): void => {
    state.setFocusedPanel('editor')
    requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
  }
  const internal = resolveInternalNoteHref(state.selectedPath, target, state.notes)
  if (internal) {
    if (internal.heading) void openWikilinkHeading(internal.path, internal.heading).then(focusSoon)
    else void state.selectNote(internal.path).then(focusSoon)
    return true
  }
  const wikilink = resolveWikilinkTarget(state.notes, target)
  if (wikilink) {
    const heading = wikilinkHeadingAnchor(target)
    if (heading) void openWikilinkHeading(wikilink.path, heading).then(focusSoon)
    else void state.selectNote(wikilink.path).then(focusSoon)
    return true
  }
  if (openDatabaseFromWikilink(target)) {
    focusSoon()
    return true
  }
  // Dead link — don't leave it a silent dead end. Offer to create the note (with
  // a confirmation), matching the `gd` follow-link path. (Discord: dead links)
  void offerCreateNoteFromLink(target)
  return true
}

const EMPTY_PANE_MODES: PaneModesByPath = {}

export function EditorPane({ pane }: { pane: PaneLeaf }): JSX.Element {
  const paneId = pane.id
  const isActive = useStore((s) => s.activePaneId === paneId)
  const tabs = pane.tabs
  const pinnedTabs = pane.pinnedTabs
  const previewTab = pane.previewTab ?? null
  const activeTab = pane.activeTab

  const content = useStore((s) => (activeTab ? s.noteContents[activeTab] ?? null : null))
  const isDirty = useStore((s) => (activeTab ? s.noteDirty[activeTab] ?? false : false))
  const comments = useStore((s) =>
    activeTab ? s.noteComments[activeTab] ?? EMPTY_COMMENTS : EMPTY_COMMENTS
  )
  const activeCommentId = useStore((s) => s.activeCommentId)
  const notes = useStore((s) => s.notes)
  const assetFiles = useStore((s) => s.assetFiles)
  const vault = useStore((s) => s.vault)
  const refreshNotes = useStore((s) => s.refreshNotes)
  const refreshAssets = useStore((s) => s.refreshAssets)
  const loading = useStore((s) => s.loadingNote && isActive)

  const setActivePane = useStore((s) => s.setActivePane)
  const focusTabInPane = useStore((s) => s.focusTabInPane)
  const closeTabInPane = useStore((s) => s.closeTabInPane)
  const reorderTabInPane = useStore((s) => s.reorderTabInPane)
  const movePaneTab = useStore((s) => s.movePaneTab)
  const splitPaneWithTab = useStore((s) => s.splitPaneWithTab)
  const openNoteInPane = useStore((s) => s.openNoteInPane)
  const toggleTabPin = useStore((s) => s.toggleTabPin)
  const unpinTabInPane = useStore((s) => s.unpinTabInPane)
  const promoteTabInPane = useStore((s) => s.promoteTabInPane)
  const updateNoteBody = useStore((s) => s.updateNoteBody)
  const persistNote = useStore((s) => s.persistNote)
  const trashActive = useStore((s) => s.trashActive)
  const archiveActive = useStore((s) => s.archiveActive)
  const restoreActive = useStore((s) => s.restoreActive)
  const unarchiveActive = useStore((s) => s.unarchiveActive)
  const exportActiveNotePdf = useStore((s) => s.exportActiveNotePdf)
  const renameActive = useStore((s) => s.renameActive)
  const loadNoteComments = useStore((s) => s.loadNoteComments)
  const setActiveCommentId = useStore((s) => s.setActiveCommentId)

  const setEditorViewRef = useStore((s) => s.setEditorViewRef)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const zenMode = useStore((s) => s.zenMode)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const setConnectionPreview = useStore((s) => s.setConnectionPreview)
  const pendingTitleFocusPath = useStore((s) => s.pendingTitleFocusPath)
  const clearPendingTitleFocus = useStore((s) => s.clearPendingTitleFocus)
  const pendingJumpLocation = useStore((s) => s.pendingJumpLocation)
  const clearPendingJumpLocation = useStore((s) => s.clearPendingJumpLocation)
  const vimMode = useStore((s) => s.vimMode)
  const vimYankToClipboard = useStore((s) => s.vimYankToClipboard)
  const livePreview = useStore((s) => s.livePreview)
  const renderTablesInLivePreview = useStore((s) => s.renderTablesInLivePreview)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const editorScrollOff = useStore((s) => s.editorScrollOff)
  const lineNumberMode = useStore((s) => s.lineNumberMode)
  const textFont = useStore((s) => s.textFont)
  const tabsEnabled = useStore((s) => s.tabsEnabled)
  const wrapTabs = useStore((s) => s.wrapTabs)
  const jumpToPreviousNote = useStore((s) => s.jumpToPreviousNote)
  const jumpToNextNote = useStore((s) => s.jumpToNextNote)
  const canGoBack = useStore((s) => s.noteBackstack.length > 0)
  const canGoForward = useStore((s) => s.noteForwardstack.length > 0)
  const tabNavOverrides = useStore((s) => s.keymapOverrides)
  const workspaceMode = useStore((s) => s.workspaceMode)
  const wordWrap = useStore((s) => s.wordWrap)
  const cursorBlink = useStore((s) => s.cursorBlink)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const folderLabels = resolveSystemFolderLabels(systemFolderLabels)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const autoCalendarPanel = useStore((s) => s.autoCalendarPanel)

  const modesByPath = useStore((s) => s.paneModes[paneId]) ?? EMPTY_PANE_MODES
  const setPaneModeForPath = useStore((s) => s.setPaneModeForPath)
  const keepViewModeAcrossNotes = useStore((s) => s.keepViewModeAcrossNotes)
  const paneStickyMode = useStore((s) => s.paneStickyModes[paneId])
  // With "keep view mode across notes" on, every note in this pane follows the
  // pane's current mode instead of its own remembered one (falls back to the
  // per-note mode until a mode has been picked in this pane).
  const mode =
    keepViewModeAcrossNotes && paneStickyMode
      ? paneStickyMode
      : paneModeForPath(modesByPath, activeTab)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [activeOutlineLine, setActiveOutlineLine] = useState<number | null>(null)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  // The calendar panel is a date navigator. It auto-opens while the pane shows
  // a daily/weekly note, but stays available (Obsidian-style) on any note as
  // long as the daily or weekly feature is enabled.
  const isDateNote = useMemo(
    () => (content ? classifyDateNote(content, vaultSettings) != null : false),
    [content, vaultSettings]
  )
  const calendarAvailable = useMemo(() => {
    const s = normalizeVaultSettings(vaultSettings)
    if (!(s.dailyNotes.enabled || s.weeklyNotes.enabled)) return false
    // The calendar navigates daily/weekly notes — it's meaningless in the Quick
    // Notes scratchpad, and showing it there makes a quick note look like a
    // calendar-linked daily note (a real source of confusion). Hide it there.
    if (content?.folder === 'quick') return false
    return true
  }, [vaultSettings, content?.folder])
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null)
  const [selectionCommentAction, setSelectionCommentAction] =
    useState<SelectionCommentAction>(null)
  const [paneDropEdge, setPaneDropEdge] = useState<PaneEdge | null>(null)
  const [tabDropIndicator, setTabDropIndicator] = useState<TabDropIndicator>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  // Right-click menu for editor text (Copy/Cut/Paste/Select All/Undo/Redo).
  // Null when closed. Captures selection state at click time so menu items
  // reflect what was actually selected.
  const [editorMenu, setEditorMenu] = useState<{
    x: number
    y: number
    hasSelection: boolean
  } | null>(null)
  const [editorHydration, setEditorHydration] = useState<EditorHydrationState | null>(null)
  const [assetDropActive, setAssetDropActive] = useState(false)
  const [imageDropIndicatorTop, setImageDropIndicatorTop] = useState<number | null>(null)
  const [tabStripOverflowing, setTabStripOverflowing] = useState(false)

  const viewRef = useRef<EditorView | null>(null)
  const importPastedImagesRef = useRef<
    ((files: File[], view: EditorView) => Promise<void>) | null
  >(null)
  const paneRootRef = useRef<HTMLDivElement | null>(null)
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const paneBodyRef = useRef<HTMLDivElement | null>(null)
  const editorSurfaceRef = useRef<HTMLDivElement | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)
  // Pending tab-scroll restore for the preview: set when a note is
  // (re)activated, re-applied once `onRendered` reports the preview (incl.
  // async diagrams) has reached full height. `lastProgrammaticPreviewTopRef`
  // lets us tell our own restore scroll apart from a user scroll, so we never
  // yank a reader who scrolled during the render window.
  const previewRestoreTargetRef = useRef<{ path: string; top: number } | null>(null)
  const lastProgrammaticPreviewTopRef = useRef<number | null>(null)
  const lastRestoredPathRef = useRef<string | null>(null)
  const vimCompartmentRef = useRef<Compartment | null>(null)
  const editorKeymapCompartmentRef = useRef<Compartment | null>(null)
  const markdownCompartmentRef = useRef<Compartment | null>(null)
  const markdownSyntaxCompartmentRef = useRef<Compartment | null>(null)
  const livePreviewCompartmentRef = useRef<Compartment | null>(null)
  const lineNumbersCompartmentRef = useRef<Compartment | null>(null)
  const wordWrapCompartmentRef = useRef<Compartment | null>(null)
  const scrolloffCompartmentRef = useRef<Compartment | null>(null)
  const drawSelectionCompartmentRef = useRef<Compartment | null>(null)
  // history() lives in a compartment so we can reset undo history on a note
  // switch — otherwise Cmd+Z crosses notes and overwrites the current one (#247).
  const historyCompartmentRef = useRef<Compartment | null>(null)
  const ignoreEditorScrollRef = useRef(false)
  const ignorePreviewScrollRef = useRef(false)
  const pendingOutlineJumpLineRef = useRef<number | null>(null)
  const pendingPreviewOutlineJumpLineRef = useRef<number | null>(null)
  const outlinePreviewJumpFrameRef = useRef<number | null>(null)
  const outlinePreviewSyncLockUntilRef = useRef(0)
  const previewIsStaleRef = useRef(false)
  const modeRef = useRef<PaneMode>(mode)
  const hasContentRef = useRef(false)
  const editorViewportSyncFrameRef = useRef<number | null>(null)
  const syncPreviewToEditorScrollRef = useRef<() => boolean>(() => false)
  const activeOutlineLineRef = useRef<number | null>(null)
  const activeOutlineFrameRef = useRef<number | null>(null)
  const selectionActionFrameRef = useRef<number | null>(null)
  const taskJumpHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deferredLivePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const richMarkdownDeferredRef = useRef(false)
  /**
   * Path currently rendered in this pane's CodeMirror view. The CM update
   * listener writes through to `noteContents[viewPathRef.current]`; the
   * sync effect updates it whenever we swap the view's document.
   */
  const viewPathRef = useRef<string | null>(null)

  const updateSelectionCommentAction = useCallback((view: EditorView | null = viewRef.current): void => {
    setSelectionCommentAction(view ? getSelectionCommentAction(view) : null)
  }, [])

  const scheduleSelectionCommentAction = useCallback((view: EditorView | null = viewRef.current): void => {
    if (selectionActionFrameRef.current != null) {
      cancelAnimationFrame(selectionActionFrameRef.current)
    }
    selectionActionFrameRef.current = requestAnimationFrame(() => {
      selectionActionFrameRef.current = null
      updateSelectionCommentAction(view)
    })
  }, [updateSelectionCommentAction])

  const openEditorContextMenu = useCallback((): boolean => {
    const view = viewRef.current
    if (!view || !viewPathRef.current) return false
    const pos = getEditorContextMenuPosition(view)
    const sel = view.state.selection.main
    setActivePane(paneId)
    setFocusedPanel('editor')
    setSelectionCommentAction(null)
    setEditorMenu({
      x: pos.x,
      y: pos.y,
      hasSelection: !sel.empty
    })
    view.focus()
    return true
  }, [paneId, setActivePane, setFocusedPanel])

  const rememberCurrentTabScroll = useCallback((path = viewPathRef.current): void => {
    if (!path) return
    const prev = recallTabScroll(path)
    const view = viewRef.current
    const previewEl = previewScrollRef.current
    const next: TabScrollPosition = {
      editor: view?.scrollDOM.scrollTop ?? prev?.editor ?? 0,
      preview: previewEl?.scrollTop ?? prev?.preview ?? 0
    }
    const selection = view && viewPathRef.current === path ? view.state.selection.main : null
    if (selection) {
      next.editorSelectionAnchor = selection.anchor
      next.editorSelectionHead = selection.head
    }
    rememberTabScroll(path, next)
  }, [])

  const toggleConnectionsPanel = useCallback(() => {
    setConnectionsOpen((open) => {
      const next = !open
      if (!next) {
        setConnectionPreview(null)
        if (focusedPanel === 'connections' || focusedPanel === 'hoverpreview') {
          setFocusedPanel('editor')
        }
      }
      return next
    })
  }, [focusedPanel, setConnectionPreview, setFocusedPanel])

  // ⌘2 toggles the connections panel — only the active pane responds so
  // the shortcut targets the pane the user is currently working in.
  useEffect(() => {
    if (!isActive) return
    const handler = (): void => {
      toggleConnectionsPanel()
    }
    window.addEventListener('zen:toggle-connections', handler)
    return () => window.removeEventListener('zen:toggle-connections', handler)
  }, [isActive, toggleConnectionsPanel])

  // Mirror `set clipboard=unnamed`: when enabled, Vim yank/delete/change also
  // copy to the system clipboard, and `p` / `P` paste from it. The patch is
  // global, so any pane can drive it. Also install the highlight-on-yank
  // handler (idempotent). (#144, #357)
  useEffect(() => {
    setYankToClipboardEnabled(vimYankToClipboard)
    setPasteFromClipboardEnabled(vimYankToClipboard)
    wireYankHighlight()
  }, [vimYankToClipboard])

  const toggleOutlinePanel = useCallback(() => {
    setOutlineOpen((open) => !open)
  }, [])

  const toggleCommentsPanel = useCallback(() => {
    setCommentsOpen((open) => !open)
  }, [])

  const toggleCalendarPanel = useCallback(() => {
    setCalendarOpen((open) => !open)
  }, [])


  const applyPaneMode = useCallback((nextMode: PaneMode) => {
    setPaneModeForPath(paneId, activeTab, nextMode)
    setActivePane(paneId)
    setFocusedPanel('editor')
    requestAnimationFrame(() => {
      if (nextMode === 'preview') {
        previewScrollRef.current?.focus()
        return
      }
      focusEditorNormalMode()
    })
  }, [activeTab, paneId, setPaneModeForPath, setActivePane, setFocusedPanel])

  // `zen:toggle-outline` — routed only to the active pane, same pattern
  // as the connections toggle.
  useEffect(() => {
    if (!isActive) return
    const handler = (): void => {
      toggleOutlinePanel()
    }
    window.addEventListener('zen:toggle-outline', handler)
    return () => window.removeEventListener('zen:toggle-outline', handler)
  }, [isActive, toggleOutlinePanel])

  useEffect(() => {
    if (!isActive) return
    const handler = (): void => {
      toggleCommentsPanel()
    }
    window.addEventListener('zen:toggle-comments', handler)
    return () => window.removeEventListener('zen:toggle-comments', handler)
  }, [isActive, toggleCommentsPanel])

  // `zen:toggle-calendar` — same active-pane routing as the panels above.
  useEffect(() => {
    if (!isActive) return
    const handler = (): void => {
      toggleCalendarPanel()
    }
    window.addEventListener('zen:toggle-calendar', handler)
    return () => window.removeEventListener('zen:toggle-calendar', handler)
  }, [isActive, toggleCalendarPanel])

  // `zen:close-right-panel` — Esc (when a right panel is focused) or the
  // "Close right panel" command dismiss whichever right-hand panel is open in
  // the active pane and return focus to the editor.
  useEffect(() => {
    if (!isActive) return
    const handler = (): void => {
      setConnectionsOpen(false)
      setOutlineOpen(false)
      setCommentsOpen(false)
      setCalendarOpen(false)
      setConnectionPreview(null)
      const panel = useStore.getState().focusedPanel
      if (panel === 'connections' || panel === 'comments' || panel === 'hoverpreview') {
        setFocusedPanel('editor')
      }
    }
    window.addEventListener('zen:close-right-panel', handler)
    return () => window.removeEventListener('zen:close-right-panel', handler)
  }, [isActive, setConnectionPreview, setFocusedPanel])

  // Auto-show the calendar when this pane lands on a daily/weekly note. On other
  // notes we leave it as-is (Obsidian-style persistence) so it stays open while
  // you browse, and only force it closed when the feature is turned off entirely.
  // Keyed on the note identity (not every render) so a manual `leader c` / icon
  // close sticks until the note changes.
  useEffect(() => {
    if (!calendarAvailable) {
      setCalendarOpen(false)
      return
    }
    if (isDateNote && autoCalendarPanel) setCalendarOpen(true)
  }, [content?.path, isDateNote, autoCalendarPanel, calendarAvailable])

  useEffect(() => {
    if (!isActive) return
    const handler = (): void => {
      openEditorContextMenu()
    }
    window.addEventListener(ZEN_OPEN_EDITOR_CONTEXT_MENU_EVENT, handler)
    return () => window.removeEventListener(ZEN_OPEN_EDITOR_CONTEXT_MENU_EVENT, handler)
  }, [isActive, openEditorContextMenu])

  // `zen:set-pane-mode` — active-pane-only route for command palette and
  // vim ex commands that switch the current note between Edit / Split /
  // Preview without touching the toolbar.
  useEffect(() => {
    if (!isActive) return
    const handler = (event: Event): void => {
      const nextMode = (event as CustomEvent<{ mode?: PaneMode }>).detail?.mode
      if (nextMode !== 'edit' && nextMode !== 'split' && nextMode !== 'preview') return
      applyPaneMode(nextMode)
    }
    window.addEventListener(ZEN_SET_PANE_MODE_EVENT, handler)
    return () => window.removeEventListener(ZEN_SET_PANE_MODE_EVENT, handler)
  }, [applyPaneMode, isActive])

  const lockOutlinePreviewSync = useCallback((durationMs = OUTLINE_JUMP_SCROLL_SYNC_LOCK_MS): void => {
    // Outline jumps target a rendered heading; ratio sync can otherwise override them.
    outlinePreviewSyncLockUntilRef.current = nextOutlinePreviewSyncLockUntil(
      performance.now(),
      durationMs,
      outlinePreviewSyncLockUntilRef.current
    )
  }, [])

  const scrollPreviewToOutlineLine = useCallback((line: number): boolean => {
    // Works wherever the preview is mounted (split or preview), not in edit.
    if (mode === 'edit' || !content) return false
    const previewEl = previewScrollRef.current
    if (!previewEl) return false
    const items = parseOutline(content.body)
    const heading = findRenderedHeadingForOutlineLine(previewEl, items, line)
    if (!heading) return false
    const nextTop = previewScrollTopForHeading(previewEl, heading, OUTLINE_JUMP_TOP_MARGIN)
    lockOutlinePreviewSync(OUTLINE_JUMP_SCROLL_SYNC_SETTLE_MS)
    if (Math.abs(previewEl.scrollTop - nextTop) >= 1) {
      ignorePreviewScrollRef.current = true
      previewEl.scrollTo({ top: nextTop, behavior: 'auto' })
    }
    return true
  }, [content?.body, lockOutlinePreviewSync, mode])

  const syncPreviewToEditorScroll = useCallback((): boolean => {
    const view = viewRef.current
    const editorEl = view?.scrollDOM
    const previewEl = previewScrollRef.current
    if (!view || !editorEl || !previewEl) return false

    // Line-based sync: map the source line at the top of the editor viewport to
    // the rendered preview block stamped with that line (data-source-line), so
    // the same content sits at the top of both panes even when their heights
    // differ. Falls back to a scroll ratio when no line data is available.
    const ratioTop = (): number =>
      scrollTopForScrollRatio(
        editorEl.scrollTop,
        editorEl.scrollHeight,
        editorEl.clientHeight,
        previewEl.scrollHeight,
        previewEl.clientHeight
      )

    const blocks = previewEl.querySelectorAll<HTMLElement>('[data-source-line]')
    let nextTop: number
    if (blocks.length === 0) {
      nextTop = ratioTop()
    } else {
      const topLine = view.state.doc.lineAt(view.lineBlockAtHeight(editorEl.scrollTop).from).number
      let anchor: HTMLElement | null = null
      let anchorLine = 0
      for (const el of blocks) {
        const ln = Number(el.dataset.sourceLine)
        if (Number.isFinite(ln) && ln <= topLine) {
          anchor = el
          anchorLine = ln
        } else if (ln > topLine) {
          break
        }
      }
      if (!anchor) {
        nextTop = 0
      } else {
        // Shift the anchor by how far the editor has scrolled past its start
        // line, so a mid-block scroll position carries over too.
        const anchorEditorTop = view.lineBlockAt(view.state.doc.line(anchorLine).from).top
        nextTop = scrollTopForElementRelativeTop(previewEl, anchor, anchorEditorTop - editorEl.scrollTop)
      }
    }

    if (Math.abs(previewEl.scrollTop - nextTop) < 1) return true
    ignorePreviewScrollRef.current = true
    previewEl.scrollTop = nextTop
    return true
  }, [])
  syncPreviewToEditorScrollRef.current = syncPreviewToEditorScroll

  const canSyncPreviewFromEditorViewport = useCallback((): boolean => {
    return shouldSyncPreviewFromEditorViewport(
      modeRef.current,
      hasContentRef.current,
      previewIsStaleRef.current,
      performance.now() < outlinePreviewSyncLockUntilRef.current
    )
  }, [])

  const schedulePreviewSyncFromEditorViewport = useCallback((): void => {
    if (!canSyncPreviewFromEditorViewport()) return
    if (editorViewportSyncFrameRef.current != null) return
    editorViewportSyncFrameRef.current = requestAnimationFrame(() => {
      editorViewportSyncFrameRef.current = null
      if (!canSyncPreviewFromEditorViewport()) return
      syncPreviewToEditorScrollRef.current()
    })
  }, [canSyncPreviewFromEditorViewport])

  const schedulePreviewOutlineJump = useCallback((line: number): void => {
    if (mode === 'edit') return
    lockOutlinePreviewSync()
    pendingPreviewOutlineJumpLineRef.current = line
    if (outlinePreviewJumpFrameRef.current != null) {
      cancelAnimationFrame(outlinePreviewJumpFrameRef.current)
    }
    outlinePreviewJumpFrameRef.current = requestAnimationFrame(() => {
      outlinePreviewJumpFrameRef.current = null
      if (scrollPreviewToOutlineLine(line)) {
        pendingPreviewOutlineJumpLineRef.current = null
      }
    })
  }, [lockOutlinePreviewSync, mode, scrollPreviewToOutlineLine])

  const handlePreviewRendered = useCallback((): void => {
    if (previewIsStaleRef.current) return
    const pendingLine = pendingPreviewOutlineJumpLineRef.current
    if (pendingLine != null) {
      if (scrollPreviewToOutlineLine(pendingLine)) {
        pendingPreviewOutlineJumpLineRef.current = null
      }
      return
    }
    // Re-apply a remembered scroll now that the preview has reached full
    // height — async diagrams grow the page after first paint, which would
    // otherwise have clamped the initial restore to a shorter document. Skip
    // it if the user has scrolled since our last programmatic set.
    const restore = previewRestoreTargetRef.current
    if (restore && restore.path === content?.path) {
      const el = previewScrollRef.current
      const last = lastProgrammaticPreviewTopRef.current
      if (el && (last == null || Math.abs(el.scrollTop - last) < 2)) {
        el.scrollTop = restore.top
        lastProgrammaticPreviewTopRef.current = el.scrollTop
      }
      previewRestoreTargetRef.current = null
      return
    }
    if (!canSyncPreviewFromEditorViewport()) return
    syncPreviewToEditorScroll()
  }, [
    canSyncPreviewFromEditorViewport,
    content?.path,
    mode,
    syncPreviewToEditorScroll,
    scrollPreviewToOutlineLine
  ])

  useEffect(() => {
    pendingPreviewOutlineJumpLineRef.current = null
    outlinePreviewSyncLockUntilRef.current = 0
  }, [content?.path])

  useEffect(() => {
    return () => {
      if (outlinePreviewJumpFrameRef.current != null) {
        cancelAnimationFrame(outlinePreviewJumpFrameRef.current)
      }
    }
  }, [])

  const commitOutlineJump = useCallback((line: number) => {
    const view = viewRef.current
    if (!view) return false
    const safeLine = Math.min(Math.max(1, line), view.state.doc.lines)
    const targetLine = view.state.doc.line(safeLine)
    const pos = targetLine.from + outlineHeadingTextOffset(targetLine.text)
    schedulePreviewOutlineJump(safeLine)
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(targetLine.from, {
        y: 'start',
        yMargin: OUTLINE_JUMP_TOP_MARGIN
      })
    })
    setFocusedPanel('editor')
    view.focus()
    return true
  }, [schedulePreviewOutlineJump, setFocusedPanel])

  const jumpToOutlineLine = useCallback((line: number) => {
    setActivePane(paneId)
    // Preview mode: scroll the rendered preview to the heading and stay in
    // preview — don't yank the user into edit mode. If the preview hasn't
    // rendered yet, schedule the scroll for when it does.
    if (mode === 'preview') {
      if (!scrollPreviewToOutlineLine(line)) {
        schedulePreviewOutlineJump(line)
      }
      return
    }
    pendingOutlineJumpLineRef.current = line
    setFocusedPanel('editor')
    if (!viewRef.current) {
      applyPaneMode('edit')
      return
    }
    if (commitOutlineJump(line)) {
      pendingOutlineJumpLineRef.current = null
    }
  }, [
    applyPaneMode,
    commitOutlineJump,
    mode,
    paneId,
    scrollPreviewToOutlineLine,
    schedulePreviewOutlineJump,
    setActivePane,
    setFocusedPanel
  ])

  const clearCommentDraft = useCallback((): void => {
    setCommentDraft(null)
  }, [])

  const captureCommentDraft = useCallback((): CommentDraft | null => {
    const view = viewRef.current
    if (!view || !content) return null
    const sel = view.state.selection.main
    const doc = view.state.doc.toString()
    let from = sel.from
    let to = sel.to
    if (sel.empty) {
      const line = view.state.doc.lineAt(sel.head)
      from = line.from
      to = line.to
    }
    const draft = selectionToCommentAnchor(doc, from, to)
    setCommentDraft(draft)
    setCommentsOpen(true)
    setActiveCommentId(null)
    setSelectionCommentAction(null)
    setActivePane(paneId)
    setFocusedPanel('editor')
    return draft
  }, [content, paneId, setActiveCommentId, setActivePane, setFocusedPanel])

  // `zen:add-comment` — keyboard shortcut (⌥⌘M) / palette command to start a
  // comment on the current selection (or line) in the active pane, no mouse.
  useEffect(() => {
    if (!isActive) return
    const handler = (): void => {
      captureCommentDraft()
    }
    window.addEventListener('zen:add-comment', handler)
    return () => window.removeEventListener('zen:add-comment', handler)
  }, [isActive, captureCommentDraft])

  const jumpToComment = useCallback((comment: NoteComment) => {
    const view = viewRef.current
    setActivePane(paneId)
    setFocusedPanel('editor')
    setActiveCommentId(comment.id)
    if (!view) return
    if (mode === 'preview') {
      applyPaneMode('edit')
    }
    const anchor = resolveCommentAnchor(comment, view.state.doc.toString())
    const selection =
      anchor.to > anchor.from
        ? { anchor: anchor.from, head: anchor.to }
        : { anchor: anchor.from }
    view.dispatch({
      selection,
      effects: EditorView.scrollIntoView(anchor.from, { y: 'center' })
    })
    view.focus()
  }, [applyPaneMode, mode, paneId, setActiveCommentId, setActivePane, setFocusedPanel])

  useEffect(() => {
    const pendingLine = pendingOutlineJumpLineRef.current
    if (pendingLine == null) return
    if (!isActive || mode === 'preview' || !content) return
    const raf = requestAnimationFrame(() => {
      if (commitOutlineJump(pendingLine)) {
        pendingOutlineJumpLineRef.current = null
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [commitOutlineJump, content?.path, isActive, mode])

  // `zen:outline-jump` lets global UI like the searchable outline
  // overlay route the jump through the active pane, which can switch
  // out of preview mode before placing the caret.
  useEffect(() => {
    if (!isActive) return
    const handler = (event: Event): void => {
      const line = (event as CustomEvent<{ line?: number }>).detail?.line
      if (typeof line !== 'number') return
      jumpToOutlineLine(line)
    }
    window.addEventListener('zen:outline-jump', handler)
    return () => window.removeEventListener('zen:outline-jump', handler)
  }, [isActive, jumpToOutlineLine])

  // Outline items derived from the current note body — line numbers
  // here are 1-based to match `parseOutline` and the editor's doc API.
  const outlineItems = useMemo(
    () => (outlineOpen ? parseOutline(content?.body ?? '') : []),
    [content?.body, outlineOpen]
  )

  useEffect(() => {
    if (!content) {
      setEditorHydration(null)
      return
    }

    const shouldDefer = shouldDeferEditorHydration(
      mode !== 'preview',
      mode,
      content.body.length,
      LARGE_DOC_LIVE_PREVIEW_DEFER_CHARS
    )
    if (!shouldDefer) {
      setEditorHydration((current) =>
        current?.path === content.path && current.ready
          ? current
          : { path: content.path, ready: true }
      )
      return
    }

    setEditorHydration((current) =>
      current?.path === content.path && current.ready
        ? current
        : { path: content.path, ready: false }
    )

    let cancelled = false
    let idleId: number | null = null
    const timeoutId = window.setTimeout(() => {
      const hydrate = (): void => {
        idleId = null
        if (cancelled) return
        setEditorHydration({ path: content.path, ready: true })
      }

      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(hydrate, { timeout: 700 })
        return
      }
      hydrate()
    }, LARGE_DOC_EDITOR_HYDRATE_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
      if (
        idleId != null &&
        typeof window.cancelIdleCallback === 'function'
      ) {
        window.cancelIdleCallback(idleId)
      }
    }
  }, [content?.body.length, content?.path, mode])

  const setActiveOutlineLineSafely = useCallback((line: number | null) => {
    if (activeOutlineLineRef.current === line) return
    activeOutlineLineRef.current = line
    setActiveOutlineLine(line)
  }, [])

  const computeActiveFromEditor = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    if (outlineItems.length === 0) {
      setActiveOutlineLineSafely(null)
      return
    }
    // Probe ~25% down the viewport (capped) so a heading is considered
    // active once it scrolls into the upper portion of the visible area
    // — not only after it has scrolled past the very top edge.
    const rect = view.scrollDOM.getBoundingClientRect()
    const probeY = rect.top + Math.min(140, rect.height * 0.25)
    const pos = view.posAtCoords({ x: rect.left + 8, y: probeY })
    if (pos == null) {
      setActiveOutlineLineSafely(null)
      return
    }
    const probeLine = view.state.doc.lineAt(pos).number
    let activeLine: number | null = null
    for (const item of outlineItems) {
      if (item.line <= probeLine) activeLine = item.line
      else break
    }
    setActiveOutlineLineSafely(activeLine)
  }, [outlineItems, setActiveOutlineLineSafely])

  const computeActiveFromPreview = useCallback(() => {
    const dom = previewScrollRef.current
    if (!dom) return
    if (outlineItems.length === 0) {
      setActiveOutlineLineSafely(null)
      return
    }
    const headings = dom.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
    if (headings.length === 0) {
      setActiveOutlineLineSafely(null)
      return
    }
    // Match the editor probe: a heading counts as active once it sits
    // inside the upper ~25% band of the preview viewport.
    const rect = dom.getBoundingClientRect()
    const threshold = rect.top + Math.min(140, rect.height * 0.25)
    let activeIndex = -1
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= threshold) activeIndex = i
      else break
    }
    if (activeIndex < 0) {
      setActiveOutlineLineSafely(null)
      return
    }
    const item = outlineItems[Math.min(activeIndex, outlineItems.length - 1)]
    setActiveOutlineLineSafely(item?.line ?? null)
  }, [outlineItems, setActiveOutlineLineSafely])

  const scheduleActiveOutlineUpdate = useCallback((compute: () => void) => {
    if (activeOutlineFrameRef.current != null) {
      cancelAnimationFrame(activeOutlineFrameRef.current)
    }
    activeOutlineFrameRef.current = requestAnimationFrame(() => {
      activeOutlineFrameRef.current = null
      compute()
    })
  }, [])

  // Mount / unmount the CodeMirror view via a callback ref on the host
  // div. The callback identity is stable so React only invokes it on
  // mount / unmount — `content` is read from `useStore.getState()` at
  // creation time and kept in sync afterward via the effect below.
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        if (selectionActionFrameRef.current != null) {
          cancelAnimationFrame(selectionActionFrameRef.current)
          selectionActionFrameRef.current = null
        }
        if (editorViewportSyncFrameRef.current != null) {
          cancelAnimationFrame(editorViewportSyncFrameRef.current)
          editorViewportSyncFrameRef.current = null
        }
        if (deferredLivePreviewTimerRef.current != null) {
          clearTimeout(deferredLivePreviewTimerRef.current)
          deferredLivePreviewTimerRef.current = null
        }
        richMarkdownDeferredRef.current = false
        setSelectionCommentAction(null)
        const existingView = viewRef.current
        rememberCurrentTabScroll()
        if (
          existingView &&
          useStore.getState().editorViewRef === existingView
        ) {
          setEditorViewRef(null)
        }
        existingView?.destroy()
        viewRef.current = null
        return
      }
      if (viewRef.current) return
      const vimCompartment = new Compartment()
      const editorKeymapCompartment = new Compartment()
      const markdownCompartment = new Compartment()
      const markdownSyntaxCompartment = new Compartment()
      const livePreviewCompartment = new Compartment()
      const lineNumbersCompartment = new Compartment()
      const wordWrapCompartment = new Compartment()
      const scrolloffCompartment = new Compartment()
      const drawSelectionCompartment = new Compartment()
      const historyCompartment = new Compartment()
      vimCompartmentRef.current = vimCompartment
      editorKeymapCompartmentRef.current = editorKeymapCompartment
      markdownCompartmentRef.current = markdownCompartment
      markdownSyntaxCompartmentRef.current = markdownSyntaxCompartment
      livePreviewCompartmentRef.current = livePreviewCompartment
      lineNumbersCompartmentRef.current = lineNumbersCompartment
      wordWrapCompartmentRef.current = wordWrapCompartment
      scrolloffCompartmentRef.current = scrolloffCompartment
      drawSelectionCompartmentRef.current = drawSelectionCompartment
      historyCompartmentRef.current = historyCompartment
      const s0 = useStore.getState()
      const initialPath = findLeaf(s0.paneLayout, paneId)?.activeTab ?? null
      const initialContent = initialPath ? s0.noteContents[initialPath] ?? null : null
      const initialBody = initialContent?.body ?? ''
      const deferInitialRichMarkdown =
        initialBody.length >= LARGE_DOC_LIVE_PREVIEW_DEFER_CHARS && !s0.livePreview
      richMarkdownDeferredRef.current = deferInitialRichMarkdown
      const stateStartedAt = performance.now()
      const state = EditorState.create({
        doc: initialBody,
        extensions: [
          appMarkdownSnippetExtension(),
          vimCompartment.of(s0.vimMode ? vim() : []),
          historyCompartment.of(history()),
          drawSelectionCompartment.of(
            drawSelection({ cursorBlinkRate: s0.cursorBlink ? 1200 : 0 })
          ),
          highlightActiveLine(),
          taskJumpHighlightField,
          yankHighlightExtension,
          vimClipboardPasteExtension,
          commentDecorationField,
          wordWrapCompartment.of(s0.wordWrap ? EditorView.lineWrapping : []),
          scrolloffCompartment.of(scrollOff(s0.editorScrollOff)),
          markdownCompartment.of(deferInitialRichMarkdown ? [] : markdownEditingExtensions()),
          markdownSyntaxCompartment.of(
            deferInitialRichMarkdown ? [] : markdownSyntaxHighlightExtensions()
          ),
          livePreviewCompartment.of(
            s0.livePreview && !deferInitialRichMarkdown
              ? wysiwygExtensions(s0.renderTablesInLivePreview)
              : []
          ),
          lineNumbersCompartment.of(lineNumberExtension(s0.lineNumberMode)),
          tooltips({ parent: document.body }),
          autocompletion({
            override: [
              slashCommandSource,
              calloutTypeSource,
              dateShortcutSource,
              atNoteSource,
              wikilinkSource,
              wikilinkHeadingSource
            ],
            addToOptions: [{ render: slashCommandRender.render, position: 0 }],
            icons: false,
            optionClass: (completion) => {
              const kind = (completion as { _kind?: string })._kind
              if (kind === 'wikilink') return 'wikilink-cmd-option'
              if (kind === 'callout') return 'callout-cmd-option'
              return 'slash-cmd-option'
            }
          }),
          completionNavKeymap,
          editorKeymapCompartment.of(buildEditorKeymap(s0.vimMode, s0.keymapOverrides)),
          EditorView.domEventHandlers({
            mousedown: (event, view) => {
              const target = event.target as HTMLElement | null
              // Follow a Markdown link in live preview. A plain click follows a
              // *rendered* link (the cursor is outside it, so its `(url)` syntax
              // is hidden) — mirroring how `[[wikilinks]]` behave; clicking a
              // link the cursor is already inside edits it instead. Cmd/Ctrl-click
              // always follows (and reaches wikilinks too), gated to the primary
              // button so a macOS Ctrl+click right-click doesn't trigger it. (#201)
              if (event.button === 0 && !event.altKey && !event.shiftKey) {
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
                if (pos != null) {
                  const doc = view.state.doc.toString()
                  if (event.metaKey || event.ctrlKey) {
                    const linkTarget = extractLinkAtCursor(doc, pos)
                    if (linkTarget && followEditorLink(linkTarget)) {
                      event.preventDefault()
                      return true
                    }
                  } else {
                    const link = markdownLinkAt(doc, pos)
                    if (link) {
                      const sel = view.state.selection.main
                      const rendered = sel.to < link.from || sel.from > link.to
                      if (rendered && followEditorLink(link.href)) {
                        event.preventDefault()
                        return true
                      }
                    }
                  }
                }
              }
              const marker = target?.closest<HTMLElement>('.cm-comment-marker[data-comment-id]')
              const commentId = marker?.dataset.commentId
              if (!commentId) return false
              event.preventDefault()
              event.stopPropagation()
              setActivePane(paneId)
              setFocusedPanel('editor')
              setActiveCommentId(commentId)
              setCommentsOpen(true)
              setCommentDraft(null)
              setSelectionCommentAction(null)
              return true
            },
            click: (event) => {
              const target = event.target as HTMLElement | null
              const marker = target?.closest<HTMLElement>('.cm-comment-marker[data-comment-id]')
              const commentId = marker?.dataset.commentId
              if (!commentId) return false
              event.preventDefault()
              event.stopPropagation()
              setActivePane(paneId)
              setFocusedPanel('editor')
              setActiveCommentId(commentId)
              setCommentsOpen(true)
              setCommentDraft(null)
              setSelectionCommentAction(null)
              return true
            },
            paste: (event, view) => {
              const files = pastedImageFilesFromClipboard(event.clipboardData)
              if (files.length === 0) return false
              event.preventDefault()
              event.stopPropagation()
              void importPastedImagesRef.current?.(files, view)
              return true
            },
            keydown: (event, view) => {
              const state = useStore.getState()
              if (
                event.key === 'm' &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.shiftKey &&
                state.vimMode
              ) {
                const cm = getCM(view)
                const insertMode = !!cm?.state.vim?.insertMode
                const sel = view.state.selection.main
                if (!insertMode && !sel.empty) {
                  event.preventDefault()
                  event.stopPropagation()
                  openEditorContextMenu()
                  return true
                }
              }
              if (event.key !== 'Escape') return false
              if (!state.vimMode) return false
              const cm = getCM(view)
              if (!cm?.state.vim?.insertMode) return false
              event.preventDefault()
              event.stopPropagation()
              Vim.exitInsertMode(cm as Parameters<typeof Vim.exitInsertMode>[0], true)
              return true
            }
          }),
          EditorView.updateListener.of((upd) => {
            if (upd.selectionSet || upd.docChanged || upd.focusChanged || upd.viewportChanged || upd.geometryChanged) {
              scheduleSelectionCommentAction(upd.view)
            }
            if (upd.viewportChanged || upd.geometryChanged) {
              schedulePreviewSyncFromEditorViewport()
            }
            if (!upd.docChanged) return
            if (upd.transactions.some((tr: Transaction) => tr.annotation(programmatic))) return
            const path = viewPathRef.current
            if (!path) return
            updateNoteBody(path, upd.state.doc.toString())
          })
        ]
      })
      recordRendererPerf('editor.mount.state', performance.now() - stateStartedAt, {
        chars: initialBody.length,
        deferred: deferInitialRichMarkdown
      })
      const viewStartedAt = performance.now()
      const view = new EditorView({ state, parent: el })
      recordRendererPerf('editor.mount.view', performance.now() - viewStartedAt, {
        chars: initialBody.length,
        deferred: deferInitialRichMarkdown
      })
      viewRef.current = view
      viewPathRef.current = initialPath
      if (initialContent && useStore.getState().activePaneId === paneId) {
        setEditorViewRef(view)
      }
      if (deferInitialRichMarkdown && initialPath) {
        deferredLivePreviewTimerRef.current = setTimeout(() => {
          deferredLivePreviewTimerRef.current = null
          if (viewRef.current !== view) return
          if (viewPathRef.current !== initialPath) return
          richMarkdownDeferredRef.current = false
          const restoreEffects = [
            markdownCompartment.reconfigure(markdownEditingExtensions()),
            markdownSyntaxCompartment.reconfigure(markdownSyntaxHighlightExtensions())
          ]
          if (useStore.getState().livePreview) {
            restoreEffects.push(livePreviewCompartment.reconfigure(wysiwygExtensions(useStore.getState().renderTablesInLivePreview)))
          }
          view.dispatch({ effects: restoreEffects })
        }, LARGE_DOC_LIVE_PREVIEW_DEFER_MS)
      }
    },
    [
      openEditorContextMenu,
      paneId,
      rememberCurrentTabScroll,
      schedulePreviewSyncFromEditorViewport,
      scheduleSelectionCommentAction,
      setActiveCommentId,
      setActivePane,
      setEditorViewRef,
      setFocusedPanel,
      updateNoteBody
    ]
  )

  // Register our view as the focused editor whenever our pane is active.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (isActive && content) {
      setEditorViewRef(view)
      return
    }
    if (useStore.getState().editorViewRef === view) {
      setEditorViewRef(null)
    }
  }, [isActive, setEditorViewRef, activeTab, content?.path])

  useEffect(() => {
    const refresh = (): void => scheduleSelectionCommentAction()
    window.addEventListener('resize', refresh)
    window.addEventListener('scroll', refresh, true)
    return () => {
      window.removeEventListener('resize', refresh)
      window.removeEventListener('scroll', refresh, true)
    }
  }, [scheduleSelectionCommentAction])

  // Sync CM doc to external content changes (file watcher, peer panes, tab switch).
  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    const nextPath = content?.path ?? null
    const nextBody = content?.body ?? ''
    const pathChanged = viewPathRef.current !== nextPath
    const bodyChanged =
      pathChanged ||
      view.state.doc.length !== nextBody.length ||
      view.state.doc.toString() !== nextBody
    if (!pathChanged && !bodyChanged) return
    if (deferredLivePreviewTimerRef.current != null) {
      clearTimeout(deferredLivePreviewTimerRef.current)
      deferredLivePreviewTimerRef.current = null
    }
    // Preserve selection on in-place body changes (peer pane edits,
    // external file watcher); jump to the start when switching tabs.
    const sel = view.state.selection.main
    const clampedAnchor = Math.min(sel.anchor, nextBody.length)
    const clampedHead = Math.min(sel.head, nextBody.length)
    const markdownCompartment = markdownCompartmentRef.current
    const markdownSyntaxCompartment = markdownSyntaxCompartmentRef.current
    const livePreviewCompartment = livePreviewCompartmentRef.current
    const livePreviewEnabled = useStore.getState().livePreview
    const deferRichMarkdown =
      pathChanged &&
      nextBody.length >= LARGE_DOC_LIVE_PREVIEW_DEFER_CHARS &&
      !livePreviewEnabled &&
      !!markdownCompartment &&
      !!markdownSyntaxCompartment
    const effects: StateEffect<unknown>[] = []
    if (deferRichMarkdown && markdownCompartment && markdownSyntaxCompartment) {
      richMarkdownDeferredRef.current = true
      effects.push(
        markdownCompartment.reconfigure([]),
        markdownSyntaxCompartment.reconfigure([])
      )
      if (livePreviewCompartment) effects.push(livePreviewCompartment.reconfigure([]))
    } else if (
      richMarkdownDeferredRef.current &&
      markdownCompartment &&
      markdownSyntaxCompartment
    ) {
      richMarkdownDeferredRef.current = false
      effects.push(
        markdownCompartment.reconfigure(markdownEditingExtensions()),
        markdownSyntaxCompartment.reconfigure(markdownSyntaxHighlightExtensions())
      )
      if (livePreviewEnabled && livePreviewCompartment) {
        effects.push(livePreviewCompartment.reconfigure(wysiwygExtensions(useStore.getState().renderTablesInLivePreview)))
      }
    }
    const dispatchStartedAt = performance.now()
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: nextBody },
      annotations: [
        programmatic.of(true),
        skipOrderedListRenumber.of(true),
        // A programmatic swap (tab switch / external file sync) must never be
        // undoable — otherwise Cmd+Z reverts the editor to the other document
        // and the resulting change saves it over the current note (#247).
        Transaction.addToHistory.of(false)
      ],
      effects: effects.length > 0 ? effects : undefined,
      selection: pathChanged ? { anchor: 0 } : { anchor: clampedAnchor, head: clampedHead }
    })
    if (pathChanged) {
      // Switching notes: also drop the previous note's undo history so undo
      // can't cross the boundary at all. There's no "clear history" command, so
      // remove the history field then re-add it empty. (#247)
      const historyCompartment = historyCompartmentRef.current
      if (historyCompartment) {
        view.dispatch({ effects: historyCompartment.reconfigure([]) })
        view.dispatch({ effects: historyCompartment.reconfigure(history()) })
      }
    }
    if (pathChanged && pendingJumpLocation?.path !== nextPath) {
      // Clear scroll on a genuine tab switch; the activation effect below
      // restores a remembered position afterward when there is one.
      view.scrollDOM.scrollTop = 0
      previewScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
    }
    recordRendererPerf('editor.doc.sync', performance.now() - dispatchStartedAt, {
      chars: nextBody.length,
      deferred: deferRichMarkdown,
      pathChanged
    })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        recordRendererPerf('editor.doc.paint-latency', performance.now() - dispatchStartedAt, {
          chars: nextBody.length,
          deferred: deferRichMarkdown,
          pathChanged
        })
      })
    })
    viewPathRef.current = nextPath
    if (
      deferRichMarkdown &&
      markdownCompartment &&
      markdownSyntaxCompartment &&
      nextPath
    ) {
      deferredLivePreviewTimerRef.current = setTimeout(() => {
        deferredLivePreviewTimerRef.current = null
        if (viewRef.current !== view) return
        if (viewPathRef.current !== nextPath) return
        richMarkdownDeferredRef.current = false
        const restoreEffects = [
          markdownCompartment.reconfigure(markdownEditingExtensions()),
          markdownSyntaxCompartment.reconfigure(markdownSyntaxHighlightExtensions())
        ]
        if (useStore.getState().livePreview && livePreviewCompartment) {
          restoreEffects.push(livePreviewCompartment.reconfigure(wysiwygExtensions(useStore.getState().renderTablesInLivePreview)))
        }
        view.dispatch({
          effects: restoreEffects
        })
      }, LARGE_DOC_LIVE_PREVIEW_DEFER_MS)
    }
  }, [content?.body, content?.path, livePreview, pendingJumpLocation?.path])

  useEffect(() => {
    if (!content) return
    void loadNoteComments(content.path)
  }, [content?.path, loadNoteComments])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: commentDecorationEffect.of({
        comments,
        activeId: activeCommentId
      })
    })
  }, [activeCommentId, comments, content?.path])

  // Toggle Vim / live-preview / line-numbers via compartments.
  useEffect(() => {
    const view = viewRef.current
    const comp = vimCompartmentRef.current
    if (!view || !comp) return
    const effects = [comp.reconfigure(vimMode ? vim() : [])]
    const keymapComp = editorKeymapCompartmentRef.current
    if (keymapComp) effects.push(keymapComp.reconfigure(buildEditorKeymap(vimMode, tabNavOverrides)))
    view.dispatch({ effects })
  }, [vimMode, tabNavOverrides])
  useEffect(() => {
    const view = viewRef.current
    const comp = livePreviewCompartmentRef.current
    if (!view || !comp) return
    if (deferredLivePreviewTimerRef.current != null) {
      if (livePreview) {
        clearTimeout(deferredLivePreviewTimerRef.current)
        deferredLivePreviewTimerRef.current = null
        richMarkdownDeferredRef.current = false
        const effects: StateEffect<unknown>[] = []
        const markdownCompartment = markdownCompartmentRef.current
        const markdownSyntaxCompartment = markdownSyntaxCompartmentRef.current
        if (markdownCompartment) {
          effects.push(markdownCompartment.reconfigure(markdownEditingExtensions()))
        }
        if (markdownSyntaxCompartment) {
          effects.push(
            markdownSyntaxCompartment.reconfigure(markdownSyntaxHighlightExtensions())
          )
        }
        effects.push(comp.reconfigure(wysiwygExtensions(useStore.getState().renderTablesInLivePreview)))
        view.dispatch({ effects })
      }
      return
    }
    view.dispatch({ effects: comp.reconfigure(livePreview ? wysiwygExtensions(useStore.getState().renderTablesInLivePreview) : []) })
  }, [livePreview, renderTablesInLivePreview])
  useEffect(() => {
    const view = viewRef.current
    const comp = lineNumbersCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({ effects: comp.reconfigure(lineNumberExtension(lineNumberMode)) })
  }, [lineNumberMode])
  useEffect(() => {
    const view = viewRef.current
    const comp = wordWrapCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({
      effects: comp.reconfigure(wordWrap ? EditorView.lineWrapping : [])
    })
  }, [wordWrap])
  useEffect(() => {
    const view = viewRef.current
    const comp = scrolloffCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({ effects: comp.reconfigure(scrollOff(editorScrollOff)) })
  }, [editorScrollOff])
  useEffect(() => {
    const view = viewRef.current
    const comp = drawSelectionCompartmentRef.current
    if (!view || !comp) return
    // 0 disables blinking for both the drawn caret and the Vim block cursor
    // (both read cursorBlinkRate from the drawSelection config). (#160)
    view.dispatch({
      effects: comp.reconfigure(
        drawSelection({ cursorBlinkRate: cursorBlink ? 1200 : 0 })
      )
    })
  }, [cursorBlink])

  // Re-measure CM on prefs that change line geometry.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const raf = requestAnimationFrame(() => view.requestMeasure())
    return () => cancelAnimationFrame(raf)
  }, [
    editorFontSize,
    editorLineHeight,
    lineNumberMode,
    textFont,
    mode,
    connectionsOpen,
    content?.path
  ])

  // Scroll sync between editor + preview when split mode is on.
  useEffect(() => {
    if (mode !== 'split' || !content) return
    const editorEl = viewRef.current?.scrollDOM
    const previewEl = previewScrollRef.current
    if (!editorEl || !previewEl) return

    const syncByRatio = (
      source: HTMLElement,
      target: HTMLElement,
      targetKind: 'editor' | 'preview'
    ): void => {
      const nextTop = scrollTopForScrollRatio(
        source.scrollTop,
        source.scrollHeight,
        source.clientHeight,
        target.scrollHeight,
        target.clientHeight
      )
      if (Math.abs(target.scrollTop - nextTop) < 1) return
      if (targetKind === 'editor') ignoreEditorScrollRef.current = true
      else ignorePreviewScrollRef.current = true
      target.scrollTop = nextTop
    }
    const onEditorScroll = (): void => {
      if (ignoreEditorScrollRef.current) {
        ignoreEditorScrollRef.current = false
        return
      }
      if (!canSyncPreviewFromEditorViewport()) return
      syncPreviewToEditorScroll()
    }
    const onPreviewScroll = (): void => {
      if (ignorePreviewScrollRef.current) {
        ignorePreviewScrollRef.current = false
        return
      }
      if (!canSyncPreviewFromEditorViewport()) return
      syncByRatio(previewEl, editorEl, 'editor')
    }
    editorEl.addEventListener('scroll', onEditorScroll, { passive: true })
    previewEl.addEventListener('scroll', onPreviewScroll, { passive: true })
    const raf = requestAnimationFrame(() => {
      if (!canSyncPreviewFromEditorViewport()) return
      syncPreviewToEditorScroll()
    })
    return () => {
      cancelAnimationFrame(raf)
      editorEl.removeEventListener('scroll', onEditorScroll)
      previewEl.removeEventListener('scroll', onPreviewScroll)
      ignoreEditorScrollRef.current = false
      ignorePreviewScrollRef.current = false
      outlinePreviewSyncLockUntilRef.current = 0
    }
  }, [
    canSyncPreviewFromEditorViewport,
    content?.path,
    editorHydration?.path,
    editorHydration?.ready,
    mode,
    syncPreviewToEditorScroll
  ])

  // Apply pendingJumpLocation — only for the active pane.
  useEffect(() => {
    if (!isActive) return
    if (!content || !pendingJumpLocation || pendingJumpLocation.path !== content.path) return
    if (mode === 'preview') {
      applyPaneMode('edit')
      return
    }
    const raf = requestAnimationFrame(() => {
      const view = viewRef.current
      if (!view) return
      const docLength = view.state.doc.length
      const anchor = Math.max(0, Math.min(docLength, pendingJumpLocation.editorSelectionAnchor))
      const head = Math.max(0, Math.min(docLength, pendingJumpLocation.editorSelectionHead))
      const scrollMode = pendingJumpLocation.editorScrollMode ?? 'preserve'
      const highlightEffects = pendingJumpLocation.highlightLine
        ? [taskJumpHighlightEffect.of(anchor)]
        : []
      if (scrollMode === 'preserve') {
        view.dispatch({
          selection: { anchor, head },
          effects: highlightEffects
        })
        view.scrollDOM.scrollTop = pendingJumpLocation.editorScrollTop
      } else {
        view.dispatch({
          selection: { anchor, head },
          effects: [
            EditorView.scrollIntoView(anchor, {
              y: scrollMode,
              yMargin: scrollMode === 'start' ? OUTLINE_JUMP_TOP_MARGIN : 0
            }),
            ...highlightEffects
          ]
        })
      }
      if (pendingJumpLocation.highlightLine) {
        if (taskJumpHighlightTimerRef.current) clearTimeout(taskJumpHighlightTimerRef.current)
        taskJumpHighlightTimerRef.current = setTimeout(() => {
          if (viewRef.current === view) view.dispatch({ effects: taskJumpHighlightEffect.of(null) })
          taskJumpHighlightTimerRef.current = null
        }, TASK_JUMP_HIGHLIGHT_MS)
      }
      previewScrollRef.current?.scrollTo({
        top: pendingJumpLocation.previewScrollTop,
        behavior: 'auto'
      })
      clearPendingJumpLocation()
    })
    return () => cancelAnimationFrame(raf)
  }, [applyPaneMode, isActive, mode, content?.path, clearPendingJumpLocation, pendingJumpLocation])

  useEffect(() => {
    return () => {
      if (taskJumpHighlightTimerRef.current) clearTimeout(taskJumpHighlightTimerRef.current)
    }
  }, [])

  // Focus the CM view when activePane → this pane AND focusedPanel === 'editor'.
  useEffect(() => {
    if (!isActive) return
    if (focusedPanel !== 'editor') return
    // A freshly created note focuses its title-rename field first (#214). That
    // input's onFocus flips focusedPanel to 'editor', which re-runs this effect
    // — don't bounce focus out of the title field and into the body H1. The
    // editor takes focus explicitly once the rename is committed (Enter/Escape).
    const active = document.activeElement
    if (active instanceof HTMLElement && active.dataset.noteTitleInput != null) return
    viewRef.current?.focus()
  }, [isActive, focusedPanel])

  // Flush save on unmount for whatever tab we currently hold. Tracking
  // `activeTab` in a ref keeps the cleanup reading the latest value
  // even though it only runs when the pane unmounts.
  const activeTabRef = useRef<string | null>(activeTab)
  activeTabRef.current = activeTab
  useEffect(() => {
    return () => {
      const path = activeTabRef.current
      if (!path) return
      if (useStore.getState().noteDirty[path]) {
        void persistNote(path)
      }
    }
  }, [persistNote])

  /* ---------- Tab strip DnD ---------- */
  const getTabDropInfo = useCallback(
    (
      payload: DragPayload | null,
      targetPath: string,
      targetEl: HTMLElement,
      clientX: number
    ): { dragPath: string; sourcePaneId?: string; targetPath: string; position: 'before' | 'after' } | null => {
      if (!payload || payload.kind !== 'note') return null
      if (payload.path === targetPath && payload.sourcePaneId === paneId) return null
      const rect = targetEl.getBoundingClientRect()
      return {
        dragPath: payload.path,
        sourcePaneId: payload.sourcePaneId,
        targetPath,
        position: clientX < rect.left + rect.width / 2 ? 'before' : 'after'
      }
    },
    [paneId]
  )

  /* ---------- Pane body DnD ---------- */
  const computePaneEdge = useCallback((clientX: number, clientY: number): PaneEdge => {
    const rect = paneBodyRef.current?.getBoundingClientRect()
    if (!rect) return 'center'
    return inferPaneDropEdge(rect, clientX, clientY)
  }, [])

  const handlePaneBodyDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (hasZenAssetItem(e)) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        setAssetDropActive(true)
        setPaneDropEdge(null)
        setTabDropIndicator(null)
        setImageDropIndicatorTop(null)
        return
      }
      if (hasZenItem(e)) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setPaneDropEdge(tabsEnabled ? computePaneEdge(e.clientX, e.clientY) : 'center')
        setTabDropIndicator(null)
        return
      }
      if (hasImageBlockDragPayload(e.dataTransfer)) {
        const imageBlock = readImageBlockDragPayload(e.dataTransfer)
        const view = viewRef.current
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (imageBlock && view && editorSurfaceRef.current) {
          const placement = getImageBlockDropPlacement(view, imageBlock, {
            x: e.clientX,
            y: e.clientY
          })
          const indicatorRect = placement ? view.coordsAtPos(placement.indicatorPos) : null
          const surfaceRect = editorSurfaceRef.current.getBoundingClientRect()
          setImageDropIndicatorTop(
            indicatorRect ? Math.max(0, indicatorRect.top - surfaceRect.top) : null
          )
        } else {
          setImageDropIndicatorTop(null)
        }
        setPaneDropEdge(null)
        return
      }
      if (!hasDroppedFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      // Show the "drop to attach" border only for importable attachments.
      // Markdown files open as a note (handled at the window level), so they
      // shouldn't flash an import affordance around the current note.
      setAssetDropActive(dragHasAttachmentFile(e.dataTransfer))
      setPaneDropEdge(null)
      setImageDropIndicatorTop(null)
    },
    [computePaneEdge, tabsEnabled]
  )

  const insertImportedAssets = useCallback(
    async (
      imported: ImportedAsset[],
      coords?: { x: number; y: number },
      targetView = viewRef.current
    ) => {
      if (imported.length === 0) return
      const view = targetView
      if (!view) return
      let insertAt = view.state.selection.main.head
      if (coords) insertAt = view.posAtCoords(coords) ?? insertAt
      const doc = view.state.doc
      const before = insertAt > 0 ? doc.sliceString(insertAt - 1, insertAt) : ''
      const after = insertAt < doc.length ? doc.sliceString(insertAt, insertAt + 1) : ''
      const insert = formatImportedAssetsForInsertion(imported, before, after)
      view.dispatch({
        changes: { from: insertAt, to: insertAt, insert },
        selection: { anchor: insertAt + insert.length }
      })
      await refreshNotes()
      setFocusedPanel('editor')
      view.focus()
    },
    [refreshNotes, setFocusedPanel]
  )

  const insertExistingVaultAssets = useCallback(
    async (paths: string[], coords?: { x: number; y: number }) => {
      const byPath = new Map<string, AssetMeta>(assetFiles.map((asset) => [asset.path, asset]))
      const imported = paths
        .map((path) => byPath.get(path))
        .filter((asset): asset is AssetMeta => !!asset)
        .map(importedAssetForExistingVaultAsset)
      await insertImportedAssets(imported, coords)
    },
    [assetFiles, insertImportedAssets]
  )

  const importDroppedFiles = useCallback(
    async (sourcePaths: string[], coords?: { x: number; y: number }) => {
      if (!content || !vault || sourcePaths.length === 0) return
      try {
        const imported = await window.zen.importFilesToNote(content.path, sourcePaths)
        await insertImportedAssets(imported, coords)
      } catch (err) {
        window.alert((err as Error).message)
      }
    },
    [content, insertImportedAssets, vault]
  )

  const importPastedImages = useCallback(
    async (files: File[], view: EditorView) => {
      if (!viewPathRef.current || files.length === 0) return
      try {
        const imported: ImportedAsset[] = []
        for (const file of files) {
          imported.push(await window.zen.importPastedImage(await pastedImageInputFromFile(file)))
        }
        await insertImportedAssets(imported, undefined, view)
        await refreshAssets()
      } catch (err) {
        window.alert((err as Error).message)
      }
    },
    [insertImportedAssets, refreshAssets]
  )
  importPastedImagesRef.current = importPastedImages

  const handlePaneBodyDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (hasZenAssetItem(e)) {
        const payload = readDragPayload(e)
        setAssetDropActive(false)
        setPaneDropEdge(null)
        setImageDropIndicatorTop(null)
        if (!payload || payload.kind !== 'asset') return
        e.preventDefault()
        e.stopPropagation()
        void insertExistingVaultAssets([payload.path], { x: e.clientX, y: e.clientY })
        return
      }
      if (hasZenItem(e)) {
        const payload = readDragPayload(e)
        // With tabs disabled the user explicitly wants single-pane
        // mode — treat every drop as a center drop so splits can't
        // sneak back in through the drag layer.
        const rawEdge = computePaneEdge(e.clientX, e.clientY)
        const edge: PaneEdge = tabsEnabled ? rawEdge : 'center'
        setPaneDropEdge(null)
        if (!payload || payload.kind !== 'note') return
        e.preventDefault()
        e.stopPropagation()
        if (edge === 'center') {
          if (payload.sourcePaneId && payload.sourcePaneId !== paneId) {
            void movePaneTab({
              sourcePaneId: payload.sourcePaneId,
              targetPaneId: paneId,
              path: payload.path
            })
          } else {
            void openNoteInPane(paneId, payload.path)
          }
        } else {
          void splitPaneWithTab({
            targetPaneId: paneId,
            edge,
            path: payload.path,
            sourcePaneId: payload.sourcePaneId
          })
        }
        return
      }
      const imageBlock = readImageBlockDragPayload(e.dataTransfer)
      if (imageBlock) {
        e.preventDefault()
        e.stopPropagation()
        setImageDropIndicatorTop(null)
        if (!content || imageBlock.notePath !== content.path) return
        const view = viewRef.current
        if (!view) return
        moveImageBlockInEditor(view, imageBlock, { x: e.clientX, y: e.clientY })
        return
      }
      const fileDrop = hasDroppedFiles(e.dataTransfer)
      const sourcePaths = droppedPathsFromTransfer(e.dataTransfer)
      setAssetDropActive(false)
      setImageDropIndicatorTop(null)
      if (fileDrop) e.preventDefault()
      if (sourcePaths.length === 0) {
        if (fileDrop) {
          window.alert('Could not read the dropped file path. Restart the app and try again.')
        }
        return
      }
      e.stopPropagation()
      void importDroppedFiles(sourcePaths, { x: e.clientX, y: e.clientY })
    },
    [
      computePaneEdge,
      content,
      importDroppedFiles,
      insertExistingVaultAssets,
      movePaneTab,
      openNoteInPane,
      paneId,
      splitPaneWithTab,
      tabsEnabled
    ]
  )

  const handlePaneBodyDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setPaneDropEdge(null)
    setAssetDropActive(false)
    setImageDropIndicatorTop(null)
  }, [])

  useEffect(() => {
    const clear = (): void => {
      setPaneDropEdge(null)
      setTabDropIndicator(null)
      setAssetDropActive(false)
      setImageDropIndicatorTop(null)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  /* ---------- Tab strip drop-on-strip handler (for dropping onto empty area) ---------- */
  const handleTabStripDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!hasZenItem(e)) return
      const payload = readDragPayload(e)
      if (!payload || payload.kind !== 'note') return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
    },
    []
  )
  const handleTabStripDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!hasZenItem(e)) return
      const payload = readDragPayload(e)
      if (!payload || payload.kind !== 'note') return
      e.preventDefault()
      e.stopPropagation()
      setTabDropIndicator(null)
      if (payload.sourcePaneId && payload.sourcePaneId !== paneId) {
        void movePaneTab({
          sourcePaneId: payload.sourcePaneId,
          targetPaneId: paneId,
          path: payload.path
        })
      } else if (!payload.sourcePaneId) {
        void openNoteInPane(paneId, payload.path)
      }
    },
    [movePaneTab, openNoteInPane, paneId]
  )

  /* ---------- Tab rendering ---------- */
  const tabItems = useMemo(
    () => {
      const pinnedSet = new Set(pinnedTabs)
      return tabs.map((path) => {
        const base = {
          path,
          pinned: pinnedSet.has(path),
          preview: path === previewTab,
          isQuick: false,
          isTasks: false,
          isTag: false,
          isHelp: false,
          isArchive: false,
          isTrash: false,
          isAssetsView: false,
          isAsset: false,
          isDiagram: false,
          isDatabase: false
        }
        if (isTasksTabPath(path)) {
          return {
            ...base,
            title: folderLabels.tasks,
            isTasks: true
          }
        }
        if (isQuickNotesTabPath(path)) {
          return {
            ...base,
            title: folderLabels.quick,
            isQuick: true
          }
        }
        if (isTagsTabPath(path)) {
          return {
            ...base,
            title: 'Tags',
            isTag: true
          }
        }
        if (isHelpTabPath(path)) {
          return {
            ...base,
            title: 'Help',
            isHelp: true
          }
        }
        if (isArchiveTabPath(path)) {
          return {
            ...base,
            title: folderLabels.archive,
            isArchive: true
          }
        }
        if (isTrashTabPath(path)) {
          return {
            ...base,
            title: folderLabels.trash,
            isTrash: true
          }
        }
        if (isAssetsViewTabPath(path)) {
          return {
            ...base,
            title: 'Assets',
            isAssetsView: true
          }
        }
        if (isAssetTabPath(path)) {
          const assetPath = assetPathFromTab(path)
          return {
            ...base,
            title: assetTitleFromPath(assetPath),
            isAsset: true
          }
        }
        if (isDiagramTabPath(path)) {
          return {
            ...base,
            title: diagramTitleFromTabPath(path),
            isDiagram: true
          }
        }
        if (isDatabaseTabPath(path)) {
          return {
            ...base,
            title: databaseTitleFromTab(path),
            isDatabase: true
          }
        }
        const meta = path === content?.path ? content : notes.find((n) => n.path === path)
        const title = meta?.title ?? path.split('/').pop()?.replace(/\.md$/i, '') ?? path
        return {
          ...base,
          title,
        }
      })
    },
    [tabs, pinnedTabs, previewTab, content, notes, folderLabels.quick, folderLabels.archive, folderLabels.trash, folderLabels.tasks]
  )

  const tabMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!tabMenu) return []
    const path = tabMenu.path
    const tabIndex = tabs.indexOf(path)
    const isPinned = pinnedTabs.includes(path)
    const pinnedSet = new Set(pinnedTabs)
    // Closable tabs (everything that isn't pinned) that sit strictly
    // after this tab in the strip.
    const closableRight = tabs
      .slice(tabIndex + 1)
      .filter((t) => !pinnedSet.has(t))
    // Everything that could be closed by "Close Others" — every tab
    // except this one AND any pinned tabs.
    const closableOthers = tabs.filter((t) => t !== path && !pinnedSet.has(t))

    // Tasks tab gets a trimmed menu — no "Pin as Reference", "Reveal in
    // Finder", or floating-window since those only make sense for notes.
    if (isTasksTabPath(path)) {
      return [
        { label: 'Close', onSelect: async () => closeTabInPane(paneId, path) },
        {
          label: 'Close Others',
          disabled: closableOthers.length === 0,
          onSelect: async () => {
            for (const t of closableOthers) await closeTabInPane(paneId, t)
          }
        },
        {
          label: 'Close Tabs to Right',
          disabled: closableRight.length === 0,
          onSelect: async () => {
            for (const t of closableRight) await closeTabInPane(paneId, t)
          }
        },
        { kind: 'separator' },
        {
          label: 'Split Right',
          onSelect: async () =>
            splitPaneWithTab({ targetPaneId: paneId, edge: 'right', path })
        },
        {
          label: 'Split Down',
          onSelect: async () =>
            splitPaneWithTab({ targetPaneId: paneId, edge: 'bottom', path })
        },
        { kind: 'separator' },
        {
          label: 'Refresh',
          onSelect: async () => {
            await useStore.getState().refreshTasks()
          }
        }
      ]
    }

    // Quick Notes, Tags, Help, Archive, and Trash tabs share the same virtual-tab menu shape:
    // close, close relatives, or split them into another pane.
    if (
      isQuickNotesTabPath(path) ||
      isTagsTabPath(path) ||
      isHelpTabPath(path) ||
      isArchiveTabPath(path) ||
      isTrashTabPath(path) ||
      isAssetTabPath(path) ||
      isDiagramTabPath(path) ||
      isDatabaseTabPath(path)
    ) {
      return [
        { label: 'Close', onSelect: async () => closeTabInPane(paneId, path) },
        {
          label: 'Close Others',
          disabled: closableOthers.length === 0,
          onSelect: async () => {
            for (const t of closableOthers) await closeTabInPane(paneId, t)
          }
        },
        {
          label: 'Close Tabs to Right',
          disabled: closableRight.length === 0,
          onSelect: async () => {
            for (const t of closableRight) await closeTabInPane(paneId, t)
          }
        },
        { kind: 'separator' },
        {
          label: 'Split Right',
          onSelect: async () =>
            splitPaneWithTab({ targetPaneId: paneId, edge: 'right', path })
        },
        {
          label: 'Split Down',
          onSelect: async () =>
            splitPaneWithTab({ targetPaneId: paneId, edge: 'bottom', path })
        }
      ]
    }

    const items: ContextMenuItem[] = [
      { label: 'Close', onSelect: async () => closeTabInPane(paneId, path) },
      {
        label: 'Close Others',
        disabled: closableOthers.length === 0,
        onSelect: async () => {
          for (const t of closableOthers) await closeTabInPane(paneId, t)
        }
      },
      {
        label: 'Close Tabs to Right',
        disabled: closableRight.length === 0,
        onSelect: async () => {
          for (const t of closableRight) await closeTabInPane(paneId, t)
        }
      },
      { kind: 'separator' },
      {
        label: isPinned ? 'Unpin Tab' : 'Pin Tab',
        onSelect: async () => {
          toggleTabPin(paneId, path)
        }
      },
      { kind: 'separator' },
      {
        // Clone the tab into a new split to the right — both panes
        // continue to show the note. Omitting sourcePaneId is what
        // tells the store to skip the move-out step.
        label: 'Split Right',
        onSelect: async () =>
          splitPaneWithTab({ targetPaneId: paneId, edge: 'right', path })
      },
      {
        label: 'Split Down',
        onSelect: async () =>
          splitPaneWithTab({ targetPaneId: paneId, edge: 'bottom', path })
      },
      { kind: 'separator' },
      {
        label: 'Pin as Reference',
        onSelect: async () => {
          await useStore.getState().pinReference(path)
        }
      },
      {
        label: 'Open in Floating Window',
        onSelect: async () => {
          await window.zen.openNoteWindow(path)
        }
      }
    ]
    if (window.zen.getAppInfo().runtime === 'desktop' && workspaceMode !== 'remote') {
      items.push({
        label: 'Reveal in File Manager',
        onSelect: async () => window.zen.revealNote(path)
      })
    }
    return items
  }, [tabMenu, tabs, pinnedTabs, paneId, closeTabInPane, splitPaneWithTab, toggleTabPin, workspaceMode])

  const renderTab = useCallback(
    (tab: {
      path: string
      title: string
      pinned: boolean
      preview: boolean
      isQuick: boolean
      isTasks: boolean
      isTag: boolean
      isHelp: boolean
      isArchive: boolean
      isTrash: boolean
      isAssetsView: boolean
      isAsset: boolean
      isDiagram: boolean
    }) => {
      const active = tab.path === activeTab
      const isVirtual =
        tab.isQuick ||
        tab.isTasks ||
        tab.isTag ||
        tab.isHelp ||
        tab.isArchive ||
        tab.isTrash ||
        tab.isAssetsView ||
        tab.isAsset ||
        tab.isDiagram
      return (
        <div
          key={tab.path}
          data-tab-menu-target="true"
          data-tab-pane-id={paneId}
          data-tab-path={tab.path}
          data-tab-active={active ? 'true' : undefined}
          className="relative"
          draggable={!isVirtual}
          onDragStart={(e) => {
            if (isVirtual) {
              e.preventDefault()
              return
            }
            setDragPayload(e, { kind: 'note', path: tab.path, sourcePaneId: paneId })
          }}
          onDragOver={(e) => {
            // Chromium masks `dataTransfer.getData()` for custom MIMEs
            // during dragover, so we can't parse the payload here —
            // fall back to `hasZenItem()` which only reads `types`.
            if (!hasZenItem(e)) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            const rect = e.currentTarget.getBoundingClientRect()
            const position: 'before' | 'after' =
              e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
            setTabDropIndicator({ path: tab.path, position })
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            setTabDropIndicator((cur) => (cur?.path === tab.path ? null : cur))
          }}
          onDrop={(e) => {
            const info = getTabDropInfo(readDragPayload(e), tab.path, e.currentTarget, e.clientX)
            setTabDropIndicator(null)
            if (!info) return
            e.preventDefault()
            e.stopPropagation()
            if (info.sourcePaneId === paneId) {
              reorderTabInPane(paneId, info.dragPath, info.targetPath, info.position)
            } else if (info.sourcePaneId) {
              const insertIndex =
                info.position === 'after'
                  ? tabs.indexOf(info.targetPath) + 1
                  : tabs.indexOf(info.targetPath)
              void movePaneTab({
                sourcePaneId: info.sourcePaneId,
                targetPaneId: paneId,
                path: info.dragPath,
                insertIndex
              })
            } else {
              const insertIndex =
                info.position === 'after'
                  ? tabs.indexOf(info.targetPath) + 1
                  : tabs.indexOf(info.targetPath)
              void openNoteInPane(paneId, info.dragPath, insertIndex)
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setTabMenu({ x: e.clientX, y: e.clientY, path: tab.path })
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
            }
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              void closeTabInPane(paneId, tab.path)
            }
          }}
        >
          {tabDropIndicator?.path === tab.path && (
            <div
              className={[
                'pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded-full bg-accent',
                tabDropIndicator.position === 'before' ? '-left-0.5' : '-right-0.5'
              ].join(' ')}
            />
          )}
          <div
            className={[
              // Flat, full-height segmented tabs (VS Code-style): right-border
              // separators, no rounded tops; the active tab is filled. (#185)
              'group relative flex h-full min-h-8 min-w-0 items-center gap-1.5 border-r border-paper-300/60 px-[var(--z-tab-pad-x)] text-sm transition-colors',
              tab.pinned ? 'max-w-[140px]' : 'max-w-[220px]',
              active && isActive
                ? focusedPanel === 'tabs'
                  ? 'bg-paper-200 font-medium text-ink-900 ring-1 ring-inset ring-accent/60'
                  : 'bg-paper-200 font-medium text-ink-900'
                : active
                  ? 'bg-paper-200/70 text-ink-700'
                  : 'text-ink-500 hover:bg-paper-200/40 hover:text-ink-900'
            ].join(' ')}
          >
            {tab.pinned && (
              <button
                type="button"
                aria-label={`Unpin ${tab.title}`}
                title="Unpin tab"
                onClick={() => unpinTabInPane(paneId, tab.path)}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-accent transition-colors hover:bg-paper-200"
              >
                <PinIcon width={11} height={11} />
              </button>
            )}
            <button
              onClick={() => void focusTabInPane(paneId, tab.path)}
              onDoubleClick={() => {
                if (tab.preview) promoteTabInPane(paneId, tab.path)
              }}
              title={tab.preview ? `${tab.title} — preview (double-click to keep open)` : undefined}
              className="flex min-w-0 flex-1 items-center gap-1.5 truncate px-1.5 text-left"
            >
              {tab.isTasks && (
                <CheckSquareIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isQuick && (
                <ZapIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isTag && (
                <TagIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isHelp && (
                <DocumentIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isArchive && (
                <ArchiveIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isTrash && (
                <TrashIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isAssetsView && (
                <PaperclipIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isAsset && (
                <DocumentIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              {tab.isDiagram && (
                <DocumentIcon width={13} height={13} className="shrink-0 text-accent" />
              )}
              <span className={['min-w-0 flex-1 truncate', tab.preview ? 'italic' : ''].join(' ')}>
                {tab.title}
              </span>
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={() => void closeTabInPane(paneId, tab.path)}
              className={[
                // The active tab keeps its close affordance; inactive tabs
                // reveal it on hover/focus (VS Code convention). (#185)
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition',
                active
                  ? 'text-ink-500 hover:bg-paper-200 hover:text-ink-900'
                  : 'opacity-0 hover:bg-paper-300/70 group-hover:opacity-100 focus-visible:opacity-100'
              ].join(' ')}
            >
              <CloseIcon width={12} height={12} />
            </button>
          </div>
        </div>
      )
    },
    [
      activeTab,
      closeTabInPane,
      focusTabInPane,
      focusedPanel,
      getTabDropInfo,
      isActive,
      movePaneTab,
      openNoteInPane,
      paneId,
      promoteTabInPane,
      reorderTabInPane,
      tabDropIndicator,
      tabs,
      unpinTabInPane
    ]
  )

  const openCommentCount = useMemo(
    () => comments.filter((comment) => comment.resolvedAt == null).length,
    [comments]
  )

  const toolbar = useMemo(() => {
    if (!content) return null
    const folder = content.folder
    // Excalidraw drawings only get the file-level actions (archive/trash) — the
    // Markdown-specific controls (edit/split/preview, connections, comments,
    // outline, calendar, PDF export) don't apply to a canvas.
    const isDrawing = isExcalidrawPath(content.path)
    return (
      <div className="flex items-center gap-1 text-ink-500">
        {!isDrawing && (
          <>
            <ToggleGroup mode={mode} onChange={applyPaneMode} />
            <div className="mx-2 h-4 w-px bg-paper-300" />
            <IconBtn
              title={connectionsOpen ? 'Hide connections' : 'Show connections'}
              active={connectionsOpen}
              onClick={toggleConnectionsPanel}
            >
              <PanelRightIcon />
            </IconBtn>
            <IconBtn
              title={
                commentsOpen
                  ? 'Hide comments'
                  : `Show comments${openCommentCount > 0 ? ` (${openCommentCount})` : ''}`
              }
              active={commentsOpen}
              onClick={toggleCommentsPanel}
            >
              <FeedbackIcon />
            </IconBtn>
            <IconBtn
              title={outlineOpen ? 'Hide outline' : 'Show outline'}
              active={outlineOpen}
              onClick={toggleOutlinePanel}
            >
              <ListTreeIcon />
            </IconBtn>
            {calendarAvailable && (
              <IconBtn
                title={calendarOpen ? 'Hide calendar' : 'Show calendar'}
                active={calendarOpen}
                onClick={toggleCalendarPanel}
              >
                <CalendarIcon />
              </IconBtn>
            )}
            <IconBtn title="Export as PDF (⇧⌘E)" onClick={() => void exportActiveNotePdf()}>
              <FileDownIcon />
            </IconBtn>
          </>
        )}
        {folder === 'trash' ? (
          <IconBtn title="Restore" onClick={() => void restoreActive()}>
            <ArrowUpRightIcon />
          </IconBtn>
        ) : folder === 'archive' ? (
          <IconBtn title="Unarchive" onClick={() => void unarchiveActive()}>
            <ArrowUpRightIcon />
          </IconBtn>
        ) : (
          <IconBtn title={folderLabels.archive} onClick={() => void archiveActive()}>
            <ArchiveIcon />
          </IconBtn>
        )}
        <IconBtn title={`Move to ${folderLabels.trash.toLowerCase()}`} onClick={() => void trashActive()}>
          <TrashIcon />
        </IconBtn>
      </div>
    )
  }, [
    content,
    mode,
    applyPaneMode,
    connectionsOpen,
    toggleConnectionsPanel,
    commentsOpen,
    openCommentCount,
    toggleCommentsPanel,
    outlineOpen,
    toggleOutlinePanel,
    calendarAvailable,
    calendarOpen,
    toggleCalendarPanel,
    trashActive,
    archiveActive,
    restoreActive,
    unarchiveActive,
    exportActiveNotePdf
  ])

  const showEditor = !!content && mode !== 'preview'
  const showPreview = !!content && mode !== 'edit'
  const splitMode = mode === 'split'
  const hasTabs = !zenMode && tabsEnabled && tabs.length > 0
  const tabStripMeasureKey = useMemo(
    () =>
      tabItems
        .map((tab) => `${tab.path}\u0000${tab.title}\u0000${tab.pinned ? '1' : '0'}`)
        .join('\u0001'),
    [tabItems]
  )

  useLayoutEffect(() => {
    if (!hasTabs || wrapTabs) {
      setTabStripOverflowing(false)
      return
    }

    const el = tabStripRef.current
    if (!el) return

    const measure = (): void => {
      const next = isTabStripOverflowing(el)
      setTabStripOverflowing((current) => (current === next ? current : next))
    }

    measure()

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (observer) {
      observer.observe(el)
      for (const child of Array.from(el.children)) {
        observer.observe(child)
      }
    }
    window.addEventListener('resize', measure)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [hasTabs, wrapTabs, tabStripMeasureKey])

  // Keep the active tab scrolled into view in the horizontally-scrolling strip,
  // so switching tabs (e.g. via the keyboard) never leaves it off-screen. (#185)
  useEffect(() => {
    if (!hasTabs || wrapTabs || !activeTab) return
    const el = tabStripRef.current?.querySelector<HTMLElement>('[data-tab-active="true"]')
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeTab, hasTabs, wrapTabs, tabStripMeasureKey])

  // Outer header holds the back/forward nav buttons + the (flex-1) tab strip.
  const tabStripHeaderClass = [
    'glass-header flex shrink-0 items-stretch border-b border-paper-300/70 pl-1',
    wrapTabs ? 'min-h-[var(--z-tab-height)]' : 'h-[var(--z-tab-height)]'
  ].join(' ')
  const tabStripClass = [
    'workspace-tab-strip flex min-w-0 flex-1 items-stretch gap-0',
    wrapTabs
      ? 'min-h-[var(--z-tab-height)] flex-wrap content-start overflow-x-hidden overflow-y-visible'
      : `h-[var(--z-tab-height)] ${tabStripOverflowing ? 'overflow-x-auto' : 'overflow-x-hidden'} overflow-y-hidden`
  ].join(' ')
  const deferEditorHydration = shouldDeferEditorHydration(
    showEditor,
    mode,
    content?.body.length ?? 0,
    LARGE_DOC_LIVE_PREVIEW_DEFER_CHARS
  )
  const editorReady = isEditorReadyForContent(
    content != null,
    showEditor,
    deferEditorHydration,
    content?.path ?? null,
    editorHydration
  )
  const previewSourceMarkdown = showPreview ? content?.body ?? '' : ''
  const previewSettleKey = showPreview && content ? content.path : ''
  const { settledMarkdown: previewMarkdown, isStale: previewIsStale } = useSettledMarkdown(
    previewSourceMarkdown,
    splitMode ? 75 : 0,
    previewSettleKey
  )
  modeRef.current = mode
  hasContentRef.current = content != null
  previewIsStaleRef.current = previewIsStale

  const handlePreviewRequestEdit = useCallback(() => {
    if (mode === 'preview') {
      applyPaneMode('edit')
      return
    }
    focusEditorNormalMode()
  }, [applyPaneMode, mode])

  // Track the topmost-visible heading and surface it as the active
  // outline item. We listen on whichever surface is the user's scroll
  // target for the current mode — split mode follows the editor since
  // that's where typing happens.
  useEffect(() => {
    if (!outlineOpen) {
      setActiveOutlineLineSafely(null)
      return
    }
    if (mode === 'preview') return
    const view = viewRef.current
    if (!view) return
    const dom = view.scrollDOM
    const handler = (): void => scheduleActiveOutlineUpdate(computeActiveFromEditor)
    dom.addEventListener('scroll', handler, { passive: true })
    handler()
    return () => {
      dom.removeEventListener('scroll', handler)
      if (activeOutlineFrameRef.current != null) {
        cancelAnimationFrame(activeOutlineFrameRef.current)
        activeOutlineFrameRef.current = null
      }
    }
  }, [
    computeActiveFromEditor,
    content?.path,
    mode,
    outlineItems,
    outlineOpen,
    scheduleActiveOutlineUpdate,
    setActiveOutlineLineSafely
  ])

  useEffect(() => {
    if (!outlineOpen) return
    if (mode !== 'preview') return
    const dom = previewScrollRef.current
    if (!dom) return
    const handler = (): void => scheduleActiveOutlineUpdate(computeActiveFromPreview)
    dom.addEventListener('scroll', handler, { passive: true })
    // Wait a frame so the preview has had a chance to render headings
    // for the current `previewMarkdown` before we measure.
    const initial = requestAnimationFrame(() => computeActiveFromPreview())
    return () => {
      cancelAnimationFrame(initial)
      dom.removeEventListener('scroll', handler)
      if (activeOutlineFrameRef.current != null) {
        cancelAnimationFrame(activeOutlineFrameRef.current)
        activeOutlineFrameRef.current = null
      }
    }
  }, [
    computeActiveFromPreview,
    content?.path,
    mode,
    outlineItems,
    outlineOpen,
    previewMarkdown,
    scheduleActiveOutlineUpdate
  ])

  // Remember this tab's scroll position as the user scrolls, so switching
  // away and back (e.g. opening another note or a diagram in a tab) restores
  // it instead of snapping to the top. This intentionally uses a layout
  // effect: its cleanup runs before the next tab's doc-sync layout effect
  // resets the shared CodeMirror scroller to 0, so the outgoing tab cannot be
  // overwritten by that programmatic reset.
  useLayoutEffect(() => {
    const path = content?.path
    if (!path) return
    const editorEl = editorReady ? viewRef.current?.scrollDOM ?? null : null
    const previewEl = previewScrollRef.current
    if (!editorEl && !previewEl) return

    let frame = 0
    const captureNow = (): void => {
      frame = 0
      const prev = recallTabScroll(path)
      const view = viewRef.current
      const selection =
        view && viewPathRef.current === path ? view.state.selection.main : null
      const next: TabScrollPosition = {
        // Keep the other surface's value when one isn't mounted (e.g.
        // preview-only mode has no editor scroller), so we don't clobber it.
        editor: editorEl?.scrollTop ?? prev?.editor ?? 0,
        preview: previewEl?.scrollTop ?? prev?.preview ?? 0
      }
      if (selection) {
        next.editorSelectionAnchor = selection.anchor
        next.editorSelectionHead = selection.head
      }
      rememberTabScroll(path, next)
    }
    const scheduleCapture = (): void => {
      if (frame) return
      frame = requestAnimationFrame(captureNow)
    }
    editorEl?.addEventListener('scroll', scheduleCapture, { passive: true })
    previewEl?.addEventListener('scroll', scheduleCapture, { passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      captureNow()
      editorEl?.removeEventListener('scroll', scheduleCapture)
      previewEl?.removeEventListener('scroll', scheduleCapture)
    }
  }, [content?.path, mode, editorReady])

  // Restore a note tab's remembered editor state on (re)activation. Keyed on the
  // active path, which flips note → (diagram tab) → note even though the
  // editor view's own `pathChanged` does not — that's why opening a diagram
  // in a tab and returning otherwise snapped the note to the top. Runs after
  // the doc-sync effect dispatches the body so the editor selection and scroll
  // are restored before paint; the preview is restored best-effort now and
  // again from `onRendered` once async diagrams settle. Explicit jumps own the
  // scroll, so defer to a matching `pendingJumpLocation`.
  useLayoutEffect(() => {
    const path = content?.path ?? null
    // Only act on a genuine activation (path change). The `pendingJumpLocation`
    // dep keeps this closure's value fresh, but its later clearing must not
    // re-trigger a restore that would clobber an explicit jump.
    if (path === lastRestoredPathRef.current) return
    lastRestoredPathRef.current = path
    previewRestoreTargetRef.current = null
    lastProgrammaticPreviewTopRef.current = null
    if (!path || pendingJumpLocation?.path === path) return
    const remembered = recallTabScroll(path)
    if (!remembered) return

    const applyEditor = (): void => {
      const view = viewRef.current
      if (!view) return
      let restoredHead: number | null = null
      if (
        remembered.editorSelectionAnchor != null &&
        remembered.editorSelectionHead != null
      ) {
        const docLength = view.state.doc.length
        const anchor = Math.max(
          0,
          Math.min(docLength, remembered.editorSelectionAnchor)
        )
        const head = Math.max(
          0,
          Math.min(docLength, remembered.editorSelectionHead)
        )
        restoredHead = head
        const current = view.state.selection.main
        if (current.anchor !== anchor || current.head !== head) {
          view.dispatch({ selection: { anchor, head } })
        }
      }
      view.scrollDOM.scrollTop = remembered.editor
      if (remembered.editor <= 0 && restoredHead != null) {
        const cursor = view.coordsAtPos(restoredHead)
        const scroller = view.scrollDOM.getBoundingClientRect()
        if (!cursor || cursor.bottom < scroller.top || cursor.top > scroller.bottom) {
          view.dispatch({ effects: EditorView.scrollIntoView(restoredHead, { y: 'center' }) })
        }
      }
    }
    applyEditor()
    const raf = requestAnimationFrame(applyEditor)
    const postFocusTimeout = window.setTimeout(applyEditor, 0)

    if (remembered.preview > 0) {
      previewRestoreTargetRef.current = { path, top: remembered.preview }
      const previewEl = previewScrollRef.current
      if (previewEl) {
        previewEl.scrollTop = remembered.preview
        lastProgrammaticPreviewTopRef.current = previewEl.scrollTop
      }
    }
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(postFocusTimeout)
    }
  }, [content?.path, pendingJumpLocation?.path])

  const paneFrameClass = [
    'relative flex min-h-0 min-w-0 flex-1 flex-col',
    isActive ? '' : 'opacity-[0.98]'
  ].join(' ')

  return (
    <section
      ref={paneRootRef}
      data-pane-id={paneId}
      className={paneFrameClass}
      onMouseDownCapture={() => {
        setActivePane(paneId)
        setFocusedPanel('editor')
      }}
      onFocusCapture={() => {
        setActivePane(paneId)
        setFocusedPanel('editor')
      }}
    >
      {hasTabs && (
        <div className={tabStripHeaderClass}>
          <div className="flex shrink-0 items-center gap-0.5 self-center">
            {!sidebarOpen && (
              <IconBtn
                title="Show sidebar (⌘1)"
                onClick={toggleSidebar}
                tooltipAlign="left"
              >
                <PanelLeftIcon width={16} height={16} />
              </IconBtn>
            )}
            <IconBtn
              title={`Go back (${getKeymapDisplay(
                tabNavOverrides,
                vimMode ? 'vim.historyBack' : 'global.historyBack'
              )})`}
              onClick={() => void jumpToPreviousNote()}
              disabled={!canGoBack}
              tooltipAlign="left"
            >
              <ArrowLeftIcon width={16} height={16} />
            </IconBtn>
            <IconBtn
              title={`Go forward (${getKeymapDisplay(
                tabNavOverrides,
                vimMode ? 'vim.historyForward' : 'global.historyForward'
              )})`}
              onClick={() => void jumpToNextNote()}
              disabled={!canGoForward}
              tooltipAlign="left"
            >
              <ArrowRightIcon width={16} height={16} />
            </IconBtn>
          </div>
          <div
            ref={tabStripRef}
            className={tabStripClass}
            onDragOver={handleTabStripDragOver}
            onDrop={handleTabStripDrop}
          >
            {tabItems.map((tab, i) => {
            // Draw a subtle vertical separator between the last pinned
            // tab and the first unpinned one (VSCode convention). The
            // separator is a flex sibling, not a wrapper, so drag hit-
            // detection on the tab itself is unchanged.
            const prevPinned = i > 0 ? tabItems[i - 1].pinned : false
            const needsSeparator = prevPinned && !tab.pinned
            return (
              <Fragment key={tab.path}>
                {needsSeparator && (
                  <div
                    aria-hidden
                    className="mx-0.5 h-5 shrink-0 self-center border-l border-paper-300/70"
                  />
                )}
                {renderTab(tab)}
              </Fragment>
            )
          })}
          </div>
        </div>
      )}
      {content && !zenMode && (
        <header className="glass-header flex h-12 shrink-0 items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Breadcrumb
              note={content}
              autoFocus={isActive && pendingTitleFocusPath === content.path}
              onAutoFocusHandled={clearPendingTitleFocus}
              onRename={(next) => {
                if (next && next !== content.title) void renameActive(next)
              }}
            />
            {isDirty && (
              <span
                aria-label="Unsaved changes"
                title="Unsaved changes"
                className="ml-2 h-2 w-2 rounded-full bg-accent/80"
              />
            )}
          </div>
          {toolbar}
        </header>
      )}
      <div className="min-h-0 min-w-0 flex flex-1">
        <div
          ref={paneBodyRef}
          className={[
            'relative flex min-h-0 min-w-0 flex-1 flex-col',
            paneDropEdge && paneDropEdge !== 'center' ? 'bg-accent/4' : ''
          ].join(' ')}
          onDragOver={handlePaneBodyDragOver}
          onDragLeave={handlePaneBodyDragLeave}
          onDrop={handlePaneBodyDrop}
        >
          {paneDropEdge && <PaneDropOverlay edge={paneDropEdge} />}
          {assetDropActive && (
            <div className="pointer-events-none absolute inset-3 z-20 rounded-xl border-2 border-dashed border-accent/55 bg-accent/8" />
          )}
          {isTasksTabPath(activeTab) ? (
            <TasksView />
          ) : isQuickNotesTabPath(activeTab) ? (
            <QuickNotesView />
          ) : isTagsTabPath(activeTab) ? (
            <TagView />
          ) : isHelpTabPath(activeTab) ? (
            <HelpView />
          ) : isArchiveTabPath(activeTab) ? (
            <ArchiveView />
          ) : isTrashTabPath(activeTab) ? (
            <TrashView />
          ) : isAssetsViewTabPath(activeTab) ? (
            <AssetsView />
          ) : activeTab && isAssetTabPath(activeTab) ? (
            isDatabaseCsvPath(assetPathFromTab(activeTab) ?? '') ? (
              <DatabaseView
                tabPath={databaseTabPath(assetPathFromTab(activeTab) as string)}
                isActive={isActive}
              />
            ) : (
              <AssetTabView tabPath={activeTab} vaultRoot={vault?.root ?? null} />
            )
          ) : activeTab && isDiagramTabPath(activeTab) ? (
            <LazyDiagramTabView diagram={diagramFromTabPath(activeTab)} />
          ) : activeTab && isDatabaseTabPath(activeTab) ? (
            <DatabaseView tabPath={activeTab} isActive={isActive} />
          ) : activeTab && isExcalidrawPath(activeTab) ? (
            <LazyExcalidrawView path={activeTab} />
          ) : activeTab &&
            content &&
            (isObsidianExcalidrawPath(activeTab) ||
              isObsidianExcalidrawMarkdown(content.body)) ? (
            <ObsidianExcalidrawPrompt path={activeTab} />
          ) : content ? (
            <div
              className={[
                'min-h-0 min-w-0 flex-1 overflow-hidden',
                splitMode ? 'flex flex-row' : 'flex flex-col'
              ].join(' ')}
            >
              <div
                ref={editorSurfaceRef}
                className={[
                  'relative min-h-0 min-w-0',
                  splitMode
                    ? 'flex min-w-0 flex-[1.05] flex-col border-r border-paper-300/70'
                    : 'flex flex-1 flex-col'
                ].join(' ')}
                style={{ display: showEditor ? 'flex' : 'none' }}
                onContextMenu={(e) => {
                  // Native browser context menu in Electron is threadbare
                  // (no Copy/Cut/Paste unless dev tools are open), so we
                  // roll our own using CodeMirror's selection state.
                  const view = viewRef.current
                  if (!view) return
                  e.preventDefault()
                  view.focus()
                  const sel = view.state.selection.main
                  setSelectionCommentAction(null)
                  setEditorMenu({
                    x: e.clientX,
                    y: e.clientY,
                    hasSelection: !sel.empty
                  })
                }}
                >
                  {imageDropIndicatorTop != null && (
                  <div
                    className="pointer-events-none absolute inset-x-4 z-20"
                    style={{ top: imageDropIndicatorTop }}
                  >
                    <div className="relative h-0.5 rounded-full bg-accent shadow-[0_0_0_1px_rgb(var(--z-accent)/0.18)]">
                      <div className="absolute -left-1.5 -top-1 h-2.5 w-2.5 rounded-full border border-paper-50/70 bg-accent" />
                      </div>
                    </div>
                  )}
                  {editorReady ? (
                    <div
                      ref={setContainerRef}
                      className={[
                        'min-h-0 min-w-0 flex-1',
                        // WYSIWYG styling (code-block cards, etc.) is gated on
                        // the same `livePreview` condition that loads the
                        // wysiwyg plugins, so CSS and plugins stay in lockstep.
                        livePreview ? 'cm-wysiwyg' : ''
                      ].join(' ')}
                    />
                  ) : (
                    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center text-sm text-ink-400">
                      Preparing editor…
                    </div>
                  )}
                </div>
              {showPreview && (
                <div
                  ref={previewScrollRef}
                  data-preview-scroll
                  tabIndex={0}
                  aria-label="Note preview"
                  className={[
                    'min-h-0 min-w-0 overflow-y-auto outline-none focus:outline-none focus-visible:outline-none',
                    splitMode
                      ? 'flex min-w-0 flex-1 flex-col bg-paper-50/10'
                      : 'flex-1'
                  ].join(' ')}
                >
                  <Preview
                    markdown={previewMarkdown}
                    notePath={content.path}
                    onRequestEdit={handlePreviewRequestEdit}
                    onRendered={handlePreviewRendered}
                  />
                </div>
              )}
            </div>
          ) : loading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-400">
              Loading…
            </div>
          ) : zenMode ? (
            <EmptyPaneState
              sidebarOpen={sidebarOpen}
              zenMode={zenMode}
              onShowSidebar={() => {
                toggleSidebar()
                setFocusedPanel('sidebar')
              }}
            />
          ) : (
            <HomeView
              sidebarOpen={sidebarOpen}
              onShowSidebar={() => {
                toggleSidebar()
                setFocusedPanel('sidebar')
              }}
            />
          )}
        </div>
        {content && connectionsOpen && isActive && !zenMode && <ConnectionsPanel note={content} />}
        {content && commentsOpen && !zenMode && (
          <CommentsPanel
            note={content}
            draft={commentDraft}
            onCaptureDraft={captureCommentDraft}
            onClearDraft={clearCommentDraft}
            onJump={jumpToComment}
          />
        )}
        {content && outlineOpen && !zenMode && (
          <OutlinePanel
            note={content}
            activeLine={activeOutlineLine}
            onJump={jumpToOutlineLine}
          />
        )}
        {content && calendarOpen && calendarAvailable && !zenMode && (
          <CalendarPanel note={content} />
        )}
      </div>
      {content &&
        showEditor &&
        selectionCommentAction &&
        !commentDraft &&
        !zenMode && (
          <EditorSelectionToolbar
            x={selectionCommentAction.x}
            y={selectionCommentAction.y}
            onWrap={(marker) => {
              const view = viewRef.current
              if (view) toggleWrap(view, marker)
            }}
            onLink={() => {
              const view = viewRef.current
              if (view) wrapLink(view)
            }}
            onComment={() => captureCommentDraft()}
            onBlockType={(type) => {
              const view = viewRef.current
              if (view) setBlockType(view, type)
            }}
            onDismiss={() => viewRef.current?.focus()}
          />
        )}
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems}
          onClose={() => setTabMenu(null)}
        />
      )}
      {editorMenu && (
        <ContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          items={buildEditorContextItems(
            viewRef.current,
            editorMenu.hasSelection,
            captureCommentDraft
          )}
          onClose={() => setEditorMenu(null)}
        />
      )}
    </section>
  )
}

function AssetTabView({
  tabPath,
  vaultRoot
}: {
  tabPath: string
  vaultRoot: string | null
}): JSX.Element {
  const assetPath = assetPathFromTab(tabPath)
  const title = assetTitleFromPath(assetPath)
  const assetUrl =
    assetPath && vaultRoot ? window.zen.resolveVaultAssetUrl(vaultRoot, assetPath) : null
  const assetKind = assetPath ? classifyLocalAssetHref(assetPath) ?? 'file' : 'file'
  const canReveal =
    !!assetPath &&
    window.zen.getAppInfo().runtime === 'desktop' &&
    useStore.getState().workspaceMode !== 'remote'

  const body = !assetPath || !assetUrl ? (
    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-400">
      Couldn't resolve asset path.
    </div>
  ) : assetKind === 'image' ? (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-black/5 p-6">
      <img
        src={assetUrl}
        alt={title}
        className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
      />
    </div>
  ) : assetKind === 'video' ? (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-black">
      <video src={assetUrl} controls className="max-h-full max-w-full" />
    </div>
  ) : assetKind === 'audio' ? (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-paper-100/35 p-6">
      <div className="w-full max-w-md rounded-lg border border-paper-300/70 bg-paper-50/80 p-4 shadow-sm">
        <div className="mb-3 truncate text-sm font-medium text-ink-900">{title}</div>
        <audio src={assetUrl} controls className="w-full" />
      </div>
    </div>
  ) : (
    <iframe
      src={assetUrl}
      title={title}
      className="min-h-0 min-w-0 flex-1 border-0 bg-paper-50"
    />
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="glass-header flex h-12 shrink-0 items-center justify-between gap-3 border-b border-paper-300/70 px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink-900">
          <DocumentIcon width={15} height={15} className="shrink-0 text-accent" />
          <span className="truncate">{title}</span>
        </div>
        {canReveal && assetPath && (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs font-medium text-ink-500 hover:bg-paper-200 hover:text-ink-900"
            onClick={() => void window.zen.revealNote(assetPath)}
          >
            Reveal
          </button>
        )}
      </header>
      {body}
    </div>
  )
}

/**
 * Build the right-click menu shown over the editor text. Uses the live
 * CodeMirror view for clipboard / undo / redo / select-all commands.
 */
function HighlightSwatch({ color }: { color: string }): JSX.Element {
  return (
    <span
      className="inline-block h-3.5 w-3.5 rounded-[3px] border border-paper-300"
      style={{ backgroundColor: `rgb(var(--hl-${color}) / 0.7)` }}
    />
  )
}

function buildEditorContextItems(
  view: EditorView | null,
  hasSelection: boolean,
  onAddComment: () => void
): ContextMenuItem[] {
  if (!view) return []

  // "Highlight" group (selection only): default (yellow) via `==`, named colors
  // via `<mark class>`, and a remove action. Shares applyHighlight with ⇧⌘H.
  const highlightItems: ContextMenuItem[] = hasSelection
    ? [
        {
          label: 'Highlight',
          hint: formatKeyToken('Mod+Shift+H'),
          icon: <HighlighterIcon width={14} height={14} />,
          onSelect: async () => applyHighlight(view, 'yellow')
        },
        ...HIGHLIGHT_COLORS.filter((c) => c.id !== 'yellow').map(
          (c): ContextMenuItem => ({
            label: `Highlight: ${c.label}`,
            icon: <HighlightSwatch color={c.id} />,
            onSelect: async () => applyHighlight(view, c.id)
          })
        ),
        {
          label: 'Remove highlight',
          onSelect: async () => applyHighlight(view, 'remove')
        },
        { kind: 'separator' }
      ]
    : []

  const copy = async (): Promise<void> => {
    const sel = view.state.selection.main
    if (sel.empty) return
    const text = view.state.sliceDoc(sel.from, sel.to)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* clipboard may be blocked */
    }
  }

  const cut = async (): Promise<void> => {
    const sel = view.state.selection.main
    if (sel.empty) return
    await copy()
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: '' },
      selection: { anchor: sel.from }
    })
    view.focus()
  }

  const paste = async (): Promise<void> => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    if (!text) return
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length }
    })
    view.focus()
  }

  return [
    {
      label: 'Add comment',
      hint: 'Enter',
      icon: <FeedbackIcon width={14} height={14} />,
      disabled: !hasSelection,
      onSelect: async () => {
        onAddComment()
      }
    },
    { kind: 'separator' },
    ...highlightItems,
    { label: 'Cut', hint: formatKeyToken('Mod+X'), disabled: !hasSelection, onSelect: cut },
    { label: 'Copy', hint: formatKeyToken('Mod+C'), disabled: !hasSelection, onSelect: copy },
    { label: 'Paste', hint: formatKeyToken('Mod+V'), onSelect: paste },
    { kind: 'separator' },
    {
      label: 'Select All',
      hint: formatKeyToken('Mod+A'),
      onSelect: async () => {
        selectAll(view)
        view.focus()
      }
    },
    { kind: 'separator' },
    {
      label: 'Undo',
      hint: formatKeyToken('Mod+Z'),
      onSelect: async () => {
        undo(view)
        view.focus()
      }
    },
    {
      label: 'Redo',
      hint: formatKeyToken('Mod+Shift+Z'),
      onSelect: async () => {
        redo(view)
        view.focus()
      }
    }
  ]
}

function PaneDropOverlay({ edge }: { edge: PaneEdge }): JSX.Element {
  const classByEdge: Record<PaneEdge, string> = {
    center:
      'inset-3 rounded-xl border-2 border-dashed border-accent/65 bg-accent/10 shadow-[inset_0_0_0_1px_rgb(var(--z-accent)/0.22)]',
    left: 'left-3 top-3 bottom-3 w-1/3 rounded-xl border border-accent/55 bg-accent/10',
    right: 'right-3 top-3 bottom-3 w-1/3 rounded-xl border border-accent/55 bg-accent/10',
    top: 'left-3 right-3 top-3 h-1/3 rounded-xl border border-accent/55 bg-accent/10',
    bottom: 'left-3 right-3 bottom-3 h-1/3 rounded-xl border border-accent/55 bg-accent/10'
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className={['absolute', classByEdge[edge]].join(' ')} />
    </div>
  )
}

function EmptyPaneState({
  sidebarOpen,
  zenMode,
  onShowSidebar
}: {
  sidebarOpen: boolean
  zenMode: boolean
  onShowSidebar: () => void
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-md rounded-3xl border border-paper-300/70 bg-paper-50/35 px-6 py-6 text-center shadow-[0_18px_48px_rgba(15,23,42,0.08)] backdrop-blur-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-paper-300/70 bg-paper-100/80 text-ink-600">
          <PanelLeftIcon width={20} height={20} />
        </div>
        <h2 className="mt-4 text-base font-medium text-ink-900">
          {zenMode ? 'Zen mode is on' : sidebarOpen ? 'No note selected' : 'Sidebar hidden'}
        </h2>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          {zenMode
            ? 'Leave Zen mode with ⌘. to bring the rest of the app chrome back.'
            : sidebarOpen
            ? 'Select a note from the sidebar, or create a new one to start writing.'
            : 'Bring the sidebar back to browse your notes, folders, and shortcuts.'}
        </p>
        {!zenMode && !sidebarOpen && (
          <div className="mt-5 flex items-center justify-center">
            <button
              type="button"
              onClick={onShowSidebar}
              className="inline-flex items-center gap-2 rounded-xl border border-paper-300 bg-paper-100 px-3.5 py-2 text-sm font-medium text-ink-900 transition-colors hover:bg-paper-200"
            >
              <PanelLeftIcon width={16} height={16} />
              <span>Show sidebar</span>
              <span className="rounded-md border border-paper-300/80 bg-paper-50/80 px-1.5 py-0.5 font-mono text-xs text-ink-500">
                ⌘1
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  active = false,
  disabled = false,
  tooltipAlign = 'center'
}: {
  children: JSX.Element
  onClick: () => void
  title: string
  active?: boolean
  disabled?: boolean
  /** 'left' anchors the tooltip to the button's left edge so it never spills
   *  off the left of the window (used by the leftmost toolbar buttons). */
  tooltipAlign?: 'center' | 'left'
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      aria-pressed={active}
      className={[
        'group relative flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        disabled
          ? 'cursor-default text-ink-500/40'
          : active
            ? 'bg-paper-200 text-ink-900'
            : 'text-ink-500 hover:bg-paper-200 hover:text-ink-900'
      ].join(' ')}
    >
      <span className="pointer-events-none">{children}</span>
      <span
        className={[
          'pointer-events-none absolute top-full z-30 mt-1.5 hidden whitespace-nowrap rounded-md border border-paper-300 bg-paper-50 px-2 py-1 text-xs font-medium text-ink-800 shadow-panel group-hover:block group-focus-visible:block',
          tooltipAlign === 'left' ? 'left-0' : 'left-1/2 -translate-x-1/2'
        ].join(' ')}
      >
        {title}
      </span>
    </button>
  )
}

function ToggleGroup({
  mode,
  onChange
}: {
  mode: PaneMode
  onChange: (m: PaneMode) => void
}): JSX.Element {
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  return (
    <div className="flex items-center gap-1 rounded-md bg-paper-200/70 p-0.5 text-xs">
      {MODE_OPTIONS.map((option) => {
        const shortcut = getKeymapDisplay(keymapOverrides, option.keymapId)
        return (
          <button
            key={option.mode}
            onClick={() => onChange(option.mode)}
            title={`${option.tooltipLabel} (${shortcut})`}
            aria-label={`${option.tooltipLabel} (${shortcut})`}
            className={[
              'rounded px-2 py-1 transition-colors',
              mode === option.mode
                ? 'bg-paper-50 text-ink-900 shadow-sm'
                : 'text-ink-500 hover:text-ink-800'
            ].join(' ')}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

const INVALID_FILENAME_CHARS = /[/\\:*?"<>|#^\[\]]/

function Breadcrumb({
  note,
  autoFocus,
  onAutoFocusHandled,
  onRename
}: {
  note: { path: string; title: string; folder: NoteFolder }
  autoFocus: boolean
  onAutoFocusHandled: () => void
  onRename: (next: string) => void
}): JSX.Element {
  const setView = useStore((s) => s.setView)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const createAndOpen = useStore((s) => s.createAndOpen)
  const createDrawingAndOpen = useStore((s) => s.createDrawingAndOpen)
  const createFolder = useStore((s) => s.createFolder)
  const [crumbMenu, setCrumbMenu] = useState<{ x: number; y: number; subpath: string } | null>(
    null
  )
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(note.title)
  const [warning, setWarning] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const editingNow = editing || autoFocus

  useEffect(() => setValue(note.title), [note.title])
  useEffect(() => setWarning(''), [note.path])
  // Switching to a different note never inherits a previous note's open rename
  // field. Listed before the autoFocus latch so a freshly created note (path +
  // autoFocus change together) ends up editing.
  useEffect(() => {
    setEditing(false)
  }, [note.path])
  // Enter title-edit mode when a freshly created note requests it (#214).
  // Entering is a one-way latch: when `onAutoFocusHandled` clears the pending
  // flag (autoFocus → false) we must NOT drop out of editing, or the focused
  // input would unmount mid-create and focus would fall back to the body. Only
  // Enter/Escape/blur or a note switch leaves edit mode.
  useEffect(() => {
    if (autoFocus) setEditing(true)
  }, [autoFocus])
  useEffect(() => {
    if (!editingNow) return
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
      if (autoFocus) onAutoFocusHandled()
    })
    return () => cancelAnimationFrame(raf)
  }, [autoFocus, editingNow, onAutoFocusHandled, note.path])

  const topFolder = note.folder
  const segments = noteFolderSubpath(note, vaultSettings)
    .split('/')
    .filter(Boolean)
  const ancestors: { label: string; subpath: string; onClick: () => void }[] = []
  if (!(topFolder === 'inbox' && isPrimaryNotesAtRoot(vaultSettings))) {
    ancestors.push({
      label: getSystemFolderLabel(topFolder, systemFolderLabels),
      subpath: '',
      onClick: () => setView({ kind: 'folder', folder: topFolder, subpath: '' })
    })
  }
  let acc = ''
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg
    const subpath = acc
    ancestors.push({
      label: seg,
      subpath,
      onClick: () => setView({ kind: 'folder', folder: topFolder, subpath })
    })
  }

  const commitRename = (rawValue = value): boolean => {
    setWarning('')
    const trimmed = rawValue.trim()
    if (!trimmed || trimmed === note.title) {
      setValue(note.title)
      return true
    }
    if (INVALID_FILENAME_CHARS.test(trimmed)) {
      setWarning('Invalid characters: # ^ [ ] | \\ : * ? " < >')
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
      return false
    }
    onRename(trimmed)
    return true
  }

  return (
    <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden text-sm text-ink-500">
      {ancestors.map((c, i) => (
        <span key={i} className="flex shrink-0 items-center gap-1">
          <button
            data-crumb-menu=""
            onClick={c.onClick}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setCrumbMenu({ x: e.clientX, y: e.clientY, subpath: c.subpath })
            }}
            className="truncate rounded px-1 hover:bg-paper-200/70 hover:text-ink-800"
            title={`Go to ${c.label} — right-click (or m) to create here`}
          >
            {c.label}
          </button>
          <span className="text-ink-400">›</span>
        </span>
      ))}
      {crumbMenu && (
        <ContextMenu
          x={crumbMenu.x}
          y={crumbMenu.y}
          onClose={() => setCrumbMenu(null)}
          items={[
            {
              label: 'New note',
              onSelect: () =>
                void createAndOpen(topFolder, crumbMenu.subpath, { focusTitle: true })
            },
            {
              label: 'New drawing',
              onSelect: () => void createDrawingAndOpen(topFolder, crumbMenu.subpath)
            },
            {
              label: 'New folder',
              onSelect: async () => {
                const name = await promptApp({
                  title: 'New folder',
                  placeholder: 'Folder name',
                  okLabel: 'Create',
                  validate: (v) => (v.includes('/') ? 'Folder name cannot contain "/"' : null)
                })
                if (!name) return
                const clean = name.trim().replace(/^\/+|\/+$/g, '')
                if (!clean) return
                const next = crumbMenu.subpath ? `${crumbMenu.subpath}/${clean}` : clean
                try {
                  await createFolder(topFolder, next)
                } catch (err) {
                  window.alert((err as Error).message)
                }
              }
            }
          ]}
        />
      )}
      {editingNow ? (
        <input
          ref={inputRef}
          data-note-title-input=""
          spellCheck={false}
          value={value}
          placeholder="Untitled"
          onFocus={() => useStore.getState().setFocusedPanel('editor')}
          onChange={(e) => {
            setValue(e.target.value)
            setWarning('')
          }}
          onBlur={() => {
            if (commitRename()) setEditing(false)
          }}
          onKeyDown={(e) => {
            // While an IME composition is active, Enter confirms the conversion
            // (and Escape cancels it) — don't commit/cancel the rename. (#183)
            if (isImeComposing(e)) return
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              if (!commitRename()) return
              setEditing(false)
              focusEditorNormalMode()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setValue(note.title)
              setWarning('')
              setEditing(false)
              focusEditorNormalMode()
            }
          }}
          title={warning || 'Rename note'}
          aria-invalid={warning ? 'true' : 'false'}
          className={[
            'min-w-[88px] max-w-[360px] rounded px-1.5 py-0.5 text-sm font-semibold text-ink-900 outline-none',
            warning ? 'bg-red-500/12 ring-1 ring-red-500/60' : 'bg-paper-200/60'
          ].join(' ')}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Rename note"
          className="truncate rounded px-1.5 py-0.5 text-sm font-semibold text-ink-900 hover:bg-paper-200/70"
        >
          {note.title || 'Untitled'}
        </button>
      )}
    </div>
  )
}
