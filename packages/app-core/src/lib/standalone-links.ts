/**
 * Which links a standalone external-file window hands to the host.
 *
 * That window has no vault, so the app's resolvers (note index, vault root)
 * have nothing to work with; the host resolves against the file's own
 * directory instead (#626). This module decides what is worth sending: a
 * `[[wikilink]]` or a local href goes to the host, a web or mail link opens
 * in the browser as everywhere else, and an in-page anchor stays with the
 * browser's own scrolling.
 */
import type { ExternalFileLink } from '@shared/ipc'
import { externalLinkUrl } from './internal-links'

export type StandaloneLinkAction =
  | { action: 'host'; link: ExternalFileLink }
  | { action: 'browser'; url: string }
  | null

/**
 * A preview anchor: a wikilink carries the target the markdown pipeline put
 * on it; anything else is judged by its href.
 */
export function standaloneLinkForAnchor(anchor: HTMLAnchorElement): StandaloneLinkAction {
  const wikilink = anchor.dataset.wikilink
  if (wikilink !== undefined) return { action: 'host', link: { kind: 'wikilink', target: wikilink } }
  return standaloneLinkForHref(anchor.getAttribute('href') ?? '')
}

/** A link target under the editor cursor: `[[…]]` source names a wikilink,
 *  everything else is a Markdown href or a bare URL. */
export function standaloneLinkForEditorTarget(source: string, target: string): StandaloneLinkAction {
  if (source.startsWith('[[')) return { action: 'host', link: { kind: 'wikilink', target } }
  return standaloneLinkForHref(target)
}

function standaloneLinkForHref(rawHref: string): StandaloneLinkAction {
  const href = rawHref.trim()
  if (!href || href.startsWith('#')) return null
  const web = externalLinkUrl(href)
  if (web) return { action: 'browser', url: web }
  if (/^(mailto|tel):/i.test(href)) return { action: 'browser', url: href }
  // A scheme the app reserves for its own assets is not a file the host can
  // find from this directory.
  if (/^zen(-[a-z]+)?:/i.test(href)) return null
  return { action: 'host', link: { kind: 'href', href } }
}
