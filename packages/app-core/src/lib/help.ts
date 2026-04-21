export interface HelpCard {
  title: string
  body: string
}

export interface HelpShortcut {
  keys: string
  action: string
  detail: string
}

export interface HelpShortcutSection {
  id: string
  title: string
  description: string
  items: HelpShortcut[]
}

export interface HelpExCommand {
  command: string
  summary: string
  detail: string
}

export interface HelpSettingsSection {
  title: string
  items: Array<{ label: string; detail: string }>
}

export const HELP_QUICK_START: HelpCard[] = [
  {
    title: 'Pick a vault you control',
    body:
      'A vault is just a folder of markdown files. ZenNotes reads and writes that folder directly, so your notes stay portable, syncable, and readable outside the app too.'
  },
  {
    title: 'Learn the three working zones',
    body:
      'The sidebar is your navigator, the note list shows the current folder or special list view, and the main pane is where tabs, splits, preview, and writing happen.'
  },
  {
    title: 'Start in Inbox, use Quick Notes for capture',
    body:
      'Inbox is for active notes. Quick Notes are for fast capture. Archive is for notes you want to keep without keeping them in the way, and Trash is recoverable deletion rather than immediate loss.'
  },
  {
    title: 'Use the keyboard from the start',
    body:
      'Search notes, search vault text, switch panes, open context menus, and run commands without leaving the keyboard. If Vim mode is on, leader flows and ex commands become part of the normal editing loop instead of an extra mode to learn later.'
  },
  {
    title: 'Insert structure while you type',
    body:
      'Type `/` to insert headings, lists, callouts, code blocks, tables, links, images, and other markdown structures. Type `@` to insert date shortcuts like Today and Tomorrow as ISO dates.'
  },
  {
    title: 'Switch between write and read modes',
    body:
      'Use Edit when you want raw markdown control, Split when you want source and rendered output together, and Preview when you want a clean reading surface with keyboard navigation.'
  },
  {
    title: 'Find things in the right place',
    body:
      'Use note search when you know the note title or path, vault text search when you know a phrase inside the note, and the command palette when you know the action you want but not where it lives.'
  },
  {
    title: 'Keep supporting material nearby',
    body:
      'Tabs, splits, floating windows, the reference pane, and the connections panel are all there to help you keep related material visible while you write instead of forcing constant back-and-forth navigation.'
  },
  {
    title: 'Pick up where you left off',
    body:
      'ZenNotes restores open tabs, splits, built-in views, and sidebar layout per vault. It also remembers the main window bounds, so reopening the app feels like returning to a workspace rather than starting over.'
  }
]

export const HELP_HOW_TO_GUIDES: HelpCard[] = [
  {
    title: 'Capture a quick note',
    body:
      'Use the Quick Note shortcut or the command palette entry to create a fast capture note. If date-titled Quick Notes are enabled, ZenNotes names it from today’s date automatically; otherwise it creates a normal quick note and focuses the title so you can keep moving.'
  },
  {
    title: 'Create a note in the folder you are already in',
    body:
      'When you are browsing a folder, use the current-folder note command instead of creating in Inbox and moving later. That keeps new notes close to the project or area you were already working in.'
  },
  {
    title: 'Move a note without dragging',
    body:
      'Use the note context menu, search for `move` or `mv` in the command palette, or run `:move` or `:mv`. With no argument, ZenNotes opens a folder picker; with a target like `archive/Reference` or `inbox/Work`, it moves the note directly.'
  },
  {
    title: 'Read a note beside its source',
    body:
      'Switch the active pane to Split mode when you want markdown on one side and rendered output on the other. Use Preview when you only want the rendered view, or keep Edit when you want the least visual noise while writing.'
  },
  {
    title: 'Search the right thing',
    body:
      'Use note search for titles and paths, note outline for headings inside the current note, and vault text search for matching lines across the vault. Those three tools solve different problems, and using the right one makes the app feel much faster.'
  },
  {
    title: 'Keep supporting notes visible',
    body:
      'Open a note in a floating window when you want it in a separate OS window, or pin a note or PDF as a reference when you want it attached to the current writing context inside ZenNotes.'
  },
  {
    title: 'Check for updates and install them',
    body:
      'Use Check for Updates from the app menu, the command palette, or Settings → About. When a release is available, ZenNotes can download it in the background and then prompt you to install and relaunch.'
  }
]

