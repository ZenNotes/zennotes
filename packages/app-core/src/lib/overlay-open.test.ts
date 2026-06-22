// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { isAppOverlayOpen } from './overlay-open'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isAppOverlayOpen', () => {
  it('is false with no overlay in the DOM', () => {
    expect(isAppOverlayOpen()).toBe(false)
  })

  it('is true while a prompt/confirm modal is open', () => {
    const el = document.createElement('div')
    el.setAttribute('data-prompt-modal', '')
    document.body.appendChild(el)
    expect(isAppOverlayOpen()).toBe(true)
  })

  it('is true while a context menu is open', () => {
    const el = document.createElement('div')
    el.setAttribute('data-ctx-menu', '')
    document.body.appendChild(el)
    expect(isAppOverlayOpen()).toBe(true)
  })
})
