/**
 * Command registry for the app's Cmd+Shift+P palette.
 *
 * `buildCommands()` is called once every time the palette opens, so
 * each command's `title`, `when`, and keyboard-shortcut display
 * reflect the store state at that moment (toggle labels flip, context-
 * sensitive commands like "Unarchive" only show up when applicable).
 */
import { isTasksViewActive, useStore } from '../store'
import { promptApp } from '../components/PromptHost'
import { focusPaneInDirection } from './pane-nav'
import { resolveQuickNoteTitle } from './quick-note-title'

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
  const cmds: Command[] = []

  /* ---------------- Note actions ---------------- */
  cmds.push(
    {
      id: 'note.new.quick',
      title: 'New Quick Note',
      category: 'Note',
      shortcut: '⇧⌘N',
      keywords: 'scratch capture jot',
      run: () => {
        const s = getState()
        const title = resolveQuickNoteTitle(s.notes, s.quickNoteDateTitle)
        return s.createAndOpen('quick', '', { title, focusTitle: true })
      }
    },
    {
      id: 'note.new.inbox',
      title: 'New Note in Inbox',
      category: 'Note',
      keywords: 'create add write',
      run: () => getState().createAndOpen('inbox', '', { focusTitle: true })
    },
    {
      id: 'note.new.here',
      title: 'New Note in Current Folder',
      category: 'Note',
      keywords: 'create add write',
      when: () => {
        const v = getState().view
        return v.kind === 'folder' && v.folder !== 'trash'
      },
      run: () => {
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
      title: 'Archive Note',
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
      title: 'Move Note to Trash',
      category: 'Note',
      keywords: 'delete',
      when: () => !!getState().activeNote && getState().activeNote?.folder !== 'trash',
      run: () => getState().trashActive()
    },
    {
      id: 'note.restore',
      title: 'Restore Note from Trash',
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
      title: 'Copy Note Absolute Path',
      category: 'Note',
      keywords: 'clipboard full system file',
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
      title: 'Copy Current Folder Absolute Path',
      category: 'Folder',
      keywords: 'clipboard full system file',
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
      title: 'Reveal Note in Finder',
      category: 'Note',
      when: () => !!getState().selectedPath,
      run: async () => {
        const p = getState().selectedPath
        if (p) await window.zen.revealNote(p)
      }
    },
    {
      id: 'note.float',
      title: 'Open in Floating Window',
      category: 'Note',
      keywords: 'popout window detach',
      when: () => !!getState().selectedPath,
      run: async () => {
        const p = getState().selectedPath
        if (p) await window.zen.openNoteWindow(p)
      }
    },
    {
      id: 'note.move',
      title: 'Move Note to Folder…',
      category: 'Note',
      when: () => !!getState().activeNote,
      run: async () => {
        const active = getState().activeNote
        if (!active) return
        const target = await promptApp({
          title: `Move "${active.title}" to…`,
          description: 'Enter a folder path, e.g. inbox/Work/Research',
          initialValue: active.path.split('/').slice(0, -1).join('/'),
          placeholder: 'inbox/Work',
          okLabel: 'Move',
          validate: (v) => {
            const trimmed = v.trim()
            if (!trimmed) return 'Folder path required'
            const top = trimmed.split('/')[0]
            if (top !== 'inbox' && top !== 'archive') {
              return 'Top-level folder must be inbox or archive'
            }
            return null
          }
        })
        if (!target) return
        const [folder, ...rest] = target.split('/')
        await getState().moveNote(
          active.path,
          folder as 'inbox' | 'archive',
          rest.join('/')
        )
      }
    }
  )

  /* ---------------- Tabs ---------------- */
  // Is the active tab currently pinned in the active pane? Used to flip
  // the Pin/Unpin command title and gate visibility.
  const isActiveTabPinned = (): boolean => {
    const s = getState()
    const leaf = s.paneLayout.kind === 'leaf' ? s.paneLayout : null
    const path = s.selectedPath
    if (!path) return false
    // Walk the tree to find the active leaf without importing tree helpers.
    const stack: (typeof s.paneLayout)[] = [s.paneLayout]
    void leaf
    while (stack.length) {
      const n = stack.pop()!
      if (n.kind === 'leaf') {
        if (n.id === s.activePaneId) return n.pinnedTabs.includes(path)
      } else {
        for (const c of n.children) stack.push(c)
      }
    }
    return false
  }

  cmds.push(
    {
      id: 'tab.close',
      title: 'Close Tab',
      category: 'Tabs',
      shortcut: '⌘W',
      when: () => !!getState().selectedPath,
      run: () => getState().closeActiveNote()
    },
    {
      id: 'tab.pin',
      title: isActiveTabPinned() ? 'Unpin Tab' : 'Pin Tab',
      category: 'Tabs',
      keywords: 'stick sticky',
      when: () => !!getState().selectedPath,
      run: () => {
        const s = getState()
        if (s.selectedPath) s.toggleTabPin(s.activePaneId, s.selectedPath)
      }
    },
    {
      id: 'nav.back',
      title: 'Go Back',
      category: 'Tabs',
      shortcut: '⌃O',
      keywords: 'history previous',
      run: () => getState().jumpToPreviousNote()
    },
    {
      id: 'nav.forward',
      title: 'Go Forward',
      category: 'Tabs',
      shortcut: '⌃I',
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
      shortcut: '⌃W h',
      run: () => {
        focusPaneInDirection('h')
      }
    },
    {
      id: 'pane.focus.down',
      title: 'Focus Pane Below',
      category: 'Panes',
      shortcut: '⌃W j',
      run: () => {
        focusPaneInDirection('j')
      }
    },
    {
      id: 'pane.focus.up',
      title: 'Focus Pane Above',
      category: 'Panes',
      shortcut: '⌃W k',
      run: () => {
        focusPaneInDirection('k')
      }
    },
    {
      id: 'pane.focus.right',
      title: 'Focus Pane Right',
      category: 'Panes',
      shortcut: '⌃W l',
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
      shortcut: '⌘P',
      keywords: 'find open',
      run: () => getState().setSearchOpen(true)
    },
    {
      id: 'nav.folder.quick',
      title: 'Go to Quick Notes',
      category: 'Go',
      keywords: 'quick scratch',
      run: () => getState().setView({ kind: 'folder', folder: 'quick', subpath: '' })
    },
    {
      id: 'nav.folder.inbox',
      title: 'Go to Inbox',
      category: 'Go',
      run: () => getState().setView({ kind: 'folder', folder: 'inbox', subpath: '' })
    },
    {
      id: 'nav.folder.archive',
      title: 'Go to Archive',
      category: 'Go',
      run: () => getState().setView({ kind: 'folder', folder: 'archive', subpath: '' })
    },
    {
      id: 'nav.folder.trash',
      title: 'Go to Trash',
      category: 'Go',
      run: () => getState().setView({ kind: 'folder', folder: 'trash', subpath: '' })
    },
    {
      id: 'nav.assets',
      title: 'Go to Attachments',
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
      id: 'view.toggle.sidebar',
      title: 'Toggle Sidebar',
      category: 'View',
      shortcut: '⌘1',
      run: () => getState().toggleSidebar()
    },
    {
      id: 'view.toggle.connections',
      title: 'Toggle Connections Panel',
      category: 'View',
      shortcut: '⌘2',
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-connections'))
      }
    },
    {
      id: 'view.focus-mode',
      title: (() => {
        const st = getState()
        return st.sidebarOpen || st.noteListOpen ? 'Enter Focus Mode' : 'Exit Focus Mode'
      })(),
      category: 'View',
      shortcut: '⌘.',
      keywords: 'zen distraction-free',
      run: () => {
        const st = getState()
        const anyOpen = st.sidebarOpen || st.noteListOpen
        st.setFocusMode(anyOpen)
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
      shortcut: '⌥Z',
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
    }
  )

  /* ---------------- Reference pane ---------------- */
  cmds.push(
    {
      id: 'ref.pin',
      title: 'Pin Active Note as Reference',
      category: 'Reference',
      keywords: 'sticky side companion research',
      when: () => !!getState().selectedPath,
      run: async () => {
        const path = getState().selectedPath
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
      shortcut: '⌘,',
      keywords: 'preferences',
      run: () => getState().setSettingsOpen(true)
    },
    {
      id: 'app.vault.pick',
      title: 'Open Vault…',
      category: 'App',
      run: () => getState().openVaultPicker()
    },
    {
      id: 'app.assets.reveal',
      title: 'Reveal Attachments Folder',
      category: 'App',
      run: () => getState().revealAssetsDir()
    }
  )

  // Filter out commands whose `when` guard rejects them.
  if (options?.includeUnavailable) return cmds
  return cmds.filter((c) => !c.when || c.when())
}
