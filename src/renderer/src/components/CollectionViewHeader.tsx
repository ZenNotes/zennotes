import type { ReactNode, Ref } from 'react'
import { SearchIcon } from './icons'

export function CollectionViewHeader({
  badge,
  badgeIcon,
  title,
  description,
  count,
  filter,
  onFilterChange,
  filterPlaceholder,
  inputRef,
  actions
}: {
  badge: string
  badgeIcon: ReactNode
  title: string
  description: string
  count: number
  filter: string
  onFilterChange: (value: string) => void
  filterPlaceholder: string
  inputRef?: Ref<HTMLInputElement>
  actions?: ReactNode
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-[22px] border border-paper-300/70 bg-paper-50/34 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="inline-flex items-center gap-2 rounded-full border border-paper-300/70 bg-paper-100/75 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-500">
                {badgeIcon}
                {badge}
              </div>
              <h1 className="text-[1.65rem] font-semibold tracking-tight text-ink-900 sm:text-[1.85rem]">
                {title}
              </h1>
              <span className="inline-flex items-center rounded-full border border-paper-300/70 bg-paper-100/70 px-2.5 py-1 text-[11px] font-medium text-ink-500">
                {count} note{count === 1 ? '' : 's'}
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-500">{description}</p>
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>

        <label className="flex items-center gap-3 rounded-xl border border-paper-300/70 bg-paper-100/80 px-4 py-2.5 text-sm text-ink-500">
          <SearchIcon width={16} height={16} />
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder={filterPlaceholder}
            className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400"
          />
        </label>
      </div>
    </section>
  )
}
