export type KeymapKind = "shortcut" | "sequence";
export type KeymapScope =
  | "app"
  | "leader"
  | "pane"
  | "vim-editor"
  | "lists"
  | "views";
export type KeymapGroup = "global" | "vim" | "navigation" | "view-actions";

export type KeymapId =
  | "global.searchNotes"
  | "global.searchNotesNonVim"
  | "global.commandPalette"
  | "global.newQuickNote"
  | "global.newNoteHere"
  | "global.newNoteFromTemplate"
  | "global.insertTemplate"
  | "global.openSettings"
  | "global.openFile"
  | "global.toggleSidebar"
  | "global.toggleConnections"
  | "global.toggleOutlinePanel"
  | "global.toggleCommentsPanel"
  | "global.toggleTimelinePanel"
  | "global.addComment"
  | "global.focusPaneLeft"
  | "global.focusPaneRight"
  | "global.focusPaneUp"
  | "global.focusPaneDown"
  | "global.modeEdit"
  | "global.modeSplit"
  | "global.modePreview"
  | "global.toggleZenMode"
  | "global.closeActiveTab"
  | "global.reopenClosedTab"
  | "global.toggleWordWrap"
  | "global.exportNotePdf"
  | "global.zoomIn"
  | "global.zoomOut"
  | "global.zoomReset"
  | "global.historyBack"
  | "global.historyForward"
  | "global.toggleRecentNote"
  | "tabs.select1"
  | "tabs.select2"
  | "tabs.select3"
  | "tabs.select4"
  | "tabs.select5"
  | "tabs.select6"
  | "tabs.select7"
  | "tabs.select8"
  | "tabs.select9"
  | "tabs.next"
  | "tabs.previous"
  | "vim.leaderPrefix"
  | "vim.leaderOpenBuffers"
  | "vim.leaderWorkflows"
  | "vim.leaderCloudConflicts"
  | "vim.leaderAtlas"
  | "vim.leaderSearchNotes"
  | "vim.leaderSearchGroup"
  | "vim.leaderSearchVaultText"
  | "vim.leaderToggleSidebar"
  | "vim.leaderNoteOutline"
  | "vim.leaderSwitchVault"
  | "vim.leaderNoteActions"
  | "vim.leaderFormatNote"
  | "vim.leaderCopyMarkdown"
  | "vim.leaderToggleFavorite"
  | "vim.leaderTableToDatabase"
  | "vim.leaderNoteCover"
  | "vim.leaderNoteCoverUnsplash"
  | "vim.leaderCalloutType"
  | "vim.leaderCodeLanguage"
  | "vim.leaderQuickCapture"
  | "vim.leaderHideToTray"
  | "vim.leaderTemplatePicker"
  | "vim.leaderInsertTemplate"
  | "vim.leaderDailyNote"
  | "vim.leaderWeeklyNote"
  | "vim.leaderMonthlyNote"
  | "vim.leaderCalendar"
  | "vim.leaderTimeline"
  | "vim.leaderUnresolvedLinks"
  | "vim.leaderFolderGallery"
  | "vim.panePrefix"
  | "vim.paneFocusLeft"
  | "vim.paneFocusDown"
  | "vim.paneFocusUp"
  | "vim.paneFocusRight"
  | "vim.paneSplitRight"
  | "vim.paneSplitDown"
  | "vim.historyBack"
  | "vim.historyForward"
  | "vim.bufferPrevious"
  | "vim.bufferNext"
  | "vim.tabPrevious"
  | "vim.tabNext"
  | "vim.hintMode"
  | "vim.goToDefinition"
  | "vim.linkPopover"
  | "vim.createNoteFromLink"
  | "vim.foldCurrent"
  | "vim.unfoldCurrent"
  | "vim.foldAll"
  | "vim.unfoldAll"
  | "vim.harperNext"
  | "vim.harperPrevious"
  | "vim.harperSuggest"
  | "vim.harperAddWord"
  | "vim.harperIgnore"
  | "vim.reviewNextChange"
  | "vim.reviewPreviousChange"
  | "vim.reviewAcceptChange"
  | "vim.reviewRejectChange"
  | "nav.moveDown"
  | "nav.moveUp"
  | "nav.moveLeft"
  | "nav.moveRight"
  | "nav.jumpTop"
  | "nav.jumpBottom"
  | "nav.halfPageDown"
  | "nav.halfPageUp"
  | "nav.openSideItem"
  | "nav.openResult"
  | "nav.back"
  | "nav.toggleFolder"
  | "nav.filter"
  | "nav.contextMenu"
  | "nav.peekPreview"
  | "nav.restore"
  | "nav.delete"
  | "nav.sidebarTrash"
  | "nav.toggleTask"
  | "nav.localEx"
  | "nav.newQuickNote"
  | "nav.unarchive"
  | "tasks.moveTaskUp"
  | "tasks.moveTaskDown"
  | "tasks.savedFilters"
  | "tags.nextNote"
  | "tags.previousNote"
  | "editor.moveLineUp"
  | "editor.moveLineDown"
  | "editor.hopMarkerForward"
  | "editor.hopMarkerBackward"
  | "editor.foldHeading"
  | "editor.unfoldHeading"
  | "editor.toggleCheckbox"
  | "editor.reflowParagraph"
  | "editor.linkPopover"
  | "editor.reviewNextChange"
  | "editor.reviewPreviousChange"
  | "editor.reviewAcceptChange"
  | "editor.reviewRejectChange";

export type KeymapOverrides = Partial<Record<KeymapId, string>>;

/**
 * The stored form of "this action has no key". An override equal to the empty
 * string means the user removed the binding on purpose: nothing fires the
 * action until it is rebound or reset, the which-key hints and the manual
 * stop advertising it, and it never collides with anything. It is distinct
 * from a missing override (the default applies) and from a recording that
 * has not captured a key yet. TOML has no null, so config.toml carries it
 * as `"action.id" = ""`.
 */
export const UNBOUND_BINDING = "";

/** What the UI calls an unbound action wherever a key would otherwise show. */
export const UNBOUND_LABEL = "Unbound";

export function isUnboundBinding(
  binding: string | null | undefined,
): binding is typeof UNBOUND_BINDING {
  return binding === UNBOUND_BINDING;
}

export function isKeymapUnbound(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): boolean {
  return isUnboundBinding(overrides?.[id]);
}

