// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { standaloneLinkForAnchor, standaloneLinkForEditorTarget } from './standalone-links'

function anchor(href: string, wikilink?: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.setAttribute('href', href)
  if (wikilink !== undefined) a.dataset.wikilink = wikilink
  return a
}

describe('standaloneLinkForAnchor', () => {
  it('sends a wikilink by the target the pipeline stamped on it', () => {
    expect(standaloneLinkForAnchor(anchor('zen://note/t00-converter-ts', 't00-converter-ts'))).toEqual({
      action: 'host',
      link: { kind: 'wikilink', target: 't00-converter-ts' }
    })
  })

  it('sends relative and absolute hrefs to the host', () => {
    expect(standaloneLinkForAnchor(anchor('../../README.md'))).toEqual({
      action: 'host',
      link: { kind: 'href', href: '../../README.md' }
    })
    expect(standaloneLinkForAnchor(anchor('graphify-out/GRAPH_REPORT.md'))).toEqual({
      action: 'host',
      link: { kind: 'href', href: 'graphify-out/GRAPH_REPORT.md' }
    })
    expect(standaloneLinkForAnchor(anchor('/tmp/spec.pdf'))).toEqual({
      action: 'host',
      link: { kind: 'href', href: '/tmp/spec.pdf' }
    })
  })

  it('keeps web and mail links for the browser', () => {
    expect(standaloneLinkForAnchor(anchor('https://example.com/x.md'))).toEqual({
      action: 'browser',
      url: 'https://example.com/x.md'
    })
    expect(standaloneLinkForAnchor(anchor('mailto:a@b.c'))).toEqual({ action: 'browser', url: 'mailto:a@b.c' })
  })

  it('leaves in-page anchors and app asset URLs alone', () => {
    expect(standaloneLinkForAnchor(anchor('#usage'))).toBeNull()
    expect(standaloneLinkForAnchor(anchor(''))).toBeNull()
    expect(standaloneLinkForAnchor(anchor('zen-asset://local/x.png'))).toBeNull()
  })
})

describe('standaloneLinkForEditorTarget', () => {
  it('tells a wikilink from a markdown href by the source it came from', () => {
    expect(standaloneLinkForEditorTarget('[[topic-name]]', 'topic-name')).toEqual({
      action: 'host',
      link: { kind: 'wikilink', target: 'topic-name' }
    })
    expect(standaloneLinkForEditorTarget('[README](../../README.md)', '../../README.md')).toEqual({
      action: 'host',
      link: { kind: 'href', href: '../../README.md' }
    })
    expect(standaloneLinkForEditorTarget('https://example.com', 'https://example.com')).toEqual({
      action: 'browser',
      url: 'https://example.com'
    })
  })
})
