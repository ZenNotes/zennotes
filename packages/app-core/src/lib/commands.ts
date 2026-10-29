/**
 * Command registry for the app's Cmd+Shift+P palette.
 *
 * `buildCommands()` is called once every time the palette opens, so
 * each command's `title`, `when`, and keyboard-shortcut display
 * reflect the store state at that moment (toggle labels flip, context-
 * sensitive commands like "Unarchive" only show up when applicable).
 */
import { requestAgentEditReview } from './agent-review-runtime'
import {
  isTagsViewActive,
  isTasksViewActive,
  isTrashViewActive,
  isUnresolvedLinksViewActive,
  useStore
} from '../store'
import { openLinkPopoverAtCursor } from './link-popover-open'
import { confirmApp } from './confirm-requests'
import { requestSettingsTarget } from './settings-navigation'
import { hideWindowToTray, useTrayStore } from './tray-runtime'
import { hostOpensNotesToRead } from './editor-host'
import { promptApp } from './prompt-requests'
import { captureNavigationContext } from './navigation-context'
import { buildMoveNotePrompt, moveNoteVocabulary, parseMoveNoteTarget } from './move-note'
import { focusPaneInDirection } from './pane-nav'
import { focusSidebarPanel } from './sidebar-focus'
import { runSidebarNotePlan, sidebarCommandPlan } from './sidebar-note-actions'
import { openContextGallery } from './folder-gallery-open'
import { findLeaf } from './pane-layout'
import { getTabStepTarget, stepActiveTab } from './buffer-navigation'
import { requestPaneMode } from './pane-mode'
import { resolveQuickNoteTitle } from './quick-note-title'
import { forwardTaskWithPicker, taskAtEditorCursor } from './forward-task'
import { canManageWorkflows } from './workflow-workspace'
import { toggleCheckbox } from './cm-toggle-checkbox'
import {
  harperAddWordAtCursor,
  harperApplyFirstSuggestion,
  harperIgnoreAtCursor,
  harperNextSuggestion,
  harperOpenSuggestions,
  harperPreviousSuggestion
} from './cm-harper'
import { harperEditorConfig, harperSupported } from './harper-runtime'
import { reflowParagraph } from './cm-reflow'
import { convertTableToDatabase } from './table-to-database'
import { removeCalloutAtCursor, requestCalloutTypeMenu } from './callout-menu'
import { requestCodeLanguagePicker } from './code-language-request'
import {
  activeNoteCover,
  coverNotePath,
  openCoverPicker,
  openUnsplashCoverPicker,
  removeCover,
  setCoverFromClipboard,
  startCoverReposition
} from './note-cover-actions'
import { unsplashSearchAvailable } from './unsplash-search'
import { openUnsplashKeySettings, unsplashKeySupported } from './unsplash-key'
import { csvPathFromDatabaseTab, type DbView } from '@shared/databases'
import {
  databaseCsvPathForTab,
  requestDatabaseViewCommand,
  type DatabaseViewCommand
} from './database-view-commands'
import { viewHasPicks } from './database-cells'
import { canRenameVault, renameVaultWithPrompt } from './rename-vault'
import { promptImageWidth } from './image-resize'
import { copyLinkAtCursor } from './link-copy'
import { getKeymapDisplay, getLeaderChordDisplay, type KeymapId } from './keymaps'
import { commandBindingHint } from './command-keymaps'
import { dispatchKeyboardContextMenu, findTabContextMenuTarget } from './keyboard-context-menu'
import { resolveSystemFolderLabels } from './system-folder-labels'
import {
  findDailyNoteForDate,
  findMonthlyNoteForDate,
  findWeeklyNoteForDate,
  isCalendarToggleAvailable
} from './vault-layout'
import { runWorkflowById } from './workflow-trigger'
import { requestPublishNote } from './publish-note-requests'
import { activeReferencePath } from './pinned-reference'
import {
  hasCloudVaultRemovalNotice,
  hasPendingCloudReview,
  openPendingCloudReview
} from './cloud-auto-sync'
import { DEMO_TOUR_START_PATH, isDemoTourStartPath } from '@shared/demo-tour'

const APP_WEBSITE_URL = 'https://zennotes.org'
const APP_DISCORD_URL = 'https://discord.gg/W4fWzapKS6'
const APP_REPOSITORY_URL = 'https://github.com/ZenNotes/zennotes'
const APP_RELEASES_URL = 'https://github.com/ZenNotes/zennotes/releases/latest'
const APP_ISSUES_URL = 'https://github.com/ZenNotes/zennotes/issues'

type FoldCommand = 'foldAtCursor' | 'unfoldAtCursor' | 'foldAllOutline' | 'unfoldAll'

async function runFoldCommand(command: FoldCommand): Promise<void> {
  const view = useStore.getState().editorViewRef
  if (!view) return
  if (command === 'unfoldAll') {
    const language = await import('@codemirror/language')
    language.unfoldAll(view)
  } else {
    // Headings and list items alike (#848); loaded on demand like the
    // editor itself.
    const folding = await import('./cm-heading-fold')
    folding[command](view)
  }
  // A fold is a view of the note, not typing: a phone keeps its keyboard down.
  if (!hostOpensNotesToRead()) view.focus()
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
  /**
   * Asked just before the command runs: true when all it does is take the
   * user to a note that already exists, to read it (Go Back, Reopen Closed
   * Tab, today's daily note when it is there already). The palette then hands
   * over the way a search pick does: the editor takes the keyboard on desktop,
   * and a host that opens notes to read (a phone) keeps it down. Commands that
   * create a note to be written in, or act on the note in place, leave it out
   * and keep focusing the editor.
   */
  opensToRead?: () => boolean
  /**
   * The name a key binding goes by, for a command whose title flips with
   * state (Enable Vim Mode / Disable Vim Mode). Settings → Keymap and the
   * config.toml reference list it, so a key is never filed under what the
   * command happened to say the moment the list was made.
   */
  bindTitle?: string
  /**
   * Why `when` says no, in words. A command run from its own key cannot
   * vanish the way a palette row does, so the key says what is missing
   * instead of doing nothing (#971). Commands without one get the generic
   * "isn't available here".
   */
  unavailableReason?: () => string
  /** `shortcut` as it was before the user's own key for the command was put
   *  in front of it: the key the command has anyway (a leader chord, `:w`).
   *  Settings shows it beside the binding as an "also". */
  builtinShortcut?: string
}

