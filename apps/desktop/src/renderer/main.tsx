import { installZenBridge } from '@zennotes/bridge-contract/bridge'
import { renderZenNotesApp } from '@zennotes/app-core/main'

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

window.addEventListener('error', (event) => {
  console.error('[desktop-renderer] uncaught error', event.error ?? event.message)
  renderBootError(String(event.error?.stack ?? event.error ?? event.message))
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[desktop-renderer] unhandled rejection', event.reason)
  renderBootError(String(event.reason?.stack ?? event.reason))
})

try {
  if (!window.zen) {
    throw new Error('window.zen bridge is unavailable in the desktop renderer')
  }
  if (!root) {
    throw new Error('Renderer root element #root was not found')
  }
  installZenBridge(window.zen)
  renderZenNotesApp(root)
} catch (error) {
  console.error('[desktop-renderer] boot failed', error)
  renderBootError(String(error instanceof Error ? error.stack ?? error.message : error))
}
