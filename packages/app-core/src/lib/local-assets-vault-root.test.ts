// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// #459: pasting an image into a note that lives in a subfolder (e.g. a daily
// note under `Daily Notes/`) inserts a vault-root wikilink `![[assets/img.png]]`.
// That path must resolve from the vault root — Obsidian wikilink semantics —
// not relative to the note's folder, otherwise the embed silently fails to
// render whenever another file shares the basename. The reporter's manual fix
// (a leading slash, `![[/assets/img.png]]`) forced the root match; now the bare
// path does too.

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      resolveLocalAssetUrl: vi.fn((_r: string, _n: string, href: string) => `zen-asset://v/${href}`),
      resolveVaultAssetUrl: vi.fn((_r: string, rel: string) => `zen-asset://v/${rel}`)
    }
  })
}

async function load() {
  vi.resetModules()
  localStorage.clear()
  installZen()
  const { useStore } = await import('../store')
  const { resolveAssetVaultRelativePath, enhanceLocalAssetNodes } = await import('./local-assets')
  return { useStore, resolveAssetVaultRelativePath, enhanceLocalAssetNodes }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

const DAILY_NOTE = 'Daily Notes/2026-07-24.md'

describe('#459 — vault-root wikilink embeds resolve from the root', () => {
  it('resolves a path-qualified asset from a subfolder note even when the basename collides', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    useStore.setState({
      assetFiles: [{ path: 'assets/image.png' }, { path: 'Photos/image.png' }] as never
    })
    // Before the fix this returned null (note-relative join missed, basename
    // search was ambiguous) so the image never rendered.
    expect(resolveAssetVaultRelativePath('/v', DAILY_NOTE, 'assets/image.png')).toBe(
      'assets/image.png'
    )
    expect(resolveAssetVaultRelativePath('/v', DAILY_NOTE, 'Photos/image.png')).toBe(
      'Photos/image.png'
    )
  })

  it('still resolves a unique basename from a subfolder note', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    useStore.setState({ assetFiles: [{ path: 'assets/image.png' }] as never })
    expect(resolveAssetVaultRelativePath('/v', DAILY_NOTE, 'assets/image.png')).toBe(
      'assets/image.png'
    )
  })

  it('leading-slash absolute paths keep resolving from the root', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    useStore.setState({
      assetFiles: [{ path: 'assets/image.png' }, { path: 'Photos/image.png' }] as never
    })
    expect(resolveAssetVaultRelativePath('/v', DAILY_NOTE, '/assets/image.png')).toBe(
      'assets/image.png'
    )
  })

  it('prefers a genuine note-relative sibling over the vault-root candidate', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    // Both a sibling `Folder/pic.png` and a root `pic.png` exist: a note-relative
    // markdown link `[x](pic.png)` must still resolve to the sibling, not the root.
    useStore.setState({
      assetFiles: [{ path: 'Folder/pic.png' }, { path: 'pic.png' }] as never
    })
    expect(resolveAssetVaultRelativePath('/v', 'Folder/note.md', 'pic.png')).toBe('Folder/pic.png')
  })

  it('renders the img embed src for a subfolder note (end to end)', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({
      assetFiles: [{ path: 'assets/image.png' }, { path: 'Photos/image.png' }] as never
    })
    const root = document.createElement('div')
    root.innerHTML = '<p><img src="assets/image.png" alt="image.png"></p>'
    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: DAILY_NOTE })
    const img = root.querySelector<HTMLImageElement>('img')!
    expect(img.dataset.localAssetUrl).toBe('zen-asset://v/assets/image.png')
  })

  it('leaves a missing image unresolved without throwing', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({ assetFiles: [{ path: 'assets/other.png' }] as never })
    const root = document.createElement('div')
    root.innerHTML = '<p><img src="missing image.png" alt="Missing image"></p>'

    expect(() =>
      enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: DAILY_NOTE })
    ).not.toThrow()
    const img = root.querySelector<HTMLImageElement>('img')!
    expect(img.dataset.localAssetUrl).toBe('zen-asset://v/missing image.png')
    expect(img.getAttribute('alt')).toBe('Missing image')
  })
})

// #462: imported Obsidian vaults use per-folder `attachments/` directories and
// Markdown embeds written relative to the vault root, e.g. a note at
// `ProjectA/fileA1.md` linking `![](ProjectA/attachments/imageA1.png)`. Same
// root cause as #459 (vault-root path resolved against the note's folder); the
// basename collision that breaks it — the same image name reused across
// projects — is the common case in a multi-project vault.
describe('#462 — Obsidian-import Markdown embeds with per-folder attachments', () => {
  // Mirrors the reporter's layout: imageA1.png reused under two projects, plus
  // an unrelated root `attachments/` and `assets/` folder.
  const VAULT = [
    { path: 'ProjectA/attachments/imageA1.png' },
    { path: 'ProjectB/attachments/imageA1.png' },
    { path: 'assets/image.png' },
    { path: 'attachments/Pasted image 20260610101407.png' }
  ] as never

  it('resolves a vault-root Markdown path from a project subfolder despite a cross-project basename collision', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    useStore.setState({ assetFiles: VAULT })
    // Before the fix: note-relative join → ProjectA/ProjectA/attachments/... (miss),
    // basename `imageA1.png` ambiguous across ProjectA/ProjectB → null → blank.
    expect(resolveAssetVaultRelativePath('/v', 'ProjectA/fileA1.md', 'ProjectA/attachments/imageA1.png')).toBe(
      'ProjectA/attachments/imageA1.png'
    )
    // And a note in ProjectB resolves to ProjectB's copy, not ProjectA's.
    expect(resolveAssetVaultRelativePath('/v', 'ProjectB/fileB1.md', 'ProjectB/attachments/imageA1.png')).toBe(
      'ProjectB/attachments/imageA1.png'
    )
  })

  it('renders the Markdown `![](…)` image embed end to end from a project note', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({ assetFiles: VAULT })
    const root = document.createElement('div')
    // Markdown `![](ProjectA/attachments/imageA1.png)` → <img> with empty alt.
    root.innerHTML = '<p><img src="ProjectA/attachments/imageA1.png" alt=""></p>'
    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: 'ProjectA/fileA1.md' })
    const img = root.querySelector<HTMLImageElement>('img')!
    expect(img.dataset.localAssetUrl).toBe('zen-asset://v/ProjectA/attachments/imageA1.png')
  })

  it('the leading-slash workaround the reporter found still resolves', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    useStore.setState({ assetFiles: VAULT })
    expect(
      resolveAssetVaultRelativePath('/v', 'ProjectA/fileA1.md', '/ProjectA/attachments/imageA1.png')
    ).toBe('ProjectA/attachments/imageA1.png')
  })
})
