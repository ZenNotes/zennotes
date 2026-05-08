import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.css'

const FloatingNoteApp = lazy(async () => {
  const module = await import('./components/FloatingNoteApp')
  return { default: module.FloatingNoteApp }
})

const QuickCaptureApp = lazy(async () => {
  const module = await import('./components/QuickCaptureApp')
  return { default: module.QuickCaptureApp }
})

export function renderZenNotesApp(root: HTMLElement): void {
  const params = new URLSearchParams(window.location.search)
  const isFloating = params.get('floating') === '1'
  const isQuickCapture = params.get('quickCapture') === '1'
  const floatingNotePath = params.get('note')

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        {isQuickCapture ? (
          <QuickCaptureApp />
        ) : isFloating && floatingNotePath ? (
          <FloatingNoteApp notePath={floatingNotePath} />
        ) : (
          <App />
        )}
      </Suspense>
    </React.StrictMode>
  )
}
