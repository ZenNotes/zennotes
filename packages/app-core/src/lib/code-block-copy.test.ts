// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyCodeBlockToClipboard,
  enhanceCodeBlockCopy,
  getCodeBlockTextForCopyButton
} from './code-block-copy'

type TestWindow = Omit<Window, 'zen'> & { zen?: Window['zen'] }

const getOptionalWindow = (): TestWindow => window as unknown as TestWindow

afterEach(() => {
  vi.useRealTimers()
  window.localStorage?.clear()
  delete getOptionalWindow().zen
})

describe('code block controls enhancement', () => {
  it('wraps rendered code blocks with one accessible toolbar', () => {
    const root = document.createElement('article')
    root.innerHTML = '<pre><code>const answer = 42;\n</code></pre>'

    enhanceCodeBlockCopy(root)
    enhanceCodeBlockCopy(root)

    const buttons = root.querySelectorAll<HTMLButtonElement>('.zen-code-copy-button')
    const foldButtons = root.querySelectorAll<HTMLButtonElement>('.zen-code-fold-button')
    const code = root.querySelector<HTMLElement>('.zen-code-block pre > code')

    expect(buttons).toHaveLength(1)
    expect(foldButtons).toHaveLength(0)
    expect(buttons[0]?.type).toBe('button')
    expect(buttons[0]?.textContent).toBe('TEXT')
    expect(buttons[0]?.dataset.copyTooltip).toBe('Copy')
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Copy TEXT code block')
    expect(code?.textContent).toBe('const answer = 42;\n')
    expect(getCodeBlockTextForCopyButton(buttons[0]!)).toBe('const answer = 42;\n')
  })

  it('uses an uppercase language flair when the code block has a language', () => {
    const root = document.createElement('article')
    root.innerHTML = '<pre><code class="language-ts">const answer = 42;\n</code></pre>'

    enhanceCodeBlockCopy(root)

    const button = root.querySelector<HTMLButtonElement>('.zen-code-copy-button')
    expect(button?.textContent).toBe('TS')
    expect(button?.dataset.codeLabel).toBe('TS')
    expect(button?.getAttribute('aria-label')).toBe('Copy TS code block')
  })

  it('copies the code text through the Zen clipboard bridge', () => {
    vi.useFakeTimers()
    const writeText = vi.fn()
    getOptionalWindow().zen = {
      clipboardWriteText: writeText
    } as Partial<Window['zen']> as Window['zen']

    const root = document.createElement('article')
    root.innerHTML = '<pre><code>console.log("hi")\n</code></pre>'
    enhanceCodeBlockCopy(root)
    const button = root.querySelector<HTMLButtonElement>('.zen-code-copy-button')!

    expect(copyCodeBlockToClipboard(button)).toBe(true)
    expect(writeText).toHaveBeenCalledWith('console.log("hi")\n')
    expect(button.textContent).toBe('Copied')
    expect(button.dataset.copyState).toBe('copied')
    expect(button.dataset.copyTooltip).toBe('Copied')

    vi.runOnlyPendingTimers()
    expect(button.textContent).toBe('TEXT')
    expect(button.dataset.copyState).toBeUndefined()
    expect(button.dataset.copyTooltip).toBe('Copy')
  })
})
