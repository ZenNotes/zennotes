import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { FloatingNoteApp } from './components/FloatingNoteApp'
import './styles/index.css'

export function renderZenNotesApp(root: HTMLElement): void {
  const params = new URLSearchParams(window.location.search)
  const isFloating = params.get('floating') === '1'
  const floatingNotePath = params.get('note')

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      {isFloating && floatingNotePath ? (
        <FloatingNoteApp notePath={floatingNotePath} />
      ) : (
        <App />
      )}
    </React.StrictMode>
  )
}
