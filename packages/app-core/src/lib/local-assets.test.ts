// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { enhanceLocalAssetNodes } from './local-assets'
import { renderMarkdown } from './markdown'

const assetFiles = [
  {
    id: '1948417e-30d2-4175-8cd4-6cfcf4ee90fb',
    path: 'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset',
    name: '王菲 - 紅豆-(480p30).mp4',
    kind: 'video',
    sourcePath: 'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/source.mp4',
    previewPath: 'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/previews/320.png',
    siblingOrder: 0,
    size: 1,
    updatedAt: 1
  },
  {
    id: '26325d22-a8d7-49ab-8968-4df0c0f0b871',
    path: 'assets/26325d22-a8d7-49ab-8968-4df0c0f0b871.asset',
    name: '示例文档.pdf',
    kind: 'pdf',
    sourcePath: 'assets/26325d22-a8d7-49ab-8968-4df0c0f0b871.asset/source.pdf',
    siblingOrder: 1,
    size: 1,
    updatedAt: 1
  },
  {
    id: '92628069-ebfd-445c-8610-d24b489025af',
    path: 'assets/92628069-ebfd-445c-8610-d24b489025af.asset',
    name: 'forground_play.mp4',
    kind: 'video',
    sourcePath: 'assets/92628069-ebfd-445c-8610-d24b489025af.asset/source.mp4',
    previewPath: 'assets/92628069-ebfd-445c-8610-d24b489025af.asset/previews/320.png',
    siblingOrder: 2,
    size: 1,
    updatedAt: 1
  }
] as const

