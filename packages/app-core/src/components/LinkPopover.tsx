/**
 * The link popover: rest the pointer on a `[[wikilink]]` (or press `K` on
 * it) and the note it names opens in a small floating editor over the note
 * you are in, Logseq-style. A link no note answers yet offers to create the
 * note, and the new note opens right there for typing.
 *
 * The editor edits the store's path-keyed `noteContents`, the same buffer
 * every pane and the pinned reference pane use, so an edit here shows up in
 * an open tab of the same note and saves through the same debounced path.
 * The store keeps that buffer alive while the popover shows it (see
 * `linkPopoverHolds`) and saves it on close.
 *
 * Keys: VimNav stands down inside the popover (it is a self-keyed surface),
 * and the popover owns Escape: it closes from Vim normal mode (insert and
 * visual mode get their own Escape first) and hands focus back to whatever
 * had it before, usually the editor the link was in.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Annotation, EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, tooltips } from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { history } from '@codemirror/commands'
import { autocompletion, completionStatus } from '@codemirror/autocomplete'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { wikilinkNoteName } from '@shared/unresolved-links'
import { useStore } from '../store'
import { noteEditingLockExtension, noteEditingSync, refreshNoteEditingLock } from '../lib/note-lifecycle-lock'
import { scrollerClickFocus } from '../lib/cm-scroller-click-focus'
import { vimAwareMarkdownKeymap } from '../lib/cm-vim-default-keymap'
import { isTouchPrimaryDevice, vimImeGuard } from '../lib/cm-vim-ime-guard'
import { vimVisualHighlightExtension } from '../lib/cm-vim-visual-highlight'
import { noteMarkdown } from '../lib/cm-markdown-language'
import { customCodeFenceHighlightExtension } from '../lib/cm-custom-code-languages'
import { markdownLinkExtension } from '../lib/cm-markdown-links'
import { listIndentWidth, markdownListIndentPlugin } from '../lib/cm-markdown-list-indent'
import { livePreviewPlugin } from '../lib/cm-live-preview'
import { sourceRevealExtension } from '../lib/cm-source-reveal'
import { frontmatterStyle, frontmatterTagExtension } from '../lib/cm-frontmatter'
import { slashCommandRender, slashCommandSource } from '../lib/cm-slash-commands'
import { calloutTypeSource } from '../lib/cm-callouts'
import { dateShortcutSource } from '../lib/cm-date-shortcuts'
import { wikilinkBlockSource, wikilinkHeadingSource, wikilinkSource } from '../lib/cm-wikilinks'
import { hashtagSource } from '../lib/cm-hashtag-complete'
import { frontmatterTagSource } from '../lib/cm-frontmatter-tag-complete'
import { completionKeymapExtension, completionNavKeymap } from '../lib/cm-completion-nav'
import { editorTabSize } from '../lib/editor-tab-size'
import { appMarkdownSnippetExtension } from '../lib/markdown-snippets-config'
import { cursorDrawSelection } from '../lib/cm-cursor-blink'
import { formatKeymapBinding, getKeymapBinding, matchesShortcutBinding } from '../lib/keymaps'
import { keyBindingsFor } from '../lib/vim-half-page-keymap'
import { isEditorInsertMode, isEditorVisualMode } from '../lib/vim-nav'
import { linkAnchorOffset, linkCreateDestination } from '../lib/link-popover'
import { getSystemFolderLabel } from '../lib/system-folder-labels'
import {
  openLinkPopoverAtCursor,
  pointerEnteredLinkPopover,
  pointerLeftLinkPopover,
  resetLinkPopoverHover
} from '../lib/link-popover-open'
import { createNoteForLinkInPlace, createNoteFromLinkNow } from '../lib/create-note-from-link'
import { openWikilinkTarget } from '../lib/wikilink-navigation'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { Button, IconButton } from './ui'
import { ArrowUpRightIcon, CloseIcon, LinkIcon } from './icons'
import { buildReferenceKeymap, paperHighlight } from './PinnedReferencePane'

const programmatic = Annotation.define<boolean>()

const OPEN_IN_TAB_BINDING = 'Mod+Enter'

/** Viewport room kept clear around the popover. */
const EDGE = 12
const GAP = 6
const MAX_WIDTH = 520
const MAX_HEIGHT = 440
const MIN_ROOM = 220

interface Placement {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

/** Under the link when there is room, above it otherwise, always on screen. */
function placementFor(rect: { left: number; top: number; bottom: number }): Placement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(MAX_WIDTH, vw - EDGE * 2)
  const left = Math.min(Math.max(EDGE, rect.left - 12), vw - width - EDGE)
  const below = vh - rect.bottom - GAP - EDGE
  const above = rect.top - GAP - EDGE
  if (below >= MIN_ROOM || below >= above) {
    return { left, width, top: rect.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) }
  }
  return { left, width, bottom: vh - rect.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) }
}

