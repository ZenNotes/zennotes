import { useEffect, useState } from 'react'

interface ReadOnlyNoteCoverProps {
  url: string
  /** Vertical focal point, 0 (top) to 1 (bottom). */
  y: number
}

/**
 * A note's cover where nobody can change it: the public share page and Quick
 * Look. The same frame and focal point as the app's NoteCover, without its
 * buttons, drop target or reposition mode, and without its store and picker
 * imports, which would carry the cover gallery into those bundles. An image
 * that does not load takes its frame with it: a reader cannot fix it.
 */
export function ReadOnlyNoteCover({ url, y }: ReadOnlyNoteCoverProps): JSX.Element | null {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  if (failed) return null
  return (
    <div
      data-note-cover="read-only"
      className="zen-note-cover relative w-full shrink-0 select-none overflow-hidden bg-paper-200"
    >
      <img
        src={url}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className="pointer-events-none h-full w-full object-cover"
        style={{ objectPosition: `50% ${Math.round(y * 1000) / 10}%` }}
      />
    </div>
  )
}
