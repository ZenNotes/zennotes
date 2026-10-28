import type { NoteCoverCreditLine } from '@shared/unsplash'

/**
 * Who made a cover's picture, in its bottom-left corner: "Photo by <name> on
 * Unsplash" for an Unsplash photo (Unsplash asks for both links wherever the
 * photo shows), the credit as written for any other cover. In the app it
 * shows with the cover's buttons; on a page nobody edits (a published note)
 * it stays in view. No store imports: the share viewer draws it too.
 */
export function NoteCoverCredit({
  line,
  persistent
}: {
  line: NoteCoverCreditLine
  persistent: boolean
}): JSX.Element {
  const link = (label: string, href: string | null): JSX.Element =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer" className="font-medium text-ink-900 underline-offset-2 hover:underline">
        {label}
      </a>
    ) : (
      <span className="font-medium text-ink-900">{label}</span>
    )
  return (
    <div
      data-note-cover-credit=""
      className={[
        // The cover's buttons' own surface, so the corner reads as one set of chrome.
        'zen-note-cover-credit absolute bottom-3 left-3 max-w-md truncate rounded-md bg-paper-50/90 px-2 py-1 text-2xs text-ink-600',
        persistent ? '' : 'opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100'
      ].join(' ')}
    >
      {line.source ? (
        <>
          Photo by {link(line.name, line.nameUrl)} on {link(line.source.name, line.source.url)}
        </>
      ) : (
        link(line.name, line.nameUrl)
      )}
    </div>
  )
}