export interface KeymapDefinition {
  id: KeymapId;
  kind: KeymapKind;
  scope: KeymapScope;
  group: KeymapGroup;
  title: string;
  description: string;
  defaultBinding: string;
  /** macOS-specific default. On a Mac, Option+<printable> chords are how many
   *  European layouts type everyday characters (`[` is Option+5 on German
   *  keyboards), so a binding like `Alt+[` swallows the keystroke instead of
   *  letting it type (#514). Actions whose cross-platform default is such a
   *  chord carry a Mac-safe default here; keep this in sync with the slim
   *  catalog in `@shared/keymaps-catalog`. */
  defaultBindingMac?: string;
  vimOnly?: boolean;
  nonVimOnly?: boolean;
  maxTokens?: number;
}
const KEYMAP_DEFINITIONS: KeymapDefinition[] = [
  {
    id: "global.searchNotes",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Search notes",
    description:
      "Open the vault-wide note search palette. Wins over Vim's Ctrl+P (cursor up) when Mod is Ctrl.",
    defaultBinding: "Mod+P",
  },
  {
    id: "global.searchNotesNonVim",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Search notes in non-Vim mode",
    description: "Extra direct search shortcut when Vim mode is off.",
    defaultBinding: "Mod+F",
    nonVimOnly: true,
  },
  {
    id: "global.commandPalette",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Open command palette",
    description: "Open the command palette.",
    defaultBinding: "Shift+Mod+P",
  },
  {
    id: "global.newQuickNote",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "New quick note",
    description: "Create a quick capture note and focus its title.",
    defaultBinding: "Shift+Mod+N",
  },
  {
    id: "global.newNoteHere",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "New note in current folder",
    description:
      "Create a note in the active note's folder (or the browsed folder when no note is open) and focus its title. Wins over Vim's Ctrl+N (cursor down) when Mod is Ctrl.",
    defaultBinding: "Mod+N",
  },
  // The template actions were reachable only through Vim's leader (Space t,
  // Space i) and the palette, so with Vim off no key could reach them (#847).
  // Windows and Linux ship unbound: Ctrl+Alt+T opens a terminal on most Linux
  // desktops, and Ctrl/Cmd+Alt+I is Electron's DevTools.
  {
    id: "global.newNoteFromTemplate",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "New note from template",
    description:
      "Open the template picker to create a note, as Vim's Leader t does. Unbound on Windows and Linux until you set a key.",
    defaultBinding: "",
    defaultBindingMac: "Alt+Mod+T",
  },
  {
    id: "global.insertTemplate",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Insert template into current note",
    description:
      "Render a template into the note you are editing, as Vim's Leader i does. Unbound until you set a key.",
    defaultBinding: "",
  },
  {
    id: "global.openSettings",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Open settings",
    description: "Open the Settings modal.",
    defaultBinding: "Mod+,",
  },
  {
    id: "global.openFile",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Open file",
    description:
      "Open a single markdown file from outside the vault. On macOS the File menu also binds ⌘O. In Vim mode on Windows/Linux the editor keeps Ctrl+O for the jumplist and insert-mode i_CTRL-O, so this fires when focus is outside the editor or with Vim off. Rebind either to change that.",
    defaultBinding: "Mod+O",
  },
  {
    id: "global.toggleSidebar",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle sidebar",
    description: "Hide or show the left sidebar.",
    defaultBinding: "Mod+1",
  },
  {
    id: "global.toggleConnections",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle connections panel",
    description: "Toggle the connections panel in the active pane.",
    defaultBinding: "Mod+2",
  },
  {
    id: "global.toggleOutlinePanel",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle outline panel",
    description: "Toggle the outline panel in the active pane.",
    defaultBinding: "Mod+3",
  },
  {
    id: "global.toggleCommentsPanel",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle comments panel",
    description: "Toggle the comments panel in the active pane.",
    defaultBinding: "Mod+Shift+C",
  },
  {
    id: "global.toggleTimelinePanel",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle timeline panel",
    // 7 because 1 to 6 are taken (sidebar, connections, outline, and the
    // three pane modes): the next free digit beside its neighbours. (#1007)
    description: "Toggle the Timeline panel in the active pane: open tasks in date order.",
    defaultBinding: "Mod+7",
  },
  {
    id: "global.addComment",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Add comment to selection",
    description: "Start a comment on the selected text (or current line).",
    defaultBinding: "Mod+Alt+M",
  },
  {
    id: "global.focusPaneLeft",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Focus pane left",
    description: "Move focus to the pane/panel on the left. Works without vim mode.",
    defaultBinding: "Alt+H",
  },
  {
    id: "global.focusPaneDown",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Focus pane down",
    description: "Move focus to the pane/panel below. Works without vim mode.",
    defaultBinding: "Alt+J",
  },
  {
    id: "global.focusPaneUp",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Focus pane up",
    description: "Move focus to the pane/panel above. Works without vim mode.",
    defaultBinding: "Alt+K",
  },
  {
    id: "global.focusPaneRight",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Focus pane right",
    description: "Move focus to the pane/panel on the right. Works without vim mode.",
    defaultBinding: "Alt+L",
  },
  {
    id: "global.modeEdit",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Switch to editor mode",
    description: "Show only the markdown editor for the active note.",
    defaultBinding: "Mod+4",
  },
  {
    id: "global.modeSplit",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Switch to split mode",
    description: "Show the editor and rendered preview side by side.",
    defaultBinding: "Mod+5",
  },
  {
    id: "global.modePreview",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Switch to preview mode",
    description: "Show only the rendered preview for the active note.",
    defaultBinding: "Mod+6",
  },
  {
    id: "global.toggleZenMode",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle Zen mode",
    description: "Hide or restore the app chrome.",
    defaultBinding: "Mod+.",
  },
  {
    id: "global.closeActiveTab",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Close active tab",
    description:
      "Close the current note or virtual tab. With Settings open it closes Settings, and in a floating window or the quick capture window it closes that window; while a dialog, palette or menu is open it does nothing. With Vim mode on and Mod resolving to Ctrl, Ctrl+W stays Vim's pane prefix while a tab is open; close the tab with :q or :bd, or rebind this.",
    defaultBinding: "Mod+W",
  },
  {
    id: "global.reopenClosedTab",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Reopen closed tab",
    description: "Reopen the most recently closed tab.",
    defaultBinding: "Shift+Mod+T",
  },
  {
    id: "global.toggleWordWrap",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle word wrap",
    description: "Switch between wrapped lines and horizontal scrolling.",
    defaultBinding: "Alt+Z",
  },
  {
    id: "global.exportNotePdf",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Export note as PDF",
    description: "Export the active note as a PDF file.",
    defaultBinding: "Shift+Mod+E",
  },
  {
    id: "global.zoomIn",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Zoom in",
    description: "Increase the app zoom factor.",
    defaultBinding: "Mod+=",
  },
  {
    id: "global.zoomOut",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Zoom out",
    description: "Decrease the app zoom factor.",
    defaultBinding: "Mod+-",
  },
  {
    id: "global.zoomReset",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Reset zoom",
    description: "Restore the app zoom factor to its default size.",
    defaultBinding: "Mod+0",
  },
  {
    id: "global.historyBack",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Go back in note history",
    description: "Jump to the previous note location in history. Works in any mode.",
    defaultBinding: "Alt+ArrowLeft",
  },
  {
    id: "global.historyForward",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Go forward in note history",
    description: "Jump forward in note history. Works in any mode.",
    defaultBinding: "Alt+ArrowRight",
  },
  {
    id: "global.toggleRecentNote",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Switch to previous note",
    description:
      "Switch to the most recently used note. Press again to alternate between the last two notes.",
    defaultBinding: "Mod+Tab",
    defaultBindingMac: "Ctrl+Tab",
  },
  // Direct tab selection (#497), browser-style. Alt+digit cross-platform; on
  // macOS Option+digit types characters on many layouts (the #514 trap) and
  // Cmd+1/2/4/5/6 already mean sidebar, connections, and the pane modes, so
  // the Mac default is Ctrl+digit (same escape toggleRecentNote uses for
  // Ctrl+Tab). Known limit: with multiple Spaces, macOS auto-enables Mission
  // Control's Ctrl+digit "Switch to Desktop" shortcuts and consumes the key
  // before the app sees it; the description tells those users to rebind.
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map(
    (n): KeymapDefinition => ({
      id: `tabs.select${n}` as KeymapId,
      kind: "shortcut",
      scope: "app",
      group: "global",
      title: `Go to tab ${n}`,
      description: `Jump straight to tab ${n}, counted across panes in the same order gt cycles. On macOS with multiple Spaces, Mission Control claims Ctrl+${n} for Switch to Desktop; rebind here (or free the key in System Settings) if nothing happens.`,
      defaultBinding: `Alt+${n}`,
      defaultBindingMac: `Ctrl+${n}`,
    }),
  ),
  // Step through the open tabs with or without Vim (#973), in the order gt/gT
  // and the digit shortcuts use. Ctrl+Tab stays Switch to previous note, so
  // these take the other common conventions: Ctrl+PageDown / Ctrl+PageUp
  // (browsers, VS Code), and Cmd+Option+Right / Left on macOS (Chrome, VS
  // Code), where Ctrl+PageDown needs fn.
  {
    id: "tabs.next",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Next tab",
    description:
      "Go to the next open tab, counted across panes in the same order gt cycles, wrapping from the last tab to the first. Works with Vim mode on or off.",
    defaultBinding: "Mod+PageDown",
    defaultBindingMac: "Alt+Mod+ArrowRight",
  },
  {
    id: "tabs.previous",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Previous tab",
    description:
      "Go to the previous open tab, counted across panes in the same order gT cycles, wrapping from the first tab to the last. Works with Vim mode on or off.",
    defaultBinding: "Mod+PageUp",
    defaultBindingMac: "Alt+Mod+ArrowLeft",
  },
  {
    id: "vim.leaderPrefix",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader key",
    description: "Start leader mode and leader hints.",
    defaultBinding: "Space",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderOpenBuffers",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: open buffers",
    description: "Open the buffer switcher.",
    defaultBinding: "o",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderAtlas",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: open atlas",
    description: "Open the Atlas map of the vault.",
    defaultBinding: "g",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderWorkflows",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: open workflows",
    // `w` already belongs to the weekly note, so this takes `a` for automation.
    description: "Open the Workflows canvas.",
    defaultBinding: "a",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderCloudConflicts",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: review Cloud conflicts",
    // `c` is the calendar and `s` the search group, so review takes `r`.
    description:
      "Open the Cloud sync conflict queue, or the vault settings question. Available while files or settings are waiting on a decision, and while this vault's Cloud vault is gone, when it opens Settings → Cloud.",
    defaultBinding: "r",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderSearchNotes",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: search notes",
    description: "Open note search from any panel.",
    defaultBinding: "f",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderSearchGroup",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: search…",
    description: "Open the search leader group (text search, etc.).",
    defaultBinding: "s",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderSearchVaultText",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader search: vault text",
    description: "Open fuzzy vault text search across note contents (under the search group).",
    defaultBinding: "t",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderToggleSidebar",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: toggle sidebar",
    description: "Show or hide the left sidebar.",
    defaultBinding: "e",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderNoteOutline",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: note outline",
    description: "Open the note outline palette.",
    defaultBinding: "p",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderSwitchVault",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: switch vault",
    description: "Open the command palette vault switcher.",
    defaultBinding: "v",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderNoteActions",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: note actions",
    description: "Open the note-local leader group.",
    defaultBinding: "l",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderFormatNote",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader note action: format note",
    description: "Format the active note from the editor.",
    defaultBinding: "f",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderCopyMarkdown",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader note action: copy note as Markdown",
    description: "Copy the whole note's Markdown source to the clipboard.",
    defaultBinding: "y",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderToggleFavorite",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader note action: toggle favorite",
    description: "Add or remove the active note from Favorites.",
    defaultBinding: "s",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderTableToDatabase",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader note action: convert table to database",
    // `d` for database; `t` stays free for whatever the note group needs next.
    description:
      "Turn the Markdown table under the cursor into a database and leave a link to it in the note.",
    defaultBinding: "d",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderNoteCover",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader note action: cover image",
    description:
      "Open the cover picker for the active note: add, change or remove the banner image across its top.",
    defaultBinding: "c",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderNoteCoverUnsplash",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader note action: cover from Unsplash",
    description:
      "Open the cover picker on its Unsplash tab, to search free photos for the active note's cover.",
    defaultBinding: "u",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderCalloutType",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader note action: callout type",
    // `c` is the cover; `a` for admonition, and for the alerts GitHub calls them.
    description:
      "Open the callout type menu at the cursor: pick a type to turn the paragraph or the selected lines into a callout, or to change the type of the callout the cursor is in.",
    defaultBinding: "a",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderCodeLanguage",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader note action: code block language",
    // `l` for language: the note group's own key, pressed twice.
    description:
      "Open the code block language picker for the code block the cursor is in: pick a language to write after its fence, or Text (plain) to take it away.",
    defaultBinding: "l",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderQuickCapture",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: open quick capture",
    description: "Open the floating quick capture window.",
    defaultBinding: "q",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderHideToTray",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: hide window to tray",
    // `b` for background: the window steps away and the app keeps running.
    description: "Hide this window to the tray, with Keep running in the tray on.",
    defaultBinding: "b",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderTemplatePicker",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: new from template",
    description: "Open the template picker to create a note.",
    defaultBinding: "t",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderInsertTemplate",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: insert template into note",
    description: "Render a template into the current note.",
    defaultBinding: "i",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderDailyNote",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: today's daily note",
    description: "Open or create today's daily note.",
    defaultBinding: "d",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderWeeklyNote",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: this week's note",
    description: "Open or create this week's weekly note.",
    defaultBinding: "w",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderMonthlyNote",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: this month's note",
    description: "Open or create this month's monthly note.",
    defaultBinding: "m",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderCalendar",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: toggle calendar",
    description: "Toggle the calendar panel for the active daily or weekly note.",
    defaultBinding: "c",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderTimeline",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: toggle timeline",
    // `n` for "next": what is coming up. Unbound at the leader before this.
    description:
      "Toggle the Timeline panel and move the keyboard into it: open tasks in date order, overdue and milestones marked.",
    defaultBinding: "n",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderUnresolvedLinks",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: unresolved links",
    // `u` for unresolved: every link in the vault that names a note no one wrote yet.
    description:
      "Open the Unresolved Links view: every [[wikilink]] in the vault that points at a note that does not exist yet.",
    defaultBinding: "u",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderFolderGallery",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: folder gallery",
    // `G` for Gallery: `g` was the Atlas already, and a capital is a key of
    // its own after the leader (`<leader>q` and `<leader>Q` differ).
    description:
      "Open the Gallery of the current folder: its notes as cards led by their covers. The folder under the sidebar cursor while the sidebar has focus, otherwise the open note's folder.",
    defaultBinding: "G",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.panePrefix",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane command prefix",
    description:
      "Start pane focus and split commands. One of the chords Vim mode reserves for itself from a focused editor, with Ctrl+O / Ctrl+I (jumplist) and Ctrl+D / Ctrl+U (half page).",
    defaultBinding: "Ctrl+W",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneFocusLeft",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: focus left",
    description: "Move focus to the panel or pane on the left.",
    defaultBinding: "h",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneFocusDown",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: focus down",
    description: "Move focus to the panel or pane below.",
    defaultBinding: "j",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneFocusUp",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: focus up",
    description: "Move focus to the panel or pane above.",
    defaultBinding: "k",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneFocusRight",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: focus right",
    description: "Move focus to the panel or pane on the right.",
    defaultBinding: "l",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneSplitRight",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: split right",
    description: "Clone the current tab into a pane on the right.",
    defaultBinding: "v",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneSplitDown",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: split down",
    description: "Clone the current tab into a pane below.",
    defaultBinding: "s",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.historyBack",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Go back in note history",
    description: "Jump to the previous note location in history.",
    defaultBinding: "Ctrl+O",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.historyForward",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Go forward in note history",
    description: "Jump forward in note history.",
    defaultBinding: "Ctrl+I",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.bufferPrevious",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Previous buffer",
    description: "Move to the previous open buffer, or a recent note when only one buffer is open.",
    defaultBinding: "[ b",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.bufferNext",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Next buffer",
    description: "Move to the next open buffer, or a recent note when only one buffer is open.",
    defaultBinding: "] b",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.tabPrevious",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Previous tab",
    description: "Go to the previous tab in the active pane (Vim-style gT).",
    defaultBinding: "g T",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.tabNext",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Next tab",
    description: "Go to the next tab in the active pane (Vim-style gt).",
    defaultBinding: "g t",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.hintMode",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: hint mode",
    description: "Show jump labels for clickable targets (jump to any button or link).",
    defaultBinding: "h",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.goToDefinition",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Follow link at cursor",
    description: "Open the note, URL, or asset under the cursor.",
    defaultBinding: "g d",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.createNoteFromLink",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Create note for link at cursor",
    description:
      "Follow the link under the cursor; a note that does not exist yet is created at once, without the confirmation.",
    defaultBinding: "g D",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.linkPopover",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Link popover for link at cursor",
    // Vim's own `K` looks up the word under the cursor; here the word is a
    // note, and the lookup shows it.
    description:
      "Open the link popover for the [[wikilink]] under the cursor: edit the note it names in place, or create it when it does not exist yet. Escape in normal mode closes it and returns here.",
    defaultBinding: "K",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.foldCurrent",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Fold heading or list item at cursor",
    description: "Collapse the heading section, the list item or the callout at the cursor; on a line under a list item or inside a foldable callout, fold that.",
    defaultBinding: "z c",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.unfoldCurrent",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Unfold heading or list item at cursor",
    description: "Expand the heading section or the list item folded at the cursor.",
    defaultBinding: "z o",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.foldAll",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Fold all headings and lists",
    description: "Collapse every heading section, every list item with lines under it and every foldable callout, nested.",
    defaultBinding: "z M",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.unfoldAll",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Unfold all headings and lists",
    description: "Expand every fold in the note.",
    defaultBinding: "z R",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.harperNext",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Next Harper suggestion",
    description: "Jump to the next grammar or spelling problem Harper found. Needs Grammar and spelling with Harper on.",
    defaultBinding: "] s",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.reviewNextChange",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Next change to review",
    description: "While reviewing an assistant's edits, jump to the next change. Vim's own diff-mode key.",
    defaultBinding: "] c",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.reviewPreviousChange",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Previous change to review",
    description: "While reviewing an assistant's edits, jump to the previous change.",
    defaultBinding: "[ c",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.reviewAcceptChange",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Accept change",
    description: "While reviewing an assistant's edits, keep the change at the cursor (diff put).",
    defaultBinding: "d p",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.reviewRejectChange",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Reject change",
    description: "While reviewing an assistant's edits, put back what the change replaced (diff obtain).",
    defaultBinding: "d o",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.harperPrevious",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Previous Harper suggestion",
    description: "Jump to the previous grammar or spelling problem Harper found.",
    defaultBinding: "[ s",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.harperSuggest",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Harper suggestions at cursor",
    description: "Open the list of fixes for the problem under the cursor; a digit or Enter applies one.",
    defaultBinding: "z =",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.harperAddWord",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Add word to Harper dictionary",
    description: "Teach the vault's dictionary the word under the cursor so Harper stops flagging it.",
    defaultBinding: "z g",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.harperIgnore",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Ignore Harper suggestion",
    description: "Hide this one suggestion here from now on without teaching the dictionary a word.",
    defaultBinding: "z G",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "nav.moveDown",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Move selection down",
    description: "Move the current row cursor or panel selection down.",
    defaultBinding: "j",
    maxTokens: 1,
  },
  {
    id: "nav.moveUp",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Move selection up",
    description: "Move the current row cursor or panel selection up.",
    defaultBinding: "k",
    maxTokens: 1,
  },
  {
    id: "nav.moveLeft",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Move selection left",
    description: "Move left between cells in a WYSIWYG table (and within cell text).",
    defaultBinding: "h",
    maxTokens: 1,
  },
  {
    id: "nav.moveRight",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Move selection right",
    description: "Move right between cells in a WYSIWYG table (and within cell text).",
    defaultBinding: "l",
    maxTokens: 1,
  },
  {
    id: "nav.jumpTop",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Jump to top",
    description:
      "Jump to the first visible row or to the top of preview content.",
    defaultBinding: "g g",
    maxTokens: 2,
  },
  {
    id: "nav.jumpBottom",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Jump to bottom",
    description:
      "Jump to the last visible row or to the bottom of preview content.",
    defaultBinding: "G",
    maxTokens: 1,
  },
  {
    id: "nav.halfPageDown",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Half-page down",
    description: "Scroll preview content down by half a viewport.",
    defaultBinding: "Ctrl+d",
    maxTokens: 1,
  },
  {
    id: "nav.halfPageUp",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Half-page up",
    description: "Scroll preview content up by half a viewport.",
    defaultBinding: "Ctrl+u",
    maxTokens: 1,
  },
  {
    id: "nav.openSideItem",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Open sidebar or note-list item",
    description: "Open the current sidebar or note-list selection.",
    defaultBinding: "l",
    maxTokens: 1,
  },
  {
    id: "nav.openResult",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Open result",
    description: "Open the selected note or result in a view.",
    defaultBinding: "o",
    maxTokens: 1,
  },
  {
    id: "nav.back",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Back out",
    description: "Collapse, move left, or return focus toward the editor.",
    defaultBinding: "h",
    maxTokens: 1,
  },
  {
    id: "nav.toggleFolder",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Toggle folder",
    description: "Expand or collapse the current sidebar folder.",
    defaultBinding: "o",
    maxTokens: 1,
  },
  {
    id: "nav.filter",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Focus filter or search",
    description:
      "Focus the local filter or open note search from panel navigation.",
    defaultBinding: "/",
    maxTokens: 1,
  },
  {
    id: "nav.contextMenu",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Open context menu",
    description: "Open the contextual actions menu for the current row.",
    defaultBinding: "m",
    maxTokens: 1,
  },
  {
    id: "nav.peekPreview",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Peek preview",
    description: "Open the hover preview for the selected connection.",
    defaultBinding: "p",
    maxTokens: 1,
  },
  {
    id: "nav.restore",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Restore trashed note",
    description: "Restore the selected trashed note.",
    defaultBinding: "r",
    maxTokens: 1,
  },
  {
    id: "nav.delete",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Delete selected result",
    description:
      "Permanently delete or move the selected item to trash, depending on the view. In the sidebar it moves the note under the cursor (or the selection that includes it) to the Trash, after a confirm.",
    defaultBinding: "x",
    maxTokens: 1,
  },
  {
    id: "nav.sidebarTrash",
    kind: "shortcut",
    scope: "lists",
    group: "view-actions",
    title: "Move sidebar note to Trash",
    description:
      "With the sidebar focused, move the note under its cursor to the Trash after a confirm, or every selected note when the selection includes that row. Works with Vim mode on or off.",
    defaultBinding: "Mod+Backspace",
  },
  {
    id: "nav.toggleTask",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Toggle task",
    description: "Check or uncheck the selected task.",
    defaultBinding: "x",
    maxTokens: 1,
  },
  {
    id: "tasks.moveTaskUp",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Move task up",
    description:
      "Move the selected task up within its group (Tasks list view). Works with Vim mode on or off.",
    defaultBinding: "K",
    maxTokens: 1,
  },
  {
    id: "tasks.moveTaskDown",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Move task down",
    description:
      "Move the selected task down within its group (Tasks list view). Works with Vim mode on or off.",
    defaultBinding: "J",
    maxTokens: 1,
  },
  {
    id: "tasks.savedFilters",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Pick a saved Tasks filter",
    description:
      "Open the picker of saved Tasks filters and apply one (Tasks view, Vim mode). Save the current filter with :savefilter <name>.",
    defaultBinding: "F",
    maxTokens: 1,
  },
  {
    id: "tags.nextNote",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Next note in Tags view",
    description:
      "Move past the selected note's tagged blocks to the next note in the Tags view (Vim mode).",
    defaultBinding: "}",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "tags.previousNote",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Previous note in Tags view",
    description:
      "Move to the previous note in the Tags view, or to the top of the current note's blocks (Vim mode).",
    defaultBinding: "{",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "editor.hopMarkerForward",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Hop past next marker",
    description:
      "Move the cursor to the far side of the next inline marker on the line: `**bold|**` becomes `**bold**|`, so finishing a formatted word never needs the arrow keys. Crosses `**`, `*`, `~~`, `==`, backticks, `$` and the bracket pairs, plus straight quotes wherever they auto-pair (the Auto-pair quotes setting, or inside code), so `\"quoted|\"` becomes `\"quoted\"|` too; an apostrophe inside a word is never a stop. Works with Vim mode on or off.",
    defaultBinding: "Alt+]",
    defaultBindingMac: "Ctrl+.",
  },
  {
    id: "editor.hopMarkerBackward",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Hop before previous marker",
    description:
      "Move the cursor to the near side of the previous inline marker on the line: `**bold**|` becomes `**bold|**`, and again to land before the opening `**`. Works with Vim mode on or off.",
    defaultBinding: "Alt+[",
    defaultBindingMac: "Ctrl+,",
  },
  {
    id: "editor.foldHeading",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Fold heading or list item",
    description: "Fold the heading section, the list item or the callout at the cursor; on a line under a list item or inside a foldable callout, fold that.",
    defaultBinding: "Mod+Alt+F",
  },
  {
    id: "editor.reviewNextChange",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Next change to review",
    description: "While reviewing an assistant's edits, jump to the next change.",
    defaultBinding: "Mod+Alt+ArrowDown",
  },
  {
    id: "editor.reviewPreviousChange",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Previous change to review",
    description: "While reviewing an assistant's edits, jump to the previous change.",
    defaultBinding: "Mod+Alt+ArrowUp",
  },
  {
    id: "editor.reviewAcceptChange",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Accept change",
    description: "While reviewing an assistant's edits, keep the change at the cursor.",
    defaultBinding: "Mod+Shift+Enter",
  },
  {
    id: "editor.reviewRejectChange",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Reject change",
    description: "While reviewing an assistant's edits, put back what the change at the cursor replaced.",
    defaultBinding: "Mod+Shift+Backspace",
  },
  {
    id: "editor.unfoldHeading",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Unfold heading or list item",
    description: "Unfold the heading section or the list item folded at the cursor.",
    defaultBinding: "Mod+Alt+U",
  },
  {
    id: "editor.moveLineUp",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Move line up",
    description:
      "Move the current line (or selected lines) up in the note editor. It reorders the markdown, so it sticks in the file. Works with Vim mode on or off.",
    defaultBinding: "Alt+ArrowUp",
  },
  {
    id: "editor.moveLineDown",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Move line down",
    description:
      "Move the current line (or selected lines) down in the note editor. It reorders the markdown, so it sticks in the file. Works with Vim mode on or off.",
    defaultBinding: "Alt+ArrowDown",
  },
  {
    id: "editor.toggleCheckbox",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Toggle checkbox",
    description:
      "Turn the current line (or selected lines) into a checkbox, and toggle it between unchecked and checked on repeat. Plain text becomes `- [ ]`, keeping any list marker or blockquote prefix. Works with Vim mode on or off.",
    defaultBinding: "Mod+L",
  },
  {
    id: "editor.reflowParagraph",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Reflow paragraph",
    description:
      "Join the hard-wrapped lines of the paragraph under the cursor (or of every paragraph in the selection) into one line, so the editor wraps it to the pane the way the preview does. Headings, list markers, tables, code, and explicit line breaks are left alone. Works with Vim mode on or off; Vim mode also has it as the `gq` operator (`gqip`, `gqj`, `gw` to keep the cursor).",
    defaultBinding: "Alt+Q",
    defaultBindingMac: "Ctrl+Q",
  },
  {
    id: "editor.linkPopover",
    kind: "shortcut",
    scope: "vim-editor",
    group: "view-actions",
    title: "Open link popover",
    description:
      "Open the link popover for the [[wikilink]] under the cursor and move into it: edit the note it names in place, or create it when it does not exist yet. Escape closes it and returns to the note you were in. Works with Vim mode on or off; Vim mode also has it as `K`.",
    defaultBinding: "Shift+Mod+K",
  },
  {
    id: "nav.localEx",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Open local ex prompt",
    description: "Open the view-specific ex prompt in Tasks or Tags.",
    defaultBinding: ":",
    maxTokens: 1,
  },
  {
    id: "nav.newQuickNote",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "New quick note from Quick Notes view",
    description: "Create a new quick note from the Quick Notes list tab.",
    defaultBinding: "n",
    maxTokens: 1,
  },
  {
    id: "nav.unarchive",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Unarchive selected note",
    description: "Move the selected archived note back to Inbox.",
    defaultBinding: "u",
    maxTokens: 1,
  },
];

