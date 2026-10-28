import { useEffect, useState } from 'react'
import type { NoteCoverCreditLine } from '@shared/unsplash'
import { NoteCoverCredit } from './NoteCoverCredit'

interface ReadOnlyNoteCoverProps {
  url: string
  /** Vertical focal point, 0 (top) to 1 (bottom). */
  y: number
  /** Who made the picture; always in view here, since nothing hovers on a
   *  page nobody edits. */
  credit?: NoteCoverCreditLine | null
}

/** What a read-only cover may load: an http(s) image (the share page's
 *  uploads, or an https cover), a built-in gradient's `data:image/` URL, and
 *  Quick Look's `zenql://` resource route. The callers already hand over only
 *  these, and an `<img>` runs no script whatever its source; the check sits at
 *  the element anyway, so a future caller cannot point it anywhere else. */
const READ_ONLY_COVER_URL = /^(?:https?:\/\/|zenql:\/\/|data:image\/)/i

export function readOnlyCoverSource(url: string): string | null {
  const trimmed = url.trim()
  return READ_ONLY_COVER_URL.test(trimmed) ? trimmed : null
}

/**
 * A note's cover where nobody can change it: the public share page and Quick
 * Look. The same frame and focal point as the app's NoteCover, without its
 * buttons, drop target or reposition mode, and without its store and picker
 * imports, which would carry the cover gallery into those bundles. An image
 * that does not load takes its frame with it: a reader cannot fix it.
 */
export function ReadOnlyNoteCover({ url, y, credit }: ReadOnlyNoteCoverProps): JSX.Element | null {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  const src = readOnlyCoverSource(url)
  if (failed || !src) return null
  return (
    <div
      data-note-cover="read-only"
      className="zen-note-cover relative w-full shrink-0 select-none overflow-hidden bg-paper-200"
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className="pointer-events-none h-full w-full object-cover"
        style={{ objectPosition: `50% ${Math.round(y * 1000) / 10}%` }}
      />
      {credit && <NoteCoverCredit line={credit} persistent />}
    </div>
  )
}
