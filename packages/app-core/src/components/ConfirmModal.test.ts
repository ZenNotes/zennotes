// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ConfirmModal, type ConfirmOptions } from './ConfirmModal'

let host: HTMLDivElement
let root: Root
const onConfirm = vi.fn()
const onCancel = vi.fn()

beforeEach(() => {
  onConfirm.mockReset()
  onCancel.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function open(options: ConfirmOptions): void {
  act(() => root.render(createElement(ConfirmModal, { options, onConfirm, onCancel })))
}

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-confirm-modal] button')].find(
    (candidate) => candidate.textContent === label
  )!
}

function enter(): void {
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}

describe('ConfirmModal and Enter', () => {
  it('opens a question that deletes on Cancel, so Enter keeps everything', () => {
    open({ title: 'Delete this row?', confirmLabel: 'Delete row', danger: true })
    expect(document.activeElement).toBe(button('Cancel'))

    enter()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('presses the confirm button once it has the focus (Tab, then Enter)', () => {
    open({ title: 'Delete this row?', confirmLabel: 'Delete row', danger: true })
    act(() => button('Delete row').focus())

    enter()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('opens any other question on its confirm button, so Enter confirms as it always did', () => {
    open({ title: 'Move “Plan” to Trash?', confirmLabel: 'Move to Trash' })
    expect(document.activeElement).toBe(button('Move to Trash'))

    enter()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('keeps Enter from the page underneath while it is open', () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    try {
      open({ title: 'Delete this row?', confirmLabel: 'Delete row', danger: true })
      enter()
      expect(behind).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', behind)
    }
  })
})

describe('ConfirmModal as a notice (#1106)', () => {
  it('shows one button, labelled OK, and Enter on it dismisses', () => {
    open({ title: "Couldn't connect to the server", description: 'The server said no.', notice: true })
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-confirm-modal] button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['OK'])
    expect(document.activeElement).toBe(button('OK'))

    enter()

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('dismisses on Escape like any dialog', () => {
    open({ title: "Couldn't connect to the server", notice: true })
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
