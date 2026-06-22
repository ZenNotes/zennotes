// Excalidraw drawings are stored as standalone `.excalidraw` files (the native
// Excalidraw JSON scene format). They are a first-class file type alongside
// Markdown notes and `.base` databases: listed in the sidebar with their own
// icon, opened in a dedicated editor tab, and saved back as JSON.

export const EXCALIDRAW_EXT = '.excalidraw'

export function isExcalidrawPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.toLowerCase().endsWith(EXCALIDRAW_EXT)
}

/** Display title for a drawing (filename without the `.excalidraw` extension). */
export function excalidrawTitleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.toLowerCase().endsWith(EXCALIDRAW_EXT)
    ? base.slice(0, -EXCALIDRAW_EXT.length)
    : base
}

/** The on-disk Excalidraw scene shape (a subset of the official format). */
export interface ExcalidrawDocument {
  type: 'excalidraw'
  version: number
  source: string
  elements: unknown[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

export function emptyExcalidrawDocument(): ExcalidrawDocument {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'zennotes',
    elements: [],
    appState: {},
    files: {}
  }
}

/** Parse on-disk JSON into a scene, falling back to an empty doc when invalid. */
export function parseExcalidrawDocument(raw: string): ExcalidrawDocument {
  try {
    const parsed = JSON.parse(raw) as Partial<ExcalidrawDocument>
    return {
      ...emptyExcalidrawDocument(),
      ...parsed,
      type: 'excalidraw',
      elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      appState:
        parsed.appState && typeof parsed.appState === 'object' ? parsed.appState : {},
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {}
    }
  } catch {
    return emptyExcalidrawDocument()
  }
}