export function buildCommands(options?: { includeUnavailable?: boolean }): Command[] {
  const getState = (): ReturnType<typeof useStore.getState> => useStore.getState()
  // The three guards most commands share. Named, so the reason a bound key
  // gives when one says no can be filled in once, below, instead of per row.
  const hasNote = (): boolean => !!getState().activeNote
  const hasEditorNote = (): boolean => !!getState().editorViewRef && !!getState().activeNote
  const hasSelection = (): boolean => !!getState().selectedPath
  const labels = () => resolveSystemFolderLabels(getState().systemFolderLabels)
  const pathLabel = (): string =>
    getState().workspaceMode === 'remote' ? 'Server Path' : 'Absolute Path'
  const shortcut = (id: KeymapId): string => getKeymapDisplay(getState().keymapOverrides, id)
  // A chord with an unbound step cannot be pressed, so the palette shows no
  // key for it rather than half a sequence.
  const chord = (...ids: KeymapId[]): string => {
    const parts = ids.map(shortcut)
    return parts.every(Boolean) ? parts.join(' ') : ''
  }
  // Whether this period's daily, weekly or monthly note is already there:
  // such a note opens to read, one the command creates is written in.
  const periodicNoteExists = (find: typeof findDailyNoteForDate): boolean =>
    !!find(getState().notes, getState().vaultSettings, new Date())
  // Leader chords, the Ctrl+W pane prefix and ex commands exist only in Vim
  // mode, so with it off the palette names none of them: a row must not
  // advertise a key that does nothing (the Vim-off hint rule).
  const vimOnly = (display: string): string => (getState().vimMode ? display : '')
  const leaderShortcut = (id: KeymapId): string =>
    vimOnly(getLeaderChordDisplay(getState().keymapOverrides, id))
  const paneShortcut = (id: KeymapId): string => vimOnly(chord('vim.panePrefix', id))
  const searchShortcut = (): string => {
    const state = getState()
    const primary = shortcut('global.searchNotes')
    if (state.vimMode) return primary
    return [primary, shortcut('global.searchNotesNonVim')].filter(Boolean).join(' / ')
  }
  const openExternal = (url: string): void => {
    window.open(url, '_blank')
  }
  const isActiveNoteFavorite = (): boolean => {
    const state = getState()
    return !!state.activeNote && state.vaultSettings.favorites.includes(state.activeNote.path)
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
        const title = resolveQuickNoteTitle(
          s.notes,
          s.quickNoteDateTitle,
          s.quickNoteTitlePrefix
        )
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
      id: 'database.new',
      title: 'New Database',
      category: 'Note',
      keywords: 'database table csv records spreadsheet board kanban base',
      run: () => void getState().newDatabase()
    },
    {
      id: 'task.new',
      title: 'New Task',
      category: 'Note',
      keywords: 'task todo checkbox tasknotes taskforge new add create file due priority',
      run: () => void getState().newTaskFile()
    },
    {
      id: 'task.new.folder',
      title: 'New Task in Folder…',
      category: 'Note',
      keywords: 'task todo new create folder project location directory organize where place',
      run: () => void getState().newTaskFileInChosenFolder()
    },
    {
      id: 'note.daily.today',
      unavailableReason: () => 'Daily notes are off: turn them on under Settings, Vault, Periodic notes',
      title: "Open Today's Daily Note",
      category: 'Note',
      keywords: 'daily journal date today log',
      shortcut: leaderShortcut('vim.leaderDailyNote'),
      when: () => getState().vaultSettings.dailyNotes.enabled,
      // Read when today's note is there already; one created here is written in.
      opensToRead: () => periodicNoteExists(findDailyNoteForDate),
      run: () => getState().openTodayDailyNote({ readIfExisting: true })
    },
    {
      id: 'note.daily.rollover',
      unavailableReason: () => 'Daily notes are off: turn them on under Settings, Vault, Periodic notes',
      title: 'Roll Over Unfinished Tasks to Today',
      category: 'Note',
      keywords: 'daily tasks rollover roll over migrate unfinished carry forward today',
      when: () => getState().vaultSettings.dailyNotes.enabled,
      // Like today's daily note: read when it is there already, focused when
      // the rollover creates it.
      opensToRead: () => periodicNoteExists(findDailyNoteForDate),
      run: () => {
        void getState().rolloverUnfinishedTasksIntoToday({ force: true, open: true })
      }
    },
    {
      id: 'note.weekly.thisWeek',
      unavailableReason: () => 'Weekly notes are off: turn them on under Settings, Vault, Periodic notes',
      title: "Open This Week's Note",
      category: 'Note',
      keywords: 'weekly week review date log',
      shortcut: leaderShortcut('vim.leaderWeeklyNote'),
      when: () => getState().vaultSettings.weeklyNotes.enabled,
      opensToRead: () => periodicNoteExists(findWeeklyNoteForDate),
      run: () => getState().openThisWeekWeeklyNote({ readIfExisting: true })
    },
    {
      id: 'note.monthly.thisMonth',
      unavailableReason: () => 'Monthly notes are off: turn them on under Settings, Vault, Periodic notes',
      title: "Open This Month's Note",
      category: 'Note',
      keywords: 'monthly month review reflection date log',
      shortcut: leaderShortcut('vim.leaderMonthlyNote'),
      when: () => getState().vaultSettings.monthlyNotes.enabled,
      opensToRead: () => periodicNoteExists(findMonthlyNoteForDate),
      run: () => getState().openThisMonthMonthlyNote({ readIfExisting: true })
    },
    {
      id: 'template.create',
      title: 'New Note from Template…',
      category: 'Note',
      keywords: 'template scaffold adr rfc meeting daily weekly boilerplate new',
      shortcut:
        shortcut('global.newNoteFromTemplate') ||
        (getState().vimMode ? leaderShortcut('vim.leaderTemplatePicker') : undefined),
      run: () => getState().setTemplatePaletteOpen(true)
    },
    {
      id: 'template.insert',
      title: 'Insert Template into Current Note…',
      category: 'Note',
      keywords: 'template insert apply into current note scaffold fill',
      shortcut:
        shortcut('global.insertTemplate') ||
        (getState().vimMode ? leaderShortcut('vim.leaderInsertTemplate') : undefined),
      when: hasNote,
      run: () => getState().openTemplatePaletteForInsert()
    },
    {
      id: 'drawing.new',
      title: 'New Drawing',
      category: 'Note',
      keywords: 'excalidraw drawing diagram sketch create new canvas',
      run: () => void getState().newDrawing()
    },
    {
      id: 'embed.drawing.existing',
      title: 'Embed Existing Drawing…',
      category: 'Note',
      keywords: 'excalidraw drawing diagram sketch insert embed image picture canvas',
      when: hasNote,
      run: () => getState().setEmbedDrawingPaletteOpen(true)
    },
    {
      id: 'embed.drawing.new',
      title: 'Embed New Drawing',
      category: 'Note',
      keywords: 'excalidraw drawing diagram sketch create new insert embed canvas',
      when: hasNote,
      run: () => void getState().embedNewDrawing()
    },
    {
      id: 'note.publish',
      unavailableReason: () => window.zen.getCapabilities().supportsCloudSync === true ? `Publish Note needs an open note outside the ${labels().trash}` : "Publishing isn't available here",
      title: 'Publish Note',
      category: 'Note',
      keywords: 'share public link web cloud update',
      when: () => {
        const note = getState().activeNote
        return window.zen.getCapabilities().supportsCloudSync === true
          && note !== null
          && note.folder !== 'trash'
      },
      run: () => {
        const note = getState().activeNote
        if (note) requestPublishNote(note)
      }
    },
    {
      id: 'template.removeBuiltins',
      unavailableReason: () => 'The built-in templates are already removed',
      title: 'Remove Built-in Templates',
      category: 'Note',
      keywords: 'template built-in builtin remove hide delete clear shipped default',
      when: () => !getState().hideBuiltinTemplates,
      run: async () => {
        const ok = await confirmApp({
          title: 'Remove all built-in templates?',
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
      unavailableReason: () => 'The built-in templates are already there',
      title: 'Restore Built-in Templates',
      category: 'Note',
      keywords: 'template built-in builtin restore bring back show shipped default',
      when: () => getState().hideBuiltinTemplates,
      run: () => getState().setHideBuiltinTemplates(false)
    },
    {
      id: 'template.saveCurrent',
      title: 'Save Current Note as Template…',
      category: 'Note',
      keywords: 'template save custom create from note',
      when: hasNote,
      run: () => getState().saveActiveNoteAsTemplate()
    },
    {
      id: 'note.new.here',
      unavailableReason: () => `New Note in Current Folder needs a note or folder outside the ${labels().trash}`,
      title: 'New Note in Current Folder',
      category: 'Note',
      shortcut: shortcut('global.newNoteHere'),
      keywords: 'create add write',
      when: () => {
        const s = getState()
        if (isTrashViewActive(s)) return false
        if (s.activeNote && s.activeNote.folder !== 'trash') return true
        return s.view.kind === 'folder' && s.view.folder !== 'trash'
      },
      run: () => getState().createNoteInCurrentFolder()
    },
    {
      id: 'note.save',
      title: 'Save Note',
      category: 'Note',
      shortcut: vimOnly(':w'),
      keywords: 'persist write',
      when: hasSelection,
      run: () => getState().persistActive()
    },
    {
      id: 'note.format',
      title: 'Format Markdown',
      category: 'Note',
      shortcut: vimOnly(':format'),
      keywords: 'prettier',
      when: hasSelection,
      run: () => getState().formatActiveNote()
    },
    {
      id: 'note.rename',
      title: 'Rename Note…',
      category: 'Note',
      when: hasNote,
      run: async () => {
        const isCurrent = captureNavigationContext()
        const active = getState().activeNote
        if (!active) return
        const next = await promptApp({
          title: 'Rename note',
          initialValue: active.title,
          okLabel: 'Rename'
        })
        if (next && next !== active.title && isCurrent() && getState().selectedPath === active.path)
          await getState().renameActive(next)
      }
    },
    {
      id: 'note.favorite',
      bindTitle: 'Toggle Note Favorite',
      unavailableReason: () => getState().activeNote ? `A note in the ${labels().trash} can't be a favorite` : 'Favorites need an open note',
      // The sidebar row's context menu was the only mouse route and the
      // leader chord the only keyboard one; the palette gives every host,
      // phones included, a way to fill the Favorites section on Home. (#810)
      title: isActiveNoteFavorite() ? 'Remove Note from Favorites' : 'Add Note to Favorites',
      category: 'Note',
      keywords: 'favourite star bookmark home sidebar',
      shortcut: vimOnly(chord('vim.leaderPrefix', 'vim.leaderNoteActions', 'vim.leaderToggleFavorite')),
      when: () => {
        const active = getState().activeNote
        return !!active && active.folder !== 'trash'
      },
      run: () => getState().toggleFavoriteActiveNote()
    },
    {
      id: 'note.cover',
      bindTitle: 'Add or Change Cover…',
      unavailableReason: () => 'A cover needs an open note',
      title: activeNoteCover() ? 'Change Cover…' : 'Add Cover…',
      category: 'Note',
      keywords: 'banner header image picture gallery gradient',
      shortcut: vimOnly(chord('vim.leaderPrefix', 'vim.leaderNoteActions', 'vim.leaderNoteCover')),
      when: () => !!coverNotePath(),
      run: () => {
        openCoverPicker()
      }
    },
    {
      id: 'note.cover.unsplash',
      unavailableReason: () => coverNotePath() ? "Unsplash search isn't available here" : 'A cover needs an open note',
      title: 'Add Cover from Unsplash…',
      category: 'Note',
      keywords: 'banner header image picture photo stock unsplash',
      shortcut: vimOnly(chord('vim.leaderPrefix', 'vim.leaderNoteActions', 'vim.leaderNoteCoverUnsplash')),
      when: () => !!coverNotePath() && unsplashSearchAvailable(),
      run: () => {
        openUnsplashCoverPicker()
      }
    },
    {
      // Settings, in the field: the cover picker's Unsplash tab searches with
      // the person's own key.
      id: 'note.cover.unsplashKey',
      title: 'Set Unsplash Access Key…',
      category: 'Note',
      keywords: 'unsplash api key access cover banner photo settings',
      when: () => unsplashKeySupported(),
      run: () => {
        openUnsplashKeySettings()
      }
    },
    {
      id: 'note.cover.paste',
      unavailableReason: () => 'A cover needs an open note',
      title: 'Paste Cover from Clipboard',
      category: 'Note',
      keywords: 'banner header image screenshot',
      shortcut: vimOnly(':cover paste'),
      when: () => !!coverNotePath(),
      run: async () => {
        const path = coverNotePath()
        if (path) await setCoverFromClipboard(path)
      }
    },
    {
      id: 'note.cover.reposition',
      unavailableReason: () => coverNotePath() ? 'This note has no cover' : 'A cover needs an open note',
      title: 'Reposition Cover',
      category: 'Note',
      keywords: 'banner header image move focal',
      shortcut: vimOnly(':cover reposition'),
      when: () => !!activeNoteCover(),
      run: () => {
        startCoverReposition()
      }
    },
    {
      id: 'note.cover.remove',
      unavailableReason: () => coverNotePath() ? 'This note has no cover' : 'A cover needs an open note',
      title: 'Remove Cover',
      category: 'Note',
      keywords: 'banner header image delete',
      shortcut: vimOnly(':cover!'),
      when: () => !!activeNoteCover(),
      run: async () => {
        const path = coverNotePath()
        if (path) await removeCover(path)
      }
    },
    {
      id: 'note.archive',
      // With the sidebar focused and its cursor on a note, that note (or the
      // selection it is part of) is the one this acts on, not the open note
      // (#972); everywhere else it is the open note, as before.
      unavailableReason: () => {
        const plan = sidebarCommandPlan('archive')
        if (plan?.kind === 'refuse') return plan.reason
        return getState().activeNote ? `Move Note to ${labels().archive} works on a note in ${labels().inbox} or ${labels().quick}` : `Move Note to ${labels().archive} needs an open note`
      },
      title: `Move Note to ${labels().archive}`,
      category: 'Note',
      when: () => {
        const plan = sidebarCommandPlan('archive')
        if (plan) return plan.kind === 'run'
        const f = getState().activeNote?.folder
        return f === 'inbox' || f === 'quick'
      },
      run: async () => {
        const plan = sidebarCommandPlan('archive')
        if (plan) {
          await runSidebarNotePlan(plan)
          return
        }
        await getState().archiveActive()
      }
    },
    {
      id: 'note.unarchive',
      unavailableReason: () => `Unarchive Note only works on a note in the ${labels().archive}`,
      title: 'Unarchive Note',
      category: 'Note',
      when: () => getState().activeNote?.folder === 'archive',
      run: () => getState().unarchiveActive()
    },
    {
      id: 'note.trash',
      // Follows the sidebar the same way as Move Note to Archive above (#972).
      unavailableReason: () => {
        const plan = sidebarCommandPlan('trash')
        if (plan?.kind === 'refuse') return plan.reason
        return getState().activeNote ? `This note is already in the ${labels().trash}` : `Move Note to ${labels().trash} needs an open note`
      },
      title: `Move Note to ${labels().trash}`,
      category: 'Note',
      keywords: 'delete',
      when: () => {
        const plan = sidebarCommandPlan('trash')
        if (plan) return plan.kind === 'run'
        return !!getState().activeNote && getState().activeNote?.folder !== 'trash'
      },
      run: async () => {
        const plan = sidebarCommandPlan('trash')
        if (plan) {
          await runSidebarNotePlan(plan)
          return
        }
        await getState().trashActive()
      }
    },
    {
      id: 'note.restore',
      unavailableReason: () => `Restore from ${labels().trash} only works on a note in the ${labels().trash}`,
      title: `Restore Note from ${labels().trash}`,
      category: 'Note',
      when: () => getState().activeNote?.folder === 'trash',
      run: () => getState().restoreActive()
    },
    {
      id: 'note.delete-permanently',
      unavailableReason: () => `Delete Note Permanently only works on a note in the ${labels().trash}`,
      title: 'Delete Note Permanently',
      category: 'Note',
      keywords: 'trash purge forever remove',
      when: () => getState().activeNote?.folder === 'trash',
      run: () => getState().deleteActivePermanently()
    },
    {
      id: 'note.copy-wikilink',
      title: 'Copy Note as Wikilink',
      category: 'Note',
      keywords: 'link clipboard',
      when: hasNote,
      run: async () => {
        const active = getState().activeNote
        if (!active) return
        const title = active.title || active.path.split('/').pop()?.replace(/\.md$/i, '') || ''
        window.zen.clipboardWriteText(`[[${title}]]`)
      }
    },
    {
      id: 'note.copy-markdown',
      title: 'Copy Note as Markdown',
      category: 'Note',
      keywords: 'copy clipboard markdown source document whole content text yank',
      when: hasNote,
      run: async () => {
        await getState().copyActiveNoteAsMarkdown()
      }
    },
    {
      id: 'note.copy-html',
      title: 'Copy Note as HTML (for email)',
      category: 'Note',
      keywords: 'copy clipboard html email rich mail paste share formatted',
      when: hasNote,
      run: async () => {
        await getState().copyActiveNoteAsHtml()
      }
    },
    {
      id: 'note.export-pdf',
      title: 'Export Note as PDF…',
      category: 'Note',
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
      id: 'note.export-docx',
      title: 'Export Note as Word Document…',
      category: 'Note',
      keywords: 'save word docx doc export office editable',
      // Desktop-only: the serializer embeds local images from the main
      // process, which the web app has no access to.
      when: () =>
        !!getState().activeNote &&
        getState().workspaceMode !== 'remote' &&
        window.zen.getAppInfo().runtime === 'desktop' &&
        typeof window.zen.exportNoteDocx === 'function',
      run: async () => {
        await getState().exportActiveNoteDocx()
      }
    },
    {
      id: 'note.copy-path',
      title: 'Copy Note Path',
      category: 'Note',
      keywords: 'clipboard relative vault',
      when: hasNote,
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
      when: hasNote,
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
      when: hasNote,
      run: async () => {
        const isCurrent = captureNavigationContext()
        const state = getState()
        const active = state.activeNote
        if (!active) return
        const vocabulary = moveNoteVocabulary(state.vaultSettings, state.systemFolderLabels, state.folders)
        const target = await promptApp(buildMoveNotePrompt(active, state.folders, vocabulary))
        // Empty is an answer (the notes root); only null is the Cancel.
        if (target === null || !isCurrent()) return
        const dest = parseMoveNoteTarget(target, vocabulary)
        await state.moveNote(active.path, dest.folder, dest.subpath, isCurrent)
      }
    }
  )

  /* ---------------- Tabs ---------------- */
  const getActiveLeaf = () => {
    const s = getState()
    return findLeaf(s.paneLayout, s.activePaneId)
  }
  // The database the active pane shows (as a database tab or a .csv asset
  // tab), with its active view, once it has loaded.
  const activeDatabaseView = (): { csvPath: string; view: DbView } | null => {
    const csvPath = databaseCsvPathForTab(getActiveLeaf()?.activeTab)
    const doc = csvPath ? getState().databases[csvPath] : undefined
    if (!csvPath || !doc) return null
    const view = doc.views.find((v) => v.id === doc.activeViewId) ?? doc.views[0]
    return view ? { csvPath, view } : null
  }
  const runDatabaseViewCommand = (command: DatabaseViewCommand): void => {
    const active = activeDatabaseView()
    if (active) requestDatabaseViewCommand(active.csvPath, command)
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
      // In Vim mode the Mod+W binding resolves to Ctrl+W on Linux/Windows, which
      // is the pane-command prefix — not close-tab — so showing it is misleading
      // (#242). Vim closes the tab with `:q` (→ closeActiveNote), matching how
      // save shows `:w`. Outside Vim, the real Mod+W binding is correct.
      shortcut: getState().vimMode ? ':q' : shortcut('global.closeActiveTab'),
      when: hasSelection,
      opensToRead: () => true,
      run: () => getState().closeActiveNote()
    },
    {
      id: 'tab.reopen',
      unavailableReason: () => 'No closed tab to reopen',
      title: 'Reopen Closed Tab',
      category: 'Tabs',
      keywords: 'restore last undo closed reopen',
      shortcut: shortcut('global.reopenClosedTab'),
      when: () => getState().closedTabStack.length > 0,
      opensToRead: () => true,
      run: () => getState().reopenLastClosedTab()
    },
    {
      id: 'tab.next',
      unavailableReason: () => 'No other tab to go to',
      title: 'Next Tab',
      category: 'Tabs',
      shortcut: shortcut('tabs.next'),
      keywords: 'cycle switch right gt ctrl+tab',
      when: () => {
        const s = getState()
        return getTabStepTarget(s.paneLayout, s.activePaneId, 1).kind !== 'none'
      },
      opensToRead: () => true,
      run: () => stepActiveTab(getState(), 1)
    },
    {
      id: 'tab.previous',
      unavailableReason: () => 'No other tab to go to',
      title: 'Previous Tab',
      category: 'Tabs',
      shortcut: shortcut('tabs.previous'),
      keywords: 'cycle switch left gT back ctrl+shift+tab',
      when: () => {
        const s = getState()
        return getTabStepTarget(s.paneLayout, s.activePaneId, -1).kind !== 'none'
      },
      opensToRead: () => true,
      run: () => stepActiveTab(getState(), -1)
    },
    {
      id: 'tab.pin',
      bindTitle: 'Pin or Unpin Tab',
      title: isActiveTabPinned() ? 'Unpin Tab' : 'Pin Tab',
      category: 'Tabs',
      keywords: 'stick sticky',
      when: hasNote,
      run: () => {
        const s = getState()
        if (s.activeNote) s.toggleTabPin(s.activePaneId, s.activeNote.path)
      }
    },
    {
      id: 'tab.close-others',
      unavailableReason: () => 'No other tab to close',
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
      unavailableReason: () => 'No tab to the right to close',
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
      when: hasNote,
      run: () => getState().setOutlinePaletteOpen(true)
    },
    {
      id: 'view.outline-panel',
      title: 'Toggle Outline Panel',
      category: 'View',
      shortcut: shortcut('global.toggleOutlinePanel'),
      keywords: 'outline panel sidebar right headings',
      when: hasNote,
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-outline'))
      }
    },
    {
      id: 'view.comments-panel',
      title: 'Toggle Comments Panel',
      category: 'View',
      shortcut: shortcut('global.toggleCommentsPanel'),
      keywords: 'comments annotations discussion margin review',
      when: hasNote,
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-comments'))
      }
    },
    {
      id: 'editor.add-comment',
      title: 'Add Comment to Selection',
      category: 'Editor',
      shortcut: shortcut('global.addComment'),
      keywords: 'comment annotate selection note review',
      when: hasNote,
      run: () => {
        window.dispatchEvent(new Event('zen:add-comment'))
      }
    },
    {
      id: 'view.calendar-panel',
      unavailableReason: () => 'The calendar opens beside a daily or weekly note',
      title: 'Toggle Calendar Panel',
      category: 'View',
      shortcut: getState().vimMode ? leaderShortcut('vim.leaderCalendar') : undefined,
      keywords: 'calendar daily weekly date navigate month week',
      // The calendar attaches to a note in the pane, so it's unavailable in the
      // note-less Tasks/Tags views and the Quick Notes scratchpad. (#413)
      when: () => isCalendarToggleAvailable(getState().vaultSettings, getState().activeNote),
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-calendar'))
      }
    },
    {
      id: 'view.timeline-panel',
      title: 'Toggle Timeline',
      category: 'View',
      shortcut: shortcut('global.toggleTimelinePanel'),
      keywords: 'timeline tasks due dates overdue milestones upcoming agenda schedule panel right',
      // Like the other right-hand panels it sits beside a note, so it needs
      // one in the pane; the tasks it lists are the whole vault's. (#1007)
      when: hasNote,
      run: () => {
        window.dispatchEvent(new Event('zen:toggle-timeline'))
      }
    },
    {
      id: 'view.close-right-panel',
      title: 'Close Right Panel',
      category: 'View',
      keywords: 'close hide dismiss right panel pane connections comments outline calendar timeline',
      when: hasNote,
      run: () => {
        window.dispatchEvent(new Event('zen:close-right-panel'))
      }
    },
    {
      id: 'view.mode.edit',
      title: 'Switch to Edit Mode',
      category: 'View',
      shortcut: shortcut('global.modeEdit'),
      keywords: 'editor writing raw markdown pane mode toolbar editmode',
      when: hasNote,
      run: () => requestPaneMode('edit')
    },
    {
      id: 'view.mode.split',
      title: 'Switch to Split Mode',
      category: 'View',
      shortcut: shortcut('global.modeSplit'),
      keywords: 'editor preview side by side pane mode toolbar splitmode',
      when: hasNote,
      run: () => requestPaneMode('split')
    },
    {
      id: 'view.mode.preview',
      title: 'Switch to Preview Mode',
      category: 'View',
      shortcut: shortcut('global.modePreview'),
      keywords: 'reading rendered markdown pane mode toolbar previewmode',
      when: hasNote,
      run: () => requestPaneMode('preview')
    },
    {
      id: 'view.zoom.in',
      title: 'Zoom In',
      category: 'View',
      shortcut: shortcut('global.zoomIn'),
      keywords: 'bigger larger scale ui app browser',
      run: async () => {
        await window.zen.zoomInApp()
      }
    },
    {
      id: 'view.zoom.out',
      title: 'Zoom Out',
      category: 'View',
      shortcut: shortcut('global.zoomOut'),
      keywords: 'smaller decrease scale ui app browser',
      run: async () => {
        await window.zen.zoomOutApp()
      }
    },
    {
      id: 'view.zoom.reset',
      title: 'Reset Zoom',
      category: 'View',
      shortcut: shortcut('global.zoomReset'),
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
      id: 'app.whatsNew',
      title: 'What’s New in ZenNotes',
      category: 'App',
      keywords: "whats what's new release notes changelog update announcement",
      when: () => window.zen.getAppInfo().runtime === 'desktop',
      run: () => void getState().openWhatsNew()
    },
    {
      id: 'app.hideToTray',
      title: 'Hide Window to Tray',
      category: 'App',
      keywords: 'tray menu bar background hide window close minimize keep running',
      shortcut: getState().vimMode ? leaderShortcut('vim.leaderHideToTray') : undefined,
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' && useTrayStore.getState().keepRunningInTray,
      run: () => void hideWindowToTray()
    },
    {
      id: 'app.quit',
      title: 'Quit ZenNotes',
      category: 'App',
      keywords: 'quit exit close app tray background stop',
      when: () => window.zen.getAppInfo().runtime === 'desktop' && !!window.zen.quitApp,
      run: () => window.zen.quitApp?.()
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
      title: 'Fold Heading or List Item at Cursor',
      category: 'Editor',
      shortcut: vimOnly(shortcut('vim.foldCurrent')),
      keywords: 'collapse fold heading section list item task bullet children callout',
      when: hasEditorNote,
      run: () => runFoldCommand('foldAtCursor')
    },
    {
      id: 'fold.unfold-heading',
      title: 'Unfold Heading or List Item at Cursor',
      category: 'Editor',
      shortcut: vimOnly(shortcut('vim.unfoldCurrent')),
      keywords: 'expand unfold heading section list item task bullet children callout',
      when: hasEditorNote,
      run: () => runFoldCommand('unfoldAtCursor')
    },
    {
      id: 'fold.all',
      title: 'Fold All Headings and Lists',
      category: 'Editor',
      shortcut: vimOnly(shortcut('vim.foldAll')),
      keywords: 'collapse fold all every heading list item task outline callout',
      when: hasEditorNote,
      run: () => runFoldCommand('foldAllOutline')
    },
    {
      id: 'fold.unfold-all',
      title: 'Unfold All Headings and Lists',
      category: 'Editor',
      shortcut: vimOnly(shortcut('vim.unfoldAll')),
      keywords: 'expand unfold all every reset heading list item task outline callout',
      when: hasEditorNote,
      run: () => runFoldCommand('unfoldAll')
    },
    {
      id: 'task.forward',
      title: 'Forward Task to Note…',
      category: 'Editor',
      keywords: 'forward task move migrate rollover bullet journal due',
      when: () => {
        const view = getState().editorViewRef
        return !!view && !!getState().activeNote && !!taskAtEditorCursor(view)
      },
      run: async () => {
        const view = getState().editorViewRef
        if (!view) return
        const task = taskAtEditorCursor(view)
        if (!task) {
          window.alert('Put the cursor on a task line to forward it.')
          return
        }
        await forwardTaskWithPicker(task)
      }
    },
    {
      id: 'task.start',
      title: 'Mark Task In Progress',
      category: 'Editor',
      keywords: 'start begin task in progress doing wip partial half started',
      when: () => {
        const view = getState().editorViewRef
        return !!view && !!getState().activeNote && !!taskAtEditorCursor(view)
      },
      run: async () => {
        const view = getState().editorViewRef
        if (!view) return
        const task = taskAtEditorCursor(view)
        if (!task) {
          window.alert('Put the cursor on a task line to mark it in progress.')
          return
        }
        await getState().startTaskFromList(task)
      }
    },
    {
      id: 'task.cancel',
      title: 'Cancel Task',
      category: 'Editor',
      keywords: 'cancel task abandon drop dropped scrap wontfix strike',
      when: () => {
        const view = getState().editorViewRef
        return !!view && !!getState().activeNote && !!taskAtEditorCursor(view)
      },
      run: async () => {
        const view = getState().editorViewRef
        if (!view) return
        const task = taskAtEditorCursor(view)
        if (!task) {
          window.alert('Put the cursor on a task line to cancel it.')
          return
        }
        await getState().cancelTaskFromList(task)
      }
    },
    {
      id: 'editor.link-popover',
      title: 'Open Link Popover',
      category: 'Editor',
      shortcut: getState().vimMode
        ? [shortcut('vim.linkPopover'), shortcut('editor.linkPopover')].filter(Boolean).join(' / ')
        : shortcut('editor.linkPopover'),
      keywords: 'link popover hover preview edit create note wikilink peek floating in place',
      when: hasEditorNote,
      run: () => {
        const view = getState().editorViewRef
        if (!view) return
        // The palette took focus; the cursor the popover reads is the
        // editor's, which it kept.
        if (!openLinkPopoverAtCursor(view)) {
          window.alert('Put the cursor on a [[wikilink]] to open its note in the link popover.')
        }
      }
    },
    {
      id: 'task.toggle-checkbox',
      title: 'Toggle Checkbox',
      category: 'Editor',
      shortcut: shortcut('editor.toggleCheckbox'),
      keywords: 'toggle checkbox task check uncheck line todo checklist convert done',
      when: hasEditorNote,
      run: () => {
        const view = getState().editorViewRef
        if (view) toggleCheckbox(view)
      }
    },
    {
      id: 'editor.reflow-paragraph',
      title: 'Reflow Paragraph',
      category: 'Editor',
      shortcut: shortcut('editor.reflowParagraph'),
      keywords: 'reflow join lines unwrap hard wrap word wrap format paragraph gq fill',
      when: hasEditorNote,
      run: () => {
        const view = getState().editorViewRef
        if (!view) return
        reflowParagraph(view)
        view.focus()
      }
    },
    {
      id: 'database.create-record-pages',
      title: 'Create Pages for All Records',
      category: 'Database',
      shortcut: getState().vimMode ? 'O' : undefined,
      keywords: 'database base records rows pages notes link wikilink bulk all csv',
      when: () => {
        const tab = getActiveLeaf()?.activeTab
        return !!tab && !!csvPathFromDatabaseTab(tab)
      },
      run: async () => {
        const tab = getActiveLeaf()?.activeTab
        const csvPath = tab ? csvPathFromDatabaseTab(tab) : null
        if (csvPath) await getState().createAllRecordPages(csvPath)
      }
    },
    // The open database's views (charles b.'s saved views). Each acts on the
    // active pane's database and its active view, and lists only where it
    // can do something there.
    {
      id: 'database.columns',
      title: 'Choose Database Columns',
      category: 'Database',
      shortcut: getState().vimMode ? 'c' : undefined,
      keywords: 'database base table columns fields show hide visible choose pick view',
      when: () => activeDatabaseView()?.view.type === 'table',
      run: () => runDatabaseViewCommand('columns')
    },
    {
      id: 'database.new-table-view',
      title: 'New Table View',
      category: 'Database',
      keywords: 'database base view table add create new saved columns',
      when: () => !!activeDatabaseView(),
      run: () => runDatabaseViewCommand('new-table-view')
    },
    {
      id: 'database.duplicate-view',
      title: 'Duplicate View',
      category: 'Database',
      keywords: 'database base view copy duplicate clone saved table board',
      when: () => !!activeDatabaseView(),
      run: () => runDatabaseViewCommand('duplicate-view')
    },
    {
      id: 'database.pick-selected',
      title: 'Show Only Selected Rows',
      category: 'Database',
      keywords: 'database base rows records pick picked picks selected selection only view subset',
      when: () => activeDatabaseView()?.view.type === 'table',
      run: () => runDatabaseViewCommand('pick-selected')
    },
    {
      id: 'database.show-all-rows',
      title: 'Show All Rows',
      category: 'Database',
      keywords: 'database base rows records picks picked clear reset all every view',
      when: () => {
        const active = activeDatabaseView()
        return !!active && viewHasPicks(active.view)
      },
      run: () => runDatabaseViewCommand('show-all-rows')
    },
    {
      id: 'table.to-database',
      title: 'Convert Table to Database…',
      category: 'Editor',
      shortcut: getState().vimMode
        ? chord('vim.leaderPrefix', 'vim.leaderNoteActions', 'vim.leaderTableToDatabase')
        : undefined,
      keywords: 'table database convert csv base grid board rows columns markdown pipe extract',
      // Stays listed whenever a note is open: with no table under the cursor
      // the run says so, which beats an entry that vanishes from the palette
      // and an ex command that returns nothing.
      when: hasEditorNote,
      run: async () => {
        const view = getState().editorViewRef
        if (!view) return
        await convertTableToDatabase(view)
      }
    },
    // Callouts from the keyboard (#1016): the type menu the right-click
    // offers, at the caret. Listed whenever a note is open, like the table
    // conversion above: a caret in code says why instead of hiding the row.
    {
      id: 'editor.callout-type',
      title: 'Set Callout Type…',
      category: 'Editor',
      shortcut: vimOnly(
        chord('vim.leaderPrefix', 'vim.leaderNoteActions', 'vim.leaderCalloutType')
      ),
      keywords:
        'callout admonition alert box turn into convert change type note info tip warning danger error success quote blockquote',
      when: hasEditorNote,
      run: () => {
        requestCalloutTypeMenu()
      }
    },
    {
      id: 'editor.remove-callout',
      title: 'Remove Callout',
      category: 'Editor',
      keywords: 'callout admonition alert unwrap plain text blockquote delete remove',
      when: hasEditorNote,
      run: () => {
        const view = getState().editorViewRef
        if (!view) return
        removeCalloutAtCursor(view)
        if (!hostOpensNotesToRead()) view.focus()
      }
    },
    // The code block language picker (#1014), for the block at the caret: the
    // same picker the block's label opens. Listed whenever a note is open;
    // outside a code block it says so.
    {
      id: 'editor.code-language',
      title: 'Set Code Block Language…',
      category: 'Editor',
      shortcut: vimOnly(
        chord('vim.leaderPrefix', 'vim.leaderNoteActions', 'vim.leaderCodeLanguage')
      ),
      keywords:
        'code block fence fenced language syntax highlight highlighting detect detected guess picker typescript python change set',
      when: hasEditorNote,
      run: () => {
        requestCodeLanguagePicker()
      }
    },
    {
      id: 'editor.copy-link',
      title: 'Copy Link Under Cursor',
      category: 'Editor',
      keywords: 'copy link url email address clipboard gy',
      when: hasEditorNote,
      run: () => {
        const view = getState().editorViewRef
        if (!view) return
        copyLinkAtCursor(view)
        // Copying is not typing: a phone keeps its keyboard down.
        if (!hostOpensNotesToRead()) view.focus()
      }
    },
    {
      id: 'editor.resize-image',
      title: 'Resize Image…',
      category: 'Editor',
      keywords: 'image picture width size resize embed px hint shrink grow',
      when: hasEditorNote,
      run: async () => {
        const view = getState().editorViewRef
        if (!view) return
        await promptImageWidth(view)
      }
    },
    {
      id: 'nav.back',
      title: 'Go Back',
      category: 'Tabs',
      shortcut: getState().vimMode ? shortcut('vim.historyBack') : shortcut('global.historyBack'),
      keywords: 'history previous',
      opensToRead: () => true,
      run: () => getState().jumpToPreviousNote()
    },
    {
      id: 'nav.forward',
      title: 'Go Forward',
      category: 'Tabs',
      shortcut: getState().vimMode ? shortcut('vim.historyForward') : shortcut('global.historyForward'),
      keywords: 'history next',
      opensToRead: () => true,
      run: () => getState().jumpToNextNote()
    },
    {
      id: 'nav.toggle-recent',
      title: 'Switch to Previous Note',
      category: 'Tabs',
      shortcut: shortcut('global.toggleRecentNote'),
      keywords: 'recent last previous alternate toggle switch note',
      opensToRead: () => true,
      run: () => getState().toggleRecentNote()
    }
  )

  /* ---------------- Panes / Splits ---------------- */
  cmds.push(
    {
      id: 'split.right',
      title: 'Split Right',
      category: 'Panes',
      shortcut: vimOnly(':vsplit'),
      keywords: 'vsplit vertical',
      when: hasSelection,
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
      shortcut: vimOnly(':split'),
      keywords: 'split horizontal',
      when: hasSelection,
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
        // Moves DOM focus too (with retries), not just the store panel: the
        // closing palette restores focus on unmount, and if that lands in a
        // self-keyed surface (database grid) it re-steals every key while the
        // sidebar paints its vim cursor. See focusSidebarPanel.
        focusSidebarPanel()
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
      unavailableReason: () => `The ${labels().tasks} view is already open`,
      title: `Open ${labels().tasks}`,
      category: 'View',
      shortcut: vimOnly(':tasks'),
      keywords: 'tasks todo checklist due waiting done vault',
      when: () => !isTasksViewActive(getState()),
      run: () => getState().openTasksView()
    },
    {
      id: 'view.workflows',
      unavailableReason: () => 'Workflows are off: turn them on under Settings, Workflows',
      title: 'Open Workflows',
      category: 'View',
      shortcut: vimOnly(':workflows'),
      keywords: 'workflow automation pipeline graph canvas nodes run dry',
      // Hidden entirely when the feature is switched off in Settings, so the
      // palette never offers a command that would open nothing.
      when: () => getState().workflowsEnabled,
      run: () => getState().openWorkflowsView()
    },
    {
      id: 'view.atlas',
      unavailableReason: () => 'The Atlas is turned off in Settings',
      title: 'Open Atlas',
      category: 'View',
      shortcut: leaderShortcut('vim.leaderAtlas'),
      keywords: 'atlas map graph vault visualize notes links regions sky 3d',
      // Hidden entirely when the feature is switched off in Settings
      when: () => getState().atlasEnabled,
      run: () => getState().openAtlasView()
    },
    {
      id: 'view.unresolved-links',
      unavailableReason: () => 'The Unresolved Links view is already open',
      title: 'Open Unresolved Links',
      category: 'View',
      shortcut: leaderShortcut('vim.leaderUnresolvedLinks'),
      keywords:
        'unresolved links missing broken dangling wikilinks notes to write later create orphan dead',
      when: () => !isUnresolvedLinksViewActive(getState()),
      run: () => getState().openUnresolvedLinksView()
    },
    {
      id: 'view.folder-gallery',
      title: 'Open Folder Gallery',
      category: 'View',
      shortcut: leaderShortcut('vim.leaderFolderGallery'),
      keywords:
        'gallery folder covers cards grid thumbnails banner images pictures board notes browse',
      // The folder under the sidebar cursor while the sidebar has focus,
      // otherwise the open note's folder (lib/folder-gallery-open.ts).
      run: () => openContextGallery()
    },
    {
      id: 'view.tags',
      unavailableReason: () => 'The Tags view is already open',
      title: 'Open Tags',
      category: 'View',
      shortcut: vimOnly(':tag'),
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
      bindTitle: 'Show or Hide Tags in Sidebar',
      title: getState().tagsCollapsed
        ? 'Show Tags in Sidebar'
        : 'Hide Tags in Sidebar',
      category: 'View',
      keywords: 'tag section fold hide collapse',
      run: () => getState().setTagsCollapsed(!getState().tagsCollapsed),
    },
    {
      id: 'view.content-align',
      bindTitle: 'Toggle Content Alignment',
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
      unavailableReason: () => 'Notes are already sorted this way',
      title: 'Sort Notes: Name (A → Z)',
      category: 'View',
      keywords: 'alphabetical order',
      when: () => getState().noteSortOrder !== 'name-asc',
      run: () => getState().setNoteSortOrder('name-asc')
    },
    {
      id: 'view.sort.name-desc',
      unavailableReason: () => 'Notes are already sorted this way',
      title: 'Sort Notes: Name (Z → A)',
      category: 'View',
      keywords: 'alphabetical order reverse',
      when: () => getState().noteSortOrder !== 'name-desc',
      run: () => getState().setNoteSortOrder('name-desc')
    },
    {
      id: 'view.sort.updated-desc',
      unavailableReason: () => 'Notes are already sorted this way',
      title: 'Sort Notes: Updated (Newest First)',
      category: 'View',
      keywords: 'date recent time modified',
      when: () => getState().noteSortOrder !== 'updated-desc',
      run: () => getState().setNoteSortOrder('updated-desc')
    },
    {
      id: 'view.sort.updated-asc',
      unavailableReason: () => 'Notes are already sorted this way',
      title: 'Sort Notes: Updated (Oldest First)',
      category: 'View',
      keywords: 'date time modified',
      when: () => getState().noteSortOrder !== 'updated-asc',
      run: () => getState().setNoteSortOrder('updated-asc')
    },
    {
      id: 'view.sort.created-desc',
      unavailableReason: () => 'Notes are already sorted this way',
      title: 'Sort Notes: Created (Newest First)',
      category: 'View',
      keywords: 'date added',
      when: () => getState().noteSortOrder !== 'created-desc',
      run: () => getState().setNoteSortOrder('created-desc')
    },
    {
      id: 'view.sort.created-asc',
      unavailableReason: () => 'Notes are already sorted this way',
      title: 'Sort Notes: Created (Oldest First)',
      category: 'View',
      keywords: 'date added reverse',
      when: () => getState().noteSortOrder !== 'created-asc',
      run: () => getState().setNoteSortOrder('created-asc')
    },
    {
      id: 'view.sort.manual',
      unavailableReason: () => 'Notes are already sorted this way',
      title: 'Sort Notes: Manual',
      category: 'View',
      keywords: 'none drag order',
      when: () => getState().noteSortOrder !== 'none',
      run: () => getState().setNoteSortOrder('none')
    },
    {
      id: 'view.group-by-kind',
      bindTitle: 'Toggle Grouping Notes by Kind',
      title: getState().groupByKind
        ? 'Ungroup Notes by Kind'
        : 'Group Notes by Kind',
      category: 'View',
      keywords: 'folders notes split section',
      run: () => getState().setGroupByKind(!getState().groupByKind)
    },
    {
      id: 'view.focus-mode',
      bindTitle: 'Toggle Zen Mode',
      title: (() => {
        const st = getState()
        return st.zenMode ? 'Exit Zen Mode' : 'Enter Zen Mode'
      })(),
      category: 'View',
      shortcut: shortcut('global.toggleZenMode'),
      keywords: 'zn distraction-free focus',
      run: () => {
        const st = getState()
        st.setFocusMode(!st.zenMode)
      }
    },
    {
      id: 'view.dark-sidebar',
      bindTitle: 'Toggle Dark Sidebar',
      title: getState().darkSidebar ? 'Light Sidebar' : 'Dark Sidebar',
      category: 'View',
      run: () => getState().setDarkSidebar(!getState().darkSidebar)
    },
    {
      // Settings, Appearance, Chrome, Status bar. Hidden, the bar still shows
      // while Cloud needs the user (lib/status-bar-visibility.ts).
      id: 'view.status-bar',
      title: 'Toggle Status Bar',
      category: 'View',
      keywords: 'status bar footer bottom bar hide show cloud sync word count backlinks chrome',
      run: () => getState().setShowStatusBar(!getState().showStatusBar)
    },
    {
      id: 'view.line-numbers.off',
      unavailableReason: () => 'Line numbers already show this way',
      title: 'Line Numbers: Off',
      category: 'View',
      when: () => getState().lineNumberMode !== 'off',
      run: () => getState().setLineNumberMode('off')
    },
    {
      id: 'view.line-numbers.absolute',
      unavailableReason: () => 'Line numbers already show this way',
      title: 'Line Numbers: Absolute',
      category: 'View',
      when: () => getState().lineNumberMode !== 'absolute',
      run: () => getState().setLineNumberMode('absolute')
    },
    {
      id: 'view.line-numbers.relative',
      unavailableReason: () => 'Line numbers already show this way',
      title: 'Line Numbers: Relative',
      category: 'View',
      when: () => getState().lineNumberMode !== 'relative',
      run: () => getState().setLineNumberMode('relative')
    }
  )

  // The Kanban card order (#889), from any note: the next board opened uses it.
  cmds.push({
    id: 'view.kanban-card-sort',
    bindTitle: 'Kanban: Toggle Card Order',
    title:
      getState().kanbanCardSort === 'due'
        ? 'Kanban: Order Cards Manually'
        : 'Kanban: Order Cards by Due Date',
    category: 'View',
    keywords: 'tasks board sort due date deadline order cards columns manual',
    run: () => getState().setKanbanCardSort(getState().kanbanCardSort === 'due' ? 'manual' : 'due')
  })

  // The Tasks list's order (#989), from any note: the next list opened uses it.
  cmds.push({
    id: 'view.tasks-list-order',
    bindTitle: 'Tasks: Toggle List Order',
    title:
      getState().tasksListOrder === 'priority'
        ? 'Tasks: Order List by Note Order'
        : 'Tasks: Order List by Priority',
    category: 'View',
    keywords: 'tasks list sort priority high order note line',
    run: () =>
      getState().setTasksListOrder(getState().tasksListOrder === 'priority' ? 'note' : 'priority')
  })

  // Saved Tasks filters (#731): one palette entry per name, so a filter is a
  // few keystrokes away from any note. Opening the view resets the filter, so
  // the query is applied once the open has settled.
  for (const [name, query] of Object.entries(getState().savedTaskFilters)) {
    cmds.push({
      id: `tasks.savedFilter.${name}`,
      title: `${labels().tasks}: ${name}`,
      category: 'View',
      keywords: `saved filter tasks ${query}`,
      run: async () => {
        if (!isTasksViewActive(getState())) await getState().openTasksView()
        getState().applySavedTaskFilter(name)
      }
    })
  }

  /* ---------------- Editor preferences ---------------- */
  cmds.push(
    {
      id: 'editor.vim.toggle',
      bindTitle: 'Toggle Vim Mode',
      title: getState().vimMode ? 'Disable Vim Mode' : 'Enable Vim Mode',
      category: 'Editor',
      run: () => getState().setVimMode(!getState().vimMode)
    },
    {
      id: 'editor.completed-task.none',
      unavailableReason: () => 'Completed tasks already look this way',
      title: 'Completed Tasks: No Style',
      category: 'Editor',
      when: () => getState().completedTaskStyle !== 'none',
      run: () => getState().setCompletedTaskStyle('none')
    },
    {
      id: 'editor.completed-task.strikethrough',
      unavailableReason: () => 'Completed tasks already look this way',
      title: 'Completed Tasks: Strikethrough',
      category: 'Editor',
      when: () => getState().completedTaskStyle !== 'strikethrough',
      run: () => getState().setCompletedTaskStyle('strikethrough')
    },
    {
      id: 'editor.completed-task.gray',
      unavailableReason: () => 'Completed tasks already look this way',
      title: 'Completed Tasks: Gray',
      category: 'Editor',
      when: () => getState().completedTaskStyle !== 'gray',
      run: () => getState().setCompletedTaskStyle('gray')
    },
    {
      id: 'editor.completed-task.gray-strikethrough',
      unavailableReason: () => 'Completed tasks already look this way',
      title: 'Completed Tasks: Strikethrough + Gray',
      category: 'Editor',
      when: () => getState().completedTaskStyle !== 'gray-strikethrough',
      run: () => getState().setCompletedTaskStyle('gray-strikethrough')
    },
    {
      id: 'editor.which-key.toggle',
      bindTitle: 'Toggle Leader Key Hints',
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
      bindTitle: 'Toggle Live Preview',
      title: getState().livePreview ? 'Disable Live Preview' : 'Enable Live Preview',
      category: 'Editor',
      keywords: 'decoration inline',
      run: () => getState().setLivePreview(!getState().livePreview)
    },
    {
      id: 'editor.harper.toggle',
      bindTitle: 'Toggle Grammar and Spelling with Harper',
      title: getState().harperEnabled
        ? 'Disable Grammar and Spelling with Harper'
        : 'Enable Grammar and Spelling with Harper',
      category: 'Editor',
      keywords: 'harper grammar spelling spell check lint',
      when: () => harperSupported(),
      run: () => getState().setHarperEnabled(!getState().harperEnabled)
    },
    {
      id: 'editor.harper.next',
      unavailableReason: () => !harperSupported() ? "Harper isn't available here" : !getState().harperEnabled ? 'Harper is off: turn it on under Settings, Editor' : 'Harper needs a note open in the editor',
      title: 'Harper: Next Suggestion',
      category: 'Editor',
      keywords: 'harper grammar spelling',
      when: () => harperSupported() && getState().harperEnabled && !!getState().editorViewRef,
      run: () => {
        const view = getState().editorViewRef
        if (view) harperNextSuggestion(view)
      }
    },
    {
      id: 'editor.harper.previous',
      unavailableReason: () => !harperSupported() ? "Harper isn't available here" : !getState().harperEnabled ? 'Harper is off: turn it on under Settings, Editor' : 'Harper needs a note open in the editor',
      title: 'Harper: Previous Suggestion',
      category: 'Editor',
      keywords: 'harper grammar spelling',
      when: () => harperSupported() && getState().harperEnabled && !!getState().editorViewRef,
      run: () => {
        const view = getState().editorViewRef
        if (view) harperPreviousSuggestion(view)
      }
    },
    {
      id: 'editor.harper.suggest',
      unavailableReason: () => !harperSupported() ? "Harper isn't available here" : !getState().harperEnabled ? 'Harper is off: turn it on under Settings, Editor' : 'Harper needs a note open in the editor',
      title: 'Harper: Show Suggestions at Cursor',
      category: 'Editor',
      keywords: 'harper grammar spelling fix',
      when: () => harperSupported() && getState().harperEnabled && !!getState().editorViewRef,
      run: () => {
        const view = getState().editorViewRef
        if (view) harperOpenSuggestions(view)
      }
    },
    {
      id: 'editor.harper.apply',
      unavailableReason: () => !harperSupported() ? "Harper isn't available here" : !getState().harperEnabled ? 'Harper is off: turn it on under Settings, Editor' : 'Harper needs a note open in the editor',
      title: 'Harper: Apply First Suggestion',
      category: 'Editor',
      keywords: 'harper grammar spelling fix',
      when: () => harperSupported() && getState().harperEnabled && !!getState().editorViewRef,
      run: () => {
        const view = getState().editorViewRef
        if (view) harperApplyFirstSuggestion(view)
      }
    },
    {
      id: 'editor.harper.addWord',
      unavailableReason: () => !harperSupported() ? "Harper isn't available here" : !getState().harperEnabled ? 'Harper is off: turn it on under Settings, Editor' : 'Harper needs a note open in the editor',
      title: 'Harper: Add Word to Dictionary',
      category: 'Editor',
      keywords: 'harper spelling dictionary',
      when: () => harperSupported() && getState().harperEnabled && !!getState().editorViewRef,
      run: () => {
        const view = getState().editorViewRef
        if (view) harperAddWordAtCursor(view, harperEditorConfig())
      }
    },
    {
      id: 'editor.harper.ignore',
      unavailableReason: () => !harperSupported() ? "Harper isn't available here" : !getState().harperEnabled ? 'Harper is off: turn it on under Settings, Editor' : 'Harper needs a note open in the editor',
      title: 'Harper: Ignore Suggestion',
      category: 'Editor',
      keywords: 'harper grammar spelling',
      when: () => harperSupported() && getState().harperEnabled && !!getState().editorViewRef,
      run: () => {
        const view = getState().editorViewRef
        if (view) harperIgnoreAtCursor(view, harperEditorConfig())
      }
    },
    {
      id: 'editor.tabs.toggle',
      bindTitle: 'Toggle Tabs',
      title: getState().tabsEnabled ? 'Disable Tabs' : 'Enable Tabs',
      category: 'Editor',
      run: () => getState().setTabsEnabled(!getState().tabsEnabled)
    },
    {
      id: 'editor.keep-panels.toggle',
      bindTitle: 'Toggle Remembering Panels per Note',
      title: getState().keepPanelsAcrossNotes
        ? 'Remember Panels per Note'
        : 'Keep Panels When Switching Notes',
      category: 'Editor',
      keywords: 'panels connections outline comments calendar sticky per note remember switch',
      run: () => getState().setKeepPanelsAcrossNotes(!getState().keepPanelsAcrossNotes)
    },
    {
      id: 'editor.persist-undo-history.toggle',
      bindTitle: 'Toggle Keeping Undo History After Quitting',
      title: getState().persistUndoHistory
        ? 'Stop Keeping Undo History After Quitting'
        : 'Keep Undo History After Quitting',
      category: 'Editor',
      keywords: 'undofile undo redo history persistent restart quit vim',
      when: () => !!window.zen?.getCapabilities?.().supportsUndoFile,
      run: () => getState().setPersistUndoHistory(!getState().persistUndoHistory)
    },
    {
      id: 'editor.word-wrap.toggle',
      bindTitle: 'Toggle Word Wrap',
      title: getState().wordWrap ? 'Disable Word Wrap' : 'Enable Word Wrap',
      category: 'Editor',
      shortcut: shortcut('global.toggleWordWrap'),
      keywords: 'wrap line soft hard',
      run: () => getState().setWordWrap(!getState().wordWrap)
    },
    {
      id: 'editor.auto-reveal.toggle',
      bindTitle: 'Toggle Auto-Reveal Active Note',
      title: getState().autoReveal
        ? 'Disable Auto-Reveal Active Note'
        : 'Enable Auto-Reveal Active Note',
      category: 'Editor',
      run: () => getState().setAutoReveal(!getState().autoReveal)
    },
    {
      id: 'editor.quick-note-date.toggle',
      bindTitle: 'Toggle Quick Note Date Titles',
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
      unavailableReason: () => 'PDF embeds already show this way',
      title: 'PDF Embeds: Compact Card',
      category: 'Editor',
      keywords: 'pdf embed compact card preview reference',
      when: () => getState().pdfEmbedInEditMode !== 'compact',
      run: () => getState().setPdfEmbedInEditMode('compact')
    },
    {
      id: 'editor.pdf-embed.full',
      unavailableReason: () => 'PDF embeds already show this way',
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
      when: hasNote,
      run: async () => {
        const path = getState().activeNote?.path
        if (path) await getState().pinReference(path)
      }
    },
    {
      id: 'ref.unpin',
      unavailableReason: () => 'No note is pinned as the reference',
      title: 'Unpin Reference',
      category: 'Reference',
      when: () => !!getState().pinnedRefPath,
      run: () => {
        getState().unpinReference()
      }
    },
    {
      id: 'ref.toggle',
      bindTitle: 'Show or Hide Reference Pane',
      title: getState().pinnedRefVisible
        ? 'Hide Reference Pane'
        : 'Show Reference Pane',
      category: 'Reference',
      when: () => !!activeReferencePath(getState()),
      run: () => {
        getState().togglePinnedRefVisible()
      }
    },
    {
      id: 'ref.focus',
      title: 'Focus Reference Pane',
      category: 'Reference',
      when: () =>
        !!activeReferencePath(getState()) && getState().pinnedRefVisible,
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
    // The palette drills into its theme list when this row is picked there;
    // run on its own (a key, the ex line) it opens the palette on that list.
    run: () => getState().setCommandPaletteOpen(true, 'theme')
  })
  cmds.push({
    id: 'ui.newTheme',
    title: 'New Custom Theme…',
    category: 'UI',
    keywords: 'custom theme create css appearance author new',
    when: () => window.zen.getAppInfo().runtime === 'desktop',
    run: async () => {
      const name = await promptApp({
        title: 'New theme',
        description: 'Creates a folder with a manifest.json and theme.css you can edit.',
        placeholder: 'My Theme',
        initialValue: 'My Theme',
        okLabel: 'Create'
      })
      if (name === null) return
      const slug = await window.zen.createCustomTheme?.({ name: name.trim() || 'My Theme' })
      if (slug) void window.zen.revealCustomThemesDir?.(slug)
    }
  })
  cmds.push({
    id: 'ui.overrides',
    title: 'Overrides…',
    category: 'UI',
    keywords: 'css override tweak override theme appearance customize color',
    when: () => window.zen.getAppInfo().runtime === 'desktop',
    run: () => getState().setSettingsOpen(true)
  })

  /* ---------------- Tags ---------------- */
  cmds.push(
    {
      id: 'tag.rename',
      title: 'Rename Tag…',
      category: 'Tag',
      run: async () => {
        const from = await promptApp({
          title: 'Rename tag: old name',
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
      bindTitle: 'Generate Demo Tour Notes',
      title: getState().notes.some((note) => isDemoTourStartPath(note.path))
        ? 'Regenerate Demo Tour Notes'
        : 'Generate Demo Tour Notes',
      category: 'Demo',
      keywords: 'demo onboarding starter tour sample example seed welcome',
      when: () => !!getState().vault,
      run: async () => {
        const installed = getState().notes.some((note) => isDemoTourStartPath(note.path))
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
        // A server that still writes the older note names reports them here.
        await getState().selectNote(
          result.notePaths.find(isDemoTourStartPath) ?? DEMO_TOUR_START_PATH
        )
      }
    },
    {
      id: 'demo.remove',
      title: 'Remove Demo Tour Notes',
      category: 'Demo',
      keywords: 'demo onboarding starter tour sample example delete clear uninstall',
      when: () => getState().notes.some((note) => isDemoTourStartPath(note.path)),
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
      id: 'app.onboarding.restart',
      title: 'Show Onboarding Wizard',
      category: 'App',
      keywords: 'onboarding welcome wizard setup first-run getting started vim theme vault',
      run: () => getState().restartOnboarding()
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
      id: 'app.vault.openWindow',
      title: 'Open Local Vault in New Window…',
      category: 'Vault',
      keywords: 'vault local open folder workspace window tab multiple',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsLocalFilesystemPickers,
      run: async () => {
        await window.zen.openVaultWindow()
      }
    },
    {
      id: 'app.file.open',
      title: 'Open File…',
      category: 'Vault',
      keywords: 'open file markdown external outside vault one-off document proofread standalone',
      shortcut: shortcut('global.openFile'),
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsLocalFilesystemPickers,
      run: async () => {
        await window.zen.openFileDialog()
      }
    },
    {
      id: 'app.vault.close',
      title: 'Close Current Vault',
      category: 'Vault',
      keywords: 'vault local close remove forget workspace',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        getState().workspaceMode !== 'remote' &&
        !!getState().vault,
      run: () => getState().closeVault()
    },
    {
      id: 'app.cloud.reviewConflicts',
      unavailableReason: () => 'No Cloud conflicts are waiting',
      title: 'Review Cloud Sync Conflicts',
      category: 'Vault',
      keywords: 'cloud sync conflict merge review resolve queue two devices differ settings',
      shortcut: getState().vimMode ? leaderShortcut('vim.leaderCloudConflicts') : undefined,
      // Hidden while nothing waits: the same dialogs the status bar's Review
      // opens (the file queue first, then the vault settings question), and
      // there is nothing to review without one of them.
      when: () => hasPendingCloudReview(),
      run: () => openPendingCloudReview(getState().activeNote?.path)
    },
    // One entry per note an assistant edited through MCP that has not been
    // reviewed yet (docs/ideas/agent-edit-review.md), newest first. A record
    // whose note is gone (deleted outside ZenNotes) has nothing to open.
    ...Object.values(getState().agentEdits)
      .filter((summary) => getState().notes.some((note) => note.path === summary.notePath))
      .sort((a, b) => b.at - a.at)
      .map(
        (summary): Command => ({
          id: `app.agentEdits.review:${summary.notePath}`,
          title: `Review Agent Changes: ${(summary.notePath.split('/').pop() ?? summary.notePath).replace(/\.md$/i, '')}`,
          category: 'Note',
          keywords: `assistant agent mcp ai changes diff review accept reject ${summary.agent} ${summary.notePath}`,
          run: async () => {
            await getState().selectNote(summary.notePath)
            requestAgentEditReview(summary.notePath)
          }
        })
      ),
    {
      id: 'app.cloud.reviewVaultRemoval',
      title: 'Review Cloud Vault',
      category: 'Vault',
      keywords: 'cloud sync vault deleted unavailable gone stopped syncing link choose new',
      shortcut: getState().vimMode ? leaderShortcut('vim.leaderCloudConflicts') : undefined,
      // While this vault's Cloud vault is gone the key opens Settings → Cloud,
      // as the status bar's Review does. A waiting decision keeps the key.
      when: () => !hasPendingCloudReview() && hasCloudVaultRemovalNotice(),
      run: () => {
        requestSettingsTarget('cloud')
        getState().setSettingsOpen(true)
      }
    },
    {
      id: 'app.vault.switch',
      title: 'Switch Vault…',
      category: 'Vault',
      keywords: 'vault local remote switch workspace recent picker server',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        (window.zen.getCapabilities().supportsLocalFilesystemPickers ||
          window.zen.getCapabilities().supportsRemoteWorkspace),
      // Drilled into by the palette; on its own key it opens the palette there.
      run: () => getState().setCommandPaletteOpen(true, 'vault')
    },
    {
      id: 'vault.rename',
      title: 'Rename Vault…',
      category: 'Vault',
      keywords: 'vault name display name rename label switcher sidebar header folder',
      // Local vaults only (#692): a temporary folder session writes nothing
      // into its folder, and a remote workspace's settings belong to its server.
      when: () => canRenameVault(getState()),
      run: async () => {
        await renameVaultWithPrompt()
      }
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
    },
    {
      id: 'cli.check-updates',
      title: 'Check for zn Updates…',
      category: 'CLI',
      keywords: 'cli zn terminal command line update upgrade version release',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsCliInstall &&
        typeof window.zen.cliUpdateCheck === 'function',
      run: async () => {
        const before = await window.zen.cliUpdateGetState?.()
        if (!before?.supported) return
        const install = await window.zen.cliGetStatus()
        if (!install.installedAt || !install.installedByThisApp) {
          await confirmApp({
            title: 'zn is not managed by ZenNotes',
            description: install.installedAt
              ? `The zn at ${install.installedAt} came from another installer. Update it with that installer (\`zn update\` tells you how).`
              : 'Install zn from Settings → CLI first; ZenNotes then keeps it up to date.',
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        let state = await window.zen.cliUpdateCheck?.({ install: before.autoUpdate })
        if (state?.phase === 'available') {
          const proceed = await confirmApp({
            title: `zn ${state.availableVersion ?? ''} is available`,
            description:
              'Install it now? The zn you have keeps working until the new one passes its checks.',
            confirmLabel: 'Install',
            cancelLabel: 'Later'
          })
          if (!proceed) return
          state = await window.zen.cliUpdateCheck?.({ install: true })
        }
        await confirmApp({
          title: 'zn updates',
          description: state?.message ?? 'Checked for zn updates.',
          confirmLabel: 'OK',
          cancelLabel: 'Close'
        })
      }
    },
    {
      id: 'cli.install',
      title: 'Install Command-Line Tool (zn)',
      category: 'CLI',
      keywords: 'cli zn terminal shell command line install symlink path bin',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsCliInstall,
      run: async () => {
        const status = await window.zen.cliGetStatus()
        if (!status.supportedPlatform) {
          await confirmApp({
            title: 'CLI not supported on this platform',
            description: status.reason ?? 'CLI install is currently macOS- and Linux-only.',
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        if (!status.available) {
          await confirmApp({
            title: 'CLI wrapper not bundled',
            description:
              status.reason ?? 'The CLI wrapper has not been built yet. Run `npm run build` or open Settings → CLI for details.',
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        if (status.installedAt && status.installedByThisApp) {
          await confirmApp({
            title: 'zn is already installed',
            description: `Installed at ${status.installedAt}. Run \`zn --help\` from any terminal.`,
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        if (status.installedAt && !status.installedByThisApp) {
          await confirmApp({
            title: 'A different `zn` already exists',
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
            `Heads up: ${status.defaultTarget.replace(/\/[^/]+$/, '')} is not on your PATH yet. Settings → CLI shows the one-line shell override you'll need to add after install.`
          )
        }
        const ok = await confirmApp({
          title: `Install zn to ${status.defaultTarget}?`,
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
            title: 'zn installed',
            description: `Symlink created at ${next.installedAt ?? next.defaultTarget}. Open a fresh terminal and run \`zn --help\` to start.${followUp}`,
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (/canceled/i.test(message)) return
          await confirmApp({
            title: 'Install failed',
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
      title: 'Uninstall Command-Line Tool (zn)',
      category: 'CLI',
      keywords: 'cli zn terminal shell command line uninstall remove symlink',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsCliInstall,
      run: async () => {
        const status = await window.zen.cliGetStatus()
        if (!status.installedAt) {
          await confirmApp({
            title: 'zn is not installed',
            description: 'There is nothing to uninstall.',
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        if (!status.installedByThisApp) {
          await confirmApp({
            title: 'Not managed by ZenNotes',
            description: `${status.installedAt} was not installed by this app. Remove it manually if you really want it gone.`,
            confirmLabel: 'OK',
            cancelLabel: 'Close'
          })
          return
        }
        const ok = await confirmApp({
          title: `Remove zn from ${status.installedAt}?`,
          description:
            'macOS may prompt for an admin password to remove the symlink. The CLI binary inside the app stays bundled, so you can reinstall any time.',
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
            title: 'Uninstall failed',
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
      title: 'Open CLI Settings',
      category: 'CLI',
      keywords: 'cli zn terminal settings command line preferences',
      when: () =>
        window.zen.getAppInfo().runtime === 'desktop' &&
        window.zen.getCapabilities().supportsCliInstall,
      run: () => {
        // Without a target Settings reopens on whatever page it showed last.
        requestSettingsTarget('cli')
        getState().setSettingsOpen(true)
      }
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

  /* ---------------- Workflows: the picker, and one Run entry each ---------------- */
  // Built from the store's workflow index the same way the remote profiles
  // above are built from theirs, so the palette always reflects the vault as
  // of the moment it opened. Drafts are left out on purpose: a draft cannot
  // run, and a row that only answers with an error is worse than no row.
  {
    const state = getState()
    // Where a workflow could run at all: any host that can keep workflow
    // files and journals, the same predicate the Workflows view uses. Gating
    // on runtime === 'desktop' left capable web workspaces (a 2.29 server
    // advertising supportsWorkflows) with a working view but no palette rows
    // and no vim ex-commands, on the keyboard-first surface of all places.
    // Deliberately NOT gated on the feature switch, because the tutorial below
    // must be findable BEFORE someone has opted in: starting it IS the opt-in,
    // exactly like the button in Settings.
    const workflowsPossibleHere =
      canManageWorkflows(
        window.zen.getAppInfo().runtime,
        state.workspaceMode,
        window.zen.getCapabilities()
      ) && typeof window.zen.applyWorkflow === 'function'
    if (workflowsPossibleHere) {
      cmds.push({
        id: 'workflow.tutorial',
        title: 'Start Workflows Tutorial',
        category: 'Workflow',
        keywords: 'workflow tutorial learn guide walkthrough practice lesson automation onboarding',
        when: () => getState().workspaceMode !== 'remote',
        run: () => {
          // Lazy on purpose: the tutorial's chapters and seeds belong to the
          // lazy layer, and a palette command must not drag them into boot.
          void import('./workflow-tutorial-flow').then((mod) => mod.startWorkflowTutorial())
        }
      })
    }
    const runnableHere = state.workflowsEnabled && workflowsPossibleHere
    if (runnableHere) {
      // `runnableHere` gates what this build of the list contains; the `when`
      // guard gates every LATER use of a captured command object. The vim ex
      // registry snapshots commands at editor mount, so without `when`, a
      // `:workflow_run_…` name kept running the full write ladder after the
      // feature was switched off in Settings.
      const stillOn = (): boolean => getState().workflowsEnabled
      // The browsable list, in the same drill-down shape as `Switch Vault…`.
      cmds.push({
        id: 'workflow.runPicker',
        title: 'Run Workflow…',
        category: 'Workflow',
        keywords: 'workflow run list pick choose automation trigger pipeline',
        when: stillOn,
        // Drilled into by the palette; on its own key it opens the palette there.
        run: () => getState().setCommandPaletteOpen(true, 'workflow')
      })
      for (const entry of state.workflowIndex) {
        if (entry.status !== 'active') continue
        cmds.push({
          id: `workflow.run.${entry.id}`,
          title: `Run: ${entry.name}`,
          category: 'Workflow',
          keywords: `${entry.name} ${entry.description} ${entry.id} workflow run automation trigger pipeline`,
          when: stillOn,
          run: () => runWorkflowById(entry.id)
        })
      }
    }
  }

  // The shared guards get their reason here, once (see hasNote above).
  for (const cmd of cmds) {
    if (cmd.unavailableReason || !cmd.when) continue
    const title = cmd.title
    if (cmd.when === hasNote) cmd.unavailableReason = () => `${title} needs an open note`
    else if (cmd.when === hasEditorNote) {
      cmd.unavailableReason = () => `${title} needs a note open in the editor`
    } else if (cmd.when === hasSelection) {
      cmd.unavailableReason = () => `${title} needs an open note`
    }
  }

  // A key the user gave a command shows on its row, ahead of any key it
  // already had (Toggle favorite keeps Space l s after it). A leader
  // sequence names a Vim key, so it shows only with Vim mode on.
  {
    const state = getState()
    const bindings = state.commandKeymaps
    for (const cmd of cmds) {
      cmd.builtinShortcut = cmd.shortcut
      const own = commandBindingHint(bindings[cmd.id], {
        overrides: state.keymapOverrides,
        vimMode: state.vimMode
      })
      if (own) cmd.shortcut = cmd.shortcut ? `${own} / ${cmd.shortcut}` : own
    }
  }

  // Filter out commands whose `when` guard rejects them.
  if (options?.includeUnavailable) return cmds
  return cmds.filter((c) => !c.when || c.when())
}
