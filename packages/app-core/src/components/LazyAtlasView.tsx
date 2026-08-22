// Same lazy pattern as LazyWorkflowsView: the canvas view stays out of the
// boot path, and deliberately gets NO named manualChunks rule (see the
// packaging scars in electron.vite.config.ts).
import { lazy, Suspense } from 'react'

const AtlasViewImpl = lazy(() => import('./AtlasView').then((mod) => ({ default: mod.AtlasView })))

export function LazyAtlasView(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <AtlasViewImpl />
    </Suspense>
  )
}
