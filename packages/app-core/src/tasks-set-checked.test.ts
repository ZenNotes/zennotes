// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { parseTasksFromBody, type VaultTask } from '@shared/tasks'
import { toggleTaskAtIndex } from '@shared/tasklists'
import { useStore } from './store'
import { setTaskChecked } from './tasks'

const PATH = 'inbox/Errands.md'

function meta(path: string): NoteMeta {
  return {
    path, title: 'Errands', folder: 'inbox', siblingOrder: 0, createdAt: 0, updatedAt: 1, size: 0,
    tags: [], wikilinks: [], hasAttachments: false, assetEmbeds: [], excerpt: ''
  }
}

describe('setTaskChecked (a tick from outside the app)', () => {
  let original: ReturnType<typeof useStore.getState>
  let disk = ''
  let writes = true
  const readNote = vi.fn(async (path: string) => ({ ...meta(path), body: disk }))
  const scan = (body: string): VaultTask[] => parseTasksFromBody(body, { path: PATH, title: 'Errands', folder: 'inbox' })
  // The real toggle's edit, on whichever body it would use, unless the
  // writer is told to decline (a folder operation holding it).
  const toggleTaskFromList = vi.fn(async (task: VaultTask) => {
    if (!writes) return
    const open = useStore.getState().noteContents[PATH]
    const next = toggleTaskAtIndex(open?.body ?? disk, task.taskIndex, !task.checked)
    if (open) {
      useStore.setState((s) => ({
        noteContents: { ...s.noteContents, [PATH]: { ...open, body: next } },
        noteDirty: { ...s.noteDirty, [PATH]: true }
      }))
    } else {
      disk = next
    }
  })
  const rescanTasksForPath = vi.fn(async () => {
    useStore.setState({ vaultTasks: scan(disk) })
  })

  beforeEach(() => {
    original = useStore.getState()
    writes = true
    toggleTaskFromList.mockClear()
    Object.defineProperty(window, 'zen', { configurable: true, value: { readNote } })
    useStore.setState({
      vault: { root: '/vault', name: 'Vault' } as never,
      notes: [meta(PATH)],
      vaultTasks: [],
      noteContents: {},
      noteDirty: {},
      toggleTaskFromList,
      rescanTasksForPath
    })
  })

  afterEach(() => useStore.setState(original, true))

  it('ticks the task the caller saw and reads the tick back', async () => {
    disk = '- [ ] One\n- [ ] Two\n'
    expect(await setTaskChecked(`${PATH}#1`, '- [ ] Two', true)).toBe('applied')
    expect(disk).toBe('- [ ] One\n- [x] Two\n')
  })

  it('finds the same line when lines above it moved', async () => {
    disk = '- [ ] New first\n- [ ] One\n- [ ] Two\n'
    expect(await setTaskChecked(`${PATH}#1`, '- [ ] Two', true)).toBe('applied')
    expect(disk).toBe('- [ ] New first\n- [ ] One\n- [x] Two\n')
  })

  it('looks the task up in an open note\'s buffer, the body the toggle edits', async () => {
    disk = '- [ ] Two\n'
    useStore.setState({
      noteContents: { [PATH]: { ...meta(PATH), body: '- [ ] Typed above\n- [ ] Two\n' } },
      noteDirty: { [PATH]: true }
    })
    expect(await setTaskChecked(`${PATH}#0`, '- [ ] Two', true)).toBe('applied')
    expect(useStore.getState().noteContents[PATH].body).toBe('- [ ] Typed above\n- [x] Two\n')
  })

  it('waits while a clean open buffer is behind the file on disk', async () => {
    disk = '- [ ] Added on the desktop\n- [ ] Two\n'
    useStore.setState({ noteContents: { [PATH]: { ...meta(PATH), body: '- [ ] Two\n' } } })
    expect(await setTaskChecked(`${PATH}#0`, '- [ ] Two', true)).toBe('retry')
    expect(toggleTaskFromList).not.toHaveBeenCalled()
  })

  it('says retry when the writer declined', async () => {
    disk = '- [ ] Two\n'
    writes = false
    expect(await setTaskChecked(`${PATH}#0`, '- [ ] Two', true)).toBe('retry')
  })

  it('leaves a task alone that is already in the wanted state', async () => {
    disk = '- [x] Two\n'
    expect(await setTaskChecked(`${PATH}#0`, '- [ ] Two', true)).toBe('unchanged')
    expect(toggleTaskFromList).not.toHaveBeenCalled()
  })

  it('unticks a line the widget ticked', async () => {
    disk = '- [x] Two\n'
    expect(await setTaskChecked(`${PATH}#0`, '- [x] Two', false)).toBe('applied')
    expect(disk).toBe('- [ ] Two\n')
  })

  it('never ticks a cancelled or forwarded task', async () => {
    disk = '- [-] Two\n- [>] Three\n'
    expect(await setTaskChecked(`${PATH}#0`, '- [ ] Two', true)).toBe('stale')
    expect(await setTaskChecked(`${PATH}#1`, '- [ ] Three', true)).toBe('stale')
    expect(toggleTaskFromList).not.toHaveBeenCalled()
  })

  it('ticks a task in a note saved with Windows line endings', async () => {
    disk = '- [ ] One\r\n- [ ] Two\r\n'
    expect(await setTaskChecked(`${PATH}#1`, '- [ ] Two', true)).toBe('applied')
    expect(disk).toBe('- [ ] One\r\n- [x] Two\r\n')
  })

  it('gives up when the line changed, is ambiguous, or the note is gone', async () => {
    disk = '- [ ] Two, renamed\n'
    expect(await setTaskChecked(`${PATH}#0`, '- [ ] Two', true)).toBe('stale')
    disk = '- [ ] A\n- [ ] Dup\n- [ ] Dup\n'
    expect(await setTaskChecked(`${PATH}#0`, '- [ ] Dup', true)).toBe('stale')
    useStore.setState({ notes: [] })
    expect(await setTaskChecked(`${PATH}#0`, '- [ ] A', true)).toBe('stale')
    expect(toggleTaskFromList).not.toHaveBeenCalled()
  })
})
