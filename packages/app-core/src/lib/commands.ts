/**
 * Command registry for the app's Cmd+Shift+P palette.
 *
 * `buildCommands()` is called once every time the palette opens, so
 * each command's `title`, `when`, and keyboard-shortcut display
 * reflect the store state at that moment (toggle labels flip, context-
 * sensitive commands like "Unarchive" only show up when applicable).
 */
import { isTagsViewActive, isTasksViewActive, isTrashViewActive, useStore } from '../store'
import { promptApp } from '../components/PromptHost'
import { confirmApp } from '../components/ConfirmHost'
import { buildMoveNotePrompt, parseMoveNoteTarget } from './move-note'
import { focusPaneInDirection } from './pane-nav'
import { findLeaf } from './pane-layout'
import { requestPaneMode } from './pane-mode'
import { resolveQuickNoteTitle } from './quick-note-title'
import { getKeymapDisplay, type KeymapId } from './keymaps'
import { dispatchKeyboardContextMenu, findTabContextMenuTarget } from './keyboard-context-menu'
import { resolveSystemFolderLabels } from './system-folder-labels'
import { foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language'
import { DEMO_TOUR_START_PATH } from '@shared/demo-tour'

const APP_WEBSITE_URL = 'https://zennotes.org'
const APP_DISCORD_URL = 'https://discord.gg/W4fWzapKS6'
const APP_REPOSITORY_URL = 'https://github.com/ZenNotes/zennotes'
const APP_RELEASES_URL = 'https://github.com/ZenNotes/zennotes/releases/latest'
const APP_ISSUES_URL = 'https://github.com/ZenNotes/zennotes/issues'

export interface Command {
  /** Stable identifier — used as React key and for analytics. */
  id: string
  /** Display title. */
  title: string
  /** Category shown as a leading prefix ("Note", "View", etc.). */
  category: string
  /** Extra search terms, e.g. synonyms the user might type. */
  keywords?: string
  /** Optional keybinding to render on the right of the row. */
  shortcut?: string
  /** When false, the command is filtered out of the palette. */
  when?: () => boolean
  /** Runs when the user picks this entry. Async is fine. */
  run: () => void | Promise<void>
}

export function buildCommands(options?: { includeUnavailable?: boolean }): Command[] {
  const getState = (): ReturnType<typeof useStore.getState> => useStore.getState()
  const labels = () => resolveSystemFolderLabels(getState().systemFolderLabels)
  const pathLabel = (): string =>
    getState().workspaceMode === 'remote' ? 'Server Path' : 'Absolute Path'
  const shortcut = (id: KeymapId): string => getKeymapDisplay(getState().keymapOverrides, id)
  const leaderShortcut = (id: KeymapId): string =>
    `${shortcut('vim.leaderPrefix')} ${shortcut(id)}`
  const paneShortcut = (id: KeymapId): string =>
    `${shortcut('vim.panePrefix')} ${shortcut(id)}`
  const searchShortcut = (): string => {
    const state = getState()
    const primary = shortcut('global.searchNotes')
    if (state.vimMode) return primary
    return `${primary} / ${shortcut('global.searchNotesNonVim')}`
  }
  const openExternal = (url: string): void => {
    window.open(url, '_blank')
  }
  const cmds: Command[] = []

  /* ---------------- Note actions ---------------- */
  cmds.push(
    {
      id: 'note.new.quick',
      title: 'New Quick Note',
      category: 'Note',
      shortcut: shortcut('global.newQuickNote'),
      keywords: 'scratch capture jot',
      run: () => {
        const s = getState()
        const title = resolveQuickNoteTitle(s.notes, s.quickNoteDateTitle)
        return s.createAndOpen('quick', '', { title, focusTitle: true })
      }
    },
    {
      id: 'note.new.inbox',
      title:
        getState().vaultSettings.primaryNotesLocation === 'root'
          ? 'New Note in Vault Root'
          : `New Note in ${labels().inbox}`,
      category: 'Note',
      keywords: 'create add write',
      run: () => getState().createAndOpen('inbox', '', { focusTitle: true })
    },
    {
      id: 'note.daily.today',
      title: "Open Today's Daily Note",
      category: 'Note',
      keywords: 'daily journal date today log',
      when: () => getState().vaultSettings.dailyNotes.enabled,
      run: () => getState().openTodayDailyNote()
    },
    {
      id: 'note.new.here',
      title: 'New Note in Current Folder',
      category: 'Note',
      keywords: 'create add write',
      when: () => {
        const v = getState().view
        return v.kind === 'folder' && v.folder !== 'trash' && !isTrashViewActive(getState())
      },
      run: () => {
        if (isTrashViewActive(getState())) return
        const v = getState().view
        if (v.kind !== 'folder') return
        return getState().createAndOpen(v.folder, v.subpath, { focusTitle: true })
      }
    },
    {
      id: 'note.save',
      title: 'Save Note',
      category: 'Note',
      shortcut: ':w',
      keywords: 'persist write',
      when: () => !!getState().selectedPath,
      run: () => getState().persistActive()
    },
    {
      id: 'note.format',
      title: 'Format Markdown',
      category: 'Note',
      shortcut: ':format',
      keywords: 'prettier',
      when: () => !!getState().selectedPath,
      run: () => getState().formatActiveNote()
    },
    {
      id: 'note.rename',
      title: 'Rename Note…',
      category: 'Note',
      when: () => !!getState().activeNote,
      run: async () => {
        const active = getState().activeNote
        if (!active) return
        const next = await promptApp({
          title: 'Rename note',
          initialValue: active.title,
          okLabel: 'Rename'
        })
        if (next && next !== active.title) await getState().renameActive(next)
      }
    },
    {
      id: 'note.archive',
      title: `Move Note to ${labels().archive}`,
      category: 'Note',
      when: () => {
        const f = getState().activeNote?.folder
        return f === 'inbox' || f === 'quick'
      },
      run: () => getState().archiveActive()
    },
    {
      id: 'note.unarchive',
      title: 'Unarchive Note',
      category: 'Note',
      when: () => getState().activeNote?.folder === 'archive',
      run: () => getState().unarchiveActive()
    },
    {
      id: 'note.trash',
      title: `Move Note to ${labels().trash}`,
      category: 'Note',
      keywords: 'delete',
      when: () => !!getState().activeNote && getState().activeNote?.folder !== 'trash',
      run: () => getState().trashActive()
    },
    {
      id: 'note.restore',
      title: `Restore Note from ${labels().trash}`,
      category: 'Note',
      when: () => getState().activeNote?.folder === 'trash',
      run: () => getState().restoreActive()
    },
    {
      id: 'note.copy-wikilink',
      title: 'Copy Note as Wikilink',
      category: 'Note',
      keywords: 'link clipboard',
      when: () => !!getState().activeNote,
      run: async () => {
        const active = getState().activeNote
        if (!active) return
        const title = active.title || active.path.split('/').pop()?.replace(/\.md$/i, '') || ''
        window.zen.clipboardWriteText(`[[${title}]]`)
      }
    },
    {
      id: 'note.copy-path',
      title: 'Copy Note Path',
      category: 'Note',
      keywords: 'clipboard relative vault',
      when: () => !!getState().activeNote,
      run: async () => {
        const active = getState().activeNote
        if (!active) return
        window.zen.clipboardWriteText(active.path)
      }
    },
    {
      id: 'note.copy-absolute-path',
      title: `Copy Note ${pathLabel()}`,
      category: 'Note',
      keywords: 'clipboard full system file server path',
      when: () => !!getState().activeNote && !!getState().vault?.root,
      run: async () => {
        const s = getState()
        if (!s.activeNote || !s.vault) return
        // vault.root is the OS-native absolute path; note.path is POSIX
        // vault-relative. Joining with the platform separator keeps the
        // output pasteable into Finder/Explorer/terminal as-is.
        const sep = s.vault.root.includes('\\') ? '\\' : '/'
        const segments = s.activeNote.path.split('/').filter(Boolean)
        window.zen.clipboardWriteText(
          [s.vault.root.replace(/[\\/]+$/, ''), ...segments].join(sep)
        )
      }
    },
    {
      id: 'folder.copy-path',
      title: 'Copy Current Folder Path',
      category: 'Folder',
      keywords: 'clipboard relative vault',
      when: () => {
        const v = getState().view
        return v.kind === 'folder'
      },
      run: async () => {
        const v = getState().view
        if (v.kind !== 'folder') return
        const rel = v.subpath ? `${v.folder}/${v.subpath}` : v.folder
        window.zen.clipboardWriteText(rel)
      }
    },
    {
      id: 'folder.copy-absolute-path',
      title: `Copy Current Folder ${pathLabel()}`,
      category: 'Folder',
      keywords: 'clipboard full system file server path',
      when: () => {
        const s = getState()
        return s.view.kind === 'folder' && !!s.vault?.root
      },
      run: async () => {
        const s = getState()
        if (s.view.kind !== 'folder' || !s.vault) return
        const sep = s.vault.root.includes('\\') ? '\\' : '/'
        const segments = [s.view.folder, ...s.view.subpath.split('/').filter(Boolean)]
        window.zen.clipboardWriteText(
          [s.vault.root.replace(/[\\/]+$/, ''), ...segments].join(sep)
        )
      }
    },
    {
      id: 'note.reveal',
      title: 'Reveal Note in File Manager',
      category: 'Note',
      when: () =>
        !!getState().activeNote &&
        getState().workspaceMode !== 'remote' &&
        window.zen.getAppInfo().runtime === 'desktop',
      run: async () => {
        const p = getState().activeNote?.path
        if (p) await window.zen.revealNote(p)
      }
    },
    {
      id: 'note.float',
      title: 'Open in Floating Window',
      category: 'Note',
      keywords: 'popout window detach',
      when: () => !!getState().activeNote,
      run: async () => {
        const p = getState().activeNote?.path
        if (p) await window.zen.openNoteWindow(p)
      }
    },
    {
      id: 'note.move',
      title: 'Move Note to Folder…',
      category: 'Note',
      keywords: 'move mv relocate folder archive inbox',
      when: () => !!getState().activeNote,
      run: async () => {
        const state = getState()
        const active = state.activeNote
        if (!active) return
        const target = await promptApp(buildMoveNotePrompt(active, state.folders))
        if (!target) return
        const dest = parseMoveNoteTarget(target)
        await state.moveNote(active.path, dest.folder, dest.subpath)
      }
    }
  )

  /* ---------------- Tabs ---------------- */
  const getActiveLeaf = () => {
    const s = getState()
    return findLeaf(s.paneLayout, s.activePaneId)
  }
  const getActiveTabContext = () => {
    const leaf = getActiveLeaf()
    if (!leaf?.activeTab) return null
    const path = leaf.activeTab
    const pinnedSet = new Set(leaf.pinnedTabs)
    const tabIndex = leaf.tabs.indexOf(path)
    return {
      leaf,
      path,
      isPinned: pinnedSet.has(path),
      closableRight: leaf.tabs.slice(tabIndex + 1).filter((tab) => !pinnedSet.has(tab)),
      closableOthers: leaf.tabs.filter((tab) => tab !== path && !pinnedSet.has(tab))
    }
  }
  const getActiveTabMenuTarget = (): HTMLElement | null => {
    const ctx = getActiveTabContext()
    if (!ctx) return null
    return findTabContextMenuTarget(ctx.leaf.id, ctx.path)
  }
  // Is the active tab currently pinned in the active pane? Used to flip
  // the Pin/Unpin command title and gate visibility.
  const isActiveTabPinned = (): boolean => getActiveTabContext()?.isPinned ?? false

  cmds.push(
    {
      id: 'tab.close',
      title: 'Close Tab',
      category: 'Tabs',
      shortcut: shortcut('global.closeActiveTab'),
      when: () => !!getState().selectedPath,
      run: () => getState().closeActiveNote()
    },
    {
      id: 'tab.pin',
      title: isActiveTabPinned() ? 'Unpin Tab' : 'Pin Tab',
      category: 'Tabs',
      keywords: 'stick sticky',
      when: () => !!getState().activeNote,
      run: () => {
        const s = getState()
        if (s.activeNote) s.toggleTabPin(s.activePaneId, s.activeNote.path)
      }
    },
    {
      id: 'tab.close-others',
      title: 'Close Other Tabs in Pane',
      category: 'Tabs',
      keywords: 'only siblings keep current close others',
      when: () => (getActiveTabContext()?.closableOthers.length ?? 0) > 0,
      run: async () => {
        const ctx = getActiveTabContext()
        if (!ctx) return
        for (const path of ctx.closableOthers) {
          await getState().closeTabInPane(ctx.leaf.id, path)
        }
      }
    },
    {
      id: 'tab.close-right',
      title: 'Close Tabs to the Right',
      category: 'Tabs',
      keywords: 'siblings later right side close',
      when: () => (getActiveTabContext()?.closableRight.length ?? 0) > 0,
      run: async () => {
        const ctx = getActiveTabContext()
        if (!ctx) return
        for (const path of ctx.closableRight) {
          await getState().closeTabInPane(ctx.leaf.id, path)
        }
      }
    },
    {
      id: 'tab.menu',
      title: 'Open Active Tab Menu',
      category: 'Tabs',
      shortcut: 'Shift+F10',
      keywords: 'context menu right click active tab',
      when: () => !!getActiveTabMenuTarget(),
      run: () => {
        const target = getActiveTabMenuTarget()
        if (target) dispatchKeyboardContextMenu(target)
      }
    },
    {
      id: 'tab.buffers',
      title: 'Open Buffer Switcher…',
      category: 'Tabs',
      shortcut: getState().vimMode ? leaderShortcut('vim.leaderOpenBuffers') : undefined,
      keywords: 'buffers hidden tabs switch list vim leader',
      when: () => {
        const s = getState()
        const leaf = findLeaf(s.paneLayout, s.activePaneId)
        return !!leaf && leaf.tabs.length > 0
      },
      run: () => getState().setBufferPaletteOpen(true)
    },
    {
      id: 'nav.outline',
      title: 'Open Note Outline…',
      category: 'Navigation',
      shortcut: getState().vimMode ? leaderShortcut('vim.leaderNoteOutline') : undefined,
      keywords: 'outline headings toc jump toc table of contents leader',
      when: () => !!getState().activeNote,
      run: () => getState().setOutlinePaletteOpen(true)
    },
    {
      id: 'view.outline-panel',
      title: 'Toggle Outline Panel',
      category: 'View',
      shortcut: shortcut('global.toggleOutlinePanel'),
      keywords: 'outline panel sidebar right headings',
      when: () => !!getState().activeNote,
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-outline'))
      }
    },
    {
      id: 'view.mode.edit',
      title: 'Switch to Edit Mode',
      category: 'View',
      shortcut: ':editmode',
      keywords: 'editor writing raw markdown pane mode toolbar',
      when: () => !!getState().activeNote,
      run: () => requestPaneMode('edit')
    },
    {
      id: 'view.mode.split',
      title: 'Switch to Split Mode',
      category: 'View',
      shortcut: ':splitmode',
      keywords: 'editor preview side by side pane mode toolbar',
      when: () => !!getState().activeNote,
      run: () => requestPaneMode('split')
    },
    {
      id: 'view.mode.preview',
      title: 'Switch to Preview Mode',
      category: 'View',
      shortcut: ':previewmode',
      keywords: 'reading rendered markdown pane mode toolbar',
      when: () => !!getState().activeNote,
      run: () => requestPaneMode('preview')
    },
    {
      id: 'view.zoom.in',
      title: 'Zoom In',
      category: 'View',
      shortcut: 'Mod+=',
      keywords: 'bigger larger scale ui app browser',
      run: async () => {
        await window.zen.zoomInApp()
      }
    },
    {
      id: 'view.zoom.out',
      title: 'Zoom Out',
      category: 'View',
      shortcut: 'Mod+-',
      keywords: 'smaller decrease scale ui app browser',
      run: async () => {
        await window.zen.zoomOutApp()
      }
    },
    {
      id: 'view.zoom.reset',
      title: 'Reset Zoom',
      category: 'View',
      shortcut: 'Mod+0',
      keywords: 'actual size normal reset scale ui app browser',
      run: async () => {
        await window.zen.resetAppZoom()
      }
    },
    {
      id: 'app.check-updates',
      title: 'Check for Updates…',
      category: 'App',
      keywords: 'update updates upgrade version release github',
      run: async () => {
        await window.zen.checkForAppUpdatesWithUi()
      }
    },
    {
      id: 'app.website',
      title: 'Open ZenNotes Website',
      category: 'App',
      keywords: 'homepage website docs learn',
      run: () => openExternal(APP_WEBSITE_URL)
    },
    {
      id: 'app.discord',
      title: 'Join ZenNotes Discord',
      category: 'App',
      keywords: 'community chat support server discord',
      run: () => openExternal(APP_DISCORD_URL)
    },
    {
      id: 'app.github',
      title: 'Open GitHub Repository',
      category: 'App',
      keywords: 'github source repository code',
      run: () => openExternal(APP_REPOSITORY_URL)
    },
    {
      id: 'app.release',
      title: 'View Latest Release',
      category: 'App',
      keywords: 'release download changelog latest',
      run: () => openExternal(APP_RELEASES_URL)
    },
    {
      id: 'app.report-issue',
      title: 'Report an Issue',
      category: 'App',
      keywords: 'bug issue github feedback problem',
      run: () => openExternal(APP_ISSUES_URL)
    },
    {
      id: 'fold.heading',
      title: 'Fold Heading at Cursor',
      category: 'Editor',
      shortcut: shortcut('vim.foldCurrent'),
      keywords: 'collapse fold heading section',
      when: () => !!getState().editorViewRef && !!getState().activeNote,
      run: () => {
        const view = getState().editorViewRef
        if (view) {
          foldCode(view)
          view.focus()
        }
      }
    },
    {
      id: 'fold.unfold-heading',
      title: 'Unfold Heading at Cursor',
      category: 'Editor',
      shortcut: shortcut('vim.unfoldCurrent'),
      keywords: 'expand unfold heading section',
      when: () => !!getState().editorViewRef && !!getState().activeNote,
      run: () => {
        const view = getState().editorViewRef
        if (view) {
          unfoldCode(view)
          view.focus()
        }
      }
    },
    {
      id: 'fold.all',
      title: 'Fold All Headings',
      category: 'Editor',
      shortcut: shortcut('vim.foldAll'),
      keywords: 'collapse fold all every',
      when: () => !!getState().editorViewRef && !!getState().activeNote,
      run: () => {
        const view = getState().editorViewRef
        if (view) {
          foldAll(view)
          view.focus()
        }
      }
    },
    {
      id: 'fold.unfold-all',
      title: 'Unfold All Headings',
      category: 'Editor',
      shortcut: shortcut('vim.unfoldAll'),
      keywords: 'expand unfold all every reset',
      when: () => !!getState().editorViewRef && !!getState().activeNote,
      run: () => {
        const view = getState().editorViewRef
        if (view) {
          unfoldAll(view)
          view.focus()
        }
      }
    },
    {
      id: 'nav.back',
      title: 'Go Back',
      category: 'Tabs',
      shortcut: shortcut('vim.historyBack'),
      keywords: 'history previous',
      run: () => getState().jumpToPreviousNote()
    },
    {
      id: 'nav.forward',
      title: 'Go Forward',
      category: 'Tabs',
      shortcut: shortcut('vim.historyForward'),
      keywords: 'history next',
      run: () => getState().jumpToNextNote()
    }
  )

  /* ---------------- Panes / Splits ---------------- */
  cmds.push(
    {
      id: 'split.right',
      title: 'Split Right',
      category: 'Panes',
      shortcut: ':vsplit',
      keywords: 'vsplit vertical',
      when: () => !!getState().selectedPath,
      run: () => {
        const st = getState()
        const path = st.selectedPath
        if (!path) return
        return st.splitPaneWithTab({
          targetPaneId: st.activePaneId,
          edge: 'right',
          path
        })
      }
    },
    {
      id: 'split.down',
      title: 'Split Down',
      category: 'Panes',
      shortcut: ':split',
      keywords: 'split horizontal',
      when: () => !!getState().selectedPath,
      run: () => {
        const st = getState()
        const path = st.selectedPath
        if (!path) return
        return st.splitPaneWithTab({
          targetPaneId: st.activePaneId,
          edge: 'bottom',
          path
        })
      }
    },
    {
      id: 'pane.focus.left',
      title: 'Focus Pane Left',
      category: 'Panes',
      shortcut: paneShortcut('vim.paneFocusLeft'),
      run: () => {
        focusPaneInDirection('h')
      }
    },
    {
      id: 'pane.focus.down',
      title: 'Focus Pane Below',
      category: 'Panes',
      shortcut: paneShortcut('vim.paneFocusDown'),
      run: () => {
        focusPaneInDirection('j')
      }
    },
    {
      id: 'pane.focus.up',
      title: 'Focus Pane Above',
      category: 'Panes',
      shortcut: paneShortcut('vim.paneFocusUp'),
      run: () => {
        focusPaneInDirection('k')
      }
    },
    {
      id: 'pane.focus.right',
      title: 'Focus Pane Right',
      category: 'Panes',
      shortcut: paneShortcut('vim.paneFocusRight'),
      run: () => {
        focusPaneInDirection('l')
      }
    }
  )

  /* ---------------- Navigation ---------------- */
  cmds.push(
    {
      id: 'nav.search',
      title: 'Search Notes…',
      category: 'Go',
      shortcut: searchShortcut(),
      keywords: 'find open cmd+f ctrl+f leader',
      run: () => getState().setSearchOpen(true)
    },
    {
      id: 'nav.search-text',
      title: 'Search Text in Vault…',
      category: 'Go',
      shortcut: getState().vimMode ? leaderShortcut('vim.leaderSearchVaultText') : undefined,
      keywords: 'grep live grep telescope fuzzy content body line text vault',
      run: () => {
        const s = getState()
        s.setSearchOpen(false)
        s.setVaultTextSearchOpen(true)
      }
    },
    {
      id: 'nav.folder.quick',
      title: `Go to ${labels().quick}`,
      category: 'Go',
      keywords: 'quick scratch',
      run: () => getState().setView({ kind: 'folder', folder: 'quick', subpath: '' })
    },
    {
      id: 'nav.folder.inbox',
      title: `Go to ${labels().inbox}`,
      category: 'Go',
      run: () => getState().setView({ kind: 'folder', folder: 'inbox', subpath: '' })
    },
    {
      id: 'nav.folder.archive',
      title: `Go to ${labels().archive}`,
      category: 'Go',
      keywords: 'archive archived storage',
      run: () => getState().openArchiveView()
    },
    {
      id: 'nav.folder.trash',
      title: `Go to ${labels().trash}`,
      category: 'Go',
      keywords: 'trash deleted restore bin',
      run: () => getState().openTrashView()
    },
    {
      id: 'nav.assets',
      title: 'Go to Files',
      category: 'Go',
      keywords: 'assets files images',
      run: () => getState().setView({ kind: 'assets' })
    },
    {
      id: 'nav.focus.sidebar',
      title: 'Focus Sidebar',
      category: 'Go',
      run: () => {
        const st = getState()
        if (!st.sidebarOpen) st.toggleSidebar()
        st.setFocusedPanel('sidebar')
      }
    },
    {
      id: 'nav.focus.editor',
      title: 'Focus Editor',
      category: 'Go',
      run: () => {
        const st = getState()
        st.setFocusedPanel('editor')
        requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
      }
    }
  )

  /* ---------------- View / Layout ---------------- */
  cmds.push(
    {
      id: 'view.tasks',
      title: 'Open Tasks',
      category: 'View',
      shortcut: ':tasks',
      keywords: 'todo checklist due waiting done vault',
      when: () => !isTasksViewActive(getState()),
      run: () => getState().openTasksView()
    },
    {
      id: 'view.tags',
      title: 'Open Tags',
      category: 'View',
      shortcut: ':tag',
      keywords: 'tags browse filter vault',
      when: () => !isTagsViewActive(getState()),
      run: () => getState().openTagView()
    },
    {
      id: 'view.toggle.sidebar',
      title: 'Toggle Sidebar',
      category: 'View',
      shortcut: shortcut('global.toggleSidebar'),
      run: () => getState().toggleSidebar()
    },
    {
      id: 'view.toggle.connections',
      title: 'Toggle Connections Panel',
      category: 'View',
      shortcut: shortcut('global.toggleConnections'),
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-connections'))
      }
    },
    {
      id: 'view.toggle.note-list',
      title: 'Toggle Note List Column',
      category: 'View',
      keywords: 'middle pane list browser',
      when: () => !getState().unifiedSidebar,
      run: () => getState().toggleNoteList()
    },
    {
      id: 'view.toggle.tags',
      title: getState().tagsCollapsed
        ? 'Show Tags in Sidebar'
        : 'Hide Tags in Sidebar',
      category: 'View',
      keywords: 'tag section fold hide collapse',
      run: () => getState().setTagsCollapsed(!getState().tagsCollapsed),
    },
    {
      id: 'view.content-align',
      title: getState().contentAlign === 'center'
        ? 'Align Content Left'
        : 'Center Content',
      category: 'View',
      keywords: 'align center left width reading',
      run: () =>
        getState().setContentAlign(
          getState().contentAlign === 'center' ? 'left' : 'center'
        )
    },
    {
      id: 'view.sort.name-asc',
      title: 'Sort Notes: Name (A → Z)',
      category: 'View',
      keywords: 'alphabetical order',
      when: () => getState().noteSortOrder !== 'name-asc',
      run: () => getState().setNoteSortOrder('name-asc')
    },
    {
      id: 'view.sort.name-desc',
      title: 'Sort Notes: Name (Z → A)',
      category: 'View',
      keywords: 'alphabetical order reverse',
      when: () => getState().noteSortOrder !== 'name-desc',
      run: () => getState().setNoteSortOrder('name-desc')
    },
    {
      id: 'view.sort.updated-desc',
      title: 'Sort Notes: Updated (Newest First)',
      category: 'View',
      keywords: 'date recent time modified',
      when: () => getState().noteSortOrder !== 'updated-desc',
      run: () => getState().setNoteSortOrder('updated-desc')
    },
    {
      id: 'view.sort.updated-asc',
      title: 'Sort Notes: Updated (Oldest First)',
      category: 'View',
      keywords: 'date time modified',
      when: () => getState().noteSortOrder !== 'updated-asc',
      run: () => getState().setNoteSortOrder('updated-asc')
    },
    {
      id: 'view.sort.created-desc',
      title: 'Sort Notes: Created (Newest First)',
      category: 'View',
      keywords: 'date added',
      when: () => getState().noteSortOrder !== 'created-desc',
      run: () => getState().setNoteSortOrder('created-desc')
    },
    {
      id: 'view.sort.created-asc',
      title: 'Sort Notes: Created (Oldest First)',
      category: 'View',
      keywords: 'date added reverse',
      when: () => getState().noteSortOrder !== 'created-asc',
      run: () => getState().setNoteSortOrder('created-asc')
    },
    {
      id: 'view.sort.manual',
      title: 'Sort Notes: Manual',
      category: 'View',
      keywords: 'none drag order',
      when: () => getState().noteSortOrder !== 'none',
      run: () => getState().setNoteSortOrder('none')
    },
    {
      id: 'view.group-by-kind',
      title: getState().groupByKind
        ? 'Ungroup Notes by Kind'
        : 'Group Notes by Kind',
      category: 'View',
      keywords: 'folders notes split section',
      run: () => getState().setGroupByKind(!getState().groupByKind)
    },
    {
      id: 'view.focus-mode',
      title: (() => {
        const st = getState()
        return st.zenMode ? 'Exit Zen Mode' : 'Enter Zen Mode'
      })(),
      category: 'View',
      shortcut: shortcut('global.toggleZenMode'),
      keywords: 'zen distraction-free focus',
      run: () => {
        const st = getState()
        st.setFocusMode(!st.zenMode)
      }
    },
    {
      id: 'view.dark-sidebar',
      title: getState().darkSidebar ? 'Light Sidebar' : 'Dark Sidebar',
      category: 'View',
      run: () => getState().setDarkSidebar(!getState().darkSidebar)
    },
    {
      id: 'view.line-numbers.off',
      title: 'Line Numbers: Off',
      category: 'View',
      when: () => getState().lineNumberMode !== 'off',
      run: () => getState().setLineNumberMode('off')
    },
    {
      id: 'view.line-numbers.absolute',
      title: 'Line Numbers: Absolute',
      category: 'View',
      when: () => getState().lineNumberMode !== 'absolute',
      run: () => getState().setLineNumberMode('absolute')
    },
    {
      id: 'view.line-numbers.relative',
      title: 'Line Numbers: Relative',
      category: 'View',
      when: () => getState().lineNumberMode !== 'relative',
      run: () => getState().setLineNumberMode('relative')
    }
  )

  /* ---------------- Editor preferences ---------------- */
  cmds.push(
    {
      id: 'editor.vim.toggle',
      title: getState().vimMode ? 'Disable Vim Mode' : 'Enable Vim Mode',
      category: 'Editor',
      run: () => getState().setVimMode(!getState().vimMode)
    },
    {
      id: 'editor.which-key.toggle',
      title: getState().whichKeyHints
        ? 'Disable Leader Key Hints'
        : 'Enable Leader Key Hints',
      category: 'Editor',
      keywords: 'which-key leader space hints overlay vim',
      when: () => getState().vimMode,
      run: () => getState().setWhichKeyHints(!getState().whichKeyHints)
    },
    {
      id: 'editor.live-preview.toggle',
      title: getState().livePreview ? 'Disable Live Preview' : 'Enable Live Preview',
      category: 'Editor',
      keywords: 'decoration inline',
      run: () => getState().setLivePreview(!getState().livePreview)
    },
    {
      id: 'editor.tabs.toggle',
      title: getState().tabsEnabled ? 'Disable Tabs' : 'Enable Tabs',
      category: 'Editor',
      run: () => getState().setTabsEnabled(!getState().tabsEnabled)
    },
    {
      id: 'editor.word-wrap.toggle',
      title: getState().wordWrap ? 'Disable Word Wrap' : 'Enable Word Wrap',
      category: 'Editor',
      shortcut: shortcut('global.toggleWordWrap'),
      keywords: 'wrap line soft hard',
      run: () => getState().setWordWrap(!getState().wordWrap)
    },
    {
      id: 'editor.auto-reveal.toggle',
      title: getState().autoReveal
        ? 'Disable Auto-Reveal Active Note'
        : 'Enable Auto-Reveal Active Note',
      category: 'Editor',
      run: () => getState().setAutoReveal(!getState().autoReveal)
    },
    {
      id: 'editor.quick-note-date.toggle',
      title: getState().quickNoteDateTitle
        ? 'Disable Quick Note Date Titles'
        : 'Enable Quick Note Date Titles'
      ,
      category: 'Editor',
      keywords: 'daily date today yyyy-mm-dd',
      run: () => getState().setQuickNoteDateTitle(!getState().quickNoteDateTitle)
    },
    {
      id: 'editor.pdf-embed.compact',
      title: 'PDF Embeds: Compact Card',
      category: 'Editor',
      keywords: 'pdf embed compact card preview reference',
      when: () => getState().pdfEmbedInEditMode !== 'compact',
      run: () => getState().setPdfEmbedInEditMode('compact')
    },
    {
      id: 'editor.pdf-embed.full',
      title: 'PDF Embeds: Inline Viewer',
      category: 'Editor',
      keywords: 'pdf embed full iframe inline',
      when: () => getState().pdfEmbedInEditMode !== 'full',
      run: () => getState().setPdfEmbedInEditMode('full')
    }
  )

  /* ---------------- Reference pane ---------------- */
  cmds.push(
    {
      id: 'ref.pin',
      title: 'Pin Active Note as Reference',
      category: 'Reference',
      keywords: 'sticky side companion research',
      when: () => !!getState().activeNote,
      run: async () => {
        const path = getState().activeNote?.path
        if (path) await getState().pinReference(path)
      }
    },
    {
      id: 'ref.unpin',
      title: 'Unpin Reference',
      category: 'Reference',
      when: () => !!getState().pinnedRefPath,
      run: () => {
        getState().unpinReference()
      }
    },
    {
      id: 'ref.toggle',
      title: getState().pinnedRefVisible
        ? 'Hide Reference Pane'
        : 'Show Reference Pane',
      category: 'Reference',
      when: () => !!getState().pinnedRefPath,
      run: () => {
        getState().togglePinnedRefVisible()
      }
    },
    {
      id: 'ref.focus',
      title: 'Focus Reference Pane',
      category: 'Reference',
      when: () =>
        !!getState().pinnedRefPath && getState().pinnedRefVisible,
      run: () => {
        const cm = document.querySelector<HTMLElement>(
          '[data-pane-id="pinned-ref"] .cm-content'
        )
        cm?.focus()
      }
    }
  )

  /* ---------------- Theme ---------------- */
  // One entry that opens a dedicated nested picker with live preview.
  // `CommandPalette` recognises this id and swaps its list in-place
  // instead of running anything.
  cmds.push({
    id: 'ui.themes',
    title: 'Themes…',
    category: 'UI',
    keywords: 'color appearance palette dark light',
    run: () => {
      /* handled by CommandPalette */
    }
  })

  /* ---------------- Tags ---------------- */
  cmds.push(
    {
      id: 'tag.rename',
      title: 'Rename Tag…',
      category: 'Tag',
      run: async () => {
        const from = await promptApp({
          title: 'Rename tag — old name',
          placeholder: 'tag'
        })
        if (!from) return
        const cleanFrom = from.replace(/^#/, '').trim()
        if (!cleanFrom) return
        const to = await promptApp({
          title: `Rename #${cleanFrom} to…`,
          placeholder: 'new-tag'
        })
        if (!to) return
        const cleanTo = to.replace(/^#/, '').trim()
        if (!cleanTo) return
        await getState().renameTag(cleanFrom, cleanTo)
      }
    },
    {
      id: 'tag.delete',
      title: 'Delete Tag…',
      category: 'Tag',
      run: async () => {
        const tag = await promptApp({
          title: 'Delete tag across all notes',
          placeholder: 'tag'
        })
        if (!tag) return
        const clean = tag.replace(/^#/, '').trim()
        if (!clean) return
        await getState().deleteTag(clean)
      }
    }
  )

  /* ---------------- App / Vault ---------------- */
  cmds.push(
    {
      id: 'demo.generate',
      title: getState().notes.some((note) => note.path === DEMO_TOUR_START_PATH)
        ? 'Regenerate Demo Tour Notes'
        : 'Generate Demo Tour Notes',
      category: 'Demo',
      keywords: 'demo onboarding starter tour sample example seed welcome',
      when: () => !!getState().vault,
      run: async () => {
        const installed = getState().notes.some((note) => note.path === DEMO_TOUR_START_PATH)
        const ok = await confirmApp({
          title: installed
            ? 'Regenerate the built-in demo tour in this vault?'
            : 'Generate the built-in demo tour in this vault?',
          description: installed
            ? 'This will overwrite the seeded demo notes under inbox/demo and reset the demo attachment.'
            : 'This will add starter notes under inbox/demo and a demo attachment file.',
          confirmLabel: installed ? 'Regenerate' : 'Generate'
        })
        if (!ok) return
        const result = await window.zen.generateDemoTour()
        await getState().refreshNotes()
        for (const path of result.notePaths) {
          await getState().applyChange({ kind: 'change', path, folder: 'inbox' })
        }
        await getState().selectNote(DEMO_TOUR_START_PATH)
      }
    },
    {
      id: 'demo.remove',
      title: 'Remove Demo Tour Notes',
      category: 'Demo',
      keywords: 'demo onboarding starter tour sample example delete clear uninstall',
      when: () => getState().notes.some((note) => note.path === DEMO_TOUR_START_PATH),
      run: async () => {
        const ok = await confirmApp({
          title: 'Remove the built-in demo tour from this vault?',
          description:
            'This deletes the seeded demo notes under inbox/demo and the demo attachment file.',
          confirmLabel: 'Remove demo tour',
          danger: true
        })
        if (!ok) return
        const result = await window.zen.removeDemoTour()
        await getState().refreshNotes()
        for (const path of result.notePaths) {
          await getState().applyChange({ kind: 'unlink', path, folder: 'inbox' })
        }
      }
    },
    {
      id: 'app.help',
      title: 'Open Help',
      category: 'App',
      keywords: 'manual docs documentation shortcuts vim onboarding learn',
      run: () => getState().openHelpView()
    },
    {
      id: 'app.settings',
      title: 'Open Settings',
      category: 'App',
      shortcut: shortcut('global.openSettings'),
      keywords: 'preferences',
      run: () => getState().setSettingsOpen(true)
    },
    {
      id: 'app.vault.pick',
      title:
        window.zen.getCapabilities().supportsRemoteWorkspace &&
        window.zen.getAppInfo().runtime === 'desktop'
          ? 'Open Local Vault…'
          : 'Open Vault…',
      category: 'Vault',
      keywords: 'vault local open folder workspace',
      run: () => getState().openVaultPicker()
    },
    {
      id: 'app.workspace.remote',
      title: 'Connect to Remote Vault…',
      category: 'Vault',
      keywords: 'vault remote server workspace self-hosted',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsRemoteWorkspace,
      run: () => getState().connectRemoteWorkspace()
    },
    {
      id: 'app.workspace.local',
      title: 'Switch to Local Vault',
      category: 'Vault',
      keywords: 'vault local workspace disconnect return',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        getState().workspaceMode === 'remote',
      run: () => getState().disconnectRemoteWorkspace()
    },
    {
      id: 'app.assets.reveal',
      title: 'Reveal Vault Root',
      category: 'App',
      when: () =>
        getState().workspaceMode !== 'remote' &&
        window.zen.getAppInfo().runtime === 'desktop',
      run: () => getState().revealAssetsDir()
    }
  )

  if (
    window.zen.getAppInfo().runtime === 'desktop' &&
    window.zen.getCapabilities().supportsRemoteWorkspace
  ) {
    const { remoteWorkspaceProfiles } = getState()
    for (const profile of remoteWorkspaceProfiles) {
      const isCurrent = getState().remoteWorkspaceInfo?.profileId === profile.id
      cmds.push({
        id: `app.workspace.remote.profile.${profile.id}`,
        title: `${isCurrent ? 'Remote Vault (Connected):' : 'Remote Vault:'} ${profile.name}`,
        category: 'Vault',
        keywords: `${profile.name} ${profile.baseUrl} ${profile.vaultPath ?? ''} vault remote server workspace saved profile`,
        run: () => {
          if (isCurrent) return
          return getState().connectRemoteWorkspaceProfile(profile.id)
        }
      })
    }
  }

  // Filter out commands whose `when` guard rejects them.
  if (options?.includeUnavailable) return cmds
  return cmds.filter((c) => !c.when || c.when())
}
