const CODE_BLOCK_CLASS = 'zen-code-block'
const CODE_BLOCK_TOOLBAR_CLASS = 'zen-code-block-toolbar'
const CODE_BLOCK_SUMMARY_CLASS = 'zen-code-block-summary'
const CODE_BLOCK_FOLDED_ATTR = 'data-code-folded'
const CODE_BLOCK_INDEX_ATTR = 'data-code-block-index'

export const CODE_COPY_BUTTON_SELECTOR = '.zen-code-copy-button'

const resetTimers = new WeakMap<HTMLButtonElement, number>()

interface CodeBlockEnhanceOptions {
  notePath?: string | null
  copyLabel?: string
  copiedLabel?: string
  failedLabel?: string
  copyFailedLabel?: string
}

export function enhanceCodeBlockCopy(
  root: ParentNode,
  options: CodeBlockEnhanceOptions = {}
): void {
  void options
  const blocks = Array.from(root.querySelectorAll<HTMLPreElement>('pre'))
  let blockIndex = 0

  for (const pre of blocks) {
    const code = pre.firstElementChild
    if (!(code instanceof HTMLElement) || code.tagName.toLowerCase() !== 'code') {
      continue
    }

    const index = blockIndex
    blockIndex += 1
    const wrapper = ensureCodeBlockWrapper(pre)
    wrapper.setAttribute(CODE_BLOCK_INDEX_ATTR, String(index))
    ensureCodeBlockToolbar(wrapper, pre, options)
    removeCodeBlockSummary(wrapper)
    wrapper.setAttribute(CODE_BLOCK_FOLDED_ATTR, 'false')
  }
}

export function getCodeBlockTextForCopyButton(button: Element): string | null {
  const block = button.closest(`.${CODE_BLOCK_CLASS}`)
  const code = block?.querySelector<HTMLElement>('pre > code')
  return code?.textContent ?? null
}

export function copyCodeBlockToClipboard(button: HTMLButtonElement): boolean {
  const text = getCodeBlockTextForCopyButton(button)
  if (text == null) return false

  const copied = writeClipboardText(text)
  setCopyButtonFeedback(button, copied ? 'copied' : 'failed')
  return copied
}

function ensureCodeBlockWrapper(pre: HTMLPreElement): HTMLElement {
  const parent = pre.parentElement
  if (parent?.classList.contains(CODE_BLOCK_CLASS)) return parent

  const wrapper = pre.ownerDocument.createElement('div')
  wrapper.className = CODE_BLOCK_CLASS
  pre.replaceWith(wrapper)
  wrapper.append(pre)
  return wrapper
}

function ensureCodeBlockToolbar(
  wrapper: HTMLElement,
  pre: HTMLPreElement,
  options: CodeBlockEnhanceOptions
): void {
  let toolbar = wrapper.querySelector<HTMLElement>(`.${CODE_BLOCK_TOOLBAR_CLASS}`)
  if (!toolbar) {
    toolbar = pre.ownerDocument.createElement('div')
    toolbar.className = CODE_BLOCK_TOOLBAR_CLASS
    wrapper.insertBefore(toolbar, pre)
  }

  const code = pre.firstElementChild instanceof HTMLElement ? pre.firstElementChild : null
  const label = code ? codeLanguageFlairLabel(code) : 'TEXT'
  const copyLabel = options.copyLabel ?? 'Copy'
  let copyButton = toolbar.querySelector<HTMLButtonElement>(CODE_COPY_BUTTON_SELECTOR)
  if (!copyButton) copyButton = pre.ownerDocument.createElement('button')
  copyButton.type = 'button'
  copyButton.className = CODE_COPY_BUTTON_SELECTOR.slice(1)
  copyButton.dataset.codeLabel = label
  copyButton.dataset.copyLabel = copyLabel
  copyButton.dataset.copiedLabel = options.copiedLabel ?? 'Copied'
  copyButton.dataset.failedLabel = options.failedLabel ?? 'Failed'
  copyButton.dataset.copyFailedLabel = options.copyFailedLabel ?? 'Copy failed'
  copyButton.dataset.copyTooltip = copyLabel
  copyButton.setAttribute('aria-label', `${copyLabel} ${label} code block`)
  copyButton.title = copyLabel
  if (!copyButton.dataset.copyState) copyButton.textContent = label

  toolbar.replaceChildren(copyButton)
}

function removeCodeBlockSummary(wrapper: HTMLElement): void {
  wrapper.querySelector<HTMLElement>(`.${CODE_BLOCK_SUMMARY_CLASS}`)?.remove()
}

function codeLanguageFlairLabel(code: HTMLElement): string {
  const classes = Array.from(code.classList)
  return (
    classes
      .find((className) => className.startsWith('language-'))
      ?.slice('language-'.length)
      .trim()
      .toUpperCase() || 'TEXT'
  )
}

function writeClipboardText(text: string): boolean {
  if (typeof window === 'undefined') return false

  try {
    const bridge = (window as Window & {
      zen?: { clipboardWriteText?: (value: string) => void }
    }).zen
    if (typeof bridge?.clipboardWriteText === 'function') {
      bridge.clipboardWriteText(text)
      return true
    }

    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }

  return false
}

function setCopyButtonFeedback(
  button: HTMLButtonElement,
  state: 'copied' | 'failed'
): void {
  const previousTimer = resetTimers.get(button)
  if (previousTimer != null) window.clearTimeout(previousTimer)

  const copied = state === 'copied'
  const copiedLabel = button.dataset.copiedLabel || 'Copied'
  const failedLabel = button.dataset.failedLabel || 'Failed'
  const copyFailedLabel = button.dataset.copyFailedLabel || 'Copy failed'
  button.dataset.copyState = state
  button.dataset.copyTooltip = copied ? copiedLabel : copyFailedLabel
  button.textContent = copied ? copiedLabel : failedLabel
  button.setAttribute('aria-label', copied ? copiedLabel : copyFailedLabel)
  button.title = copied ? copiedLabel : copyFailedLabel

  const resetTimer = window.setTimeout(() => {
    const label = button.dataset.codeLabel || 'TEXT'
    const copyLabel = button.dataset.copyLabel || 'Copy'
    button.textContent = label
    button.dataset.copyTooltip = copyLabel
    button.setAttribute('aria-label', `${copyLabel} ${label} code block`)
    button.title = copyLabel
    delete button.dataset.copyState
    resetTimers.delete(button)
  }, 1400)
  resetTimers.set(button, resetTimer)
}