export const HELP_CORE_CONCEPTS: HelpCard[] = [
  {
    title: 'Notes are real markdown files',
    body:
      'ZenNotes edits markdown on disk. Rename, move, archive, restore, and floating-window operations all work on the underlying files, not an internal copy.'
  },
  {
    title: 'System folders are workflow buckets',
    body:
      'Inbox, Quick Notes, Archive, and Trash are built-in top-level buckets with specific jobs. You can rename how they appear in the UI without renaming the actual folders on disk, which keeps your workflow flexible without breaking the file layout.'
  },
  {
    title: 'Tabs and splits are first-class',
    body:
      'Each editor pane can hold multiple tabs. Split the current tab right or down, move between panes with pane motions, switch the active note between Edit, Split, and Preview from commands, and, if you hide tabs, use the buffer switcher shortcut or `:buffers`. The active tab also has a full keyboard context menu, so actions like Close Others, Close Tabs to the Right, Pin Tab, Pin as Reference, Open in Floating Window, and Reveal in Finder stay accessible without the mouse. If you disable Vim mode, use the command palette instead.'
  },
  {
    title: 'Context menus are part of the keyboard model',
    body:
      'ZenNotes treats context menus as keyboard-reachable UI, not mouse-only escape hatches. Use the configured context-menu binding on the selected sidebar or note-list row, or use `Shift+F10` / the system Context Menu key to open the active tab menu from the editor or preview side. The command palette also exposes the same high-value tab actions directly.'
  },
  {
    title: 'Sessions restore on relaunch',
    body:
      'Workspace restore is saved per vault, while the window frame restore is global. Reopening ZenNotes brings back your pane layout, open buffers, built-in views, and the last window bounds instead of dropping you into a fresh shell.'
  },
  {
    title: 'Leader mode can teach itself',
    body:
      'If Leader key hints are enabled, pressing the configured Leader key opens a which-key style panel that shows the next available leader actions, including note-local commands like format note and longer sequences like vault text search. Settings let you choose between a timed hint or a sticky leader overlay that stays open until you dismiss it. If you disable Vim mode, the leader system is turned off with it.'
  },
  {
    title: 'Tasks, tags, archive, and trash are vault-wide views',
    body:
      'Tasks scans every note for checkboxes, Tags lets you browse notes matching any selected tag, Archive gives you a dedicated list of cold-storage notes, and Trash gives you a recovery surface for deleted notes without turning the left rail into a second browser.'
  },
  {
    title: 'Moving notes is path-first',
    body:
      'Use the note context menu, search `move` or `mv` in the command palette, or run `:move` / `:mv` from the ex line to move the active note into Inbox or Archive. With no argument, the command opens the folder picker; with a target like `:mv archive/Reference` or `:move inbox/Work`, it moves the note directly. The move prompt autocompletes folder paths, so you can type and Tab through existing destinations instead of dragging.'
  },
  {
    title: 'Command palette mirrors the important tab actions',
    body:
      'You do not need to remember where a tab action lives. The command palette exposes direct entries for closing the current tab, closing sibling tabs, closing tabs to the right, pinning or unpinning the tab, opening the active tab menu, splitting the current tab, pinning the active note as a reference, opening the note in a floating window, and revealing it in Finder.'
  },
  {
    title: 'Slash commands speed up writing',
    body:
      'When you type `/` at the start of a line or after whitespace, ZenNotes opens an inline insert menu for common markdown structures such as headings, bulleted or numbered lists, to-do items, callouts, code blocks, dividers, tables, math blocks, links, images, and even creating a new note page.'
  },
  {
    title: '@ shortcuts insert relative dates',
    body:
      'Typing `@` in normal text opens date suggestions for Today, Yesterday, and Tomorrow. Choosing one inserts an ISO date like `2026-04-15`, which keeps notes file-friendly, searchable, and easy to sort.'
  },
  {
    title: 'Reference and connections support research-heavy work',
    body:
      'Pin a companion note or PDF in the reference pane, then toggle the connections panel to inspect backlinks and unresolved links while you draft.'
  },
  {
    title: 'Zen mode removes chrome',
    body:
      'Use the configured Zen shortcut to strip away the title bar, sidebar, note list, tabs, pane headers, side panels, and status bar so only the active editor, preview, or split view stays visible.'
  },
  {
    title: 'Links are actionable',
    body:
      'Use [[wikilinks]] or markdown links. In normal mode, the follow-link motion opens the link under the cursor, offers to create missing notes, and pins PDFs into the reference pane.'
  },
  {
    title: 'Files stay local',
    body:
      'Drop files into a note to insert local files. By default, ZenNotes keeps them as ordinary files in the vault root, can reveal the vault from the app, and treats PDFs specially in preview and reference workflows.'
  },
  {
    title: 'Math, diagrams, and plots render from plain fences',
    body:
      'Inline `$…$` and display `$$…$$` math render via KaTeX. Beyond math, four fenced block languages turn into live diagrams in preview and split mode: `mermaid` for flow, sequence, state, gantt, and graph diagrams; `tikz` for LaTeX-native coordinate systems, commutative diagrams, and figure-quality plots (the TeX engine runs on-device so no network is required); `jsxgraph` for interactive geometry and function plots driven by a small JSON config; and `function-plot` for compact Cartesian function plotting. Each block is ordinary markdown on disk, so the source remains portable and diffable.'
  },
  {
    title: 'Footer actions expose utility views',
    body:
      'The sidebar footer gives you direct access to Files, Help, and Settings, so utility screens stay discoverable even when you are new to the app.'
  },
  {
    title: 'Destructive actions ask first',
    body:
      'Moving a note to Trash now asks for confirmation before anything is deleted from the active workspace, and the Trash view separates restore from permanent delete.'
  },
  {
    title: 'Updates are release-driven',
    body:
      'In-app updates read the published GitHub release feed. That means update checks, download prompts, and release notes are all driven by the same public releases you can open manually from the app menu or command palette.'
  }
]

