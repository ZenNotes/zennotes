import { lazy, Suspense } from 'react'

const PreviewImpl = lazy(() =>
  import('./Preview').then((mod) => ({ default: mod.Preview }))
)

export function LazyPreview({
  markdown,
  notePath,
  onRequestEdit,
  onRendered
}: {
  markdown: string
  notePath: string
  onRequestEdit?: (() => void) | null
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
