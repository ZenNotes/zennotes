// @vitest-environment jsdom

import {
  autocompletion,
  currentCompletions,
  selectedCompletionIndex,
  startCompletion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { defaultKeymap } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { completionKeymapExtension, completionNavKeymap } from './cm-completion-nav'

/** Stands in for the `@` date/note sources: three options, no filtering. */
function source(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/@\w*/)
  if (!match) return null
  return {
    from: match.from + 1,
    options: [{ label: 'Today' }, { label: 'Tomorrow' }, { label: 'Yesterday' }],
    filter: false
  }
}

function mount(): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: 'line one\nline two\n@\nline four',
      selection: { anchor: 19 },
      extensions: [
        autocompletion({ defaultKeymap: false, override: [source] }),
        completionNavKeymap,
        completionKeymapExtension,
        keymap.of([...defaultKeymap])
      ]
    }),
    parent: document.body
  })
}

function press(view: EditorView, key: string): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  )
}

/**
 * Wait for the popup to open, then past `interactionDelay` (75ms, counted
 * from the moment it opened), before which the popup ignores navigation. A
 * fixed sleep from `startCompletion` is not enough on a slow runner: the
 * popup can open late in that window and the first press lands inside the
 * delay, which reads as "the arrow did nothing".
 */
async function settle(view: EditorView): Promise<void> {
  const deadline = Date.now() + 5_000
  while (currentCompletions(view.state).length === 0) {
    if (Date.now() > deadline) throw new Error('completion never opened')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
}

describe('completion arrow navigation', () => {
  it('moves the highlighted option instead of the caret', async () => {
    const view = mount()
    startCompletion(view)
    await settle(view)
    expect(currentCompletions(view.state).length).toBe(3)
    expect(selectedCompletionIndex(view.state)).toBe(0)
    const caret = view.state.selection.main.head

    press(view, 'ArrowDown')
    expect(selectedCompletionIndex(view.state)).toBe(1)
    press(view, 'ArrowDown')
    expect(selectedCompletionIndex(view.state)).toBe(2)
    press(view, 'ArrowUp')
    expect(selectedCompletionIndex(view.state)).toBe(1)

    // Mounted below `defaultKeymap` instead, its ArrowUp/ArrowDown caret motions
    // win and the caret move closes the menu — the regression this guards.
    expect(currentCompletions(view.state).length).toBe(3)
    expect(view.state.selection.main.head).toBe(caret)

    view.destroy()
  })

  it('lets the arrows through when no completion is open', () => {
    let reached = 0
    const view = new EditorView({
      state: EditorState.create({
        doc: 'line one',
        extensions: [
          autocompletion({ defaultKeymap: false, override: [source] }),
          completionNavKeymap,
          completionKeymapExtension,
          keymap.of([
            {
              key: 'ArrowDown',
              run: () => {
                reached += 1
                return true
              }
            }
          ])
        ]
      }),
      parent: document.body
    })

    press(view, 'ArrowDown')
    expect(reached).toBe(1)

    view.destroy()
  })
})
