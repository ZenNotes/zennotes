import { createPortal } from 'react-dom'

export interface WhichKeyItem {
  keyLabel: string
  label: string
  detail: string
}

export function WhichKeyOverlay({
  prefix,
  title,
  items,
  detail = 'Press a key to continue or Esc to cancel.'
}: {
  prefix: string
  title: string
  items: WhichKeyItem[]
  detail?: string
}): JSX.Element | null {
  if (items.length === 0) return null
  const twoColumn = items.length > 3
  const oddItemCount = items.length % 2 === 1

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[100] flex justify-center px-4">
      <div className="w-[min(640px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-paper-300/70 bg-paper-100 shadow-float backdrop-blur-md">
        <div className="flex items-center justify-between gap-3 border-b border-paper-300/60 px-3.5 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="rounded-md border border-accent/35 bg-paper-200 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
              {prefix}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink-900">{title}</div>
              <div className="text-[11px] text-ink-500">{detail}</div>
            </div>
          </div>
        </div>

        <div className={['grid bg-paper-100', twoColumn ? 'sm:grid-cols-2' : 'grid-cols-1'].join(' ')}>
          {items.map((item, index) => (
            <div
              key={`${prefix}-${item.keyLabel}`}
              className={[
                'flex items-start gap-2.5 border-paper-300/55 bg-paper-100 px-3.5 py-2.5',
                twoColumn && oddItemCount && index === items.length - 1 ? 'sm:col-span-2' : '',
                twoColumn && index % 2 === 1 ? 'sm:border-l' : '',
                index > 0 ? 'border-t' : ''
              ].join(' ')}
            >
              <div className="mt-0.5 flex min-w-[2rem] shrink-0 items-center gap-1 whitespace-nowrap">
                {item.keyLabel
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((token, tokenIndex) => (
                    <span
                      key={`${prefix}-${item.keyLabel}-${tokenIndex}`}
                      className="rounded-md border border-paper-300 bg-paper-200/85 px-2 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-700"
                    >
                      {token}
                    </span>
                  ))}
              </div>
              <div className="min-w-0">
                <div className="text-[15px] font-medium leading-5 text-ink-900">{item.label}</div>
                <div className="mt-0.5 text-xs leading-[1.35rem] text-ink-500">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
