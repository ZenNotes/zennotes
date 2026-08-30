/**
 * "Copy" for a link, from a right-click or the keyboard. A web link copies
 * its URL (a bare `google.com` the way the click handler would open it, with
 * the scheme), a `mailto:` copies the address itself (nobody wants the
 * `mailto:` prefix or its `?subject=` tail in the clipboard), `tel:` the
 * number. Note links, wikilinks, in-page anchors and local files are not
 * copyable here: they have their own menus and actions.
 */
import type { EditorView } from '@codemirror/view'
import type { ContextMenuItem } from '../components/ContextMenu'
import { writeClipboardText } from './clipboard-text'
import { externalLinkUrl, linkRangeAtCursor } from './internal-links'
import { useToastStore } from './toast'

export type CopyableLinkKind = 'url' | 'email' | 'phone'

export interface CopyableLink {
  kind: CopyableLinkKind
  /** What lands in the clipboard. */
  value: string
  /** What opens when the user picks "Open". */
  url: string
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** The copyable form of a link target (`https://…`, `mailto:…`, `tel:…`, or a
 *  bare domain), or null when the target is not an outside link. */
export function copyableLink(target: string): CopyableLink | null {
  const url = externalLinkUrl(target)
  if (!url) return null
  if (/^mailto:/i.test(url)) {
    const address = decodeSafe(url.slice('mailto:'.length).split('?')[0] ?? '').trim()
    return address ? { kind: 'email', value: address, url } : null
  }
  if (/^tel:/i.test(url)) {
    const number = decodeSafe(url.slice('tel:'.length)).trim()
    return number ? { kind: 'phone', value: number, url } : null
  }
  return { kind: 'url', value: url, url }
}

const COPY_LABEL: Record<CopyableLinkKind, string> = {
  url: 'Copy link',
  email: 'Copy email address',
  phone: 'Copy phone number'
}

const COPIED_MESSAGE: Record<CopyableLinkKind, string> = {
  url: 'Link copied',
  email: 'Email address copied',
  phone: 'Phone number copied'
}

const OPEN_LABEL: Record<CopyableLinkKind, string> = {
  url: 'Open link',
  email: 'Write email',
  phone: 'Open link'
}

export function copyLink(link: CopyableLink): boolean {
  const ok = writeClipboardText(link.value)
  useToastStore
    .getState()
    .addToast(ok ? COPIED_MESSAGE[link.kind] : 'Could not copy', ok ? 'success' : 'error')
  return ok
}

export function openLink(link: CopyableLink): void {
  // Same route the click handlers take: Electron's window-open handler sends
  // outside URLs to the OS browser (or mail client), the web client to a tab.
  window.open(link.url, '_blank')
}

/** The link group for a context menu, separator included. */
export function linkMenuItems(link: CopyableLink): ContextMenuItem[] {
  return [
    { label: OPEN_LABEL[link.kind], onSelect: () => openLink(link) },
    {
      label: COPY_LABEL[link.kind],
      onSelect: () => {
        copyLink(link)
      }
    },
    { kind: 'separator' }
  ]
}

/** The copyable link at a document offset, or null. */
export function copyableLinkAt(view: EditorView, pos: number): CopyableLink | null {
  const range = linkRangeAtCursor(view.state.doc.toString(), pos)
  return range ? copyableLink(range.target) : null
}

/** Keyboard path (`gy`, Copy Link Under Cursor): copy the link the caret is
 *  in, or say that there is none. */
export function copyLinkAtCursor(view: EditorView): boolean {
  const link = copyableLinkAt(view, view.state.selection.main.head)
  if (!link) {
    useToastStore.getState().addToast('No link under the cursor', 'info')
    return false
  }
  return copyLink(link)
}
