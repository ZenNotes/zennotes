import { lazy, Suspense } from 'react'
import type { NoteMeta } from '@shared/ipc'

type AnchorRectLike = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>

const NoteHoverPreviewImpl = lazy(() =>
  import('./NoteHoverPreview').then((mod) => ({ default: mod.NoteHoverPreview }))
)

export function LazyNoteHoverPreview({
  note,
  anchorRect,
  placement = 'anchored',
  interactive = false,
  onPointerEnter,
  onPointerLeave
}: {
  note: Pick<NoteMeta, 'path' | 'title'>
  anchorRect: AnchorRectLike
  placement?: 'anchored' | 'floating'
  interactive?: boolean
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}): JSX.Element {
  return (
    <Suspense fallback={null}>
      <NoteHoverPreviewImpl
        note={note}
        anchorRect={anchorRect}
        placement={placement}
        interactive={interactive}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      />
    </Suspense>
  )
}