for (const definition of KEYMAP_DEFINITIONS) {
  const normalized =
    definition.kind === "shortcut"
      ? normalizeShortcutBinding(definition.defaultBinding)
      : normalizeSequenceBinding(definition.defaultBinding);
  if (normalized) definition.defaultBinding = normalized;
}

const KEYMAP_INDEX = new Map<KeymapId, KeymapDefinition>(
  KEYMAP_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

/** The nine direct tab-selection shortcuts (#497), index = position in the
 *  array + 1. Kept as a list so dispatchers can loop instead of hand-writing
 *  nine matches. */
export const TAB_SELECT_KEYMAP_IDS: readonly KeymapId[] = [
  "tabs.select1",
  "tabs.select2",
  "tabs.select3",
  "tabs.select4",
  "tabs.select5",
  "tabs.select6",
  "tabs.select7",
  "tabs.select8",
  "tabs.select9",
];

const KEYMAP_GROUP_LABELS: Record<KeymapGroup, string> = {
  global: "Global shortcuts",
  vim: "Vim-specific shortcuts",
  navigation: "Navigation",
  "view-actions": "View-specific actions",
};

export function getKeymapDefinitions(): KeymapDefinition[] {
  return KEYMAP_DEFINITIONS.slice();
}

export function getKeymapDefinition(id: KeymapId): KeymapDefinition {
  const definition = KEYMAP_INDEX.get(id);
  if (!definition) throw new Error(`Unknown keymap id: ${id}`);
  return definition;
}

export function getKeymapGroupLabel(group: KeymapGroup): string {
  return KEYMAP_GROUP_LABELS[group];
}

export function getDefaultKeymapBinding(id: KeymapId): string {
  const def = getKeymapDefinition(id);
  return isMacPlatform() && def.defaultBindingMac
    ? def.defaultBindingMac
    : def.defaultBinding;
}

export function getKeymapBinding(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): string {
  const override = overrides?.[id];
  // A string override wins even when it is empty: that is an unbound action,
  // not a missing override, and must not fall back to the default.
  return typeof override === "string" ? override : getDefaultKeymapBinding(id);
}

export function getSequenceTokens(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): string[] {
  return getKeymapBinding(overrides, id)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => resolveSequenceToken(token));
}

