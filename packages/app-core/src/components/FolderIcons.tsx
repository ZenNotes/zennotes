import type { ReactNode, SVGProps } from 'react'
import type { FolderIconId, NoteFolder } from '@shared/ipc'
import { ArchiveIcon, DocumentIcon, InboxIcon, TagIcon, TrashIcon, ZapIcon } from './icons'
import { folderIconKey } from '../lib/vault-layout'

export interface FolderIconOption {
  id: FolderIconId
  label: string
  icon: JSX.Element
}

function Glyph({
  children,
  ...rest
}: SVGProps<SVGSVGElement> & { children: ReactNode }): JSX.Element {
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

export function FolderGlyphIcon({ open = false }: { open?: boolean }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={open ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      fillOpacity={open ? 0.18 : 0}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

function BookIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
    </Glyph>
  )
}

function BookmarkIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
    </Glyph>
  )
}

function CalendarIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18" />
    </Glyph>
  )
}

function BriefcaseIcon(): JSX.Element {
  return (
    <Glyph>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 12h18" />
    </Glyph>
  )
}

function SparkleIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="m12 3 1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8Z" />
      <path d="m19 15 .8 1.7L21.5 18l-1.7.8L19 20.5l-.8-1.7L16.5 18l1.7-.8Z" />
      <path d="m5 14 .8 1.7L7.5 17l-1.7.8L5 19.5l-.8-1.7L2.5 17l1.7-.8Z" />
    </Glyph>
  )
}

function CodeIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="m8 9-4 3 4 3" />
      <path d="m16 9 4 3-4 3" />
      <path d="m14 5-4 14" />
    </Glyph>
  )
}

function UserIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M20 21a8 8 0 0 0-16 0" />
      <circle cx="12" cy="8" r="4" />
    </Glyph>
  )
}

function StarIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2l1.1-6.2L3 9.6l6.2-.9Z" />
    </Glyph>
  )
}

function HeartIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="m12 20-1.4-1.2C5.2 14.2 2 11.3 2 7.8 2 5 4.2 3 7 3c1.6 0 3.1.7 4 1.9C12 3.7 13.4 3 15 3c2.8 0 5 2 5 4.8 0 3.5-3.2 6.4-8.6 11Z" />
    </Glyph>
  )
}

function LinkIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M10 13a5 5 0 0 0 7.1 0l2.1-2.1a5 5 0 0 0-7.1-7.1L10.9 5" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-2.1 2.1a5 5 0 0 0 7.1 7.1L13.1 19" />
    </Glyph>
  )
}

function LightbulbIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1.2 2.1h5.6c.2-.9.6-1.6 1.2-2.1A7 7 0 0 0 12 2Z" />
    </Glyph>
  )
}

function FlaskIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M10 2v6l-5.5 9.2A3 3 0 0 0 7 22h10a3 3 0 0 0 2.5-4.8L14 8V2" />
      <path d="M8 11h8" />
    </Glyph>
  )
}

function GraduationIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="m3 9 9-5 9 5-9 5-9-5Z" />
      <path d="M7 11.5V16c0 1.3 2.2 3 5 3s5-1.7 5-3v-4.5" />
      <path d="M21 10v5" />
    </Glyph>
  )
}

function MusicIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M9 18V6l10-2v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
    </Glyph>
  )
}

function ImageIcon(): JSX.Element {
  return (
    <Glyph>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m21 16-4.5-4.5a2 2 0 0 0-2.8 0L7 18" />
    </Glyph>
  )
}

function PaletteIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-1.4a1.6 1.6 0 0 1 0-3.2h1.9A4.5 4.5 0 0 0 18 9.3 6.3 6.3 0 0 0 12 3Z" />
      <circle cx="7.5" cy="10.5" r="1" />
      <circle cx="10.5" cy="7.5" r="1" />
      <circle cx="15.5" cy="8.5" r="1" />
      <circle cx="16.5" cy="13.5" r="1" />
    </Glyph>
  )
}

function TerminalIcon(): JSX.Element {
  return (
    <Glyph>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </Glyph>
  )
}

function WrenchIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M14.5 6.5a4 4 0 0 0 5 5l-8.8 8.8a2 2 0 1 1-2.8-2.8l8.8-8.8a4 4 0 0 0-5-5l2.1 2.1-2.8 2.8Z" />
    </Glyph>
  )
}

