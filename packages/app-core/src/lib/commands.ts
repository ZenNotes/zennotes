/**
 * Command registry for the app's Cmd+Shift+P palette.
 *
 * `buildCommands()` is called once every time the palette opens, so
 * each command's `title`, `when`, and keyboard-shortcut display
 * reflect the store state at that moment (toggle labels flip, context-
 * sensitive commands like "Unarchive" only show up when applicable).
 */
import { isTagsViewActive, isTasksViewActive, isTrashViewActive, useStore } from '../store'
import { confirmApp } from './confirm-requests'
import { promptApp } from './prompt-requests'
import { buildMoveNotePrompt, parseMoveNoteTarget } from './move-note'
import { focusPaneInDirection } from './pane-nav'
import { findLeaf } from './pane-layout'
import { requestPaneMode } from './pane-mode'
import { resolveQuickNoteTitle } from './quick-note-title'
import { getKeymapDisplay, type KeymapId } from './keymaps'
import { translate } from './i18n'
import { dispatchKeyboardContextMenu, findTabContextMenuTarget } from './keyboard-context-menu'
import { resolveSystemFolderLabels } from './system-folder-labels'
import { normalizeVaultSettings } from './vault-layout'
import { DEMO_TOUR_START_PATH } from '@shared/demo-tour'

const APP_WEBSITE_URL = 'https://zennotes.org'
const APP_DISCORD_URL = 'https://discord.gg/W4fWzapKS6'
const APP_REPOSITORY_URL = 'https://github.com/songgnqing/zennotes'
const APP_RELEASES_URL = 'https://github.com/songgnqing/zennotes/releases/latest'
const APP_ISSUES_URL = 'https://github.com/songgnqing/zennotes/issues'

type FoldCommand = 'foldCode' | 'unfoldCode' | 'foldAll' | 'unfoldAll'