export const HELP_SHORTCUT_SECTIONS: HelpShortcutSection[] = [
  {
    id: 'global-shortcuts',
    title: 'Global shortcuts',
    description: 'These work across the main app shell.',
    items: [
      { keys: 'Mod+P', action: 'Search notes', detail: 'Open the note search palette.' },
      { keys: 'Mod+F', action: 'Search notes (non-Vim mode)', detail: 'Open the note search palette directly when Vim mode is off.' },
      { keys: 'Shift+Mod+P', action: 'Open commands', detail: 'Open the command palette.' },
      { keys: 'Shift+Mod+N', action: 'New Quick Note', detail: 'Create a quick capture note and focus its title.' },
      { keys: 'Mod+,', action: 'Open Settings', detail: 'Open settings for appearance, editor behavior, fonts, vault controls, and app details.' },
      { keys: 'Mod+1', action: 'Toggle sidebar', detail: 'Hide or show the left sidebar.' },
      { keys: 'Mod+2', action: 'Toggle connections', detail: 'Toggle the connections panel for the active editor pane.' },
      { keys: 'Mod+.', action: 'Toggle Zen mode', detail: 'Hide or restore the app chrome so only the active editor, preview, or split view stays on screen.' },
      { keys: 'Mod+W', action: 'Close active tab', detail: 'Close the current note or virtual tab.' },
      { keys: 'Mod+=', action: 'Zoom in', detail: 'Scale the whole app up, including chrome, editor, and preview.' },
      { keys: 'Mod+-', action: 'Zoom out', detail: 'Scale the whole app down when the UI feels too large.' },
      { keys: 'Mod+0', action: 'Reset zoom', detail: 'Return the app to its default scale.' },
      { keys: 'Alt+Z', action: 'Toggle word wrap', detail: 'Switch between wrapped lines and horizontal scrolling.' },
      { keys: 'Esc', action: 'Dismiss overlay', detail: 'Close note search or the command palette when they are open.' }
    ]
  },
  {
    id: 'panel-motion',
    title: 'Pane and panel motion',
    description: 'These are the primary keyboard-first movement patterns. The Vim-style ones assume Vim mode is on.',
    items: [
      { keys: 'Ctrl-w h / j / k / l', action: 'Move focus', detail: 'Move between sidebar, note list, the active pane’s tab strip, editor, connections, or adjacent editor panes. From tabs, use h / l to switch tabs and j to return to the editor.' },
      { keys: 'Ctrl-w v', action: 'Split right', detail: 'Clone the current tab into a pane to the right.' },
      { keys: 'Ctrl-w s', action: 'Split down', detail: 'Clone the current tab into a pane below.' },
      { keys: 'Space o', action: 'Open buffers', detail: 'Show a searchable list of every open buffer across every pane.' },
      { keys: 'Space f', action: 'Search notes', detail: 'Open the vault-wide note search palette.' },
      { keys: 'Space s t', action: 'Search vault text', detail: 'Fuzzy-search matching text lines across notes in Inbox, Quick Notes, and Archive.' },
      { keys: 'Space e', action: 'Toggle left sidebar', detail: 'Show or hide the folder/tag sidebar without touching the mouse.' },
      { keys: 'Space p', action: 'Note outline', detail: 'Jump to any heading in the active note via a searchable overlay.' },
      { keys: 'Space, then pause', action: 'Show leader hints', detail: 'If enabled in Settings, open a which-key style guide for the next available leader actions. Sticky mode keeps it open until `Space` or `Esc`.' },
      { keys: 'Mod+3', action: 'Toggle outline panel', detail: 'Show or hide the persistent outline in the active pane.' },
      { keys: 'zc / zo', action: 'Fold / unfold heading', detail: 'Collapse or expand the section below the heading at the cursor.' },
      { keys: 'zM / zR', action: 'Fold / unfold all', detail: 'Collapse or expand every heading section in the note.' },
      { keys: 'Ctrl-o', action: 'Go back', detail: 'Jump to the previous note location in history.' },
      { keys: 'Ctrl-i', action: 'Go forward', detail: 'Jump forward in note history.' },
      { keys: 'f', action: 'Hint mode', detail: 'Show jump labels for clickable targets when you are not in insert mode.' }
    ]
  },
  {
    id: 'lists-and-sidebar',
    title: 'Sidebar and list navigation',
    description: 'These bindings work when the sidebar or note list owns focus in Vim mode.',
    items: [
      { keys: 'j / k', action: 'Move selection', detail: 'Move down or up one visible item.' },
      { keys: 'g g / G', action: 'Jump to top or bottom', detail: 'Fast travel to the first or last visible row.' },
      { keys: 'Enter / l', action: 'Open item', detail: 'Open the selected note, folder, tag, or built-in row.' },
      { keys: 'h', action: 'Collapse or move left', detail: 'Collapse the current folder or move focus back toward the editor.' },
      { keys: 'o', action: 'Toggle folder', detail: 'Expand or collapse the selected folder in the sidebar.' },
      { keys: '/', action: 'Search notes', detail: 'Open note search directly from keyboard navigation mode.' },
      { keys: 'm', action: 'Open context menu', detail: 'Open the right-click menu for the selected sidebar or note-list row, including move, archive, trash, floating-window, and reveal actions where they apply.' },
      { keys: 'Esc', action: 'Return to editor', detail: 'Drop back into the main editor focus path.' }
    ]
  },
  {
    id: 'editor-writing-aids',
    title: 'Editor writing aids',
    description: 'Inline completions that appear while you type in the markdown editor.',
    items: [
      {
        keys: '/',
        action: 'Open slash commands',
        detail:
          'At the start of a line or after whitespace, show an insert menu for headings, lists, to-dos, callouts, code blocks, dividers, tables, math blocks, links, images, and creating a new page.'
      },
      {
        keys: 'Type after /',
        action: 'Filter the insert menu',
        detail:
          'Keep typing to narrow the slash command list by name, then confirm the highlighted item to insert its markdown structure.'
      },
      {
        keys: '@',
        action: 'Open date shortcuts',
        detail:
          'Show inline suggestions for Today, Yesterday, and Tomorrow while writing so you can insert dates without leaving the keyboard.'
      },
      {
        keys: 'Type after @',
        action: 'Filter date suggestions',
        detail:
          'Match by words like today or tomorrow, or by date fragments such as weekday, month, day number, or the ISO date before confirming the result.'
      }
    ]
  },
  {
    id: 'preview-and-connections',
    title: 'Preview and connections',
    description: 'These keys apply when reading preview content or the connections panel.',
    items: [
      { keys: 'j / k', action: 'Scroll preview', detail: 'Move through rendered preview content line-by-line.' },
      { keys: 'Ctrl-d / Ctrl-u', action: 'Half-page scroll', detail: 'Move preview content by half a viewport.' },
      { keys: 'g g / G', action: 'Jump to top or bottom', detail: 'Go to the start or end of the preview or connections list.' },
      { keys: 'm / Shift+F10', action: 'Open active tab menu', detail: 'Open the right-click menu for the active tab while you are reading preview content. This exposes Close, Close Others, Close Tabs to the Right, Pin Tab, Split Right, Split Down, Pin as Reference, Open in Floating Window, and Reveal in Finder.' },
      { keys: '/', action: 'Search notes', detail: 'Open note search without leaving keyboard navigation.' },
      { keys: 'p', action: 'Peek backlink', detail: 'In the connections panel, open the hover preview for the selected note.' },
      { keys: 'h / Esc', action: 'Back out', detail: 'Return from hover preview to connections, or from connections to the editor.' }
    ]
  },
  {
    id: 'tasks-tags-trash',
    title: 'Tasks, tags, and trash views',
    description: 'These virtual views each run their own keyboard loop in the main pane.',
    items: [
      { keys: 'j / k', action: 'Move row cursor', detail: 'Step through task rows, tagged notes, or trashed notes.' },
      { keys: 'g g / G', action: 'Jump to top or bottom', detail: 'Move to the first or last visible result.' },
      { keys: 'Enter / o', action: 'Open current result', detail: 'Open the selected task source note, tagged note, or trashed note.' },
      { keys: 'Space / x', action: 'Toggle task', detail: 'Tasks view only: check or uncheck the selected task.' },
      { keys: 'r', action: 'Restore trashed note', detail: 'Trash view only: restore the selected trashed note.' },
      { keys: 'x / d', action: 'Delete forever', detail: 'Trash view only: permanently delete the selected trashed note after confirmation.' },
      { keys: '/', action: 'Filter the view', detail: 'Focus the local filter box for tasks, tag matches, or trashed notes.' },
      { keys: ':', action: 'Open local ex prompt', detail: 'Run the view-specific command line inside Tasks or Tags.' },
      { keys: 'Esc', action: 'Close or clear', detail: 'Clear the filter first, then close the active virtual view on a second press.' }
    ]
  }
]