type RuntimeZenApi = { platformSync?: () => NodeJS.Platform };

function getRuntimePlatform(): NodeJS.Platform | null {
  if (typeof window !== "undefined") {
    const zen = (window as Window & { zen?: RuntimeZenApi }).zen;
    if (typeof zen?.platformSync === "function") {
      return zen.platformSync();
    }
  }
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform as NodeJS.Platform;
  }
  return null;
}

export function isMacPlatform(): boolean {
  const runtimePlatform = getRuntimePlatform();
  if (runtimePlatform) return runtimePlatform === "darwin";
  if (typeof navigator === "undefined") return true;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

export function isLinuxPlatform(): boolean {
  const runtimePlatform = getRuntimePlatform();
  if (runtimePlatform) return runtimePlatform === "linux";
  if (typeof navigator === "undefined") return false;
  // Android's user agent also says "Linux"; the X11/Wayland desktops this
  // distinguishes are the ones that say "Linux" without saying "Android".
  return (
    /Linux|X11/i.test(navigator.platform) && !/Android/i.test(navigator.userAgent)
  );
}

function isModifierKey(key: string): boolean {
  return (
    key === "Shift" || key === "Control" || key === "Alt" || key === "Meta"
  );
}

function physicalKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  switch (code) {
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    case "NumpadAdd":
      return "+";
    case "NumpadSubtract":
      return "-";
    case "NumpadMultiply":
      return "*";
    case "NumpadDivide":
      return "/";
    case "NumpadDecimal":
      return ".";
    default:
      return null;
  }
}

