import type { MouseEvent as ReactMouseEvent } from 'react'
import { useT } from '../lib/i18n'

/**
 * A thin drag handle pinned to the left edge of a right-side panel. The parent
 * must be positioned (relative). Mirrors the pinned reference pane's handle:
 * a wide invisible grab strip with a hairline that highlights on hover.
 */
export function PanelResizeHandle({
  onStart
}: {
  onStart: (e: ReactMouseEvent<HTMLElement>) => void
}): JSX.Element {
  const t = useT()
  return (
    <div
      onMouseDown={onStart}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize panel')}
      title={t('Drag to resize')}
      className="group absolute left-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none"
    >
      <div className="absolute left-0 top-0 h-full w-px bg-transparent transition-colors group-hover:bg-accent/50" />
    </div>
  )
}
