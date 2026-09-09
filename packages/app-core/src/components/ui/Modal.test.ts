// @vitest-environment jsdom

import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

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