/**
 * Resolve the binding key from a KeyboardEvent.
 *
 * Layout-aware: when `event.key` is a single printable ASCII char it
 * reflects what the active keyboard layout *typed* (Colemak/Dvorak
 * users want `Cmd+P` to fire on whichever physical key produces `p`,
 * not on the QWERTY-P position). Letters are uppercased so binding
 * comparison is case-insensitive (Shift state is encoded separately).
 *
 * Falls back to `event.code` (physical position) when `event.key` is
 * unusable. On macOS, Alt-bearing combos like Option+J or Hyper
 * (=⌃⌥⇧⌘)+J produce transformed glyphs (`ˆ`, `Ô`, …) outside ASCII;
 * the fallback keeps Hyper+J recording as `J` so those bindings
 * round-trip cleanly.
 *
 * Returns `null` for modifier-only events, dead-key composition
 * (`event.key === 'Dead'`/`'Process'`), and special keys (Space, Tab,
 * Enter, F1–F24, arrows) — the caller resolves those via
 * `normalizeKeyName(event.key)`.
 */
function resolveKeyFromEvent(event: KeyboardEvent): string | null {
  if (isModifierKey(event.key)) return null;
  const k = event.key;
  // Skip the typed-char fast path for '+': it is the binding-string
  // separator, so emitting it would produce unparsable strings like
  // "Mod+Shift++". Fall through to physicalKeyFromCode (event.code
  // = "Equal" -> "=" for Shift+Cmd+=).
  if (k.length === 1 && k !== "+") {
    const cp = k.charCodeAt(0);
    if (cp > 0x20 && cp < 0x7f) {
      return k.toUpperCase();
    }
  }
  return physicalKeyFromCode(event.code);
}