async function runFoldCommand(command: FoldCommand): Promise<void> {
  const view = useStore.getState().editorViewRef
  if (!view) return
  const foldModule = await import('@codemirror/language')
  foldModule[command](view)
  view.focus()
}

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
  // Translate a command title/category for the current UI language. The palette
  // rebuilds every time it opens, so reading the language here is enough.
  const tr = (s: string): string => translate(getState().language, s)
  const labels = () => resolveSystemFolderLabels(getState().systemFolderLabels)
  const pathLabel = (): string =>
    getState().workspaceMode === 'remote' ? tr('Server Path') : tr('Absolute Path')
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
      title: tr('New Quick Note'),
      category: tr('Note'),
      shortcut: shortcut('global.newQuickNote'),
      keywords: 'scratch capture jot',
      run: () => {
        const s = getState()
        const title = resolveQuickNoteTitle(
          s.notes,
          s.quickNoteDateTitle,
          s.quickNoteTitlePrefix ?? undefined
        )
        return s.createAndOpen('quick', '', { title, focusTitle: true })
      }
    },
    {
      id: 'note.new.inbox',
      title:
        getState().vaultSettings.primaryNotesLocation === 'root'
          ? tr('New Note in Vault Root')
          : `${tr('New Note in')} ${labels().inbox}`,
      category: tr('Note'),
      keywords: 'create add write',
      run: () => getState().createAndOpen('inbox', '', { focusTitle: true })
    },
    {
      id: 'database.new',
      title: tr('New Database'),
      category: tr('Note'),
      keywords: 'database table csv records spreadsheet board kanban base',
      run: () => getState().createDatabase('inbox', '')
    },
    {
      id: 'note.daily.today',
      title: tr("Open Today's Daily Note"),
      category: tr('Note'),
      keywords: 'daily journal date today log',
      shortcut: leaderShortcut('vim.leaderDailyNote'),
      when: () => getState().vaultSettings.dailyNotes.enabled,
      run: () => getState().openTodayDailyNote()
    },
    {
      id: 'note.weekly.thisWeek',
      title: tr("Open This Week's Note"),
      category: tr('Note'),
      keywords: 'weekly week review date log',
      shortcut: leaderShortcut('vim.leaderWeeklyNote'),
      when: () => getState().vaultSettings.weeklyNotes.enabled,
      run: () => getState().openThisWeekWeeklyNote()
    },
    {
      id: 'template.create',
      title: tr('New Note from Template…'),
      category: tr('Note'),
      keywords: 'template scaffold adr rfc meeting daily weekly boilerplate new',
      shortcut: leaderShortcut('vim.leaderTemplatePicker'),
      run: () => getState().setTemplatePaletteOpen(true)
    },
    {
      id: 'template.insert',
      title: tr('Insert Template into Current Note…'),
      category: tr('Note'),
      keywords: 'template insert apply into current note scaffold fill',
      shortcut: leaderShortcut('vim.leaderInsertTemplate'),
      when: () => !!getState().activeNote,
      run: () => getState().openTemplatePaletteForInsert()
    },
    {
      id: 'template.removeBuiltins',
      title: tr('Remove Built-in Templates'),
      category: tr('Note'),
      keywords: 'template built-in builtin remove hide delete clear shipped default',
      when: () => !getState().hideBuiltinTemplates,
      run: async () => {
        const ok = await confirmApp({
          title: tr('Remove all built-in templates?'),
          description:
            'The shipped templates will be hidden from the picker and palette. Your custom templates are unaffected, and you can restore the built-ins anytime.',
          confirmLabel: 'Remove',
          danger: true
        })
        if (!ok) return
        getState().setHideBuiltinTemplates(true)
      }
    },
    {
      id: 'template.restoreBuiltins',
      title: tr('Restore Built-in Templates'),
      category: tr('Note'),
      keywords: 'template built-in builtin restore bring back show shipped default',
      when: () => getState().hideBuiltinTemplates,
      run: () => getState().setHideBuiltinTemplates(false)
    },
    {
      id: 'template.saveCurrent',
      title: tr('Save Current Note as Template…'),
      category: tr('Note'),
      keywords: 'template save custom create from note',
      when: () => !!getState().activeNote,
      run: () => getState().saveActiveNoteAsTemplate()
    },
    {
      id: 'note.new.here',
      title: tr('New Note in Current Folder'),
      category: tr('Note'),
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
      title: tr('Save Note'),
      category: tr('Note'),
      shortcut: ':w',
      keywords: 'persist write',
      when: () => !!getState().selectedPath,
      run: () => getState().persistActive()
    },
    {
      id: 'note.format',
      title: tr('Format Markdown'),
      category: tr('Note'),
      shortcut: ':format',
      keywords: 'prettier',
      when: () => !!getState().selectedPath,
      run: () => getState().formatActiveNote()
    },
    {
      id: 'note.rename',
      title: tr('Rename Note…'),
      category: tr('Note'),
      when: () => !!getState().activeNote,
      run: async () => {
        const active = getState().activeNote
        if (!active) return
        const next = await promptApp({
          title: tr('Rename note'),
          initialValue: active.title,
          okLabel: 'Rename'
        })
        if (next && next !== active.title) await getState().renameActive(next)
      }
    },
    {
      id: 'note.archive',
      title: `${tr('Move Note to')} ${labels().archive}`,
      category: tr('Note'),
      when: () => {
        const f = getState().activeNote?.folder
        return f === 'inbox' || f === 'quick'
      },
      run: () => getState().archiveActive()
    },
    {
      id: 'note.unarchive',
      title: tr('Unarchive Note'),
      category: tr('Note'),
      when: () => getState().activeNote?.folder === 'archive',
      run: () => getState().unarchiveActive()
    },
    {
      id: 'note.trash',
      title: `${tr('Move Note to')} ${labels().trash}`,
      category: tr('Note'),
      keywords: 'delete',
      when: () => !!getState().activeNote && getState().activeNote?.folder !== 'trash',
      run: () => getState().trashActive()
    },
    {
      id: 'note.restore',
      title: `${tr('Restore Note from')} ${labels().trash}`,
      category: tr('Note'),
      when: () => getState().activeNote?.folder === 'trash',
      run: () => getState().restoreActive()
    },
    {
      id: 'note.copy-wikilink',
      title: tr('Copy Note as Wikilink'),
      category: tr('Note'),
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
      id: 'note.export-pdf',
      title: tr('Export Note as PDF…'),
      category: tr('Note'),
      shortcut: shortcut('global.exportNotePdf'),
      keywords: 'save print pdf export',
      when: () =>
        !!getState().activeNote &&
        (window.zen.getCapabilities().supportsLocalFilesystemPickers ||
          window.zen.getAppInfo().runtime === 'web'),
      run: async () => {
        await getState().exportActiveNotePdf()
      }
    },
    {
      id: 'note.copy-path',
      title: tr('Copy Note Path'),
      category: tr('Note'),
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
      title: `${tr('Copy Note')} ${pathLabel()}`,
      category: tr('Note'),
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
      title: tr('Copy Current Folder Path'),
      category: tr('Folder'),
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
      title: `${tr('Copy Current Folder')} ${pathLabel()}`,
      category: tr('Folder'),
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
      title: tr('Reveal Note in File Manager'),
      category: tr('Note'),
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
      title: tr('Open in Floating Window'),
      category: tr('Note'),
      keywords: 'popout window detach',
      when: () => !!getState().activeNote,
      run: async () => {
        const p = getState().activeNote?.path
        if (p) await window.zen.openNoteWindow(p)
      }
    },
    {
      id: 'note.move',
      title: tr('Move Note to Folder…'),
      category: tr('Note'),
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
      title: tr('Close Tab'),
      category: tr('Tabs'),
      shortcut: shortcut('global.closeActiveTab'),
      when: () => !!getState().selectedPath,
      run: () => getState().closeActiveNote()
    },
    {
      id: 'tab.pin',
      title: isActiveTabPinned() ? tr('Unpin Tab') : tr('Pin Tab'),
      category: tr('Tabs'),
      keywords: 'stick sticky',
      when: () => !!getState().activeNote,
      run: () => {
        const s = getState()
        if (s.activeNote) s.toggleTabPin(s.activePaneId, s.activeNote.path)
      }
    },
    {
      id: 'tab.close-others',
      title: tr('Close Other Tabs in Pane'),
      category: tr('Tabs'),
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
      title: tr('Close Tabs to the Right'),
      category: tr('Tabs'),
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
      title: tr('Open Active Tab Menu'),
      category: tr('Tabs'),
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
      title: tr('Open Buffer Switcher…'),
      category: tr('Tabs'),
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
      title: tr('Open Note Outline…'),
      category: tr('Navigation'),
      shortcut: getState().vimMode ? leaderShortcut('vim.leaderNoteOutline') : undefined,
      keywords: 'outline headings toc jump toc table of contents leader',
      when: () => !!getState().activeNote,
      run: () => getState().setOutlinePaletteOpen(true)
    },
    {
      id: 'view.outline-panel',
      title: tr('Toggle Outline Panel'),
      category: tr('View'),
      shortcut: shortcut('global.toggleOutlinePanel'),
      keywords: 'outline panel sidebar right headings',
      when: () => !!getState().activeNote,
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-outline'))
      }
    },
    {
      id: 'view.comments-panel',
      title: tr('Toggle Comments Panel'),
      category: tr('View'),
      shortcut: shortcut('global.toggleCommentsPanel'),
      keywords: 'comments annotations discussion margin review',
      when: () => !!getState().activeNote,
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-comments'))
      }
    },
    {
      id: 'editor.add-comment',
      title: tr('Add Comment to Selection'),
      category: tr('Editor'),
      shortcut: shortcut('global.addComment'),
      keywords: 'comment annotate selection note review',
      when: () => !!getState().activeNote,
      run: () => {
        window.dispatchEvent(new Event('zen:add-comment'))
      }
    },
    {
      id: 'view.calendar-panel',
      title: tr('Toggle Calendar Panel'),
      category: tr('View'),
      shortcut: getState().vimMode ? leaderShortcut('vim.leaderCalendar') : undefined,
      keywords: 'calendar daily weekly date navigate month week',
      when: () => {
        const s = normalizeVaultSettings(getState().vaultSettings)
        return s.dailyNotes.enabled || s.weeklyNotes.enabled
      },
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-calendar'))
      }
    },
    {
      id: 'view.close-right-panel',
      title: tr('Close Right Panel'),
      category: tr('View'),
      keywords: 'close hide dismiss right panel pane connections comments outline calendar',
      when: () => !!getState().activeNote,
      run: () => {
        window.dispatchEvent(new Event('zen:close-right-panel'))
      }
    },
    {
      id: 'view.mode.edit',
      title: tr('Switch to Edit Mode'),
      category: tr('View'),
      shortcut: shortcut('global.modeEdit'),
      keywords: 'editor writing raw markdown pane mode toolbar editmode',
      when: () => !!getState().activeNote,
      run: () => requestPaneMode('edit')
    },
    {
      id: 'view.mode.split',
      title: tr('Switch to Split Mode'),
      category: tr('View'),
      shortcut: shortcut('global.modeSplit'),
      keywords: 'editor preview side by side pane mode toolbar splitmode',
      when: () => !!getState().activeNote,
      run: () => requestPaneMode('split')
    },
    {
      id: 'view.mode.preview',
      title: tr('Switch to Preview Mode'),
      category: tr('View'),
      shortcut: shortcut('global.modePreview'),
      keywords: 'reading rendered markdown pane mode toolbar previewmode',
      when: () => !!getState().activeNote,
      run: () => requestPaneMode('preview')
    },
    {
      id: 'view.zoom.in',
      title: tr('Zoom In'),
      category: tr('View'),
      shortcut: shortcut('global.zoomIn'),
      keywords: 'bigger larger scale ui app browser',
      run: async () => {
        await window.zen.zoomInApp()
      }
    },
    {
      id: 'view.zoom.out',
      title: tr('Zoom Out'),
      category: tr('View'),
      shortcut: shortcut('global.zoomOut'),
      keywords: 'smaller decrease scale ui app browser',
      run: async () => {
        await window.zen.zoomOutApp()
      }
    },
    {
      id: 'view.zoom.reset',
      title: tr('Reset Zoom'),
      category: tr('View'),
      shortcut: shortcut('global.zoomReset'),
      keywords: 'actual size normal reset scale ui app browser',
      run: async () => {
        await window.zen.resetAppZoom()
      }
    },
    {
      id: 'app.check-updates',
      title: tr('Check for Updates…'),
      category: tr('App'),
      keywords: 'update updates upgrade version release github',
      run: async () => {
        await window.zen.checkForAppUpdatesWithUi()
      }
    },
    {
      id: 'app.website',
      title: tr('Open ZenNotes Website'),
      category: tr('App'),
      keywords: 'homepage website docs learn',
      run: () => openExternal(APP_WEBSITE_URL)
    },
    {
      id: 'app.discord',
      title: tr('Join ZenNotes Discord'),
      category: tr('App'),
      keywords: 'community chat support server discord',
      run: () => openExternal(APP_DISCORD_URL)
    },
    {
      id: 'app.github',
      title: tr('Open GitHub Repository'),
      category: tr('App'),
      keywords: 'github source repository code',
      run: () => openExternal(APP_REPOSITORY_URL)
    },
    {
      id: 'app.release',
      title: tr('View Latest Release'),
      category: tr('App'),
      keywords: 'release download changelog latest',
      run: () => openExternal(APP_RELEASES_URL)
    },
    {
      id: 'app.report-issue',
      title: tr('Report an Issue'),
      category: tr('App'),
      keywords: 'bug issue github feedback problem',
      run: () => openExternal(APP_ISSUES_URL)
    },
    {
      id: 'fold.heading',
      title: tr('Fold Heading at Cursor'),
      category: tr('Editor'),
      shortcut: shortcut('vim.foldCurrent'),
      keywords: 'collapse fold heading section',
      when: () => !!getState().editorViewRef && !!getState().activeNote,
      run: () => runFoldCommand('foldCode')
    },
    {
      id: 'fold.unfold-heading',
      title: tr('Unfold Heading at Cursor'),
      category: tr('Editor'),
      shortcut: shortcut('vim.unfoldCurrent'),
      keywords: 'expand unfold heading section',
      when: () => !!getState().editorViewRef && !!getState().activeNote,
      run: () => runFoldCommand('unfoldCode')
    },
    {
      id: 'fold.all',
      title: tr('Fold All Headings'),
      category: tr('Editor'),
      shortcut: shortcut('vim.foldAll'),
      keywords: 'collapse fold all every',
      when: () => !!getState().editorViewRef && !!getState().activeNote,
      run: () => runFoldCommand('foldAll')
    },
    {
      id: 'fold.unfold-all',
      title: tr('Unfold All Headings'),
      category: tr('Editor'),
      shortcut: shortcut('vim.unfoldAll'),
      keywords: 'expand unfold all every reset',
      when: () => !!getState().editorViewRef && !!getState().activeNote,
      run: () => runFoldCommand('unfoldAll')
    },
    {
      id: 'nav.back',
      title: tr('Go Back'),
      category: tr('Tabs'),
      shortcut: shortcut('vim.historyBack'),
      keywords: 'history previous',
      run: () => getState().jumpToPreviousNote()
    },
    {
      id: 'nav.forward',
      title: tr('Go Forward'),
      category: tr('Tabs'),
      shortcut: shortcut('vim.historyForward'),
      keywords: 'history next',
      run: () => getState().jumpToNextNote()
    }
  )

  /* ---------------- Panes / Splits ---------------- */
  cmds.push(
    {
      id: 'split.right',
      title: tr('Split Right'),
      category: tr('Panes'),
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
      title: tr('Split Down'),
      category: tr('Panes'),
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
      title: tr('Focus Pane Left'),
      category: tr('Panes'),
      shortcut: paneShortcut('vim.paneFocusLeft'),
      run: () => {
        focusPaneInDirection('h')
      }
    },
    {
      id: 'pane.focus.down',
      title: tr('Focus Pane Below'),
      category: tr('Panes'),
      shortcut: paneShortcut('vim.paneFocusDown'),
      run: () => {
        focusPaneInDirection('j')
      }
    },
    {
      id: 'pane.focus.up',
      title: tr('Focus Pane Above'),
      category: tr('Panes'),
      shortcut: paneShortcut('vim.paneFocusUp'),
      run: () => {
        focusPaneInDirection('k')
      }
    },
    {
      id: 'pane.focus.right',
      title: tr('Focus Pane Right'),
      category: tr('Panes'),
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
      title: tr('Search Notes…'),
      category: tr('Go'),
      shortcut: searchShortcut(),
      keywords: 'find open cmd+f ctrl+f leader',
      run: () => getState().setSearchOpen(true)
    },
    {
      id: 'nav.search-text',
      title: tr('Search Text in Vault…'),
      category: tr('Go'),
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
      title: `${tr('Go to')} ${labels().quick}`,
      category: tr('Go'),
      keywords: 'quick scratch',
      run: () => getState().setView({ kind: 'folder', folder: 'quick', subpath: '' })
    },
    {
      id: 'nav.folder.inbox',
      title: `${tr('Go to')} ${labels().inbox}`,
      category: tr('Go'),
      run: () => getState().setView({ kind: 'folder', folder: 'inbox', subpath: '' })
    },
    {
      id: 'nav.folder.archive',
      title: `${tr('Go to')} ${labels().archive}`,
      category: tr('Go'),
      keywords: 'archive archived storage',
      run: () => getState().openArchiveView()
    },
    {
      id: 'nav.folder.trash',
      title: `${tr('Go to')} ${labels().trash}`,
      category: tr('Go'),
      keywords: 'trash deleted restore bin',
      run: () => getState().openTrashView()
    },
    {
      id: 'nav.assets',
      title: tr('Go to Files'),
      category: tr('Go'),
      keywords: 'assets files images',
      run: () => getState().setView({ kind: 'assets' })
    },
    {
      id: 'nav.focus.sidebar',
      title: tr('Focus Sidebar'),
      category: tr('Go'),
      run: () => {
        const st = getState()
        if (!st.sidebarOpen) st.toggleSidebar()
        st.setFocusedPanel('sidebar')
      }
    },
    {
      id: 'nav.focus.editor',
      title: tr('Focus Editor'),
      category: tr('Go'),
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
      title: tr('Open Tasks'),
      category: tr('View'),
      shortcut: ':tasks',
      keywords: 'todo checklist due waiting done vault',
      when: () => !isTasksViewActive(getState()),
      run: () => getState().openTasksView()
    },
    {
      id: 'view.tags',
      title: tr('Open Tags'),
      category: tr('View'),
      shortcut: ':tag',
      keywords: 'tags browse filter vault',
      when: () => !isTagsViewActive(getState()),
      run: () => getState().openTagView()
    },
    {
      id: 'view.toggle.sidebar',
      title: tr('Toggle Sidebar'),
      category: tr('View'),
      shortcut: shortcut('global.toggleSidebar'),
      run: () => getState().toggleSidebar()
    },
    {
      id: 'view.toggle.connections',
      title: tr('Toggle Connections Panel'),
      category: tr('View'),
      shortcut: shortcut('global.toggleConnections'),
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-connections'))
      }
    },
    {
      id: 'view.toggle.note-list',
      title: tr('Toggle Note List Column'),
      category: tr('View'),
      keywords: 'middle pane list browser',
      when: () => !getState().unifiedSidebar,
      run: () => getState().toggleNoteList()
    },
    {
      id: 'view.toggle.tags',
      title: getState().tagsCollapsed
        ? tr('Show Tags in Sidebar')
        : tr('Hide Tags in Sidebar'),
      category: tr('View'),
      keywords: 'tag section fold hide collapse',
      run: () => getState().setTagsCollapsed(!getState().tagsCollapsed),
    },
    {
      id: 'view.content-align',
      title: getState().contentAlign === 'center'
        ? tr('Align Content Left')
        : tr('Center Content'),
      category: tr('View'),
      keywords: 'align center left width reading',
      run: () =>
        getState().setContentAlign(
          getState().contentAlign === 'center' ? 'left' : 'center'
        )
    },
    {
      id: 'view.sort.name-asc',
      title: tr('Sort Notes: Name (A → Z)'),
      category: tr('View'),
      keywords: 'alphabetical order',
      when: () => getState().noteSortOrder !== 'name-asc',
      run: () => getState().setNoteSortOrder('name-asc')
    },
    {
      id: 'view.sort.name-desc',
      title: tr('Sort Notes: Name (Z → A)'),
      category: tr('View'),
      keywords: 'alphabetical order reverse',
      when: () => getState().noteSortOrder !== 'name-desc',
      run: () => getState().setNoteSortOrder('name-desc')
    },
    {
      id: 'view.sort.updated-desc',
      title: tr('Sort Notes: Updated (Newest First)'),
      category: tr('View'),
      keywords: 'date recent time modified',
      when: () => getState().noteSortOrder !== 'updated-desc',
      run: () => getState().setNoteSortOrder('updated-desc')
    },
    {
      id: 'view.sort.updated-asc',
      title: tr('Sort Notes: Updated (Oldest First)'),
      category: tr('View'),
      keywords: 'date time modified',
      when: () => getState().noteSortOrder !== 'updated-asc',
      run: () => getState().setNoteSortOrder('updated-asc')
    },
    {
      id: 'view.sort.created-desc',
      title: tr('Sort Notes: Created (Newest First)'),
      category: tr('View'),
      keywords: 'date added',
      when: () => getState().noteSortOrder !== 'created-desc',
      run: () => getState().setNoteSortOrder('created-desc')
    },
    {
      id: 'view.sort.created-asc',
      title: tr('Sort Notes: Created (Oldest First)'),
      category: tr('View'),
      keywords: 'date added reverse',
      when: () => getState().noteSortOrder !== 'created-asc',
      run: () => getState().setNoteSortOrder('created-asc')
    },
    {
      id: 'view.sort.manual',
      title: tr('Sort Notes: Manual'),
      category: tr('View'),
      keywords: 'none drag order',
      when: () => getState().noteSortOrder !== 'none',
      run: () => getState().setNoteSortOrder('none')
    },
    {
      id: 'view.group-by-kind',
      title: getState().groupByKind
        ? tr('Ungroup Notes by Kind')
        : tr('Group Notes by Kind'),
      category: tr('View'),
      keywords: 'folders notes split section',
      run: () => getState().setGroupByKind(!getState().groupByKind)
    },
    {
      id: 'view.focus-mode',
      title: (() => {
        const st = getState()
        return st.zenMode ? tr('Exit Zen Mode') : tr('Enter Zen Mode')
      })(),
      category: tr('View'),
      shortcut: shortcut('global.toggleZenMode'),
      keywords: 'zen distraction-free focus',
      run: () => {
        const st = getState()
        st.setFocusMode(!st.zenMode)
      }
    },
    {
      id: 'view.dark-sidebar',
      title: getState().darkSidebar ? tr('Light Sidebar') : tr('Dark Sidebar'),
      category: tr('View'),
      run: () => getState().setDarkSidebar(!getState().darkSidebar)
    },
    {
      id: 'view.line-numbers.off',
      title: tr('Line Numbers: Off'),
      category: tr('View'),
      when: () => getState().lineNumberMode !== 'off',
      run: () => getState().setLineNumberMode('off')
    },
    {
      id: 'view.line-numbers.absolute',
      title: tr('Line Numbers: Absolute'),
      category: tr('View'),
      when: () => getState().lineNumberMode !== 'absolute',
      run: () => getState().setLineNumberMode('absolute')
    },
    {
      id: 'view.line-numbers.relative',
      title: tr('Line Numbers: Relative'),
      category: tr('View'),
      when: () => getState().lineNumberMode !== 'relative',
      run: () => getState().setLineNumberMode('relative')
    }
  )

  /* ---------------- Editor preferences ---------------- */
  cmds.push(
    {
      id: 'editor.vim.toggle',
      title: getState().vimMode ? tr('Disable Vim Mode') : tr('Enable Vim Mode'),
      category: tr('Editor'),
      run: () => getState().setVimMode(!getState().vimMode)
    },
    {
      id: 'editor.which-key.toggle',
      title: getState().whichKeyHints
        ? tr('Disable Leader Key Hints')
        : tr('Enable Leader Key Hints'),
      category: tr('Editor'),
      keywords: 'which-key leader space hints overlay vim',
      when: () => getState().vimMode,
      run: () => getState().setWhichKeyHints(!getState().whichKeyHints)
    },
    {
      id: 'editor.live-preview.toggle',
      title: getState().livePreview ? tr('Disable Live Preview') : tr('Enable Live Preview'),
      category: tr('Editor'),
      keywords: 'decoration inline',
      run: () => getState().setLivePreview(!getState().livePreview)
    },
    {
      id: 'editor.tabs.toggle',
      title: getState().tabsEnabled ? tr('Disable Tabs') : tr('Enable Tabs'),
      category: tr('Editor'),
      run: () => getState().setTabsEnabled(!getState().tabsEnabled)
    },
    {
      id: 'editor.word-wrap.toggle',
      title: getState().wordWrap ? tr('Disable Word Wrap') : tr('Enable Word Wrap'),
      category: tr('Editor'),
      shortcut: shortcut('global.toggleWordWrap'),
      keywords: 'wrap line soft hard',
      run: () => getState().setWordWrap(!getState().wordWrap)
    },
    {
      id: 'editor.auto-reveal.toggle',
      title: getState().autoReveal
        ? tr('Disable Auto-Reveal Active Note')
        : tr('Enable Auto-Reveal Active Note'),
      category: tr('Editor'),
      run: () => getState().setAutoReveal(!getState().autoReveal)
    },
    {
      id: 'editor.quick-note-date.toggle',
      title: getState().quickNoteDateTitle
        ? tr('Disable Quick Note Date Titles')
        : tr('Enable Quick Note Date Titles')
      ,
      category: tr('Editor'),
      keywords: 'daily date today yyyy-mm-dd',
      run: () => getState().setQuickNoteDateTitle(!getState().quickNoteDateTitle)
    },
    {
      id: 'editor.pdf-embed.compact',
      title: tr('PDF Embeds: Compact Card'),
      category: tr('Editor'),
      keywords: 'pdf embed compact card preview reference',
      when: () => getState().pdfEmbedInEditMode !== 'compact',
      run: () => getState().setPdfEmbedInEditMode('compact')
    },
    {
      id: 'editor.pdf-embed.full',
      title: tr('PDF Embeds: Inline Viewer'),
      category: tr('Editor'),
      keywords: 'pdf embed full iframe inline',
      when: () => getState().pdfEmbedInEditMode !== 'full',
      run: () => getState().setPdfEmbedInEditMode('full')
    }
  )

  /* ---------------- Reference pane ---------------- */
  cmds.push(
    {
      id: 'ref.pin',
      title: tr('Pin Active Note as Reference'),
      category: tr('Reference'),
      keywords: 'sticky side companion research',
      when: () => !!getState().activeNote,
      run: async () => {
        const path = getState().activeNote?.path
        if (path) await getState().pinReference(path)
      }
    },
    {
      id: 'ref.unpin',
      title: tr('Unpin Reference'),
      category: tr('Reference'),
      when: () => !!getState().pinnedRefPath,
      run: () => {
        getState().unpinReference()
      }
    },
    {
      id: 'ref.toggle',
      title: getState().pinnedRefVisible
        ? tr('Hide Reference Pane')
        : tr('Show Reference Pane'),
      category: tr('Reference'),
      when: () => !!getState().pinnedRefPath,
      run: () => {
        getState().togglePinnedRefVisible()
      }
    },
    {
      id: 'ref.focus',
      title: tr('Focus Reference Pane'),
      category: tr('Reference'),
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
    title: tr('Themes…'),
    category: tr('UI'),
    keywords: 'color appearance palette dark light',
    run: () => {
      /* handled by CommandPalette */
    }
  })

  /* ---------------- Tags ---------------- */
  cmds.push(
    {
      id: 'tag.rename',
      title: tr('Rename Tag…'),
      category: tr('Tag'),
      run: async () => {
        const from = await promptApp({
          title: tr('Rename tag — old name'),
          placeholder: 'tag'
        })
        if (!from) return
        const cleanFrom = from.replace(/^#/, '').trim()
        if (!cleanFrom) return
        const to = await promptApp({
          title: `${tr('Rename')} #${cleanFrom} ${tr('to…')}`,
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
      title: tr('Delete Tag…'),
      category: tr('Tag'),
      run: async () => {
        const tag = await promptApp({
          title: tr('Delete tag across all notes'),
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
        ? tr('Regenerate Demo Tour Notes')
        : tr('Generate Demo Tour Notes'),
      category: tr('Demo'),
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
      title: tr('Remove Demo Tour Notes'),
      category: tr('Demo'),
      keywords: 'demo onboarding starter tour sample example delete clear uninstall',
      when: () => getState().notes.some((note) => note.path === DEMO_TOUR_START_PATH),
      run: async () => {
        const ok = await confirmApp({
          title: tr('Remove the built-in demo tour from this vault?'),
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
      title: tr('Open Help'),
      category: tr('App'),
      keywords: 'manual docs documentation shortcuts vim onboarding learn',
      run: () => getState().openHelpView()
    },
    {
      id: 'app.onboarding.restart',
      title: tr('Show Onboarding Wizard'),
      category: tr('App'),
      keywords: 'onboarding welcome wizard setup first-run getting started vim theme vault',
      run: () => getState().restartOnboarding()
    },
    {
      id: 'app.settings',
      title: tr('Open Settings'),
      category: tr('App'),
      shortcut: shortcut('global.openSettings'),
      keywords: 'preferences',
      run: () => getState().setSettingsOpen(true)
    },
    {
      id: 'app.vault.pick',
      title:
        window.zen.getCapabilities().supportsRemoteWorkspace &&
        window.zen.getAppInfo().runtime === 'desktop'
          ? tr('Open Local Vault…')
          : tr('Open Vault…'),
      category: tr('Vault'),
      keywords: 'vault local open folder workspace',
      run: () => getState().openVaultPicker()
    },
    {
      id: 'app.vault.openWindow',
      title: tr('Open Local Vault in New Window…'),
      category: tr('Vault'),
      keywords: 'vault local open folder workspace window tab multiple',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsLocalFilesystemPickers,
      run: async () => {
        await window.zen.openVaultWindow()
      }
    },
    {
      id: 'app.vault.close',
      title: tr('Close Current Vault'),
      category: tr('Vault'),
      keywords: 'vault local close remove forget workspace',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        getState().workspaceMode !== 'remote' &&
        !!getState().vault,
      run: () => getState().closeVault()
    },
    {
      id: 'app.vault.switch',
      title: tr('Switch Vault…'),
      category: tr('Vault'),
      keywords: 'vault local remote switch workspace recent picker server',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        (window.zen.getCapabilities().supportsLocalFilesystemPickers ||
          window.zen.getCapabilities().supportsRemoteWorkspace),
      run: () => {
        /* handled by CommandPalette */
      }
    },
    {
      id: 'app.workspace.remote',
      title: tr('Connect to Remote Vault…'),
      category: tr('Vault'),
      keywords: 'vault remote server workspace self-hosted',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsRemoteWorkspace,
      run: () => getState().connectRemoteWorkspace()
    },
    {
      id: 'app.workspace.local',
      title: tr('Switch to Local Vault'),
      category: tr('Vault'),
      keywords: 'vault local workspace disconnect return',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        getState().workspaceMode === 'remote',
      run: () => getState().disconnectRemoteWorkspace()
    },
    {
      id: 'app.assets.reveal',
      title: tr('Reveal Vault Root'),
      category: tr('App'),
      when: () =>
        getState().workspaceMode !== 'remote' &&
        window.zen.getAppInfo().runtime === 'desktop',
      run: () => getState().revealAssetsDir()
    },
    {
      id: 'cli.install',
      title: tr('Install Command-Line Tool (zen)'),
      category: tr('CLI'),
      keywords: 'cli zen terminal shell command line install symlink path bin',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsCliInstall,
      run: async () => {
        const status = await window.zen.cliGetStatus()
        if (!status.supportedPlatform) {
          await confirmApp({
            title: tr('CLI not supported on this platform'),
            description: status.reason ?? 'CLI install is currently macOS- and Linux-only.',
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        if (!status.available) {
          await confirmApp({
            title: tr('CLI wrapper not bundled'),
            description:
              status.reason ?? 'The CLI wrapper has not been built yet. Run `npm run build` or open Settings → CLI for details.',
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        if (status.installedAt && status.installedByThisApp) {
          await confirmApp({
            title: tr('zen is already installed'),
            description: `Installed at ${status.installedAt}. Run \`zen --help\` from any terminal.`,
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        if (status.installedAt && !status.installedByThisApp) {
          await confirmApp({
            title: tr('A different `zen` already exists'),
            description: `${status.installedAt} is not managed by ZenNotes. Remove it manually if you want ZenNotes to take over.`,
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        const lines: string[] = []
        if (status.requiresSudo) {
          lines.push(
            'macOS will prompt for an admin password because no user-writable directory was found on your PATH.'
          )
        }
        if (status.pathHint) {
          lines.push(
            `Heads up: ${status.defaultTarget.replace(/\/[^/]+$/, '')} is not on your PATH yet. Settings → CLI shows the one-line shell snippet you'll need to add after install.`
          )
        }
        const ok = await confirmApp({
          title: `Install zen to ${status.defaultTarget}?`,
          description: lines.join('\n\n') || undefined,
          confirmLabel: 'Install'
        })
        if (!ok) return
        try {
          const next = await window.zen.cliInstall()
          const followUp = next.pathHint
            ? `\n\nAdd ${next.defaultTarget.replace(/\/[^/]+$/, '')} to your PATH so the shell can find it:\n${next.pathHint}`
            : ''
          await confirmApp({
            title: tr('zen installed'),
            description: `Symlink created at ${next.installedAt ?? next.defaultTarget}. Open a fresh terminal and run \`zen --help\` to start.${followUp}`,
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (/canceled/i.test(message)) return
          await confirmApp({
            title: tr('Install failed'),
            description: message,
            confirmLabel: 'OK',
            cancelLabel: 'Close',
            danger: true
          })
        }
      }
    },
    {
      id: 'cli.uninstall',
      title: tr('Uninstall Command-Line Tool (zen)'),
      category: tr('CLI'),
      keywords: 'cli zen terminal shell command line uninstall remove symlink',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsCliInstall,
      run: async () => {
        const status = await window.zen.cliGetStatus()
        if (!status.installedAt) {
          await confirmApp({
            title: tr('zen is not installed'),
            description: 'There is nothing to uninstall.',
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        if (!status.installedByThisApp) {
          await confirmApp({
            title: tr('Not managed by ZenNotes'),
            description: `${status.installedAt} was not installed by this app. Remove it manually if you really want it gone.`,
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        const ok = await confirmApp({
          title: `Remove zen from ${status.installedAt}?`,
          description:
            'macOS may prompt for an admin password to remove the symlink. The CLI binary inside the app stays bundled — you can reinstall any time.',
          confirmLabel: 'Uninstall',
          danger: true
        })
        if (!ok) return
        try {
          await window.zen.cliUninstall()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (/canceled/i.test(message)) return
          await confirmApp({
            title: tr('Uninstall failed'),
            description: message,
            confirmLabel: 'OK',
            cancelLabel: 'Close',
            danger: true
          })
        }
      }
    },
    {
      id: 'cli.openSettings',
      title: tr('Open CLI Settings'),
      category: tr('CLI'),
      keywords: 'cli zen terminal settings command line preferences',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsCliInstall,
      run: () => getState().setSettingsOpen(true)
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
        title: `${isCurrent ? tr('Remote Vault (Connected):') : tr('Remote Vault:')} ${profile.name}`,
        category: tr('Vault'),
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
