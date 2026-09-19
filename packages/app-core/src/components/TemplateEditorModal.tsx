/**
 * Create/edit a custom template. The left pane is a CodeMirror editor (with
 * Vim motions when enabled and `{{variable}}` autocomplete); the right pane
 * shows a live render with sample variables substituted. A legend lists the
 * available variables. Esc does not close the modal — it is the Vim
 * normal-mode key — so in-progress work is never lost; use Cancel or Save.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { Compartment, EditorState, type Transaction } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap, tooltips } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap } from '../lib/cm-vim-default-keymap'
import { vimVisualHighlightExtension } from '../lib/cm-vim-visual-highlight'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { autocompletion } from '@codemirror/autocomplete'
import { useStore } from '../store'
import { parseFrontmatter, slugifyTemplateName } from '@shared/template-files'
import { renderTemplate } from '../lib/template-render'
import { resolveCodeLanguage } from '../lib/cm-code-languages'
import { customCodeFenceHighlightExtension } from '../lib/cm-custom-code-languages'
import { markdownLinkExtension } from '../lib/cm-markdown-links'
import { markdownListIndentPlugin } from '../lib/cm-markdown-list-indent'
import { appMarkdownSnippetExtension } from '../lib/markdown-snippets-config'
import { headingFolding } from '../lib/cm-heading-fold'
import { editorTabSize } from '../lib/editor-tab-size'
import { templateVariableSource, TEMPLATE_VARIABLES } from '../lib/cm-template-variables'
import { templateSlashCommandSource, slashCommandRender } from '../lib/cm-slash-commands'
import { calloutTypeSource } from '../lib/cm-callouts'
import { completionKeymapExtension, completionNavKeymap } from '../lib/cm-completion-nav'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

const SKELETON = `---
name: New Template
description:
category: Custom
---
# {{title}}

{{cursor}}
`

// The editor fills whatever height its container gives it: the container is
// what changes between the side-by-side and the stacked layout below.
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    lineHeight: '1.6',
    overflow: 'auto'
  },
  '.cm-content': { padding: '16px' }
})

// Mirror the main editor's highlight (class-based `tok-*`, styled by the app
// stylesheet) instead of `defaultHighlightStyle`, whose inline underline +
// large headings made the YAML frontmatter look like giant setext headings.
const templateHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'tok-heading1' },
  { tag: t.heading2, class: 'tok-heading2' },
  { tag: t.heading3, class: 'tok-heading3' },
  { tag: t.heading4, class: 'tok-heading4' },
  { tag: t.heading5, class: 'tok-heading5' },
  { tag: t.heading6, class: 'tok-heading6' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.strikethrough, class: 'tok-strikethrough' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.monospace, class: 'tok-monospace' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: t.list, class: 'tok-list' },
  { tag: t.meta, class: 'tok-meta' },
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.atom, class: 'tok-atom' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.punctuation, class: 'tok-punct' }
])

export function TemplateEditorModal({
  initialRaw,
  sourcePath,
  onClose
}: {
  initialRaw?: string
  sourcePath?: string
  onClose: () => void
}): JSX.Element {
  const saveCustomTemplate = useStore((s) => s.saveCustomTemplate)
  const vimMode = useStore((s) => s.vimMode)
  const [raw, setRaw] = useState(initialRaw ?? SKELETON)
  const [saving, setSaving] = useState(false)
  const viewRef = useRef<EditorView | null>(null)
  // vimMode is read once at mount; keep it in a ref so the mount callback isn't
  // re-created (which would tear down the editor) when unrelated state changes.
  const vimModeRef = useRef(vimMode)

  const { name, preview } = useMemo(() => {
    const { data, body } = parseFrontmatter(raw)
    const nm = (data.name ?? '').trim()
    return { name: nm, preview: renderTemplate(body, { title: nm || 'Sample Note' }).body }
  }, [raw])

  const setEditorContainer = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      viewRef.current?.destroy()
      viewRef.current = null
      return
    }
    if (viewRef.current) return
    const state = EditorState.create({
      doc: initialRaw ?? SKELETON,
      extensions: [
        appMarkdownSnippetExtension(),
        new Compartment().of(vimModeRef.current ? vim() : []),
        vimVisualHighlightExtension,
        history(),
        drawSelection(),
        editorTabSize(useStore.getState().editorTabSize),
        highlightActiveLine(),
        EditorView.lineWrapping,
        // Parse the leading `---…---` block as YAML frontmatter and the rest as
        // markdown, so the metadata isn't mistaken for setext headings.
        yamlFrontmatter({
          content: markdown({
            base: markdownLanguage,
            codeLanguages: resolveCodeLanguage,
            addKeymap: false
          })
        }),
        customCodeFenceHighlightExtension,
        markdownLinkExtension,
        vimAwareMarkdownKeymap,
        markdownListIndentPlugin,
        headingFolding({
          showLevelLabels: useStore.getState().showHeadingLevelLabels
        }),
        syntaxHighlighting(templateHighlight),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        // Render autocomplete tooltips on <body> so the modal's overflow:hidden
        // doesn't clip the slash / variable dropdowns.
        tooltips({ parent: document.body }),
        autocompletion({
          // See EditorPane: skip the stock keymap so mac `Alt-`` / `Alt-i`
          // don't swallow those characters on AltGr-style layouts (#429).
          defaultKeymap: false,
          override: [templateSlashCommandSource, calloutTypeSource, templateVariableSource],
          activateOnTyping: true,
          icons: false,
          addToOptions: [{ render: slashCommandRender.render, position: 0 }],
          optionClass: (completion) =>
            (completion as { _kind?: string })._kind === 'callout'
              ? 'callout-cmd-option'
              : 'slash-cmd-option'
        }),
        completionNavKeymap,
        completionKeymapExtension,
        keymap.of([
          indentWithTab,
          ...vimAwareDefaultKeymap(vimModeRef.current),
          ...historyKeymap
        ]),
        editorTheme,
        EditorView.updateListener.of((upd) => {
          if (upd.docChanged) setRaw(upd.state.doc.toString())
        })
      ]
    })
    const view = new EditorView({ state, parent: el })
    viewRef.current = view
    requestAnimationFrame(() => view.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const insertVariable = (insert: string): void => {
    const view = viewRef.current
    if (!view) return
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length }
    })
    view.focus()
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await saveCustomTemplate({
        slug: slugifyTemplateName(name || 'template'),
        raw,
        previousSourcePath: sourcePath
      })
      onClose()
    } catch (err) {
      console.error('saveCustomTemplate failed', err)
      setSaving(false)
    }
  }

  return (
    // Esc is the Vim normal-mode key, and backdrop clicks must not discard
    // in-progress work — so this modal closes only via Cancel/Save.
    <Modal
      size="xl"
      layer="popover"
      align="center"
      onClose={onClose}
      closeOnEsc={false}
      closeOnBackdrop={false}
      className="flex flex-col"
      data={{ 'data-template-editor': '' }}
    >
      <div className="flex items-center justify-between border-b border-paper-300/70 px-5 py-3">
        <div className="text-sm font-semibold text-ink-900">
          {sourcePath ? 'Edit template' : 'New template'}
        </div>
        <div className="text-xs text-ink-500">
          {vimMode ? 'Vim · ' : ''}YAML frontmatter + markdown body
        </div>
      </div>
      {/* Side by side from the md breakpoint up; below it (phones, a narrow
          window) the two halves would each be too slim to use, so the editor
          sits above the preview and takes the larger share of the height.
          Decided by the viewport, not the platform. (android#78) */}
      <div className="grid grid-cols-1 md:grid-cols-2" data-template-editor-panes>
        <div
          ref={setEditorContainer}
          className="h-[38vh] overflow-hidden border-b border-paper-300/50 bg-paper-50 md:h-[60vh] md:border-b-0 md:border-r"
        />
        <div className="h-[22vh] overflow-auto whitespace-pre-wrap p-4 font-mono text-sm leading-relaxed text-ink-700 md:h-[60vh]">
          {preview || <span className="text-ink-500">Preview…</span>}
        </div>
      </div>
      {/* One scrolling row of chips when stacked: wrapped, ten chips would
          eat the height the editor just gained. */}
      <div className="flex flex-nowrap items-center gap-x-3 gap-y-1.5 overflow-x-auto border-t border-paper-300/50 bg-paper-50 px-5 py-2.5 md:flex-wrap md:overflow-visible">
        <span className="form-label shrink-0">Variables</span>
        {TEMPLATE_VARIABLES.map((variable) => (
          <button
            key={variable.name}
            type="button"
            title={variable.detail}
            onClick={() => insertVariable(variable.insert)}
            className="shrink-0 rounded-md border border-paper-300/70 bg-paper-100/80 px-2 py-0.5 font-mono text-xs text-ink-700 hover:bg-paper-200 hover:text-ink-900"
          >
            {variable.insert}
          </button>
        ))}
        <span className="shrink-0 text-xs text-ink-500">or type {'{{'} to autocomplete</span>
      </div>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          Save
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
