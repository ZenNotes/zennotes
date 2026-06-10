import { installZenBridge } from '@zennotes/bridge-contract/bridge'
import { renderZenNotesApp } from '@zennotes/app-core/main'
import { renderExportNoteWindow } from './export-window'

const root = document.getElementById('root')

function renderBootError(message: string): void {
  if (!root) return
  root.replaceChildren()
  const pre = document.createElement('pre')
  pre.style.padding = '24px'
  pre.style.color = '#b42318'
  pre.style.background = '#fff7f7'
  pre.style.font = '14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace'
  pre.style.whiteSpace = 'pre-wrap'
  pre.textContent = message
  root.appendChild(pre)
}

// Once the app has mounted, a stray async error must NOT blow away the whole
// UI — `renderBootError` wipes #root, so reserve it for failures that happen
// *before* the app is up. After boot we only log, so e.g. a transient
// clipboard rejection no longer forces a relaunch (#79).
let booted = false

window.addEventListener('error', (event) => {
  console.error('[desktop-renderer] uncaught error', event.error ?? event.message)
  if (!booted) renderBootError(String(event.error?.stack ?? event.error ?? event.message))
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[desktop-renderer] unhandled rejection', event.reason)
  if (!booted) renderBootError(String(event.reason?.stack ?? event.reason))
})

try {
  if (!window.zen) {
    throw new Error('window.zen bridge is unavailable in the desktop renderer')
  }
  if (!root) {
    throw new Error('Renderer root element #root was not found')
  }
  installZenBridge(window.zen)
  const params = new URLSearchParams(window.location.search)
  const exportNotePath = params.get('exportNote')
  if (exportNotePath) {
    renderExportNoteWindow(root, exportNotePath)
  } else {
    renderZenNotesApp(root)
  }
  booted = true
} catch (error) {
  console.error('[desktop-renderer] boot failed', error)
  renderBootError(String(error instanceof Error ? error.stack ?? error.message : error))
}
