// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { NoteHoverPreview } from './NoteHoverPreview'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PLAN = [
  '# Wednesday, October 28, 2026',
  '',
  '## Focus',
  '- Dentist 10:30 a.m.',
  "- Leave for Lori & Steve's after work",
  '',
  '## Tasks',
  '- [ ] Pack my bags before I leave'
].join('\n')

const note = { path: 'inbox/Daily Notes/2026-10-28.md', title: '2026-10-28' }
const anchorRect = { left: 1200, top: 300, right: 1230, bottom: 320, width: 30, height: 20 }

// The calendar's day preview shows the note the way it reads, line by line,
// instead of the index excerpt that ran every line into one paragraph.
describe('NoteHoverPreview', () => {
  let host: HTMLDivElement
  let root: Root
  let readNote: ReturnType<typeof vi.fn>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    readNote = vi.fn()
    ;(window as unknown as { zen: unknown }).zen = { readNote }
    useStore.setState({ activeNote: null })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
  })

  const render = async (): Promise<HTMLElement> => {
    await act(async () => {
      root.render(createElement(NoteHoverPreview, { note, anchorRect }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    return document.body.querySelector<HTMLElement>('.note-hover-preview')!
  }

  it("draws a day's plan with its headings, list items and task box", async () => {
    readNote.mockResolvedValue({ ...note, body: PLAN })
    const card = await render()
    const article = card.querySelector('article')!
    expect([...article.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Focus', 'Tasks'])
    expect(article.querySelectorAll('li')).toHaveLength(3)
    expect(article.querySelector('input[type="checkbox"]')).not.toBeNull()
  })

  it('says an empty note is empty instead of loading forever', async () => {
    readNote.mockResolvedValue({ ...note, body: '' })
    const card = await render()
    expect(card.textContent).toContain('Empty note')
    expect(card.textContent).not.toContain('Loading preview')
  })

  it('stays opaque, so nothing behind it smears through the blur', async () => {
    readNote.mockResolvedValue({ ...note, body: PLAN })
    const preview = await render()
    // `bg-paper-100/98` looks opaque, but 98 is not on the opacity scale, so
    // Tailwind drew no background at all and the blur showed the text behind it.
    expect(preview.classList.contains('bg-paper-100')).toBe(true)
    expect(preview.className).not.toContain('backdrop-blur')
  })

  it('says it is loading while the note is read', async () => {
    readNote.mockReturnValue(new Promise(() => {}))
    const card = await render()
    expect(card.textContent).toContain('Loading preview')
  })
})