describe('enhanceLocalAssetNodes', () => {
  beforeEach(() => {
    useStore.setState({ assetFiles: [...assetFiles] })
    ;(window as unknown as {
      zen: { resolveVaultAssetUrl: (root: string, rel: string) => string }
    }).zen = {
      resolveVaultAssetUrl: (_root, rel) => `zen-asset://local/${rel}`
    }
  })

  it('splits a paragraph containing only asset links into separate embeds', () => {
    const root = document.createElement('article')
    root.innerHTML = renderMarkdown(
      [
        '![[asset:1948417e-30d2-4175-8cd4-6cfcf4ee90fb|王菲 - 紅豆-(480p30).mp4]]',
        '![[asset:26325d22-a8d7-49ab-8968-4df0c0f0b871|示例文档.pdf]]',
        '![[asset:92628069-ebfd-445c-8610-d24b489025af|forground_play.mp4]]'
      ].join('\n')
    )

    expect(useStore.getState().assetFiles).toHaveLength(3)
    expect(root.querySelectorAll('a[href^="asset:"]')).toHaveLength(3)

    enhanceLocalAssetNodes(root, {
      vaultRoot: '/vault',
      notePath: 'quick/想法和BUG.md',
      onOpenAsset: vi.fn()
    })

    expect(root.querySelectorAll('p')).toHaveLength(0)
    expect(root.querySelectorAll('figure')).toHaveLength(3)
    expect(root.querySelectorAll('video.local-video-embed-video')).toHaveLength(2)
    expect(root.querySelectorAll('.local-pdf-book-embed')).toHaveLength(1)
    expect(root.querySelector('.local-pdf-book-tag')?.textContent).toBe('PDF')
    expect(root.querySelectorAll('a[href^="asset:"]')).toHaveLength(0)
    expect(root.querySelector('video.local-video-embed-video')?.getAttribute('poster')).toContain(
      'previews/320.png'
    )
  })

  it('renders asset wikilinks even when sanitizer output has no href', () => {
    const root = document.createElement('article')
    root.innerHTML = [
      '<p>',
      '<a class="wikilink broken" data-wikilink="asset:1948417e-30d2-4175-8cd4-6cfcf4ee90fb">',
      '王菲 - 紅豆-(480p30).mp4',
      '</a>',
      '</p>'
    ].join('')

    enhanceLocalAssetNodes(root, {
      vaultRoot: '/vault',
      notePath: 'quick/想法和BUG.md',
      onOpenAsset: vi.fn()
    })

    expect(root.querySelectorAll('p')).toHaveLength(0)
    expect(root.querySelector('video.local-video-embed-video')).toBeTruthy()
    expect(root.querySelector('a.wikilink')).toBeNull()
  })

  it('splits asset wikilinks without href into separate embeds', () => {
    const root = document.createElement('article')
    root.innerHTML = [
      '<p>',
      '<a class="wikilink broken" data-wikilink="asset:1948417e-30d2-4175-8cd4-6cfcf4ee90fb">',
      '王菲 - 紅豆-(480p30).mp4',
      '</a><br>',
      '<a class="wikilink broken" data-wikilink="asset:26325d22-a8d7-49ab-8968-4df0c0f0b871">',
      '示例文档.pdf',
      '</a>',
      '</p>'
    ].join('')

    enhanceLocalAssetNodes(root, {
      vaultRoot: '/vault',
      notePath: 'quick/想法和BUG.md',
      onOpenAsset: vi.fn()
    })

    expect(root.querySelectorAll('p')).toHaveLength(0)
    expect(root.querySelectorAll('figure')).toHaveLength(2)
    expect(root.querySelector('video.local-video-embed-video')).toBeTruthy()
    expect(root.querySelector('.local-pdf-book-embed')).toBeTruthy()
  })

  it('resolves asset refs from UUID bundle paths when asset metadata has no id', () => {
    useStore.setState({
      assetFiles: assetFiles.map((asset) => {
        const { id: _id, ...withoutId } = asset
        return withoutId
      })
    })
    const root = document.createElement('article')
    root.innerHTML = renderMarkdown(
      '![[asset:1948417e-30d2-4175-8cd4-6cfcf4ee90fb|王菲 - 紅豆-(480p30).mp4]]'
    )

    enhanceLocalAssetNodes(root, {
      vaultRoot: '/vault',
      notePath: 'quick/想法和BUG.md',
      onOpenAsset: vi.fn()
    })

    expect(root.querySelector('video.local-video-embed-video')).toBeTruthy()
    expect(root.querySelector('video.local-video-embed-video')?.getAttribute('src')).toContain(
      'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/source.mp4'
    )
  })

  it('resolves asset refs from legacy listings of source files inside UUID bundles', () => {
    useStore.setState({
      assetFiles: [
        {
          path: 'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/source.mp4',
          name: 'source.mp4',
          kind: 'video',
          siblingOrder: 0,
          size: 1,
          updatedAt: 1
        }
      ]
    })
    const root = document.createElement('article')
    root.innerHTML = renderMarkdown(
      '![[asset:1948417e-30d2-4175-8cd4-6cfcf4ee90fb|王菲 - 紅豆-(480p30).mp4]]'
    )

    enhanceLocalAssetNodes(root, {
      vaultRoot: '/vault',
      notePath: 'quick/想法和BUG.md',
      onOpenAsset: vi.fn()
    })

    expect(root.querySelector('video.local-video-embed-video')).toBeTruthy()
    expect(root.querySelector('video.local-video-embed-video')?.getAttribute('src')).toContain(
      'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/source.mp4'
    )
  })

  it('replaces asset links that markdown nested inside a task list item', () => {
    const root = document.createElement('article')
    root.innerHTML = renderMarkdown(
      [
        '- [x] To do 渲染错误。',
        '![[asset:1948417e-30d2-4175-8cd4-6cfcf4ee90fb|王菲 - 紅豆-(480p30).mp4]]',
        '![[asset:26325d22-a8d7-49ab-8968-4df0c0f0b871|示例文档.pdf]]'
      ].join('\n')
    )

    expect(root.querySelectorAll('li a[href^="asset:"]')).toHaveLength(2)

    enhanceLocalAssetNodes(root, {
      vaultRoot: '/vault',
      notePath: 'quick/想法和BUG.md',
      onOpenAsset: vi.fn()
    })

    expect(root.querySelectorAll('li a[href^="asset:"]')).toHaveLength(0)
    expect(root.querySelectorAll('li br')).toHaveLength(0)
    expect(root.querySelector('li video.local-video-embed-video')).toBeNull()
    expect(root.querySelector('li .local-pdf-book-embed')).toBeNull()
    expect(root.querySelector('ul + figure video.local-video-embed-video')).toBeTruthy()
    expect(root.querySelector('ul + figure + figure.local-pdf-book-embed')).toBeTruthy()
    expect(root.querySelectorAll('figure[data-local-asset-hoisted="true"]')).toHaveLength(2)
  })
})
