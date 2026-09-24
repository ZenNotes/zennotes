import { describe, expect, it } from 'vitest'
import { buildWorkflowIndex } from './workflow-index'

describe('buildWorkflowIndex', () => {
  it('summarizes name, status, trigger, and whether any step writes', () => {
    const files = [
      {
        id: 'reading-log',
        sourcePath: '.zennotes/workflows/reading-log.md',
        raw: '---\nname: Reading log\ndescription: Sync it\n---\n\nbooks = tag #book\nbooks | add-tag #x\n'
      },
      {
        id: 'peek',
        sourcePath: '.zennotes/workflows/peek.md',
        raw: '---\nstatus: draft\n---\n\nnotes = all\n'
      },
      {
        id: 'file-topics',
        sourcePath: '.zennotes/workflows/file-topics.md',
        raw: '---\nname: File topics\ntrigger: on note-saved where folder = inbox\n---\n\nall | move Topics\n'
      }
    ]
    expect(buildWorkflowIndex(files)).toEqual([
      {
        id: 'reading-log',
        name: 'Reading log',
        description: 'Sync it',
        status: 'active',
        trigger: { type: 'manual' },
        mutates: true
      },
      // The name falls back to the id and a missing status reads as the
      // parser's default, so the index answers for every file the view lists.
      {
        id: 'peek',
        name: 'peek',
        description: '',
        status: 'draft',
        trigger: { type: 'manual' },
        mutates: false
      },
      // The trigger rides along as parsed, so the event triggers can find
      // their listeners without reading a file on every save.
      {
        id: 'file-topics',
        name: 'File topics',
        description: '',
        status: 'active',
        trigger: { type: 'event', event: 'note-saved', where: 'folder = inbox' },
        mutates: true
      }
    ])
  })

  it('still indexes a file with broken lines', () => {
    const files = [
      {
        id: 'wonky',
        sourcePath: '.zennotes/workflows/wonky.md',
        raw: '---\nname: Wonky\n---\n\nnot-a-verb something\n'
      }
    ]
    expect(buildWorkflowIndex(files)[0]).toMatchObject({ id: 'wonky', name: 'Wonky' })
  })

  it('degrades a trigger the engine does not know to manual, as the parser does', () => {
    const files = [
      {
        id: 'future',
        sourcePath: '.zennotes/workflows/future.md',
        raw: '---\ntrigger: on note-starred\n---\n\nnotes = all\n'
      }
    ]
    expect(buildWorkflowIndex(files)[0].trigger).toEqual({ type: 'manual' })
  })
})
