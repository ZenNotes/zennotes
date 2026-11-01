// Where Excalidraw loads its bundled fonts from: main serves the
// `zen-excalidraw:` protocol from resources/excalidraw-fonts (#324). Shared by
// the renderer, which sets EXCALIDRAW_ASSET_PATH to it, and by
// electron.vite.config.ts, which points Excalidraw's CDN fallback at it too.
export const EXCALIDRAW_ASSET_PATH = 'zen-excalidraw://assets/'
