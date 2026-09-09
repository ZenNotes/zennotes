import { useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { parseExcalidrawDocument } from '@shared/excalidraw'
import { useStore } from '../store'

type InitialData = ComponentProps<typeof Excalidraw>['initialData']
type ExcalidrawProps = ComponentProps<typeof Excalidraw>
type OnChange = NonNullable<ExcalidrawProps['onChange']>
type SceneElements = Parameters<OnChange>[0]
type AppState = Parameters<OnChange>[1]
type BinaryFiles = Parameters<OnChange>[2]

interface LatestScene {
  elements: SceneElements
  appState: AppState
  files: BinaryFiles
}

/**
 * One opened drawing: the scene the canvas reports and the debounced write
 * that persists it, bound to the vault path the scene was read from.
 *
 * The binding is what keeps a switch between drawings from destroying one
 * of them (#755). The view used to hold a single "latest scene" and write it
 * to whichever path the view was showing when the debounce fired. Excalidraw
 * reads `initialData` once at mount and reports its scene through onChange
 * from componentDidUpdate on every render, so a canvas that survives a path
 * change keeps reporting the OLD drawing under the NEW path. It survived more
 * often than not: the read for the next drawing answers in about a
 * millisecond on a local vault, and React then folds the "show the
 * placeholder" and "mount the next drawing" state updates into a single
 * render, so the old canvas was never torn down. Seven hundred milliseconds
 * later the old scene overwrote the file that had just been opened.
 *
 * Every change is now recorded against the session of the canvas that
 * reported it, and a session that the view has left is closed: its flush is
 * final, and a last report from the canvas being torn down cannot arm a
 * write against any path.
 */
interface DrawingSession {
  path: string
  /** Serialized scene last written to, or read from, `path`. */
  lastSaved: string
  latest: LatestScene | null
  timer: ReturnType<typeof setTimeout> | null
  /** Set once the view leaves this drawing. */
  closed: boolean
}

interface LoadedDrawing {
  session: DrawingSession
  initialData: InitialData
}

const SAVE_DEBOUNCE_MS = 700

type ViewportState = Pick<AppState, 'scrollX' | 'scrollY' | 'zoom'>

const VIEWPORT_MEMORY_LIMIT = 60
const viewportMemory = new Map<string, ViewportState>()

function rememberViewport(path: string, appState: AppState): void {
  viewportMemory.delete(path)
  viewportMemory.set(path, {
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom
  })
  while (viewportMemory.size > VIEWPORT_MEMORY_LIMIT) {
    const oldest = viewportMemory.keys().next().value
    if (oldest === undefined) break
    viewportMemory.delete(oldest)
  }
}

function writeSession(session: DrawingSession): void {
  const scene = session.latest
  if (!scene) return
  let json: string
  try {
    json = serializeAsJSON(scene.elements, scene.appState, scene.files, 'local')
  } catch {
    return
  }
  if (json === session.lastSaved) return
  session.lastSaved = json
  void window.zen.writeNote(session.path, json)
}

function flushSession(session: DrawingSession): void {
  if (session.timer) {
    clearTimeout(session.timer)
    session.timer = null
  }
  writeSession(session)
}

function closeSession(session: DrawingSession | null): void {
  if (!session || session.closed) return
  session.closed = true
  flushSession(session)
}

function recordChange(
  session: DrawingSession,
  elements: SceneElements,
  appState: AppState,
  files: BinaryFiles
): void {
  if (session.closed) return
  session.latest = { elements, appState, files }
  rememberViewport(session.path, appState)
  if (session.timer) clearTimeout(session.timer)
  session.timer = setTimeout(() => {
    session.timer = null
    // Skip no-op writes (Excalidraw fires onChange on load and on hover).
    writeSession(session)
  }, SAVE_DEBOUNCE_MS)
}

function readThemeMode(): 'light' | 'dark' {
  return typeof document !== 'undefined' &&
    document.documentElement.dataset.themeMode === 'dark'
    ? 'dark'
    : 'light'
}

/**
 * The embedded Excalidraw drawing editor for a `.excalidraw` file. Loaded lazily
 * (see LazyExcalidrawView) so the heavy bundle never touches startup. Reads the
 * scene JSON from disk on open and debounce-saves it back on every change.
 */
export function ExcalidrawView({ path }: { path: string }): JSX.Element {
  const [loaded, setLoaded] = useState<LoadedDrawing | null>(null)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const sessionRef = useRef<DrawingSession | null>(null)

  // Follow the app's resolved light/dark mode. That mode lives on
  // `<html data-theme-mode>`, maintained in App.tsx (it already accounts for
  // built-in themes, custom themes, and auto/system) — custom theme ids aren't
  // in the built-in THEMES registry, so we can't derive the mode from themeId.
  // Observe the attribute so an open drawing tracks live theme and OS dark-mode
  // switches, rather than reading it once during render. (#363)
  const [excalidrawTheme, setExcalidrawTheme] = useState<'light' | 'dark'>(readThemeMode)
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const html = document.documentElement
    const sync = (): void => setExcalidrawTheme(readThemeMode())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(html, { attributes: true, attributeFilter: ['data-theme-mode'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    const open = (body: string): void => {
      const doc = parseExcalidrawDocument(body)
      const session: DrawingSession = {
        path,
        lastSaved: body,
        latest: null,
        timer: null,
        closed: false
      }
      sessionRef.current = session
      const rememberedViewport = viewportMemory.get(path)
      setLoaded({
        session,
        initialData: {
          elements: doc.elements,
          appState: rememberedViewport
            ? { ...doc.appState, ...rememberedViewport }
            : doc.appState,
          files: doc.files
        } as InitialData
      })
    }
    window.zen.readNote(path).then(
      (res) => {
        if (!cancelled) open(res?.body ?? '')
      },
      () => {
        if (!cancelled) open('')
      }
    )
    return () => {
      cancelled = true
      // Only a read that resolved for this path can have opened a session, so
      // whatever is here belongs to the drawing being left. Closing it writes
      // its scene to its own path and retires it before the next drawing is
      // read; the view never carries a scene across paths.
      closeSession(sessionRef.current)
      sessionRef.current = null
    }
  }, [path])

  if (!loaded) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500">
        Loading drawing…
      </div>
    )
  }

  const { session, initialData } = loaded
  return (
    // Clicking into the drawing claims the keyboard the same way the editor
    // and the archive list do. Without the claim, focusedPanel stayed on the
    // sidebar row that opened the drawing: the sidebar kept painting its
    // cursor, and pane navigation (Ctrl+W h/l) measured from the wrong
    // panel. VimNav yields to the canvas by DOM focus regardless (#721).
    <div
      className="min-h-0 w-full flex-1"
      style={{ height: '100%' }}
      data-excalidraw-view
      onMouseDownCapture={() => setFocusedPanel('editor')}
      onFocusCapture={() => setFocusedPanel('editor')}
    >
      {/* One canvas per path. Excalidraw reads initialData once at mount, so a
          path change has to remount it, including when React folds the
          placeholder render into the next drawing's render (#755). */}
      <Excalidraw
        key={session.path}
        initialData={initialData}
        theme={excalidrawTheme}
        onChange={(elements, appState, files) =>
          recordChange(session, elements, appState, files)
        }
      />
    </div>
  )
}
