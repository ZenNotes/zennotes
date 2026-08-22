// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { moveNoteToTrash } from './trash-note'
import { useToastStore } from './toast'

const meta: NoteMeta = {
  path: 'quick/Scratch.md',
  title: 'Scratch',
  folder: 'quick',
  siblingOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  size: 12,
  tags: []
} as unknown as NoteMeta

const moveToTrash = vi.fn<(path: string) => Promise<NoteMeta>>()

beforeEach(() => {
  moveToTrash.mockReset()
  useToastStore.setState({ toasts: [] })
  Object.defineProperty(window, 'zen', { value: { moveToTrash }, configurable: true })
})

describe('moveNoteToTrash', () => {
  it('returns the moved meta and stays quiet in an ordinary vault', async () => {
    moveToTrash.mockResolvedValue(meta)
    await expect(moveNoteToTrash('quick/Scratch.md')).resolves.toEqual(meta)
    expect(moveToTrash).toHaveBeenCalledWith('quick/Scratch.md')
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('tells a temporary folder session where the note went', async () => {
    moveToTrash.mockResolvedValue(meta)
    await moveNoteToTrash('quick/Scratch.md', { temporarySession: true })
    const [toast] = useToastStore.getState().toasts
    expect(toast?.type).toBe('info')
    expect(toast?.message).toContain('system Trash')
  })

  it('surfaces a refusal as an error toast instead of a console line (#650)', async () => {
    moveToTrash.mockRejectedValue(
      new Error(
        "Error invoking remote method 'vault:move-to-trash': Error: Move to Trash is not available here."
      )
    )
    await expect(moveNoteToTrash('quick/Scratch.md')).resolves.toBeNull()
    const [toast] = useToastStore.getState().toasts
    expect(toast?.type).toBe('error')
    expect(toast?.message).toBe('Could not move to Trash: Move to Trash is not available here.')
  })
})
