import { readNoteCover } from '@shared/note-cover'
import { readOnlyNoteCoverUrl } from '@shared/note-cover-gradients'
import type { QuickLookPayload } from './payload'
import type { QuickLookPrefs } from './prefs'
import { decodeRef, lookupQuickLookAsset } from './shim'

/** The extension serves a cover it was asked for by reference from here. */
export const QUICKLOOK_COVER_PREFIX = 'zenql://app/cover/'

export interface QuickLookCover {
  url: string
  y: number
}

/**
 * The note's cover as the preview draws it, or null for none.
 *
 * The extension finds a `![[...]]` cover while it scans the note for embeds,
 * which is how ZenNotes and Obsidian's Banners plugin write one. Every other
 * form `readNoteCover` accepts (a plain `[[link]]`, a bare path, `cover:`) is
 * asked for by reference instead, so the frontmatter is read here, by the
 * app's own parser, and the extension only resolves the file, beside the note
 * or in the vault, with the limits it puts on any embed. An https cover is
 * left out: the preview never goes online. Pinned or scrolling makes no
 * difference in a preview, which is one page that scrolls.
 */
export function quickLookCover(
  payload: Pick<QuickLookPayload, 'markdown' | 'assets'>,
  prefs: Pick<QuickLookPrefs, 'noteCoverPlacement'>
): QuickLookCover | null {
  if (prefs.noteCoverPlacement === 'hidden') return null
  const cover = readNoteCover(payload.markdown)
  const url = readOnlyNoteCoverUrl(cover, {
    resolveVault: (href) =>
      lookupQuickLookAsset(payload, href) ?? `${QUICKLOOK_COVER_PREFIX}${encodeURIComponent(decodeRef(href))}`,
    remote: false
  })
  return cover && url ? { url, y: cover.y } : null
}
