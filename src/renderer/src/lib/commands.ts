/**
 * Command registry for the app's Cmd+Shift+P palette.
 *
 * `buildCommands()` is called once every time the palette opens, so
 * each command's `title`, `when`, and keyboard-shortcut display
 * reflect the store state at that moment (toggle labels flip, context-
 * sensitive commands like "Unarchive" only show up when applicable).
 */
import { useStore } from '../store'
import { promptApp } from '../components/PromptHost'
import { focusPaneInDirection } from './pane-nav'

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

export function buildCommands(): Command[] {
  const getState = (): ReturnType<typeof useStore.getState> => useStore.getState()
  const cmds: Command[] = []

  /* ---------------- Note actions ---------------- */
  cmds.push(
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
      when: () => getState().activeNote?.folder === 'inbox',
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
      title: 'Copy as Wikilink',
      category: 'Note',
      when: () => !!getState().activeNote,
      run: async () => {
        const active = getState().activeNote
        if (!active) return
        const title = active.title || active.path.split('/').pop()?.replace(/\.md$/i, '') || ''
        await navigator.clipboard.writeText(`[[${title}]]`)
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
      id: 'editor.auto-reveal.toggle',
      title: getState().autoReveal
        ? 'Disable Auto-Reveal Active Note'
        : 'Enable Auto-Reveal Active Note',
      category: 'Editor',
      run: () => getState().setAutoReveal(!getState().autoReveal)
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
  return cmds.filter((c) => !c.when || c.when())
}