export function LinkPopover(): JSX.Element | null {
  const popover = useStore((s) => s.linkPopover)
  const note = useStore((s) =>
    s.linkPopover?.path ? s.notes.find((n) => n.path === s.linkPopover?.path) ?? null : null
  )
  const content = useStore((s) =>
    s.linkPopover?.path ? s.noteContents[s.linkPopover.path] ?? null : null
  )
  const isDirty = useStore((s) =>
    s.linkPopover?.path ? s.noteDirty[s.linkPopover.path] ?? false : false
  )
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const closeLinkPopover = useStore((s) => s.closeLinkPopover)
  const pinLinkPopover = useStore((s) => s.pinLinkPopover)
  const showNoteInLinkPopover = useStore((s) => s.showNoteInLinkPopover)
  const selectedPath = useStore((s) => s.selectedPath)
  const vaultRoot = useStore((s) => s.vault?.root ?? null)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const createRef = useRef<HTMLButtonElement | null>(null)
  // Where the keyboard was before the popover took it; Escape gives it back.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const placement = useMemo(
    () => (popover ? placementFor(popover.anchorRect) : null),
    [popover?.anchorRect]
  )

  const rememberReturnFocus = useCallback(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return
    if (rootRef.current?.contains(active)) return
    if (active === document.body) return
    returnFocusRef.current = active
  }, [])

  const close = useCallback(
    (restoreFocus: boolean) => {
      const hadFocus =
        !!rootRef.current && rootRef.current.contains(document.activeElement)
      resetLinkPopoverHover()
      closeLinkPopover()
      const back = returnFocusRef.current
      returnFocusRef.current = null
      if (!restoreFocus || !hadFocus) return
      // The note editor goes back to Vim normal mode on the cursor it had
      // (CodeMirror keeps the selection while blurred); anything else, such
      // as the Unresolved Links list, just takes focus back.
      const mainView = useStore.getState().editorViewRef
      if (back?.isConnected && !mainView?.dom.contains(back)) {
        back.focus({ preventScroll: true })
        return
      }
      focusEditorNormalMode()
    },
    [closeLinkPopover]
  )

  // A popover is about a link in the note on screen; another note, or
  // another vault, leaves it behind.
  const firstSelected = useRef(selectedPath)
  useEffect(() => {
    if (selectedPath === firstSelected.current) return
    close(false)
  }, [selectedPath, close])
  const firstVault = useRef(vaultRoot)
  useEffect(() => {
    if (vaultRoot === firstVault.current) return
    close(false)
  }, [vaultRoot, close])

  // Keyboard-opened popovers take focus; remember where it came from first.
  useLayoutEffect(() => {
    if (!popover?.focus) return
    rememberReturnFocus()
    if (!popover.path) {
      requestAnimationFrame(() => createRef.current?.focus({ preventScroll: true }))
    }
  }, [popover?.serial, popover?.focus, popover?.path, rememberReturnFocus])

  useEffect(() => {
    setCreateError(null)
    setCreating(false)
  }, [popover?.serial])

  // Outside clicks close a pinned popover; keys typed elsewhere close a
  // hover popover, which is only ever a glance; scrolling the page under a
  // hover popover moves its link away from it.
  useEffect(() => {
    if (!popover) return
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (target && rootRef.current?.contains(target)) return
      // Completion menus of the popover editor render into document.body.
      if ((target as HTMLElement | null)?.closest?.('.cm-tooltip')) return
      close(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as Node | null
      if (target && rootRef.current?.contains(target)) return
      if (useStore.getState().linkPopover?.mode === 'hover') close(false)
    }
    const onScroll = (e: Event): void => {
      const target = e.target as Node | null
      if (target && rootRef.current?.contains(target)) return
      if (useStore.getState().linkPopover?.mode === 'hover') close(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [popover !== null, close])

  const openInTab = useCallback(() => {
    const current = useStore.getState().linkPopover
    if (!current) return
    close(false)
    if (current.path) {
      void openWikilinkTarget(current.path, current.target).then(() => focusEditorNormalMode())
    } else {
      void createNoteFromLinkNow(current.target)
    }
  }, [close])

  const create = useCallback(async () => {
    const current = useStore.getState().linkPopover
    if (!current || current.path || creating) return
    setCreating(true)
    setCreateError(null)
    const path = await createNoteForLinkInPlace(current.target)
    // The popover may have closed while the note was being written.
    if (useStore.getState().linkPopover?.serial !== current.serial) return
    setCreating(false)
    if (path) {
      await showNoteInLinkPopover(path)
      return
    }
    // A weekly or monthly note is made by opening it (its template runs
    // there), so that one link leaves the popover for the main editor.
    const name = wikilinkNoteName(current.target)
    if (name && !/[\\:*?"<>|]/.test(name)) {
      close(false)
      void createNoteFromLinkNow(current.target)
      return
    }
    setCreateError('This link cannot name a note file.')
  }, [close, creating, showNoteInLinkPopover])

  const onKeyDownCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const native = e.nativeEvent
      const state = useStore.getState()
      if (matchesShortcutBinding(native, OPEN_IN_TAB_BINDING)) {
        e.preventDefault()
        e.stopPropagation()
        openInTab()
        return
      }
      if (e.key !== 'Escape' || native.isComposing) return
      const view = viewRef.current
      if (view && view.hasFocus) {
        // An open completion menu, Vim insert or visual mode: their Escape first.
        if (completionStatus(view.state) === 'active') return
        if (isEditorInsertMode(view, state.vimMode) || isEditorVisualMode(view, state.vimMode)) return
      }
      e.preventDefault()
      e.stopPropagation()
      close(true)
    },
    [close, openInTab]
  )

  if (!popover || !placement) return null

  const exists = !!popover.path
  const title = exists
    ? note?.title ?? popover.path!.split('/').pop()!.replace(/\.md$/i, '')
    : wikilinkNoteName(popover.target) || popover.target
  const destination = exists ? null : linkCreateDestination(popover.target)
  const subtitle = exists
    ? popover.path!
    : destination
      ? `Not written yet · new note in ${getSystemFolderLabel(destination.folder, systemFolderLabels)}${destination.subpath ? ` / ${destination.subpath}` : ''}`
      : 'Not written yet'
  const openHint = formatKeymapBinding(OPEN_IN_TAB_BINDING, 'shortcut')

  return createPortal(
    <div
      ref={rootRef}
      data-link-popover=""
      data-link-popover-state={exists ? 'note' : 'missing'}
      data-link-popover-path={popover.path ?? undefined}
      data-link-popover-target={popover.target}
      data-link-popover-mode={popover.mode}
      role="dialog"
      aria-label={`Link popover: ${title}`}
      className="zn-link-popover fixed z-popover flex flex-col overflow-hidden rounded-2xl bg-paper-100 shadow-float ring-1 ring-paper-300/80"
      style={{
        left: placement.left,
        width: placement.width,
        top: placement.top,
        bottom: placement.bottom,
        maxHeight: placement.maxHeight
      }}
      onPointerEnter={pointerEnteredLinkPopover}
      onPointerLeave={pointerLeftLinkPopover}
      onPointerDownCapture={() => {
        rememberReturnFocus()
        pinLinkPopover()
      }}
      onFocusCapture={() => pinLinkPopover()}
      onKeyDownCapture={onKeyDownCapture}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-paper-300/60 px-3 py-2">
        <LinkIcon width={14} height={14} className="mt-1 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-ink-900">{title}</span>
            {exists && isDirty && (
              <span aria-label="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/80" />
            )}
          </div>
          <div className="truncate text-xs text-ink-500">{subtitle}</div>
        </div>
        <IconButton
          size="sm"
          title={exists ? `Open in a tab (${openHint})` : `Create and open in a tab (${openHint})`}
          aria-label={exists ? 'Open in a tab' : 'Create and open in a tab'}
          onClick={openInTab}
          data-link-popover-open=""
        >
          <ArrowUpRightIcon width={14} height={14} />
        </IconButton>
        <IconButton
          size="sm"
          title="Close (Esc)"
          aria-label="Close link popover"
          onClick={() => close(true)}
        >
          <CloseIcon width={14} height={14} />
        </IconButton>
      </header>
      {exists ? (
        content ? (
          <PopoverNoteEditor
            key={popover.path!}
            path={popover.path!}
            target={popover.target}
            focus={popover.focus}
            created={popover.created}
            serial={popover.serial}
            viewRef={viewRef}
            keymapOverrides={keymapOverrides}
          />
        ) : (
          <div className="px-4 py-6 text-sm text-ink-400">Loading…</div>
        )
      ) : (
        <div className="flex flex-col gap-3 px-4 py-4">
          <p className="text-sm text-ink-700">
            No note answers this link yet. Create it and write it here, without leaving the note you are in.
          </p>
          <div className="flex items-center gap-2">
            <Button
              ref={createRef}
              variant="primary"
              onClick={() => void create()}
              disabled={creating}
              data-link-popover-create=""
            >
              {creating ? 'Creating…' : 'Create note'}
            </Button>
            <span className="text-xs text-ink-400">Enter to create · Esc to close</span>
          </div>
          {createError && <p className="text-xs text-danger">{createError}</p>}
        </div>
      )}
    </div>,
    document.body
  )
}

/**
 * The popover's editor, mounted per note. Same building blocks as the pinned
 * reference pane's editor, without its gutters: a popover is a glance and a
 * few lines of writing, not a second workspace.
 */
function PopoverNoteEditor({
  path,
  target,
  focus,
  created,
  serial,
  viewRef,
  keymapOverrides
}: {
  path: string
  target: string
  focus: boolean
  created: boolean
  serial: number
  viewRef: React.MutableRefObject<EditorView | null>
  keymapOverrides: ReturnType<typeof useStore.getState>['keymapOverrides']
}): JSX.Element {
  const content = useStore((s) => s.noteContents[path] ?? null)
  const updateNoteBody = useStore((s) => s.updateNoteBody)
  const pathRef = useRef(path)
  pathRef.current = path

  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        viewRef.current?.destroy()
        viewRef.current = null
        return
      }
      if (viewRef.current) return
      const s0 = useStore.getState()
      const body = s0.noteContents[path]?.body ?? ''
      const state = EditorState.create({
        doc: body,
        extensions: [
          noteEditingLockExtension(() => ({ vault: useStore.getState().vault, path: pathRef.current })),
          appMarkdownSnippetExtension(),
          sourceRevealExtension,
          s0.vimMode ? vim() : [],
          vimImeGuard(() => useStore.getState().vimBlockImeInNormalMode && !isTouchPrimaryDevice()),
          vimVisualHighlightExtension,
          history(),
          scrollerClickFocus,
          cursorDrawSelection(s0.cursorBlink),
          editorTabSize(s0.editorTabSize),
          listIndentWidth(s0.editorTabSize),
          highlightActiveLine(),
          EditorView.lineWrapping,
          noteMarkdown(),
          customCodeFenceHighlightExtension,
          markdownLinkExtension,
          vimAwareMarkdownKeymap,
          markdownListIndentPlugin,
          frontmatterStyle,
          frontmatterTagExtension,
          syntaxHighlighting(paperHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          s0.livePreview ? livePreviewPlugin : [],
          tooltips({ parent: document.body }),
          autocompletion({
            defaultKeymap: false,
            override: [
              slashCommandSource,
              calloutTypeSource,
              dateShortcutSource,
              frontmatterTagSource,
              hashtagSource,
              wikilinkSource,
              wikilinkHeadingSource,
              wikilinkBlockSource
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
          completionKeymapExtension,
          keymap.of([
            // The popover for a link inside the popover replaces this one,
            // so a chain of notes can be followed without leaving the note
            // underneath.
            ...keyBindingsFor(getKeymapBinding(keymapOverrides, 'editor.linkPopover'), (view) =>
              openLinkPopoverAtCursor(view)
            )
          ]),
          buildReferenceKeymap(s0.vimMode, keymapOverrides),
          EditorView.updateListener.of((upd) => {
            if (!upd.docChanged) return
            if (upd.transactions.some((tr: Transaction) => tr.annotation(programmatic))) return
            updateNoteBody(pathRef.current, upd.state.doc.toString())
          })
        ]
      })
      const view = new EditorView({ state, parent: el })
      viewRef.current = view
    },
    // The view is built once per note; the component is keyed by path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Edits made elsewhere (an open tab of the same note, a sync) flow in.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !content) return
    const next = content.body
    if (view.state.doc.toString() === next) return
    const sel = view.state.selection.main
    refreshNoteEditingLock(view)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      annotations: [programmatic.of(true), noteEditingSync.of(true)],
      selection: {
        anchor: Math.min(sel.anchor, next.length),
        head: Math.min(sel.head, next.length)
      }
    })
  }, [content?.body, viewRef])

  // Place the cursor and, when the popover was opened from a key, take the
  // keyboard. A link's anchor wins; a note just created starts at its end,
  // in insert mode, ready for the first sentence.
  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc
    const anchor = linkAnchorOffset(doc.toString(), target)
    const at = anchor ?? (created ? doc.length : 0)
    view.dispatch({
      selection: EditorSelection.cursor(Math.min(at, doc.length)),
      effects: EditorView.scrollIntoView(Math.min(at, doc.length), { y: 'start', yMargin: 8 })
    })
    if (!focus) return
    const raf = requestAnimationFrame(() => {
      view.focus()
      if (created && useStore.getState().vimMode) {
        const cm = getCM(view)
        if (cm && !cm.state.vim?.insertMode) Vim.handleKey(cm, 'a', 'user')
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [serial, focus, created, path, target, viewRef])

  // Unsaved edits are saved by the store as the popover closes; a note
  // switched away from inside the popover saves on its own debounce.
  return (
    <div
      ref={setContainerRef}
      data-link-popover-editor=""
      className="min-h-0 flex-1 overflow-hidden"
    />
  )
}
