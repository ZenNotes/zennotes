import { describe, expect, it } from 'vitest'
import type { WorkflowOp } from './types'
import { prepareWorkflowRun } from './prepare-run'

describe('prepareWorkflowRun', () => {
  it('turns workflow ops into one optimistic file transaction for the server', async () => {
    const files = new Map<string, string>([['inbox/A.md', '# A\n']])
    const ops: WorkflowOp[] = [
      { kind: 'append', path: 'inbox/A.md', text: 'done' },
      { kind: 'archive', path: 'inbox/A.md' },
      { kind: 'notify', message: 'Archived' }
    ]

    const prepared = await prepareWorkflowRun(
      { workflowId: 'docker-workflow', ops },
      {
        read: async (path) => files.get(path) ?? null,
        systemFolderDirs: {}
      }
    )

    expect(prepared).toEqual({
      workflowId: 'docker-workflow',
      ops,
      applied: 2,
      irreversible: 1,
      changes: [
        { path: 'inbox/A.md', before: '# A\n', after: null },
        { path: 'archive/A.md', before: null, after: '# A\ndone\n' }
      ]
    })
  })

  it('refuses a create that would replace an existing note', async () => {
    await expect(
      prepareWorkflowRun(
        {
          workflowId: 'unsafe-create',
          ops: [{ kind: 'create-note', path: 'inbox/A.md', body: '' }]
        },
        {
          read: async (path) => (path === 'inbox/A.md' ? '# Existing\n' : null),
          systemFolderDirs: {}
        }
      )
    ).rejects.toThrow('create-note would replace the existing note inbox/A.md')
  })

  it('keeps a colliding archive destination unique in the prepared transaction', async () => {
    const files = new Map<string, string>([
      ['inbox/A.md', '# A\n'],
      ['archive/A.md', '# Existing archive\n']
    ])

    const prepared = await prepareWorkflowRun(
      {
        workflowId: 'collision',
        ops: [
          { kind: 'append', path: 'inbox/A.md', text: 'done' },
          { kind: 'archive', path: 'inbox/A.md' }
        ]
      },
      {
        read: async (path) => files.get(path) ?? null,
        systemFolderDirs: {}
      }
    )

    expect(prepared.changes).toEqual([
      { path: 'inbox/A.md', before: '# A\n', after: null },
      { path: 'archive/A 2.md', before: null, after: '# A\ndone\n' }
    ])
  })

  it('rejects malformed operations before reading or preparing files', async () => {
    await expect(
      prepareWorkflowRun(
        { workflowId: 'malformed', ops: [{ kind: 'write-note' }] },
        { read: async () => null, systemFolderDirs: {} }
      )
    ).rejects.toThrow('Workflow op 0 is not a valid operation')
  })
})
