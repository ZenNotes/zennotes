// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing, syntaxHighlighting } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import { afterEach, describe, expect, it } from 'vitest'
import { codeBlockFlairPlugin } from './cm-code-block-flair'
import { resolveCodeLanguage } from './cm-code-languages'
import {
  codeLanguageDetection,
  codeLanguageGuessesChanged,
  detectedCodeLanguage
} from './cm-code-language-detect'
import { codeFenceAt, setCodeFenceLanguage } from './code-language-menu'

const PYTHON = `import os
from pathlib import Path


def find_notes(root: Path) -> list[Path]:
    """Return every markdown file under root."""
    notes = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.endswith(".md"):
                notes.append(Path(dirpath) / name)
    return sorted(notes)`

const BASH = `#!/usr/bin/env bash
set -euo pipefail
for f in "$HOME"/notes/*.md; do
  echo "$f"
done`

const views: EditorView[] = []

function editor(doc: string, detect = true, more: Extension[] = []): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const extensions: Extension[] = [
    markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage }),
    syntaxHighlighting(classHighlighter),
    codeBlockFlairPlugin,
    detect ? codeLanguageDetection() : [],
    more
  ]
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) })
  forceParsing(view, doc.length, 5000)
  views.push(view)
  return view
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.parentElement?.remove()
    view.destroy()
  }
})

const labels = (view: EditorView): string[] =>
  Array.from(view.dom.querySelectorAll('.cm-code-flair')).map((el) => el.textContent ?? '')

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Each token of a block's text with the classes it is drawn with. */
function tokenClasses(view: EditorView, text: string): string[] {
  const out: string[] = []
  for (const line of Array.from(view.dom.querySelectorAll('.cm-line'))) {
    for (const span of Array.from(line.querySelectorAll('span[class*="tok-"]'))) {
      const own = span.className
        .split(/\s+/)
        .filter((name) => name.startsWith('tok-') && name !== 'tok-monospace')
        .sort()
        .join(' ')
      if (own && text.includes(span.textContent ?? '\0')) out.push(`${span.textContent}:${own}`)
    }
  }
  return out
}

describe('code block language detection in the editor', () => {
  it('labels an unlabeled block "detected" and colours it, without touching the file', async () => {
    const doc = `Notes\n\n\`\`\`\n${PYTHON}\n\`\`\`\n\n\`\`\`js\nconst a = 1\n\`\`\`\n\n\`\`\`\nhello\n\`\`\``
    const view = editor(doc)
    await until(() => labels(view).includes('python · detected'))
    expect(labels(view)).toEqual(['python · detected', 'js', 'text'])
    expect(view.state.doc.toString()).toBe(doc)
    const fence = codeFenceAt(view.state, doc.indexOf('import os'))!
    expect(detectedCodeLanguage(view.state, fence.from)).toBe('python')
    expect(view.dom.querySelector('.cm-code-flair.is-detected')).not.toBeNull()
    expect(tokenClasses(view, PYTHON)).toContain('def:tok-keyword')
  })

  it('draws a guessed block exactly as the same block labeled', async () => {
    const guessed = editor(`\`\`\`\n${PYTHON}\n\`\`\``)
    const labeled = editor(`\`\`\`python\n${PYTHON}\n\`\`\``)
    await until(() => labels(guessed).includes('python · detected'))
    await until(() => tokenClasses(guessed, PYTHON).length > 0)
    expect(tokenClasses(guessed, PYTHON)).toEqual(tokenClasses(labeled, PYTHON))
  })

  it('loads a guessed grammar language-data keeps lazily, then colours with it', async () => {
    const view = editor(`\`\`\`\n${BASH}\n\`\`\``)
    await until(() => labels(view).includes('bash · detected'))
    await until(() => tokenClasses(view, BASH).length > 0)
    expect(tokenClasses(view, BASH).some((token) => token.startsWith('echo:'))).toBe(true)
  })

  it('keeps the guess while the block is typed in, until the next one', async () => {
    const doc = `\`\`\`\n${PYTHON}\n\`\`\``
    const view = editor(doc)
    await until(() => labels(view).includes('python · detected'))
    const at = doc.indexOf('return sorted')
    view.dispatch({ changes: { from: at, insert: 'x = 1\n    ' }, userEvent: 'input.type' })
    expect(labels(view)).toEqual(['python · detected'])
    expect(tokenClasses(view, 'x = 1').length).toBeGreaterThan(0)
  })

  it('does not count an edit that only moves a guess as a new one, so typing never re-parses', async () => {
    const changed: boolean[] = []
    const probe = ViewPlugin.define(() => ({
      update: (update: ViewUpdate) => {
        if (update.docChanged) changed.push(codeLanguageGuessesChanged(update))
      }
    }))
    const doc = `Intro\n\n\`\`\`\n${PYTHON}\n\`\`\``
    const view = editor(doc, true, [probe])
    await until(() => labels(view).includes('python · detected'))
    view.dispatch({ changes: { from: 0, insert: 'A ' }, userEvent: 'input.type' })
    const inBlock = view.state.doc.toString().indexOf('return sorted')
    view.dispatch({ changes: { from: inBlock, insert: '# x\n    ' }, userEvent: 'input.type' })
    expect(changed).toEqual([false, false])
    expect(labels(view)).toEqual(['python · detected'])
  })

  it('drops the guess once the block names a language, which only a pick writes', async () => {
    const doc = `\`\`\`\n${PYTHON}\n\`\`\``
    const view = editor(doc)
    await until(() => labels(view).includes('python · detected'))
    const fence = codeFenceAt(view.state, doc.indexOf('import'))!
    setCodeFenceLanguage(view, fence.from, 'python')
    expect(view.state.doc.toString().startsWith('```python\n')).toBe(true)
    expect(labels(view)).toEqual(['python'])
    expect(view.dom.querySelector('.cm-code-flair.is-detected')).toBeNull()
  })

  it('guesses nothing with the setting off: the block reads text and stays plain', async () => {
    const view = editor(`\`\`\`\n${PYTHON}\n\`\`\``, false)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(labels(view)).toEqual(['text'])
    expect(tokenClasses(view, PYTHON)).toEqual([])
  })

  it('leaves a tiny block as text', async () => {
    const view = editor('```\nx = 1\n```\n\n```\n' + PYTHON + '\n```')
    await until(() => labels(view).includes('python · detected'))
    expect(labels(view)[0]).toBe('text')
  })
})

describe('the code block label', () => {
  it('is a language button with the copy button beside it', () => {
    const view = editor('```ts\nconst a: number = 1\n```', false)
    const bar = view.dom.querySelector('.cm-code-flair-bar')!
    const language = bar.querySelector('.cm-code-flair')!
    const copy = bar.querySelector('.cm-code-copy')!
    expect(language.textContent).toBe('ts')
    expect(language.getAttribute('aria-haspopup')).toBe('menu')
    expect(copy.getAttribute('aria-label')).toBe('Copy code')
  })

  it('opens the picker for its block, through the window event', () => {
    const doc = '```ts\nconst a: number = 1\n```'
    const view = editor(doc, false)
    let request: CustomEvent | null = null
    const listen = (event: Event): void => {
      request = event as CustomEvent
    }
    window.addEventListener('zen:open-code-language-picker', listen)
    ;(view.dom.querySelector('.cm-code-flair') as HTMLButtonElement).click()
    window.removeEventListener('zen:open-code-language-picker', listen)
    expect(request).not.toBeNull()
    expect(request!.detail.view).toBe(view)
    expect(request!.detail.fenceFrom).toBe(0)
  })
})