export const HELP_VIM_COMMANDS: HelpExCommand[] = [
  {
    command: ':w',
    summary: 'Save the active note',
    detail: 'Flush the current buffer to disk immediately.'
  },
  {
    command: ':q',
    summary: 'Close the current tab or virtual view',
    detail: 'Closes the active note or the current virtual tab, including Tasks, Tags, Help, and Trash.'
  },
  {
    command: ':wq',
    summary: 'Save and close',
    detail: 'Writes the current note, then closes it. On virtual views like Tasks, Tags, Help, or Trash it just closes.'
  },
  {
    command: ':format',
    summary: 'Format markdown',
    detail: 'Runs markdown formatting on the active note.'
  },
  {
    command: ':tasks',
    summary: 'Open Tasks',
    detail: 'Open the vault-wide Tasks virtual tab.'
  },
  {
    command: ':tag foo bar',
    summary: 'Open Tags with a selection',
    detail: 'Open the Tags view and replace the selected tag set with the given tags.'
  },
  {
    command: ':trash',
    summary: 'Open Trash',
    detail: 'Open the built-in Trash recovery view in the active pane.'
  },
  {
    command: ':split / :vsplit',
    summary: 'Split the current tab',
    detail: 'Clone the active tab down or right.'
  },
  {
    command: ':edit path / :e path',
    summary: 'Open or create by vault path',
    detail: 'Open a note by explicit vault-relative path, creating it if needed.'
  },
  {
    command: ':new [path]',
    summary: 'Create a new note',
    detail: 'Without a path it creates a new inbox note; with a path it opens or creates exactly there.'
  },
  {
    command: ':move [folder] / :mv [folder]',
    summary: 'Move the active note',
    detail: 'Both names are supported explicitly. Without an argument they open the move prompt; with a path like `archive/Reference` or `inbox/Work` they move the active note there directly.'
  },
  {
    command: ':bn / :bp',
    summary: 'Cycle tabs',
    detail: 'Move to the next or previous tab, or the next most-recent note when only one tab is open.'
  },
  {
    command: ':buffers / :ls',
    summary: 'Open the buffer switcher',
    detail: 'List the current pane’s open buffers in a searchable overlay.'
  },
  {
    command: ':bd / :bc',
    summary: 'Close the active tab',
    detail: 'Buffer-delete aliases for the current note or virtual tab.'
  },
  {
    command: ':only',
    summary: 'Close sibling tabs in this pane',
    detail: 'Keep only the active tab in the current pane.'
  },
  {
    command: ':qa / :quitall / :xa / :wa',
    summary: 'Close every tab everywhere',
    detail: 'Closes all tabs across all panes. The write aliases act the same way here.'
  },
  {
    command: ':help / :h',
    summary: 'Open this manual',
    detail: 'Bring up the built-in Help tab.'
  },
  {
    command: ':demo_generate / :demo_remove',
    summary: 'Seed or remove the demo tour',
    detail: 'Install the built-in onboarding notes into the current vault under `inbox/demo`, or remove that seeded tour later without touching the rest of the vault.'
  },
  {
    command: ':cmd query / :commands',
    summary: 'Run or browse palette commands',
    detail: 'Fuzzy-run the best matching command, or open the full command palette.'
  },
  {
    command: ':tab_menu / :tab_close_others / :tab_close_right',
    summary: 'Run tab-menu actions from the ex line',
    detail: 'Every command-palette tab action is also registered on the `:` line. Use these aliases to open the active tab menu itself, close sibling tabs in the current pane, or close tabs to the right without touching the tab strip.'
  },
  {
    command: 'gd',
    summary: 'Follow the link under the cursor',
    detail: 'Open wikilinks, open external links, create missing notes, or pin PDFs into the reference pane.'
  },
  {
    command: '<Tab> / <Shift-Tab> on the ex line',
    summary: 'Complete ex commands',
    detail: 'Cycle through every registered ex command with a wildmenu popup, and complete supported command arguments like `:view edit|split|preview` and `:zen toggle|on|off`.'
  },
  {
    command: '<Space> l f',
    summary: 'Leader-format in normal mode',
    detail: 'A quick keyboard path to format the active note from the editor.'
  },
  {
    command: '<Space> (pause)',
    summary: 'Show leader hints',
    detail: 'When Leader key hints are enabled, pressing the configured Leader key shows a which-key style overlay for the next available leader actions. Settings let you choose a timed timeout or a sticky mode that stays open until you dismiss it. Turning Vim mode off disables the leader system too.'
  },
  {
    command: '<Space> o',
    summary: 'Leader buffer switcher',
    detail: 'Open the searchable list of every open buffer across every pane. Works from any non-text panel.'
  },
  {
    command: '<Space> f',
    summary: 'Leader note search',
    detail: 'Open the vault-wide note search palette from any panel.'
  },
  {
    command: '<Space> e',
    summary: 'Leader toggle sidebar',
    detail: 'Show or hide the left sidebar from any panel.'
  },
  {
    command: '<Space> p',
    summary: 'Leader note outline',
    detail: 'Open a searchable list of every heading in the active note; Enter jumps the editor to that line.'
  },
  {
    command: ':outline',
    summary: 'Note outline palette',
    detail: 'The ex-line path to the same searchable note outline opened by the Leader outline binding.'
  },
  {
    command: ':view edit|split|preview',
    summary: 'Switch the active note layout',
    detail: 'Change the current pane between editor-only, side-by-side split, and preview-only modes without clicking the toolbar.'
  },
  {
    command: ':zen [toggle|on|off] / :zenmode',
    summary: 'Toggle Zen mode',
    detail: 'Enter or leave Zen mode from the ex line. `:zen` by itself toggles; `:zen on` and `:zen off` force a specific state.'
  },
  {
    command: ':editmode / :splitmode / :previewmode',
    summary: 'Direct mode aliases',
    detail: 'Single-command aliases for switching the active note to Edit, Split, or Preview mode.'
  },
  {
    command: ':fold / :unfold',
    summary: 'Toggle the heading at the cursor',
    detail: 'Collapse or expand the section beneath the heading at the current line. This is the ex-line path to the editor fold and unfold motions.'
  },
  {
    command: ':foldall / :unfoldall',
    summary: 'Fold every heading',
    detail: 'Collapse or expand every heading section at once. This is the ex-line path to the editor-wide fold motions.'
  }
]

