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
    title: 'Choose a vault',
    body:
      'A vault is just a folder of markdown files. ZenNotes reads it directly, keeps everything file-based, and never hides your notes behind a database.'
  },
  {
    title: 'Use the three working zones',
    body:
      'The sidebar is your navigator, the note list is your current folder or attachments view, and the editor pane is where tabs, splits, preview, and focused writing happen.'
  },
  {
    title: 'Capture, organize, archive',
    body:
      'Quick Notes are for fast capture, Inbox is active work, Archive is cold storage, and Trash is recoverable deletion. Inbox and Archive support nested folders, while Trash opens as a dedicated main-pane recovery view so the sidebar stays singular.'
  },
  {
    title: 'Stay keyboard-first',
    body:
      'Search notes with Cmd+P, open the command palette with Shift+Cmd+P, and use Vim mode for ex commands, pane motion, hint mode, leader hints, and link-following.'
  },
  {
    title: 'Use the built-in manual',
    body:
      'Open Help from the sidebar footer or with `:help` to browse shortcuts, commands, panel behavior, Vim flows, and settings in one place.'
  },
  {
    title: 'Pick up where you left off',
    body:
      'ZenNotes restores the last open tabs, splits, and built-in views for each vault, so closing and reopening the app brings you back to the same workspace.'
  }
]

export const HELP_CORE_CONCEPTS: HelpCard[] = [
  {
    title: 'Notes are real markdown files',
    body:
      'ZenNotes edits markdown on disk. Rename, move, archive, restore, and floating-window operations all work on the underlying files, not an internal copy.'
  },
  {
    title: 'Tabs and splits are first-class',
    body:
      'Each editor pane can hold multiple tabs. Split the current tab right or down, move between panes with Ctrl-w motions, switch the active note between Edit, Split, and Preview from commands, and, if you hide tabs, use the buffer switcher with `Space o` or `:buffers`.'
  },
  {
    title: 'Leader mode can teach itself',
    body:
      'If Leader key hints are enabled, pressing `Space` opens a which-key style panel that shows the next available leader actions, including note-local commands like `Space l f`. Settings let you choose between a timed hint or a sticky leader overlay that stays open until you press `Space` again or `Esc`.'
  },
  {
    title: 'Tasks, tags, and trash are vault-wide views',
    body:
      'Tasks scans every note for checkboxes, Tags lets you browse notes matching any selected tag, and Trash gives you a dedicated recovery surface for deleted notes without turning the left rail into a second browser.'
  },
  {
    title: 'Moving notes is path-first',
    body:
      'Use the note context menu or the command palette to move a note into Inbox or Archive. The move prompt autocompletes folder paths, so you can type and Tab through existing destinations instead of dragging.'
  },
  {
    title: 'Reference and connections support research-heavy work',
    body:
      'Pin a companion note or PDF in the reference pane, then toggle the connections panel to inspect backlinks and unresolved links while you draft.'
  },
  {
    title: 'Links are actionable',
    body:
      'Use [[wikilinks]] or markdown links. In normal mode, `gd` follows the link under the cursor, offers to create missing notes, and pins PDFs into the reference pane.'
  },
  {
    title: 'Attachments stay local',
    body:
      'Drop files into a note to insert local assets. ZenNotes tracks the attachments folder, can reveal it from the app, and treats PDFs specially in preview and reference workflows.'
  },
  {
    title: 'Footer actions expose utility views',
    body:
      'The sidebar footer gives you direct access to Attachments, Help, and Preferences, so utility screens stay discoverable even when you are new to the app.'
  },
  {
    title: 'Destructive actions ask first',
    body:
      'Moving a note to Trash now asks for confirmation before anything is deleted from the active workspace, and the Trash view separates restore from permanent delete.'
  }
]