function normalizeKeyName(key: string): string | null {
  if (!key) return null;
  if (isModifierKey(key)) return null;
  if (key === " ") return "Space";
  if (/^esc(?:ape)?$/i.test(key)) return "Escape";
  if (/^(return|enter)$/i.test(key)) return "Enter";
  if (/^tab$/i.test(key)) return "Tab";
  if (/^arrowup$/i.test(key)) return "ArrowUp";
  if (/^arrowdown$/i.test(key)) return "ArrowDown";
  if (/^arrowleft$/i.test(key)) return "ArrowLeft";
  if (/^arrowright$/i.test(key)) return "ArrowRight";
  if (key.length === 1) {
    if (/[A-Za-z]/.test(key)) return key.toUpperCase();
    return key;
  }
  return key;
}

function normalizeSequenceBaseToken(key: string): string | null {
  if (!key) return null;
  if (isModifierKey(key)) return null;
  if (key === " ") return "Space";
  if (/^esc(?:ape)?$/i.test(key)) return "Esc";
  if (/^(return|enter)$/i.test(key)) return "Enter";
  if (/^tab$/i.test(key)) return "Tab";
  if (/^arrowup$/i.test(key)) return "ArrowUp";
  if (/^arrowdown$/i.test(key)) return "ArrowDown";
  if (/^arrowleft$/i.test(key)) return "ArrowLeft";
  if (/^arrowright$/i.test(key)) return "ArrowRight";
  if (key.length === 1) return key;
  return key;
}

function normalizeModifierToken(
  modifier: string,
): "Ctrl" | "Alt" | "Shift" | "Meta" | "Mod" | null {
  if (/^(cmd|command|meta)$/i.test(modifier)) return "Meta";
  if (/^(ctrl|control)$/i.test(modifier)) return "Ctrl";
  if (/^(alt|option|opt)$/i.test(modifier)) return "Alt";
  if (/^shift$/i.test(modifier)) return "Shift";
  if (/^mod$/i.test(modifier)) return "Mod";
  return null;
}

