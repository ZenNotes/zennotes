import { lazy, Suspense } from 'react'
import type { DiagramTabPayload } from '../lib/diagram-tabs'
import type { PreviewEditRequest } from '../lib/preview-outline-jump'

const PreviewImpl = lazy(() =>
  import('./Preview').then((mod) => ({ default: mod.Preview }))
)

const DiagramTabViewImpl = lazy(() =>
  import('./Preview').then((mod) => ({ default: mod.DiagramTabView }))
)

export function LazyPreview({
  markdown,
  notePath,
  onRequestEdit,
  onRendered
}: {
  markdown: string
  notePath: string
  onRequestEdit?: ((request?: PreviewEditRequest | null) => void) | null
  onRendered?: (() => void) | null
}): JSX.Element {
  return (
    <Suspense fallback={null}>
      <PreviewImpl
        markdown={markdown}
        notePath={notePath}
        onRequestEdit={onRequestEdit}
        onRendered={onRendered}
      />
    </Suspense>
  )
}

export function LazyDiagramTabView({
  diagram
}: {
  diagram: DiagramTabPayload | null
}): JSX.Element {
  return (
    <Suspense fallback={null}>
      <DiagramTabViewImpl diagram={diagram} />
    </Suspense>
  )
}
