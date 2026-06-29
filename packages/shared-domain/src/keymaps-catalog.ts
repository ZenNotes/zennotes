// Slim, generated keymap catalog: one entry per bindable action with its
// group, default binding, and title. Lives here (not in app-core) so the
// desktop main process can list every action as a commented default in the
// config file for discovery (issue #203). The full definitions — kinds,
// scopes, descriptions, resolution logic — stay in
// `packages/app-core/src/lib/keymaps.ts`, which is the source of truth; a test
// there asserts this catalog stays in sync (id, group, defaultBinding, title).
//
// Regenerate via the keymaps-catalog drift test in app-core if definitions change.

export interface KeymapCatalogEntry {
  id: string
  group: string
  defaultBinding: string
  title: string
}

/** Display order for keymap groups in the generated config reference. */
export const KEYMAP_GROUP_ORDER = ["global", "vim", "navigation", "view-actions"] as const

export const KEYMAP_GROUP_LABELS: Record<string, string> = {
  global: "Global",
  vim: "Vim",
  navigation: "Navigation",
  "view-actions": "View actions"
}

export const KEYMAP_CATALOG: KeymapCatalogEntry[] = [
  { id: "global.searchNotes", group: "global", defaultBinding: "Mod+P", title: "Search notes" },
  { id: "global.searchNotesNonVim", group: "global", defaultBinding: "Mod+F", title: "Search notes in non-Vim mode" },
  { id: "global.commandPalette", group: "global", defaultBinding: "Shift+Mod+P", title: "Open command palette" },
  { id: "global.newQuickNote", group: "global", defaultBinding: "Shift+Mod+N", title: "New quick note" },
  { id: "global.openSettings", group: "global", defaultBinding: "Mod+,", title: "Open settings" },
  { id: "global.toggleSidebar", group: "global", defaultBinding: "Mod+1", title: "Toggle sidebar" },
  { id: "global.toggleConnections", group: "global", defaultBinding: "Mod+2", title: "Toggle connections panel" },
  { id: "global.toggleOutlinePanel", group: "global", defaultBinding: "Mod+3", title: "Toggle outline panel" },
  { id: "global.toggleCommentsPanel", group: "global", defaultBinding: "Shift+Mod+C", title: "Toggle comments panel" },
  { id: "global.addComment", group: "global", defaultBinding: "Alt+Mod+M", title: "Add comment to selection" },
  { id: "global.focusPaneLeft", group: "global", defaultBinding: "Alt+H", title: "Focus pane left" },
  { id: "global.focusPaneDown", group: "global", defaultBinding: "Alt+J", title: "Focus pane down" },
  { id: "global.focusPaneUp", group: "global", defaultBinding: "Alt+K", title: "Focus pane up" },
  { id: "global.focusPaneRight", group: "global", defaultBinding: "Alt+L", title: "Focus pane right" },
  { id: "global.modeEdit", group: "global", defaultBinding: "Mod+4", title: "Switch to editor mode" },
  { id: "global.modeSplit", group: "global", defaultBinding: "Mod+5", title: "Switch to split mode" },
  { id: "global.modePreview", group: "global", defaultBinding: "Mod+6", title: "Switch to preview mode" },
  { id: "global.toggleZenMode", group: "global", defaultBinding: "Mod+.", title: "Toggle Zen mode" },
  { id: "global.closeActiveTab", group: "global", defaultBinding: "Mod+W", title: "Close active tab" },
  { id: "global.toggleWordWrap", group: "global", defaultBinding: "Alt+Z", title: "Toggle word wrap" },
  { id: "global.exportNotePdf", group: "global", defaultBinding: "Shift+Mod+E", title: "Export note as PDF" },
  { id: "global.zoomIn", group: "global", defaultBinding: "Mod+=", title: "Zoom in" },
  { id: "global.zoomOut", group: "global", defaultBinding: "Mod+-", title: "Zoom out" },
  { id: "global.zoomReset", group: "global", defaultBinding: "Mod+0", title: "Reset zoom" },
  { id: "global.historyBack", group: "global", defaultBinding: "Alt+ArrowLeft", title: "Go back in note history" },
  { id: "global.historyForward", group: "global", defaultBinding: "Alt+ArrowRight", title: "Go forward in note history" },
  { id: "vim.leaderPrefix", group: "vim", defaultBinding: "Space", title: "Leader key" },
  { id: "vim.leaderOpenBuffers", group: "vim", defaultBinding: "o", title: "Leader: open buffers" },
  { id: "vim.leaderSearchNotes", group: "vim", defaultBinding: "f", title: "Leader: search notes" },
  { id: "vim.leaderSearchGroup", group: "vim", defaultBinding: "s", title: "Leader: search…" },
  { id: "vim.leaderSearchVaultText", group: "vim", defaultBinding: "t", title: "Leader search: vault text" },
  { id: "vim.leaderToggleSidebar", group: "vim", defaultBinding: "e", title: "Leader: toggle sidebar" },
  { id: "vim.leaderNoteOutline", group: "vim", defaultBinding: "p", title: "Leader: note outline" },
  { id: "vim.leaderSwitchVault", group: "vim", defaultBinding: "v", title: "Leader: switch vault" },
  { id: "vim.leaderNoteActions", group: "vim", defaultBinding: "l", title: "Leader: note actions" },
  { id: "vim.leaderFormatNote", group: "vim", defaultBinding: "f", title: "Leader note action: format note" },
  { id: "vim.leaderCopyMarkdown", group: "vim", defaultBinding: "y", title: "Leader note action: copy note as Markdown" },
  { id: "vim.leaderToggleFavorite", group: "vim", defaultBinding: "s", title: "Leader note action: toggle favorite" },
  { id: "vim.leaderQuickCapture", group: "vim", defaultBinding: "q", title: "Leader: open quick capture" },
  { id: "vim.leaderTemplatePicker", group: "vim", defaultBinding: "t", title: "Leader: new from template" },
  { id: "vim.leaderInsertTemplate", group: "vim", defaultBinding: "i", title: "Leader: insert template into note" },
  { id: "vim.leaderDailyNote", group: "vim", defaultBinding: "d", title: "Leader: today's daily note" },
  { id: "vim.leaderWeeklyNote", group: "vim", defaultBinding: "w", title: "Leader: this week's note" },
  { id: "vim.leaderCalendar", group: "vim", defaultBinding: "c", title: "Leader: toggle calendar" },
  { id: "vim.panePrefix", group: "vim", defaultBinding: "Ctrl+W", title: "Pane command prefix" },
  { id: "vim.paneFocusLeft", group: "vim", defaultBinding: "h", title: "Pane: focus left" },
  { id: "vim.paneFocusDown", group: "vim", defaultBinding: "j", title: "Pane: focus down" },
  { id: "vim.paneFocusUp", group: "vim", defaultBinding: "k", title: "Pane: focus up" },
  { id: "vim.paneFocusRight", group: "vim", defaultBinding: "l", title: "Pane: focus right" },
  { id: "vim.paneSplitRight", group: "vim", defaultBinding: "v", title: "Pane: split right" },
  { id: "vim.paneSplitDown", group: "vim", defaultBinding: "s", title: "Pane: split down" },
  { id: "vim.historyBack", group: "vim", defaultBinding: "Ctrl+O", title: "Go back in note history" },
  { id: "vim.historyForward", group: "vim", defaultBinding: "Ctrl+I", title: "Go forward in note history" },
  { id: "vim.bufferPrevious", group: "vim", defaultBinding: "[ b", title: "Previous buffer" },
  { id: "vim.bufferNext", group: "vim", defaultBinding: "] b", title: "Next buffer" },
  { id: "vim.tabPrevious", group: "vim", defaultBinding: "g T", title: "Previous tab" },
  { id: "vim.tabNext", group: "vim", defaultBinding: "g t", title: "Next tab" },
  { id: "vim.hintMode", group: "vim", defaultBinding: "h", title: "Leader: hint mode" },
  { id: "vim.goToDefinition", group: "vim", defaultBinding: "g d", title: "Follow link at cursor" },
  { id: "vim.foldCurrent", group: "vim", defaultBinding: "z c", title: "Fold heading at cursor" },
  { id: "vim.unfoldCurrent", group: "vim", defaultBinding: "z o", title: "Unfold heading at cursor" },
  { id: "vim.foldAll", group: "vim", defaultBinding: "z M", title: "Fold all headings" },
  { id: "vim.unfoldAll", group: "vim", defaultBinding: "z R", title: "Unfold all headings" },
  { id: "nav.moveDown", group: "navigation", defaultBinding: "j", title: "Move selection down" },
  { id: "nav.moveUp", group: "navigation", defaultBinding: "k", title: "Move selection up" },
  { id: "nav.moveLeft", group: "navigation", defaultBinding: "h", title: "Move selection left" },
  { id: "nav.moveRight", group: "navigation", defaultBinding: "l", title: "Move selection right" },
  { id: "nav.jumpTop", group: "navigation", defaultBinding: "g g", title: "Jump to top" },
  { id: "nav.jumpBottom", group: "navigation", defaultBinding: "G", title: "Jump to bottom" },
  { id: "nav.halfPageDown", group: "view-actions", defaultBinding: "Ctrl+D", title: "Half-page down" },
  { id: "nav.halfPageUp", group: "view-actions", defaultBinding: "Ctrl+U", title: "Half-page up" },
  { id: "nav.openSideItem", group: "navigation", defaultBinding: "l", title: "Open sidebar or note-list item" },
  { id: "nav.openResult", group: "navigation", defaultBinding: "o", title: "Open result" },
  { id: "nav.back", group: "navigation", defaultBinding: "h", title: "Back out" },
  { id: "nav.toggleFolder", group: "navigation", defaultBinding: "o", title: "Toggle folder" },
  { id: "nav.filter", group: "navigation", defaultBinding: "/", title: "Focus filter or search" },
  { id: "nav.contextMenu", group: "view-actions", defaultBinding: "m", title: "Open context menu" },
  { id: "nav.peekPreview", group: "view-actions", defaultBinding: "p", title: "Peek preview" },
  { id: "nav.restore", group: "view-actions", defaultBinding: "r", title: "Restore trashed note" },
  { id: "nav.delete", group: "view-actions", defaultBinding: "x", title: "Delete selected result" },
  { id: "nav.toggleTask", group: "view-actions", defaultBinding: "x", title: "Toggle task" },
  { id: "tasks.moveTaskUp", group: "view-actions", defaultBinding: "K", title: "Move task up" },
  { id: "tasks.moveTaskDown", group: "view-actions", defaultBinding: "J", title: "Move task down" },
  { id: "editor.moveLineUp", group: "view-actions", defaultBinding: "Alt+ArrowUp", title: "Move line up" },
  { id: "editor.moveLineDown", group: "view-actions", defaultBinding: "Alt+ArrowDown", title: "Move line down" },
  { id: "nav.localEx", group: "view-actions", defaultBinding: ":", title: "Open local ex prompt" },
  { id: "nav.newQuickNote", group: "view-actions", defaultBinding: "n", title: "New quick note from Quick Notes view" },
  { id: "nav.unarchive", group: "view-actions", defaultBinding: "u", title: "Unarchive selected note" }
]