function normalizeModifiers(parts: string[]): string[] {
  const order = ["Ctrl", "Alt", "Shift", "Mod", "Meta"];
  const unique = [...new Set(parts)];
  return unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export function normalizeShortcutBinding(input: string): string | null {
  const mac = isMacPlatform();
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const rawKey = parts.pop();
  if (!rawKey) return null;
  const key = normalizeKeyName(rawKey);
  if (!key) return null;
  const modifiers = normalizeModifiers(parts.flatMap((part) => {
    const normalized = normalizeModifierToken(part);
    if (!normalized) return [];
    // Canonicalize the platform-primary modifier to `Mod` so stored
    // shortcut bindings remain portable across the renderer and the
    // key recorder. Keep the non-primary modifier explicit.
    if (normalized === "Meta") return [mac ? "Mod" : "Meta"];
    if (normalized === "Ctrl") return [mac ? "Ctrl" : "Mod"];
    return [normalized];
  }));
  return [...modifiers, key].join("+");
}

export function normalizeSequenceToken(input: string): string | null {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const rawKey = parts.pop();
  if (!rawKey) return null;
  let base = normalizeSequenceBaseToken(rawKey);
  if (!base) return null;
  // `Mod` stays `Mod`: it is the portable spelling of "Cmd on macOS, Ctrl
  // elsewhere", so a config.toml that says `"nav.delete" = "Mod+Backspace"`
  // means the same chord on every machine it syncs to. It used to be dropped
  // here, which stored that binding as a bare Backspace (#972); keydowns never
  // spell `Mod`, so matching resolves it per platform (resolveSequenceToken).
  const modifiers = normalizeModifiers(
    parts
      .map((part) => normalizeModifierToken(part))
      .filter((part): part is NonNullable<typeof part> => !!part),
  );
  // When a non-Shift modifier (Ctrl/Alt/Meta/Mod) is combined with a single
  // ASCII letter, canonicalize to uppercase. Event-produced tokens come
  // out lowercase (e.g. Ctrl+w → `'w'` since Shift isn't held), but the
  // convention in default bindings and user-written keymaps is uppercase
  // (`'Ctrl+W'`). Matching them requires a consistent canonical form.
  if (
    base.length === 1 &&
    /[a-zA-Z]/.test(base) &&
    modifiers.some(
      (m) => m === "Ctrl" || m === "Alt" || m === "Meta" || m === "Mod",
    )
  ) {
    base = base.toUpperCase();
  }
  return modifiers.length > 0 ? `${modifiers.join("+")}+${base}` : base;
}

/**
 * A stored sequence token as a keydown on this platform reads: `Mod` becomes
 * `Meta` (Cmd) on macOS and `Ctrl` elsewhere, the way the shortcut format
 * reads it. `sequenceTokenFromEvent` never produces `Mod`, so every place that
 * compares a binding's token with an event's goes through this first
 * (getSequenceTokens and advanceSequence do it for their callers).
 */
export function resolveSequenceToken(token: string, mac?: boolean): string {
  const parts = token.split("+");
  if (parts.length < 2) return token;
  const base = parts.pop() as string;
  if (!parts.includes("Mod")) return token;
  mac ??= isMacPlatform();
  const modifiers = normalizeModifiers(
    parts.map((part) => (part === "Mod" ? (mac ? "Meta" : "Ctrl") : part)),
  );
  return `${modifiers.join("+")}+${base}`;
}

export function normalizeSequenceBinding(input: string): string | null {
  const tokens = input
    .split(/\s+/)
    .map((token) => normalizeSequenceToken(token))
    .filter((token): token is string => !!token);
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

export function normalizeKeymapBinding(
  id: KeymapId,
  input: string,
): string | null {
  const definition = getKeymapDefinition(id);
  const normalized =
    definition.kind === "shortcut"
      ? normalizeShortcutBinding(input)
      : normalizeSequenceBinding(input);
  if (!normalized) return null;
  if (definition.kind === "sequence" && definition.maxTokens) {
    const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
    if (tokenCount > definition.maxTokens) {
      return normalized
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, definition.maxTokens)
        .join(" ");
    }
  }
  return normalized;
}

/**
 * Global shortcuts share one always-active namespace, so two actions bound to
 * the same combination silently shadow each other (#298). Return the OTHER
 * global-shortcut definition that `binding` would collide with under the given
 * overrides, or null when there's no conflict.
 *
 * Only `app`-scope shortcuts are checked: the sequence-based groups (vim / nav /
 * view) reuse keys by design — disambiguated at runtime by the focused surface
 * (e.g. `x` deletes in Trash but toggles a task in Tasks) — so a shared key
 * there is not a conflict and the shipped defaults must not be flagged.
 */
export function findKeymapConflict(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
  binding: string,
): KeymapDefinition | null {
  const definition = getKeymapDefinition(id);
  if (definition.scope !== "app") return null;
  const normalized = normalizeKeymapBinding(id, binding);
  if (!normalized) return null;
  for (const other of KEYMAP_DEFINITIONS) {
    if (other.id === id || other.scope !== "app") continue;
    if (getKeymapBinding(overrides, other.id) === normalized) return other;
  }
  return null;
}

export function normalizeKeymapOverrides(input: unknown): KeymapOverrides {
  if (!input || typeof input !== "object") return {};
  const overrides: KeymapOverrides = {};
  for (const definition of KEYMAP_DEFINITIONS) {
    const raw = (input as Record<string, unknown>)[definition.id];
    if (typeof raw !== "string") continue;
    // An empty (or blank) value is a deliberate unbind and survives as such;
    // it is not a broken binding to be dropped in favor of the default.
    if (raw.trim() === UNBOUND_BINDING) {
      overrides[definition.id] = UNBOUND_BINDING;
      continue;
    }
    const normalized = normalizeKeymapBinding(definition.id, raw);
    // The platform's default, not the cross-platform one: a definition with a
    // `defaultBindingMac` has two defaults, and comparing against the wrong one
    // on macOS threw away a deliberate rebind back to the Mac default (it read
    // as "same as default, drop it") while keeping the Mac default itself as a
    // stored override on Windows/Linux.
    if (normalized && normalized !== getDefaultKeymapBinding(definition.id)) {
      overrides[definition.id] = normalized;
    }
  }
  return overrides;
}

function shortcutModifiersFromEvent(event: KeyboardEvent): string[] {
  const mac = isMacPlatform();
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push(mac ? "Ctrl" : "Mod");
  if (event.metaKey) modifiers.push(mac ? "Mod" : "Meta");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return modifiers;
}

export function shortcutBindingFromEvent(event: KeyboardEvent): string | null {
  // Alt+numpad digits are the Windows Alt-code input method (hold Alt, type
  // 0233 on the numpad for an accented character). Numpad digits resolve to
  // the bare digit, so with Alt+1..9 shipped as tab defaults (#497) every
  // Alt-code keystroke would switch tabs mid-entry: on Windows those chords
  // belong to the OS and never resolve to a binding.
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    /^Numpad\d$/.test(event.code) &&
    !isMacPlatform() &&
    !isLinuxPlatform()
  ) {
    return null;
  }
  const resolved = resolveKeyFromEvent(event);
  const key = resolved ?? normalizeKeyName(event.key);
  if (!key) return null;
  return normalizeShortcutBinding(
    [...shortcutModifiersFromEvent(event), key].join("+"),
  );
}

export function sequenceTokenFromEvent(event: KeyboardEvent): string | null {
  const resolved = resolveKeyFromEvent(event);
  // Sequence tokens are case-sensitive for letters (`<leader>q` vs
  // `<leader>Q` are different bindings). resolveKeyFromEvent returns
  // uppercase letters — fold them down so unmodified letters still
  // produce lowercase tokens, then promote to upper if Shift is held.
  let base: string | null
  if (resolved && /^[A-Z]$/.test(resolved)) {
    base = event.shiftKey ? resolved : resolved.toLowerCase()
  } else if (resolved) {
    base = resolved
  } else {
    base = normalizeSequenceBaseToken(event.key);
  }
  if (!base) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.metaKey) modifiers.push("Meta");
  if (event.shiftKey && base.length !== 1) modifiers.push("Shift");
  return normalizeSequenceToken(
    modifiers.length > 0 ? `${modifiers.join("+")}+${base}` : base,
  );
}

