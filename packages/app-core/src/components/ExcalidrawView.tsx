import { useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { parseExcalidrawDocument } from '@shared/excalidraw'

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
  const [initialData, setInitialData] = useState<InitialData | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef<string>('')
  const latestScene = useRef<LatestScene | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path

  const writeLatestScene = (savePath: string): void => {
    const scene = latestScene.current
    if (!scene) return
    let json: string
    try {
      json = serializeAsJSON(scene.elements, scene.appState, scene.files, 'local')
    } catch {
      return
    }
    if (json === lastSaved.current) return
    lastSaved.current = json
    void window.zen.writeNote(savePath, json)
  }

  const flushPendingSave = (savePath = pathRef.current): void => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    writeLatestScene(savePath)
  }

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
    setInitialData(undefined)
    window.zen
      .readNote(path)
      .then((res) => {
        if (cancelled) return
        lastSaved.current = res?.body ?? ''
        latestScene.current = null
        const doc = parseExcalidrawDocument(res?.body ?? '')
        const rememberedViewport = viewportMemory.get(path)
        setInitialData({
          elements: doc.elements,
          appState: rememberedViewport
            ? { ...doc.appState, ...rememberedViewport }
            : doc.appState,
          files: doc.files
        } as InitialData)
      })
      .catch(() => {
        if (!cancelled) setInitialData({} as InitialData)
      })
    return () => {
      flushPendingSave(path)
      cancelled = true
    }
  }, [path])

  useEffect(
    () => () => {
      flushPendingSave()
    },
    []
  )

  if (initialData === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500">
        Loading drawing…
      </div>
    )
  }

  return (
    <div className="min-h-0 w-full flex-1" style={{ height: '100%' }} data-excalidraw-view>
      <Excalidraw
        initialData={initialData}
        theme={excalidrawTheme}
        onChange={(elements, appState, files) => {
          latestScene.current = { elements, appState, files }
          rememberViewport(pathRef.current, appState)
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => {
            saveTimer.current = null
            // Skip no-op writes (Excalidraw fires onChange on load and on hover).
            writeLatestScene(pathRef.current)
          }, 700)
        }}
      />
    </div>
  )
}
