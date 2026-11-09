import type { SVGProps } from 'react'

type GlyphProps = SVGProps<SVGSVGElement>

function Stroke(props: GlyphProps & { children: React.ReactNode }): JSX.Element {
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
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const FolderGlyph = (p: GlyphProps): JSX.Element => (
  <Stroke {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </Stroke>
)

/** Stacked pages: where Notion's workspaces live. Not Notion's mark. */
export const WorkspaceGlyph = (p: GlyphProps): JSX.Element => (
  <Stroke {...p}>
    <rect x="7" y="3.5" width="13" height="15" rx="2" />
    <path d="M4 8v10.5A2.5 2.5 0 0 0 6.5 21H15" />
    <path d="M10.5 8.5h6M10.5 12h6" />
  </Stroke>
)

/** An outline of nested bullets, for a graph of blocks. Not Logseq's mark. */
export const OutlineGlyph = (p: GlyphProps): JSX.Element => (
  <Stroke {...p}>
    <circle cx="5" cy="6" r="1.25" />
    <circle cx="10" cy="12" r="1.25" />
    <circle cx="10" cy="18" r="1.25" />
    <path d="M9 6h11M14 12h6M14 18h6M5 8v8.5a1.5 1.5 0 0 0 1.5 1.5H8" />
  </Stroke>
)

/** A faceted stone, for a local vault. Not Obsidian's mark. */
export const VaultGlyph = (p: GlyphProps): JSX.Element => (
  <Stroke {...p}>
    <path d="M12 3 5 8.5 7.5 19 12 21l4.5-2L19 8.5Z" />
    <path d="M12 3v18M5 8.5l7 3 7-3" />
  </Stroke>
)
