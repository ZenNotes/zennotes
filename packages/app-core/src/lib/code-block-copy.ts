import { writeClipboardText } from './clipboard-text'

const CODE_BLOCK_CLASS = 'zen-code-block'
const CODE_BLOCK_TOOLBAR_CLASS = 'zen-code-block-toolbar'
const CODE_BLOCK_SUMMARY_CLASS = 'zen-code-block-summary'
const CODE_BLOCK_FOLDED_ATTR = 'data-code-folded'
const CODE_BLOCK_STORAGE_KEY_ATTR = 'data-code-fold-storage-key'
const CODE_BLOCK_INDEX_ATTR = 'data-code-block-index'
const CODE_BLOCK_FOLDS_STORAGE_PREFIX = 'zen:code-block-folds:v1'

export const CODE_COPY_BUTTON_SELECTOR = '.zen-code-copy-button'
export const CODE_FOLD_BUTTON_SELECTOR = '.zen-code-fold-button'

const resetTimers = new WeakMap<HTMLButtonElement, number>()

interface CodeBlockEnhanceOptions {
  notePath?: string | null
}

export function enhanceCodeBlockCopy(
  root: ParentNode,
  options: CodeBlockEnhanceOptions = {}
): void {
  const blocks = Array.from(root.querySelectorAll<HTMLPreElement>('pre'))
  const storageKey = options.notePath ? codeBlockFoldStorageKey(options.notePath) : null
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
    if (storageKey) wrapper.setAttribute(CODE_BLOCK_STORAGE_KEY_ATTR, storageKey)
    else wrapper.removeAttribute(CODE_BLOCK_STORAGE_KEY_ATTR)

    ensureCodeBlockToolbar(wrapper, pre)
    ensureCodeBlockSummary(wrapper, code)

    const persisted = storageKey ? readPersistedFoldState(storageKey, index) : null
    applyCodeBlockFoldState(wrapper, persisted ?? false)
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

export function toggleCodeBlockFold(button: HTMLButtonElement): boolean {
  const block = button.closest<HTMLElement>(`.${CODE_BLOCK_CLASS}`)
  if (!block) return false

  const folded = block.getAttribute(CODE_BLOCK_FOLDED_ATTR) !== 'true'
  applyCodeBlockFoldState(block, folded)
  persistCodeBlockFoldState(block, folded)
  return true
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

function ensureCodeBlockToolbar(wrapper: HTMLElement, pre: HTMLPreElement): void {
  if (wrapper.querySelector(`.${CODE_BLOCK_TOOLBAR_CLASS}`)) return

  const toolbar = pre.ownerDocument.createElement('div')
  toolbar.className = CODE_BLOCK_TOOLBAR_CLASS

  const foldButton = pre.ownerDocument.createElement('button')
  foldButton.type = 'button'
  foldButton.className = CODE_FOLD_BUTTON_SELECTOR.slice(1)
  foldButton.setAttribute('aria-label', 'Collapse code block')
  foldButton.setAttribute('aria-expanded', 'true')
  foldButton.title = 'Collapse code block'
  foldButton.textContent = 'Fold'

  const copyButton = pre.ownerDocument.createElement('button')
  copyButton.type = 'button'
  copyButton.className = CODE_COPY_BUTTON_SELECTOR.slice(1)
  copyButton.setAttribute('aria-label', 'Copy code block')
  copyButton.title = 'Copy code block'
  copyButton.textContent = 'Copy'

  toolbar.append(foldButton, copyButton)
  wrapper.insertBefore(toolbar, pre)
}

function ensureCodeBlockSummary(wrapper: HTMLElement, code: HTMLElement): void {
  let summary = wrapper.querySelector<HTMLElement>(`.${CODE_BLOCK_SUMMARY_CLASS}`)
  if (!summary) {
    summary = code.ownerDocument.createElement('div')
    summary.className = CODE_BLOCK_SUMMARY_CLASS
    wrapper.insertBefore(summary, wrapper.querySelector('pre')?.nextSibling ?? null)
  }
  summary.textContent = summarizeCodeBlock(code)
}

function summarizeCodeBlock(code: HTMLElement): string {
  const lineCount = countCodeLines(code.textContent ?? '')
  const language = codeLanguageLabel(code)
  const noun = lineCount === 1 ? 'line' : 'lines'
  return `${language} folded (${lineCount} ${noun})`
}

function countCodeLines(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '')
  if (!normalized) return 0
  return normalized.split('\n').length
}

function codeLanguageLabel(code: HTMLElement): string {
  const classes = Array.from(code.classList)
  const language = classes
    .find((className) => className.startsWith('language-'))
    ?.slice('language-'.length)
    .trim()
  if (!language) return 'Code block'
  return `${language.toUpperCase()} code block`
}

function applyCodeBlockFoldState(block: HTMLElement, folded: boolean): void {
  block.setAttribute(CODE_BLOCK_FOLDED_ATTR, folded ? 'true' : 'false')

  const button = block.querySelector<HTMLButtonElement>(CODE_FOLD_BUTTON_SELECTOR)
  if (!button) return
  button.textContent = folded ? 'Expand' : 'Fold'
  button.setAttribute('aria-expanded', String(!folded))
  button.setAttribute('aria-label', folded ? 'Expand code block' : 'Collapse code block')
  button.title = folded ? 'Expand code block' : 'Collapse code block'
}

function persistCodeBlockFoldState(block: HTMLElement, folded: boolean): void {
  const storageKey = block.getAttribute(CODE_BLOCK_STORAGE_KEY_ATTR)
  const rawIndex = block.getAttribute(CODE_BLOCK_INDEX_ATTR)
  const index = rawIndex == null ? Number.NaN : Number.parseInt(rawIndex, 10)
  if (!storageKey || !Number.isFinite(index) || index < 0) return

  const next = readFoldMap(storageKey)
  if (folded) next[String(index)] = true
  else delete next[String(index)]

  try {
    if (Object.keys(next).length > 0) {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
    } else {
      window.localStorage.removeItem(storageKey)
    }
  } catch {
    // Persistence is best-effort; folding should still work without storage.
  }
}

function readPersistedFoldState(storageKey: string, index: number): boolean | null {
  const value = readFoldMap(storageKey)[String(index)]
  return typeof value === 'boolean' ? value : null
}

function readFoldMap(storageKey: string): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] =>
          /^\d+$/.test(entry[0]) && typeof entry[1] === 'boolean'
      )
    )
  } catch {
    return {}
  }
}

function codeBlockFoldStorageKey(notePath: string): string {
  return `${CODE_BLOCK_FOLDS_STORAGE_PREFIX}:${encodeURIComponent(notePath)}`
}

function setCopyButtonFeedback(
  button: HTMLButtonElement,
  state: 'copied' | 'failed'
): void {
  const previousTimer = resetTimers.get(button)
  if (previousTimer != null) window.clearTimeout(previousTimer)

  const copied = state === 'copied'
  button.dataset.copyState = state
  button.textContent = copied ? 'Copied' : 'Failed'
  button.setAttribute('aria-label', copied ? 'Copied code block' : 'Copy failed')
  button.title = copied ? 'Copied code block' : 'Copy failed'

  const resetTimer = window.setTimeout(() => {
    button.textContent = 'Copy'
    button.setAttribute('aria-label', 'Copy code block')
    button.title = 'Copy code block'
    delete button.dataset.copyState
    resetTimers.delete(button)
  }, 1400)
  resetTimers.set(button, resetTimer)
}
