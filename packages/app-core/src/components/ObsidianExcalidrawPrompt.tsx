import { useState } from 'react'
import { useStore } from '../store'
import { Button } from './ui/Button'

/**
 * Shown in place of the raw markdown when the open file is an Obsidian Excalidraw
 * drawing. Offers to convert it into a native ZenNotes `.excalidraw` drawing
 * (which then opens in the drawing editor). The original file is left in place. (#266)
 */
export function ObsidianExcalidrawPrompt({ path }: { path: string }): JSX.Element {
  const [converting, setConverting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConvert = async (): Promise<void> => {
    if (!window.zen.convertObsidianExcalidraw) {
      setError('Converting Obsidian drawings is only available in the desktop app.')
      return
    }
    setConverting(true)
    setError(null)
    try {
      const meta = await window.zen.convertObsidianExcalidraw(path)
      await useStore.getState().refreshNotes()
      await useStore.getState().selectNote(meta.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not convert this drawing.')
      setConverting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md rounded-3xl border border-paper-300/70 bg-paper-50/50 p-8 text-center shadow-[0_14px_36px_rgba(15,23,42,0.05)]">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </div>
        <h2 className="font-serif text-2xl font-semibold text-ink-900">
          Obsidian Excalidraw drawing
        </h2>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          This file is an Excalidraw drawing made with Obsidian. Convert it to a native ZenNotes
          drawing to view and edit it here. Your original file is left untouched.
        </p>
        <div className="mt-6">
          <Button
            variant="primary"
            size="md"
            onClick={() => void handleConvert()}
            disabled={converting}
          >
            {converting ? 'Converting…' : 'Convert to ZenNotes drawing'}
          </Button>
        </div>
        {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
      </div>
    </div>
  )
}
