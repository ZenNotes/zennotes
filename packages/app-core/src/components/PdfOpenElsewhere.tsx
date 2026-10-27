import { openVaultAssetExternally } from '../lib/external-file-link'
import { DocumentIcon } from './icons'
import { Button } from './ui/Button'

/**
 * Stands in for a PDF's frame (the reference pane, an asset tab) where the
 * engine cannot draw one (`canShowPdfInline`): an iframe there is an empty
 * page, so the PDF goes to another app instead. A pin made before this
 * existed, or from a menu, still lands here rather than on a blank sheet.
 */
export function PdfOpenElsewhere({
  assetPath,
  title
}: {
  assetPath: string
  title: string
}): JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <DocumentIcon width={28} height={28} className="text-accent" />
      <div className="max-w-full truncate text-sm font-medium text-ink-900">{title}</div>
      <p className="max-w-xs text-xs text-ink-500">This device can't show PDFs inside ZenNotes.</p>
      <Button
        variant="primary"
        onClick={() => void openVaultAssetExternally(assetPath, { confirm: false })}
      >
        Open in another app
      </Button>
    </div>
  )
}
