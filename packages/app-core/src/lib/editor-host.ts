import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { EditorBounds, EditorHostOptions, EditorHostRegistration } from '../editor'

const hostCompartment = new Compartment()
const mounted = new Set<HostView>()
let active: { options: EditorHostOptions } | null = null
const insetProperty = '--zen-editor-host-bottom-inset'
const nativeTyping = {
  autocorrect: 'on',
  autocapitalize: 'sentences',
  spellcheck: 'true',
  writingsuggestions: 'true'
}
const insetTheme = EditorView.theme({
  '&': { boxSizing: 'border-box', paddingBottom: `var(${insetProperty}, 0px)` }
})

function bounds(rect: DOMRect): EditorBounds {
  const { top, bottom, left, right, width, height } = rect
  return Object.freeze({ top, bottom, left, right, width, height })
}

function inset(value: number | undefined, height: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(value, height))
    : 0
}

class HostView {
  scrollBottom = 0
  private destroyed = false
  private reveal: (() => boolean) | null = null

  constructor(readonly view: EditorView) {
    mounted.add(this)
    if (active?.options.measureBottomInsets) this.refresh()
  }

  update(update: ViewUpdate): void {
    if (active?.options.measureBottomInsets && (update.geometryChanged || update.viewportChanged))
      this.refresh()
  }

  refresh(): void {
    if (this.destroyed) return
    this.view.requestMeasure({
      key: this,
      read: () => {
        const owner = active
        if (this.destroyed) return { owner, layout: 0, scroll: 0 }
        const editor = bounds(this.view.dom.getBoundingClientRect())
        const scroll = bounds(this.view.scrollDOM.getBoundingClientRect())
        try {
          const measured = owner?.options.measureBottomInsets?.(Object.freeze({ editor, scroll }))
          return {
            owner,
            layout: inset(measured?.layout, editor.height),
            scroll: inset(measured?.scroll, scroll.height)
          }
        } catch {
          // Host overlays can disappear during disposal. Do not retain stale clearance.
          return { owner, layout: 0, scroll: 0 }
        }
      },
      write: (measured) => {
        if (this.destroyed || active !== measured.owner) return
        this.scrollBottom = measured.scroll
        const value = active?.options.measureBottomInsets ? `${measured.layout}px` : ''
        if (this.view.dom.style.getPropertyValue(insetProperty) !== value) {
          if (value) this.view.dom.style.setProperty(insetProperty, value)
          else this.view.dom.style.removeProperty(insetProperty)
          // Layout clearance changes the scroll viewport. Measure again before
          // applying its additional margin or revealing the caret.
          this.refresh()
          return
        }
        const reveal = this.reveal
        if (!reveal) return
        // CodeMirror forbids dispatch during the measurement write phase.
        queueMicrotask(() => {
          if (this.destroyed || active !== measured.owner || this.reveal !== reveal) return
          this.reveal = null
          if (reveal())
            this.view.dispatch({
              effects: EditorView.scrollIntoView(this.view.state.selection.main.head, {
                y: 'nearest'
              })
            })
        })
      }
    })
  }

  requestReveal(isCurrent: () => boolean): void {
    this.reveal = isCurrent
    this.refresh()
  }

  reset(): void {
    this.reveal = null
    this.scrollBottom = 0
    this.view.dom.style.removeProperty(insetProperty)
  }

  destroy(): void {
    this.destroyed = true
    this.reset()
    mounted.delete(this)
  }
}

const hostPlugin = ViewPlugin.fromClass(HostView)

function configuration(): Extension {
  return [
    active?.options.nativeTyping ? EditorView.contentAttributes.of(nativeTyping) : [],
    active?.options.measureBottomInsets
      ? [
          insetTheme,
          EditorView.scrollMargins.of((view) => ({
            bottom: view.plugin(hostPlugin)?.scrollBottom ?? 0
          }))
        ]
      : []
  ]
}

function reconfigure(): void {
  for (const host of mounted) {
    host.reset()
    host.view.dispatch({ effects: hostCompartment.reconfigure(configuration()) })
    if (active?.options.measureBottomInsets) host.refresh()
  }
}

/** Part of the editor's initial state, before publication or a first focus. */
export function noteEditorHostExtension(): Extension {
  return [hostCompartment.of(configuration()), hostPlugin]
}

export function installNoteEditorHost(options: EditorHostOptions): EditorHostRegistration {
  const owner = {
    options: {
      nativeTyping: options.nativeTyping,
      measureBottomInsets: options.measureBottomInsets
    }
  }
  active = owner
  reconfigure()
  return {
    refresh: () => {
      if (active === owner) for (const host of mounted) host.refresh()
    },
    dispose: () => {
      if (active !== owner) return
      active = null
      reconfigure()
    }
  }
}

export function requestNoteEditorReveal(view: EditorView, isCurrent: () => boolean): boolean {
  const host = view.plugin(hostPlugin)
  if (!host) return false
  host.requestReveal(isCurrent)
  return true
}
