import { lazy, Suspense } from 'react'

const ExcalidrawViewImpl = lazy(() =>
  import('./ExcalidrawView').then((mod) => ({ default: mod.ExcalidrawView }))
)

/** Lazy boundary for the Excalidraw editor so its heavy bundle loads on demand. */
export function LazyExcalidrawView({ path }: { path: string }): JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500">
          Loading drawing…
        </div>
      }
    >
      <ExcalidrawViewImpl path={path} />
    </Suspense>
  )
}
