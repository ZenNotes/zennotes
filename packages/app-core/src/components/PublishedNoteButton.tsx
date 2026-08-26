import { useEffect, useState } from 'react'
import { getZenBridge, type ZenBridge } from '@zennotes/bridge-contract/bridge'
import type { PublishableCloudNote } from '../lib/cloud-publishing'
import {
  subscribePublishedNoteChanges,
  type PublishedNoteChange
} from '../lib/published-note-events'
import { requestPublishNote } from '../lib/publish-note-requests'
import { isCloudAccountConnectedPhase, useCloudSyncStatusStore } from '../lib/cloud-auto-sync'
import { LinkIcon } from './icons'

type PublishedNoteLookupBridge = Pick<ZenBridge, 'listCloudPublishedNotes'>

export function PublishedNoteButton({
  note,
  bridge = getZenBridge()
}: {
  note: PublishableCloudNote
  bridge?: PublishedNoteLookupBridge
}): JSX.Element | null {
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Publishing needs a signed-in Cloud account; without one the button opened
  // a dialog that could only fail, so it stays out of the header until the
  // account is connected (the status bar's Connect is the way in).
  const connected = useCloudSyncStatusStore((state) => isCloudAccountConnectedPhase(state.phase))

  useEffect(() => {
    if (!connected) {
      setPublishedUrl(null)
      setLoading(false)
      return undefined
    }
    let cancelled = false
    let changedSinceRequest = false

    setPublishedUrl(null)
    setLoading(true)

    const unsubscribe = subscribePublishedNoteChanges((change: PublishedNoteChange) => {
      if (change.notePath !== note.path) return
      changedSinceRequest = true
      setPublishedUrl(change.url)
    })

    void bridge.listCloudPublishedNotes()
      .then((publishedNotes) => {
        if (cancelled || changedSinceRequest) return
        const published = publishedNotes.find((candidate) => candidate.note_path === note.path)
        setPublishedUrl(published?.url ?? null)
      })
      .catch(() => {
        // Publishing stays available when the status lookup is temporarily unavailable.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge, connected, note.path])

  if (!connected) return null

  const published = publishedUrl !== null
  const label = published ? 'Published · Manage public note' : 'Publish note'

  return (
    <button
      type="button"
      onClick={() => requestPublishNote(note)}
      aria-label={label}
      aria-busy={loading}
      data-published={published ? 'true' : 'false'}
      className={[
        'group relative ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
        published
          ? 'bg-accent/12 text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/18'
          : 'text-ink-400 hover:bg-paper-200/70 hover:text-ink-800'
      ].join(' ')}
    >
      <LinkIcon width={13} height={13} />
      <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-paper-300 bg-paper-50 px-2 py-1 text-xs font-medium text-ink-800 shadow-panel group-hover:block group-focus-visible:block">
        {label}
      </span>
    </button>
  )
}