export function matchesShortcutBinding(
  event: KeyboardEvent,
  binding: string,
): boolean {
  if (isUnboundBinding(binding)) return false;
  const normalized = shortcutBindingFromEvent(event);
  if (!!normalized && normalized === binding) return true;
  // Layouts with shifted digits (French AZERTY, Czech) type punctuation on
  // the digit row, so a digit binding like the Alt+1..9 tab defaults (#497)
  // would never fire by typed character (Alt+1 arrives as "Alt+&"). Fall
  // back to the physical digit-row position, the same shield class the Mac
  // Option+printable defaults needed (#514). Numpad digits stay out of this
  // fallback on purpose: see the Alt-code guard in shortcutBindingFromEvent.
  const digit = /^Digit(\d)$/.exec(event.code)?.[1];
  if (!digit) return false;
  const physical = normalizeShortcutBinding(
    [...shortcutModifiersFromEvent(event), digit].join("+"),
  );
  return !!physical && physical !== normalized && physical === binding;
}

export function matchesShortcut(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): boolean {
  return matchesShortcutBinding(event, getKeymapBinding(overrides, id));
}

/**
 * True when the event lands on a combination the user has explicitly rebound
 * to some other action. The #497 tab shortcuts shipped nine new defaults into
 * the middle of an ordered dispatch chain, so without this check a
 * pre-existing override on e.g. Alt+3 (checked later in the chain) would
 * silently lose to the new default. An explicit rebind outranks a shipped
 * default; callers skip their default binding when this returns true.
 */
export function eventMatchesUserOverride(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  excludeId: KeymapId,
): boolean {
  if (!overrides) return false;
  for (const [id, binding] of Object.entries(overrides)) {
    if (id === excludeId || typeof binding !== "string") continue;
    if (isUnboundBinding(binding)) continue;
    const definition = KEYMAP_INDEX.get(id as KeymapId);
    if (!definition || definition.kind !== "shortcut") continue;
    if (definition.scope !== "app") continue;
    if (matchesShortcutBinding(event, binding)) return true;
  }
  return false;
}

/**
 * The app-wide shortcut (an `app`-scope action: the global and tab
 * shortcuts) this keydown is, under these overrides, or null. Surfaces that
 * let a chord through to one of their own actions step aside for these, so
 * a global shortcut keeps its key everywhere.
 */
export function appShortcutForEvent(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
): KeymapDefinition | null {
  for (const definition of KEYMAP_DEFINITIONS) {
    if (definition.scope !== "app" || definition.kind !== "shortcut") continue;
    if (matchesShortcut(event, overrides, definition.id)) return definition;
  }
  return null;
}

/** Ctrl, Alt or Cmd/Meta is down: a chord, not a typed key. Shift alone
 *  types a capital, so it does not count. */
export function isChordEvent(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey">,
): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

export function matchesSequenceToken(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): boolean {
  const tokens = getSequenceTokens(overrides, id);
  if (tokens.length !== 1) return false;
  const token = sequenceTokenFromEvent(event);
  return !!token && token === tokens[0];
}

export function formatKeyToken(token: string, mac = isMacPlatform()): string {
  if (token.includes("+")) {
    const parts = token.split("+");
    const base = parts.pop() ?? token;
    const prefix = parts
      .map((part) => formatKeyToken(part, mac))
      .join(mac ? "" : "+");
    return `${prefix}${mac ? "" : prefix ? "+" : ""}${formatKeyToken(base, mac)}`;
  }
  if (token === "Mod") return mac ? "⌘" : "Ctrl";
  if (token === "Meta") return mac ? "⌘" : "Meta";
  if (token === "Ctrl") return mac ? "⌃" : "Ctrl";
  if (token === "Alt") return mac ? "⌥" : "Alt";
  if (token === "Shift") return mac ? "⇧" : "Shift";
  if (token === "Escape" || token === "Esc") return "Esc";
  if (token === "Enter") return mac ? "↵" : "Enter";
  if (token === "Tab") return "Tab";
  if (token === "Space") return "Space";
  if (token === "ArrowUp") return "↑";
  if (token === "ArrowDown") return "↓";
  if (token === "ArrowLeft") return "←";
  if (token === "ArrowRight") return "→";
  return token;
}

export function formatKeymapBinding(binding: string, kind: KeymapKind): string {
  if (kind === "shortcut") {
    return formatKeyToken(binding);
  }
  return binding
    .split(/\s+/)
    .map((token) => formatKeyToken(token))
    .join(" ");
}

/** The binding as the UI shows it, or the empty string for an unbound
 *  action so a caller can leave the key column, chip or tooltip out
 *  entirely. Surfaces that want a word instead use `UNBOUND_LABEL`. */
export function getKeymapDisplay(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): string {
  const definition = getKeymapDefinition(id);
  return formatKeymapBinding(getKeymapBinding(overrides, id), definition.kind);
}

/** A leader chord as the palette shows it ("Space r"), or the empty string
 *  when either step is unbound: half a sequence cannot be pressed, so no
 *  surface names it. */
export function getLeaderChordDisplay(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): string {
  const leader = getKeymapDisplay(overrides, "vim.leaderPrefix");
  const step = getKeymapDisplay(overrides, id);
  return leader && step ? `${leader} ${step}` : "";
}

/** `label (display)` while the action has a key, the bare label once it is
 *  unbound: a tooltip must not read "Go back ()". */
export function labelWithShortcut(label: string, display: string): string {
  return display ? `${label} (${display})` : label;
}

export function describeCurrentBinding(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): string {
  return getKeymapDisplay(overrides, id);
}

/**
 * Whether a shortcut belongs to a feature this host has. Agent edit review
 * needs `supportsAgentEditReview` and Harper needs `supportsHarper`; where
 * they are absent (the web client, the phones and iPads) the shortcuts can
 * never fire, so Settings → Keymap leaves them out instead of offering keys
 * for a review or a grammar check that does not exist there.
 */
export function keymapAvailableOnHost(
  id: KeymapId,
  capabilities: { supportsAgentEditReview?: boolean; supportsHarper?: boolean },
): boolean {
  if (id.startsWith("editor.review") || id.startsWith("vim.review")) {
    return capabilities.supportsAgentEditReview === true;
  }
  if (id.startsWith("vim.harper")) return capabilities.supportsHarper === true;
  return true;
}

export function getKeymapDefinitionsByGroup(): Array<{
  group: KeymapGroup;
  label: string;
  items: KeymapDefinition[];
}> {
  const groups: KeymapGroup[] = ["global", "vim", "navigation", "view-actions"];
  return groups.map((group) => ({
    group,
    label: getKeymapGroupLabel(group),
    items: KEYMAP_DEFINITIONS.filter(
      (definition) => definition.group === group,
    ),
  }));
}

export function advanceSequence(
  event: KeyboardEvent,
  binding: string,
  pendingRef: { current: number },
  timerRef: { current?: ReturnType<typeof setTimeout> },
  onMatch: () => void,
  consume: () => void,
  timeoutMs = 500,
): boolean {
  const tokens = binding
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => resolveSequenceToken(token));
  if (tokens.length === 0) return false;
  const token = sequenceTokenFromEvent(event);
  if (!token) return false;

  const reset = (): void => {
    pendingRef.current = 0;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };

  if (pendingRef.current > 0) {
    if (token === tokens[pendingRef.current]) {
      consume();
      pendingRef.current += 1;
      if (pendingRef.current >= tokens.length) {
        reset();
        onMatch();
      } else {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(reset, timeoutMs);
      }
      return true;
    }
    reset();
  }

  if (token !== tokens[0]) return false;
  consume();
  if (tokens.length === 1) {
    onMatch();
    return true;
  }
  pendingRef.current = 1;
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(reset, timeoutMs);
  return true;
}
