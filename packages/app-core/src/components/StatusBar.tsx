import { useMemo } from 'react'
import { useStore } from '../store'
import type { NoteContent, NoteMeta } from '@shared/ipc'
import { backlinksForNote } from '../lib/wikilinks'

/**
 * Footer strip showing quick stats for the active note: backlinks,
 * word count, character count, and estimated read time. Modelled on
 * the Obsidian status bar.
 *
 * Backlinks use the `wikilinks` field populated by the main process
 * on every `readMeta` call, so we don't need to re-scan note bodies
 * at render time.
 */
export function StatusBar({ note }: { note: NoteContent }): JSX.Element {
  const notes = useStore((s) => s.notes)

  const { words, characters, minutes } = useMemo(() => {
    const body = note.body
    const stripped = body
      .replace(/^---\n[\s\S]*?\n---\n/, '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
    const wordArr = stripped.trim().split(/\s+/).filter(Boolean)
    const w = wordArr.length
    const c = body.length
    const m = Math.max(1, Math.round(w / 200))
    return { words: w, characters: c, minutes: m }
  }, [note.body])

  const backlinks = useMemo(() => {
    return backlinksForNote(notes as NoteMeta[], note).length
  }, [note, notes])

  return (
    <div
      className="flex h-8 shrink-0 items-center justify-end gap-5 px-6 text-[11px] text-ink-500"
      style={{ borderTop: '1px solid var(--glass-stroke)' }}
    >
      <Stat>
        {backlinks} {backlinks === 1 ? 'backlink' : 'backlinks'}
      </Stat>
      <Stat>
        {words.toLocaleString()} {words === 1 ? 'word' : 'words'}
      </Stat>
      <Stat>{characters.toLocaleString()} characters</Stat>
      <Stat>{minutes} min read</Stat>
    </div>
  )
}

function Stat({ children }: { children: React.ReactNode }): JSX.Element {
  return <span className="tabular-nums">{children}</span>
}
