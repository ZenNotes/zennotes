import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function I(props: IconProps & { children: React.ReactNode }): JSX.Element {
  const { children, ...rest } = props
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const SearchIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </I>
)

export const InboxIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    <path d="M4 13 6.6 5.5A2 2 0 0 1 8.5 4h7a2 2 0 0 1 1.9 1.5L20 13" />
    <path d="M4 13h4l1.5 2.5h5L16 13h4" />
  </I>
)

export const ArchiveIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </I>
)

export const TagIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M20.6 12.6 12.7 20.5a1.8 1.8 0 0 1-2.5 0L3 13.4V4h9.4l8.2 8.2a1.8 1.8 0 0 1 0 2.4Z" />
    <circle cx="7.5" cy="8.5" r="1.2" />
  </I>
)

export const SettingsIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </I>
)

export const FeedbackIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
  </I>
)

export const TrashIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </I>
)

export const PlusIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </I>
)

export const CommandIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 10h.01" />
    <path d="M10 10h7" />
    <path d="M7 14h.01" />
    <path d="M10 14h4" />
  </I>
)

export const PanelLeftIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </I>
)

export const PanelRightIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </I>
)

export const ColumnsIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
    <path d="M15 4v16" />
  </I>
)

export const ChevronRightIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="m9 6 6 6-6 6" />
  </I>
)

export const MoreIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </I>
)

export const CloseIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="m18 6-12 12" />
    <path d="M6 6l12 12" />
  </I>
)

export const FolderPlusIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M12 12v4" />
    <path d="M10 14h4" />
  </I>
)

export const NotePlusIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9" />
    <path d="M14 3v6h6" />
    <path d="M12 13v4" />
    <path d="M10 15h4" />
  </I>
)

export const SortIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M3 6h13" />
    <path d="M3 12h9" />
    <path d="M3 18h5" />
    <path d="m17 8 3-3 3 3" />
    <path d="M20 5v14" />
  </I>
)

export const TargetIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" />
  </I>
)

export const ExpandAllIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </I>
)

export const ListTreeIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M21 12h-8" />
    <path d="M21 6H8" />
    <path d="M21 18h-8" />
    <path d="M3 6v4c0 1.1.9 2 2 2h3" />
    <path d="M3 10v6c0 1.1.9 2 2 2h3" />
  </I>
)

export const PinIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z" />
  </I>
)

export const ZapIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
  </I>
)

export const ExternalIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </I>
)

export const ArrowUpRightIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M7 17 17 7" />
    <path d="M8 7h9v9" />
  </I>
)

export const CheckSquareIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="m9 11 3 3 8-8" />
    <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" />
  </I>
)

export const DocumentIcon = (p: IconProps): JSX.Element => (
  <I {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </I>
)