function GlobeIcon(): JSX.Element {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </Glyph>
  )
}

function MapIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2Z" />
      <path d="M9 4v14" />
      <path d="M15 6v14" />
    </Glyph>
  )
}

function ChartIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20v-3" />
    </Glyph>
  )
}

function HomeIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="m3 11 9-7 9 7" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-6h4v6" />
    </Glyph>
  )
}

export const FOLDER_ICON_OPTIONS: readonly FolderIconOption[] = [
  { id: 'folder', label: 'Folder', icon: <FolderGlyphIcon /> },
  { id: 'tray', label: 'Inbox', icon: <InboxIcon width={16} height={16} /> },
  { id: 'bolt', label: 'Quick', icon: <ZapIcon width={16} height={16} /> },
  { id: 'archive', label: 'Archive', icon: <ArchiveIcon width={16} height={16} /> },
  { id: 'trash', label: 'Trash', icon: <TrashIcon width={16} height={16} /> },
  { id: 'book', label: 'Book', icon: <BookIcon /> },
  { id: 'bookmark', label: 'Bookmark', icon: <BookmarkIcon /> },
  { id: 'calendar', label: 'Calendar', icon: <CalendarIcon /> },
  { id: 'briefcase', label: 'Briefcase', icon: <BriefcaseIcon /> },
  { id: 'tag', label: 'Tag', icon: <TagIcon width={16} height={16} /> },
  { id: 'document', label: 'Document', icon: <DocumentIcon width={16} height={16} /> },
  { id: 'sparkle', label: 'Sparkle', icon: <SparkleIcon /> },
  { id: 'code', label: 'Code', icon: <CodeIcon /> },
  { id: 'user', label: 'Person', icon: <UserIcon /> },
  { id: 'star', label: 'Star', icon: <StarIcon /> },
  { id: 'heart', label: 'Heart', icon: <HeartIcon /> },
  { id: 'link', label: 'Link', icon: <LinkIcon /> },
  { id: 'lightbulb', label: 'Idea', icon: <LightbulbIcon /> },
  { id: 'flask', label: 'Lab', icon: <FlaskIcon /> },
  { id: 'graduation', label: 'Study', icon: <GraduationIcon /> },
  { id: 'music', label: 'Music', icon: <MusicIcon /> },
  { id: 'image', label: 'Image', icon: <ImageIcon /> },
  { id: 'palette', label: 'Design', icon: <PaletteIcon /> },
  { id: 'terminal', label: 'Terminal', icon: <TerminalIcon /> },
  { id: 'wrench', label: 'Tools', icon: <WrenchIcon /> },
  { id: 'globe', label: 'Web', icon: <GlobeIcon /> },
  { id: 'map', label: 'Map', icon: <MapIcon /> },
  { id: 'chart', label: 'Chart', icon: <ChartIcon /> },
  { id: 'home', label: 'Home', icon: <HomeIcon /> }
] as const

const FOLDER_ICON_LOOKUP = new Map(FOLDER_ICON_OPTIONS.map((option) => [option.id, option]))

export function defaultFolderIconId(folder: NoteFolder, subpath: string): FolderIconId {
  if (subpath) return 'folder'
  switch (folder) {
    case 'quick':
      return 'bolt'
    case 'archive':
      return 'archive'
    case 'trash':
      return 'trash'
    case 'inbox':
    default:
      return 'tray'
  }
}

export function resolveFolderIconId(
  folder: NoteFolder,
  subpath: string,
  folderIcons: Record<string, FolderIconId>
): FolderIconId {
  return folderIcons[folderIconKey(folder, subpath)] ?? defaultFolderIconId(folder, subpath)
}

export function resolveFolderIconOption(
  folder: NoteFolder,
  subpath: string,
  folderIcons: Record<string, FolderIconId>
): FolderIconOption {
  return (
    FOLDER_ICON_LOOKUP.get(resolveFolderIconId(folder, subpath, folderIcons)) ??
    FOLDER_ICON_LOOKUP.get(defaultFolderIconId(folder, subpath)) ??
    FOLDER_ICON_OPTIONS[0]
  )
}

export function iconOptionById(id: FolderIconId): FolderIconOption {
  return FOLDER_ICON_LOOKUP.get(id) ?? FOLDER_ICON_OPTIONS[0]
}
