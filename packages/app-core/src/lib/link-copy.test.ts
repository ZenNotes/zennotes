// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyLinkAtCursor, copyableLink, linkMenuItems } from './link-copy'
import { useToastStore } from './toast'

const zenWindow = window as unknown as { zen?: { clipboardWriteText?: (value: string) => void } }

describe('copyableLink', () => {
  it('copies a web link as its URL, scheme included for a bare domain', () => {
    expect(copyableLink('https://example.com/docs?x=1')).toEqual({
      kind: 'url',
      value: 'https://example.com/docs?x=1',
      url: 'https://example.com/docs?x=1'
    })
    expect(copyableLink('google.com/search')).toEqual({
      kind: 'url',
      value: 'https://google.com/search',
      url: 'https://google.com/search'
    })
  })

  it('copies the address behind a mailto:, without the scheme or the query', () => {
    expect(copyableLink('mailto:someone@example.com?subject=Hi%20there')).toEqual({
      kind: 'email',
      value: 'someone@example.com',
      url: 'mailto:someone@example.com?subject=Hi%20there'
    })
    expect(copyableLink('mailto:')).toBeNull()
  })

  it('copies the number behind a tel:', () => {
    expect(copyableLink('tel:+1-555-0100')).toMatchObject({ kind: 'phone', value: '+1-555-0100' })
  })

  it('is null for notes, wikilinks, anchors, and local files', () => {
    expect(copyableLink('Meeting notes')).toBeNull()
    expect(copyableLink('folder/Note.md')).toBeNull()
    expect(copyableLink('#heading')).toBeNull()
    expect(copyableLink('assets/deck.pdf')).toBeNull()
    expect(copyableLink('')).toBeNull()
  })
})

describe('linkMenuItems', () => {
  it('labels the pair by kind and ends with a separator', () => {
    const url = linkMenuItems(copyableLink('https://example.com')!)
    expect(url.map((i) => i.label ?? i.kind)).toEqual(['Open link', 'Copy link', 'separator'])
    const mail = linkMenuItems(copyableLink('mailto:a@b.co')!)
    expect(mail.map((i) => i.label ?? i.kind)).toEqual([
      'Write email',
      'Copy email address',
      'separator'
    ])
  })
})

describe('copyLinkAtCursor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete zenWindow.zen
    useToastStore.setState({ toasts: [] })
  })

  function editor(doc: string, cursor: number): EditorView {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    return new EditorView({
      parent,
      state: EditorState.create({ doc, selection: { anchor: cursor } })
    })
  }

  it('writes the link under the caret to the clipboard and says so', () => {
    const written: string[] = []
    zenWindow.zen = { clipboardWriteText: (value) => written.push(value) }
    const view = editor('See [the docs](https://example.com/docs) today', 8)
    expect(copyLinkAtCursor(view)).toBe(true)
    expect(written).toEqual(['https://example.com/docs'])
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain('Link copied')
    view.destroy()
  })

  it('copies the bare address of a mailto link', () => {
    const written: string[] = []
    zenWindow.zen = { clipboardWriteText: (value) => written.push(value) }
    const view = editor('[Ping me](mailto:me@example.com?subject=Hello)', 3)
    expect(copyLinkAtCursor(view)).toBe(true)
    expect(written).toEqual(['me@example.com'])
    view.destroy()
  })

  it('explains itself when the caret is not in a link', () => {
    const written: string[] = []
    zenWindow.zen = { clipboardWriteText: (value) => written.push(value) }
    const view = editor('plain text and a [[Wikilink]]', 2)
    expect(copyLinkAtCursor(view)).toBe(false)
    expect(written).toEqual([])
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'No link under the cursor'
    )
    view.destroy()
  })

  it('does not copy a wikilink', () => {
    const written: string[] = []
    zenWindow.zen = { clipboardWriteText: (value) => written.push(value) }
    const view = editor('go to [[Meeting notes]] now', 12)
    expect(copyLinkAtCursor(view)).toBe(false)
    expect(written).toEqual([])
    view.destroy()
  })
})