export const HELP_SETTINGS: HelpSettingsSection[] = [
  {
    title: 'Appearance',
    items: [
      { label: 'Theme, mode, and variant', detail: 'Pick a theme family, light or dark mode, and the active flavor or contrast where the theme supports it.' },
      { label: 'Dark sidebar', detail: 'Tint the sidebar slightly darker than the canvas so the chrome reads as a distinct surface.' }
    ]
  },
  {
    title: 'Editor behavior',
    items: [
      { label: 'Vim mode', detail: 'Turn CodeMirror Vim bindings on or off for the editor and reference pane.' },
      { label: 'Leader key hints', detail: 'Show a which-key style guide after pressing the configured Leader key so available leader actions stay visible while you decide. This setting is only available when Vim mode is enabled.' },
      { label: 'Leader hint behavior', detail: 'Choose whether leader hints auto-hide after a timeout or stay open until you dismiss them with the Leader key or Esc. These controls only appear when Vim mode is enabled.' },
      { label: 'Leader hint duration', detail: 'When behavior is Timed, control how long the which-key overlay stays visible and how long the pending leader sequence remains active after pressing the Leader key. This setting is only available in Vim mode.' },
      { label: 'Vault text search backend and binary paths', detail: 'Choose Auto, the built-in searcher, ripgrep, or fzf for vault-wide text search. Auto prefers system tools when they are installed and falls back cleanly when they are not, you can provide explicit binary paths for ripgrep or fzf if they are not on your PATH, and Settings now shows the resolved runtime backend that will actually be used.' },
      { label: 'Live preview', detail: 'Hide markdown syntax on lines you are not actively editing.' },
      { label: 'Note tabs', detail: 'Enable or disable tab-based editing and split-friendly note workflows.' },
      { label: 'Word wrap', detail: 'Wrap long lines to the editor width or let them scroll horizontally.' },
      { label: 'PDFs in edit mode', detail: 'Choose between compact PDF cards or full inline PDF embeds while writing.' },
      { label: 'Date-titled Quick Notes', detail: 'Name quick notes by date instead of timestamp-based titles.' }
    ]
  },
  {
    title: 'Typography and layout',
    items: [
      { label: 'Interface, text, and monospace fonts', detail: 'Choose different fonts for chrome, reading text, and code blocks.' },
      { label: 'Font size and line height', detail: 'Tune reading density in the editor and preview.' },
      { label: 'Reading width and editor width', detail: 'Cap long lines so wide windows stay readable.' },
      { label: 'Content alignment', detail: 'Center note content in its column or left-align it to the pane edge.' },
      { label: 'Line numbers', detail: 'Switch between off, absolute, and relative gutter numbering.' }
    ]
  },
  {
    title: 'Keymaps',
    items: [
      { label: 'Shortcut overrides', detail: 'Remap global app shortcuts, Vim-specific bindings, panel navigation keys, and view actions from one place.' },
      { label: 'Recorded sequences', detail: 'Capture single shortcuts or multi-step sequences such as Leader flows, pane prefixes, `g g`, `g d`, or fold motions without editing raw config files.' },
      { label: 'Context-menu bindings', detail: 'The same keymap table controls the context-menu action used in the sidebar, note list, and preview-side active-tab menu, so mouse-free navigation stays configurable.' },
      { label: 'Reset controls', detail: 'Clear an individual override or reset the entire keymap table back to the shipped defaults.' }
    ]
  },
  {
    title: 'Vault',
    items: [
      { label: 'Vault location', detail: 'Reveal or change the root folder ZenNotes treats as the active vault.' },
      { label: 'System folder labels', detail: 'Rename how Inbox, Quick Notes, Archive, and Trash appear in the UI without renaming the real folders on disk.' }
    ]
  },
  {
    title: 'About',
    items: [
      { label: 'App identity', detail: 'See the ZenNotes app icon, current version, and a short description of the app as a keyboard-first markdown workflow with Vim motions and plain local files.' },
      { label: 'Updates and releases', detail: 'Check for updates, download a newer build, install and relaunch, or jump straight to the latest GitHub release from inside the app.' },
      { label: 'Website, community, and issue links', detail: 'The app now exposes direct links to the ZenNotes website, Discord, GitHub repository, and issue tracker so support paths stay discoverable.' },
      { label: 'Lumary Labs', detail: 'The About section links to Lumary Labs at lumarylabs.com so company details stay easy to find from inside the app.' }
    ]
  }
]
