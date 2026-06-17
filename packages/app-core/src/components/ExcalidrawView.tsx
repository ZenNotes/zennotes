import { useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { parseExcalidrawDocument } from '@shared/excalidraw'
import { useStore } from '../store'
import { THEMES } from '../lib/themes'

type InitialData = ComponentProps<typeof Excalidraw>['initialData']

/**
 * The embedded Excalidraw drawing editor for a `.excalidraw` file. Loaded lazily
 * (see LazyExcalidrawView) so the heavy bundle never touches startup. Reads the
 * scene JSON from disk on open and debounce-saves it back on every change.
 */
export function ExcalidrawView({ path }: { path: string }): JSX.Element {
  const [initialData, setInitialData] = useState<InitialData | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef<string>('')
  const pathRef = useRef(path)
  pathRef.current = path

  // Match the app's light/dark theme.
  const themeId = useStore((s) => s.themeId)
  const excalidrawTheme = THEMES.find((t) => t.id === themeId)?.mode === 'dark' ? 'dark' : 'light'

  useEffect(() => {
    let cancelled = false
    setInitialData(undefined)
    window.zen
      .readNote(path)
      .then((res) => {
        if (cancelled) return
        lastSaved.current = res?.body ?? ''
        const doc = parseExcalidrawDocument(res?.body ?? '')
        setInitialData({
          elements: doc.elements,
          appState: doc.appState,
          files: doc.files
        } as InitialData)
      })
      .catch(() => {
        if (!cancelled) setInitialData({} as InitialData)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
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
    <div className="min-h-0 w-full flex-1" style={{ height: '100%' }}>
      <Excalidraw
        initialData={initialData}
        theme={excalidrawTheme}
        onChange={(elements, appState, files) => {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => {
            let json: string
            try {
              json = serializeAsJSON(elements, appState, files, 'local')
            } catch {
              return
            }
            // Skip no-op writes (Excalidraw fires onChange on load and on hover).
            if (json === lastSaved.current) return
            lastSaved.current = json
            void window.zen.writeNote(pathRef.current, json)
          }, 700)
        }}
      />
    </div>
  )
}
