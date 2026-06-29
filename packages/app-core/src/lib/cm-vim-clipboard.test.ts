import { afterEach, describe, expect, it, vi } from 'vitest'

// A stand-in for codemirror-vim's register controller. The lib wraps its
// pushText; `original` lets us assert the wrapped call still runs.
const unnamed = { value: '', toString: () => unnamed.value }
const original = vi.fn((registerName: string, _operator: string, text: string) => {
  if (!registerName || registerName === '"') unnamed.value = text
})
const controller = { pushText: original, unnamedRegister: unnamed }

vi.mock('@replit/codemirror-vim', () => ({
  Vim: { getRegisterController: () => controller }
}))

const writeText = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(globalThis.navigator, 'clipboard', {
  value: { writeText },
  configurable: true
})

// Imported after the mocks so the lib captures the fake controller.
const { setYankToClipboardEnabled } = await import('./cm-vim-clipboard')

afterEach(() => {
  writeText.mockClear()
  original.mockClear()
  unnamed.value = ''
})

describe('vim yank to clipboard', () => {
  it('writes a default-register yank to the system clipboard when enabled', () => {
    setYankToClipboardEnabled(true)
    controller.pushText('', 'yank', 'hello')
    expect(original).toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('does not write when disabled', () => {
    setYankToClipboardEnabled(false)
    controller.pushText('', 'yank', 'nope')
    expect(original).toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('only syncs the unnamed register, not explicit named ones', () => {
    setYankToClipboardEnabled(true)
    controller.pushText('a', 'yank', 'named')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('ignores the black hole register', () => {
    setYankToClipboardEnabled(true)
    controller.pushText('_', 'delete', 'gone')
    expect(writeText).not.toHaveBeenCalled()
  })
})