export const HELP_SHORTCUT_SECTIONS: HelpShortcutSection[] = [
  {
    id: 'global-shortcuts',
    title: 'Global shortcuts',
    description: 'These work across the main app shell.',
    items: [
      { keys: '⌘P', action: 'Search notes', detail: 'Open the note search palette.' },
      { keys: '⇧⌘P', action: 'Open commands', detail: 'Open the command palette.' },
      { keys: '⇧⌘N', action: 'New Quick Note', detail: 'Create a quick capture note and focus its title.' },
      { keys: '⌘,', action: 'Open Settings', detail: 'Open preferences for appearance, editor, fonts, and vault settings.' },
      { keys: '⌘1', action: 'Toggle sidebar', detail: 'Hide or show the left sidebar.' },
      { keys: '⌘2', action: 'Toggle connections', detail: 'Toggle the connections panel for the active editor pane.' },
      { keys: '⌘.', action: 'Toggle focus mode', detail: 'Hide or restore the app chrome for distraction-free writing.' },
      { keys: '⌘W', action: 'Close active tab', detail: 'Close the current note or virtual tab.' },
      { keys: '⌥Z', action: 'Toggle word wrap', detail: 'Switch between wrapped lines and horizontal scrolling.' },
      { keys: 'Esc', action: 'Dismiss overlay', detail: 'Close note search or the command palette when they are open.' }
    ]
  },
  {
    id: 'panel-motion',
    title: 'Pane and panel motion',
    description: 'These are the main keyboard-first movement patterns outside typing.',
    items: [
      { keys: 'Ctrl-w h / j / k / l', action: 'Move focus', detail: 'Move between sidebar, note list, editor, connections, or adjacent editor panes.' },
      { keys: 'Ctrl-w v', action: 'Split right', detail: 'Clone the current tab into a pane to the right.' },
      { keys: 'Ctrl-w s', action: 'Split down', detail: 'Clone the current tab into a pane below.' },
      { keys: 'Space o', action: 'Open buffers', detail: 'Show a searchable list of every open buffer across every pane.' },
      { keys: 'Space f', action: 'Search notes', detail: 'Open the vault-wide note search palette.' },
      { keys: 'Space e', action: 'Toggle left sidebar', detail: 'Show or hide the folder/tag sidebar without touching the mouse.' },
      { keys: 'Space p', action: 'Note outline', detail: 'Jump to any heading in the active note via a searchable overlay.' },
      { keys: 'Space, then pause', action: 'Show leader hints', detail: 'If enabled in Settings, open a which-key style guide for the next available leader actions. Sticky mode keeps it open until `Space` or `Esc`.' },
      { keys: '⌘3', action: 'Toggle outline panel', detail: 'Show or hide the persistent outline in the active pane.' },
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
    description: 'These bindings work when the sidebar or note list owns focus.',
    items: [
      { keys: 'j / k', action: 'Move selection', detail: 'Move down or up one visible item.' },
      { keys: 'g g / G', action: 'Jump to top or bottom', detail: 'Fast travel to the first or last visible row.' },
      { keys: 'Enter / l', action: 'Open item', detail: 'Open the selected note, folder, tag, or built-in row.' },
      { keys: 'h', action: 'Collapse or move left', detail: 'Collapse the current folder or move focus back toward the editor.' },
      { keys: 'o', action: 'Toggle folder', detail: 'Expand or collapse the selected folder in the sidebar.' },
      { keys: '/', action: 'Search notes', detail: 'Open note search directly from keyboard navigation mode.' },
      { keys: 'm', action: 'Open context menu', detail: 'Open the right-click menu for the selected sidebar row.' },
      { keys: 'Esc', action: 'Return to editor', detail: 'Drop back into the main editor focus path.' }
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
    detail: 'Closes the active note, Tasks tab, or Tags tab.'
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
    command: ':cmd query / :commands',
    summary: 'Run or browse palette commands',
    detail: 'Fuzzy-run the best matching command, or open the full command palette.'
  },
  {
    command: 'gd',
    summary: 'Follow the link under the cursor',
    detail: 'Open wikilinks, open external links, create missing notes, or pin PDFs into the reference pane.'
  },
  {
    command: '<Tab> / <Shift-Tab> on the ex line',
    summary: 'Complete ex commands',
    detail: 'Cycle through every registered ex command with a wildmenu popup, and complete supported command arguments like `:view edit|split|preview`.'
  },
  {
    command: '<Space> l f',
    summary: 'Leader-format in normal mode',
    detail: 'A quick keyboard path to format the active note from the editor.'
  },
  {
    command: '<Space> (pause)',
    summary: 'Show leader hints',
    detail: 'When Leader key hints are enabled, pressing Space shows a which-key style overlay for the next available leader actions. Settings let you choose a timed timeout or a sticky mode that stays open until Space or Esc.'
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
    detail: 'Same as <Space> p — ex-line access to the note outline.'
  },
  {
    command: ':view edit|split|preview',
    summary: 'Switch the active note layout',
    detail: 'Change the current pane between editor-only, side-by-side split, and preview-only modes without clicking the toolbar.'
  },
  {
    command: ':editmode / :splitmode / :previewmode',
    summary: 'Direct mode aliases',
    detail: 'Single-command aliases for switching the active note to Edit, Split, or Preview mode.'
  },
  {
    command: ':fold / :unfold',
    summary: 'Toggle the heading at the cursor',
    detail: 'Collapse or expand the section beneath the heading at the current line. Same as vim `zc` / `zo`.'
  },
  {
    command: ':foldall / :unfoldall',
    summary: 'Fold every heading',
    detail: 'Collapse or expand every heading section at once. Same as vim `zM` / `zR`.'
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
      { label: 'Leader key hints', detail: 'Show a which-key style guide after pressing Space so available leader actions stay visible while you decide.' },
      { label: 'Leader hint behavior', detail: 'Choose whether leader hints auto-hide after a timeout or stay open until you dismiss them with Space or Esc.' },
      { label: 'Leader hint duration', detail: 'When behavior is Timed, control how long the which-key overlay stays visible and how long the pending leader sequence remains active after pressing Space.' },
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
    title: 'Vault',
    items: [
      { label: 'Vault location', detail: 'Reveal or change the root folder ZenNotes treats as the active vault.' }
    ]
  }
]
