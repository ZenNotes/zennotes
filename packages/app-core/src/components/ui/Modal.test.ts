// @vitest-environment jsdom

import { act, createElement, createRef, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Modal, trapDialogTab, useDialogFocus } from './Modal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Modal focus', () => {
  it('claims focus on open and hands it back on close', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()

    const view = mount([
      createElement('button', { key: 'a' }, 'First'),
      createElement('button', { key: 'b' }, 'Second')
    ])
    expect(document.activeElement?.textContent).toBe('First')

    view.unmount()
    expect(document.activeElement).toBe(opener)
  })

  it('prefers an explicit initial focus target', () => {
    const initialFocus = createRef<HTMLInputElement>()
    mount(
      [
        createElement('button', { key: 'a' }, 'First'),
        createElement('input', { key: 'b', ref: initialFocus, placeholder: 'Name' })
      ],
      { initialFocus }
    )
    expect(document.activeElement).toBe(initialFocus.current)
  })

  it('leaves focus content has already claimed inside the panel', () => {
    const own = createRef<HTMLInputElement>()
    mount(
      [
        createElement('button', { key: 'a' }, 'First'),
        createElement(SelfFocusing, { key: 'b', target: own })
      ],
      {}
    )
    expect(document.activeElement).toBe(own.current)
  })

  it('cycles Tab inside the panel instead of leaking to the page behind it', () => {
    mount([
      createElement('button', { key: 'a' }, 'First'),
      createElement('button', { key: 'b' }, 'Last')
    ])
    const [first, last] = [...document.querySelectorAll('[role="dialog"] button')]

    ;(last as HTMLElement).focus()
    act(() => {
      last.dispatchEvent(tab({ shiftKey: false }))
    })
    expect(document.activeElement).toBe(first)

    act(() => {
      first.dispatchEvent(tab({ shiftKey: true }))
    })
    expect(document.activeElement).toBe(last)
  })
})

// Settings draws its own backdrop and panel, so it takes the shell's focus
// behavior through the exported hook instead of through <Modal>. It used to
// have none: the keyboard stayed on the editor behind the open window and
// typing edited the note.
describe('useDialogFocus on a hand-rolled panel', () => {
  function OwnPanel({ focusPanel }: { focusPanel: boolean }): JSX.Element {
    const panel = useRef<HTMLDivElement | null>(null)
    const search = useRef<HTMLInputElement | null>(null)
    useDialogFocus(panel, focusPanel ? panel : search)
    return createElement(
      'div',
      {
        ref: panel,
        role: 'dialog',
        tabIndex: -1,
        'data-own-panel': '',
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => trapDialogTab(e, panel.current)
      },
      createElement('button', { key: 'a' }, 'Category'),
      createElement('input', { key: 'b', ref: search, placeholder: 'Search settings' }),
      createElement('button', { key: 'c' }, 'Done')
    )
  }

  function mountOwnPanel(focusPanel: boolean) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(createElement(OwnPanel, { focusPanel })))
    return () => {
      act(() => root.unmount())
      host.remove()
    }
  }

  it('moves the keyboard off the page into the chosen control, and back on close', () => {
    const editor = document.createElement('textarea')
    document.body.append(editor)
    editor.focus()

    const unmount = mountOwnPanel(false)
    expect((document.activeElement as HTMLInputElement).placeholder).toBe('Search settings')

    unmount()
    expect(document.activeElement).toBe(editor)
  })

  // Touch devices: a focused input would raise the on-screen keyboard over the
  // panel, so the panel itself takes focus.
  it('can land on the panel itself instead of an input', () => {
    const editor = document.createElement('textarea')
    document.body.append(editor)
    editor.focus()

    mountOwnPanel(true)
    expect(document.activeElement).toBe(document.querySelector('[data-own-panel]'))
  })

  it('keeps Tab inside the panel', () => {
    mountOwnPanel(false)
    const stops = [...document.querySelectorAll<HTMLElement>('[data-own-panel] button')]
    const [first, last] = [stops[0], stops[stops.length - 1]]

    last.focus()
    act(() => {
      last.dispatchEvent(tab({ shiftKey: false }))
    })
    expect(document.activeElement).toBe(first)

    act(() => {
      first.dispatchEvent(tab({ shiftKey: true }))
    })
    expect(document.activeElement).toBe(last)
  })
})

function SelfFocusing({ target }: { target: React.RefObject<HTMLInputElement> }): JSX.Element {
  return createElement('input', {
    ref: (node: HTMLInputElement | null) => {
      ;(target as { current: HTMLInputElement | null }).current = node
      node?.focus()
    }
  })
}

function tab(options: { shiftKey: boolean }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
    shiftKey: options.shiftKey
  })
}

function mount(
  children: unknown[],
  props: { initialFocus?: React.RefObject<HTMLElement> } = {}
) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      createElement(
        Modal,
        { onClose: vi.fn(), children: null, ...props },
        ...(children as [])
      )
    )
  )
  return {
    unmount() {
      act(() => root.unmount())
      host.remove()
    }
  }
}
