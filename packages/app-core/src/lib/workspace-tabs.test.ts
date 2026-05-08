import { describe, expect, it } from 'vitest'
import { HELP_TAB_PATH } from '@shared/help'
import { assetTabPath } from './asset-tabs'
import type { PaneLayout } from './pane-layout'
import {
  initialWorkspaceRestoreContentPaths,
  workspaceRestorePrefetchContentPaths
} from './workspace-tabs'

describe('initialWorkspaceRestoreContentPaths', () => {
  it('loads only active real-note tabs for visible panes', () => {
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        {
          kind: 'leaf',
          id: 'left',
          tabs: ['inbox/inactive.md', 'inbox/active-left.md'],
          pinnedTabs: [],
          activeTab: 'inbox/active-left.md'
        },
        {
          kind: 'leaf',
          id: 'right',
          tabs: ['inbox/active-right.md', 'archive/inactive.md'],
          pinnedTabs: [],
          activeTab: 'inbox/active-right.md'
        }
      ]
    }

    expect(
      initialWorkspaceRestoreContentPaths(
        layout,
        new Set([
          'inbox/inactive.md',
          'inbox/active-left.md',
          'inbox/active-right.md',
          'archive/inactive.md'
        ])
      )
    ).toEqual(['inbox/active-left.md', 'inbox/active-right.md'])
  })

  it('skips virtual, asset, missing, and duplicate active tabs', () => {
    const duplicate = 'inbox/shared.md'
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'column',
      sizes: [0.25, 0.25, 0.25, 0.25],
      children: [
        {
          kind: 'leaf',
          id: 'help',
          tabs: [HELP_TAB_PATH],
          pinnedTabs: [],
          activeTab: HELP_TAB_PATH
        },
        {
          kind: 'leaf',
          id: 'asset',
          tabs: [assetTabPath('diagram.png')],
          pinnedTabs: [],
          activeTab: assetTabPath('diagram.png')
        },
        {
          kind: 'leaf',
          id: 'missing',
          tabs: ['inbox/missing.md'],
          pinnedTabs: [],
          activeTab: 'inbox/missing.md'
        },
        {
          kind: 'split',
          id: 'nested',
          direction: 'row',
          sizes: [0.5, 0.5],
          children: [
            {
              kind: 'leaf',
              id: 'first',
              tabs: [duplicate],
              pinnedTabs: [],
              activeTab: duplicate
            },
            {
              kind: 'leaf',
              id: 'second',
              tabs: [duplicate],
              pinnedTabs: [],
              activeTab: duplicate
            }
          ]
        }
      ]
    }

    expect(initialWorkspaceRestoreContentPaths(layout, new Set([duplicate]))).toEqual([
      duplicate
    ])
  })
})

describe('workspaceRestorePrefetchContentPaths', () => {
  it('queues inactive real-note tabs after initially restored paths', () => {
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        {
          kind: 'leaf',
          id: 'left',
          tabs: ['inbox/active-left.md', 'inbox/inactive-left.md', HELP_TAB_PATH],
          pinnedTabs: [],
          activeTab: 'inbox/active-left.md'
        },
        {
          kind: 'leaf',
          id: 'right',
          tabs: ['inbox/active-right.md', 'inbox/inactive-right.md', 'inbox/inactive-left.md'],
          pinnedTabs: [],
          activeTab: 'inbox/active-right.md'
        }
      ]
    }

    expect(
      workspaceRestorePrefetchContentPaths(
        layout,
        new Set([
          'inbox/active-left.md',
          'inbox/inactive-left.md',
          'inbox/active-right.md',
          'inbox/inactive-right.md'
        ]),
        new Set(['inbox/active-left.md', 'inbox/active-right.md'])
      )
    ).toEqual(['inbox/inactive-left.md', 'inbox/inactive-right.md'])
  })
})
