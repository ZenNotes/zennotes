import { renderZenNotesApp } from '@zennotes/app-core/main'
import { installBridge, webBasePath } from './bridge/http-bridge'
import { renderExportNoteWindow } from './export-window'

installBridge()

// Point Excalidraw's font loader at our same-origin, CSP-allowed path instead of
// its default esm.sh CDN, which the server's `font-src 'self'` blocks so font
// changes never rendered on web (the web counterpart of the desktop #324 fix).
// Must be set before the lazy Excalidraw bundle loads; it appends
// `fonts/<Family>/<file>` to this base. `webBasePath` keeps it correct under a
// reverse-proxy subpath deploy.
const excalidrawGlobal = window as unknown as { EXCALIDRAW_ASSET_PATH?: string }
excalidrawGlobal.EXCALIDRAW_ASSET_PATH = `${webBasePath}/excalidraw-assets/`

const root = document.getElementById('root')
if (!root) {
  throw new Error('Renderer root element #root was not found')
}

const params = new URLSearchParams(window.location.search)
const exportNotePath = params.get('exportNote')
if (exportNotePath) {
  renderExportNoteWindow(root, exportNotePath)
} else {
  renderZenNotesApp(root)
}
