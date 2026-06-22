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
      'Inbox is for active notes. Quick Notes are for fast capture. Archive is for notes you want to keep without keeping them in the way, and Trash is recoverable deletion rather than immediate loss. If you prefer an Obsidian-style vault, Settings can make the vault root your primary notes area instead of requiring an inbox folder.'
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
    title: 'Format a selection',
    body:
      'Select text to pop up a formatting toolbar — bold, italic, strikethrough, highlight, code, math, link, comment, and a “Turn into” menu that re-types the block (Text, Heading 1–3, lists, quote, code). The same actions have keyboard shortcuts that work on every platform, in or out of Vim mode: Mod+B bold, Mod+I italic, Mod+E code, Mod+K link, Shift+Mod+S strikethrough, Shift+Mod+H highlight, Shift+Mod+M math (Mod is ⌘ on macOS, Ctrl on Windows/Linux). Press Mod+/ to focus the toolbar and walk it with the arrow keys; Enter applies, Esc returns to the text.'
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
    title: 'Use files without leaving ZenNotes',
    body:
      'Images, SVGs, PDFs, audio, video, and other local files can appear in the vault tree and open in ZenNotes tabs or reference panes. The files stay ordinary vault files, but opening them does not have to bounce you out to another app.'
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
    title: 'Capture from anywhere with the floating window',
    body:
      'Press the quick capture hotkey — CommandOrControl+Shift+Space by default, configurable under Settings → Editor — to drop a small always-on-top window over whatever app you are using. You type in one place: the first line becomes the note title and the rest is the body. Mod+Enter saves the note into Quick Notes and hides the window; Mod+N saves and immediately opens a fresh blank capture so you can jot several in a row; Mod+P loads an existing note to edit instead. Editing the first line of a Quick note renames that note in place rather than creating a duplicate, and you can drag the window by its top bar to reposition it.'
  },
  {
    title: 'Create a note in the folder you are already in',
    body:
      'When you are browsing a folder, use the current-folder note command instead of creating in Inbox and moving later. That keeps new notes close to the project or area you were already working in.'
  },
  {
    title: 'Start a note from a template',
    body:
      'Open the template picker with `Space t`, the `:template` (or `:tmpl`) ex command, or the “New Note from Template…” command palette entry. Pick a built-in template — engineering ones like ADR, RFC/Design Doc, Bug Report, Postmortem, Meeting Notes, and 1:1, or personal ones like Daily Note, Weekly Review, Reading Notes, Journal, Project Kickoff, and To-do — or one of your own. ZenNotes then asks which folder to create it in (defaulting to the folder you are viewing) and fills in variables like the date and week before placing your cursor where the template marks it. To create straight into a specific folder, right-click that folder in the sidebar and choose “New from template”.'
  },
  {
    title: 'Make and edit your own templates',
    body:
      'Open Settings → Templates. Press “New template” to author one: a template is just markdown with optional YAML frontmatter (`name`, `description`, `category`, `titleTemplate`, `targetFolder`, `targetSubpath`) and a body. Use the variables `{{title}}`, `{{date}}`, `{{date:YYYY-MM-DD}}` (any moment-style format), `{{time}}`, `{{week}}`, and `{{cursor}}` (where the caret lands). Custom templates are saved as plain `.md` files under `.zennotes/templates/`. You can also fork a built-in by pressing Edit on it — that creates an editable copy that shadows the original, and Reset restores the built-in. From any note, the “Save Current Note as Template…” command captures it as a new template.'
  },
  {
    title: 'Turn a CSV into a database',
    body:
      'Run “New Database” from the command palette (or right-click a folder in the sidebar → New database) to create one, or just open an existing `.csv` file from the vault. ZenNotes stores the data as `<Name>.csv` plus a small `<Name>.csv.base.json` sidecar that holds field types, select options, and your saved views. Edit cells inline in the Table view, group records in a Board by any select field, switch the raw-CSV toggle to see the underlying file, and press `o` on a row to open it as a full Markdown page whose frontmatter mirrors the row’s properties. The whole grid is keyboard-driven — see the Database grid shortcuts.'
  },
  {
    title: 'Move a note without dragging',
    body:
      'Use the note context menu, search for `move` or `mv` in the command palette, or run `:move` or `:mv`. With no argument, ZenNotes opens a folder picker; with a target like `archive/Reference` or `inbox/Work`, it moves the note directly.'
  },
  {
    title: 'Act on multiple sidebar items',
    body:
      'Use Cmd-click on macOS or Ctrl-click on Windows/Linux to toggle notes and folders in the sidebar. Use Shift-click to select a visible range. The context menu then applies to the selected set, including open in tabs, move, archive, trash, restore, delete folders, copy paths, and drag/drop moves where those actions make sense.'
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
    title: 'Search from Raycast on macOS',
    body:
      'Install the `zen` CLI from Settings → CLI, then use the Raycast Extension section on the same page to install ZenNotes for Raycast locally. Raycast can search notes, filter by folder or tag, open a note in the app, open it in a floating window, archive or unarchive, move to Trash, reveal in Finder, copy the note path, and copy a wikilink.'
  },
  {
    title: 'Check for updates and install them',
    body:
      'Use Check for Updates from the app menu, the command palette, or Settings → About. When a release is available, ZenNotes can download it in the background and then prompt you to install and relaunch.'
  },
  {
    title: 'Run the self-hosted web version with Docker',
    body:
      'Prefer ZenNotes in a browser instead of the desktop app? Pull the prebuilt, multi-arch image from Docker Hub with `docker pull adibhanna/zennotes`, generate a login token and keep a copy (`openssl rand -hex 32`), then start the container with your vault mounted:\n`docker run -d -p 127.0.0.1:7878:7878 \\\n  -e ZENNOTES_AUTH_TOKEN=<your-token> \\\n  -v "$HOME/Documents/MyVault:/workspace" \\\n  -v "$HOME/zennotes-data:/data" \\\n  adibhanna/zennotes:latest`\nThe server binds to 0.0.0.0, so it will not start without that token — open http://localhost:7878 and paste the token on first connect. Your notes stay as ordinary .md files on the host, and the desktop app can point at the same server. The full walkthrough, including reverse-proxy and TLS hardening, lives at zennotes.org/docs.'
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
    title: 'Primary notes can live at the vault root',
    body:
      'Settings → Vault lets you choose between the original Inbox model and a Vault root model. Vault root mode surfaces top-level notes, folders, and loose files directly, which is better for imported Obsidian-style vaults and flat Markdown folders.'
  },
  {
    title: 'Tabs and splits are first-class',
    body:
      'Each editor pane can hold multiple tabs. Split the current tab right or down, move between panes with pane motions, switch the active note between Edit, Split, and Preview from commands, and, if you hide tabs, use the buffer switcher shortcut or `:buffers`. The active tab also has a full keyboard context menu, so actions like Close Others, Close Tabs to the Right, Pin Tab, Pin as Reference, Open in Floating Window, and Reveal in Finder stay accessible without the mouse. If you disable Vim mode, use the command palette instead.'
  },
  {
    title: 'Context menus are part of the keyboard model',
    body:
      'ZenNotes treats context menus as keyboard-reachable UI, not mouse-only escape hatches. Use the configured context-menu binding on the selected sidebar or note-list row. In the editor, select text and press `m` to open the text menu with commenting first; `Shift+F10` / the system Context Menu key still opens the active tab menu when no text is selected. The command palette also exposes the same high-value tab actions directly.'
  },
  {
    title: 'Comments attach to selected text',
    body:
      'Select text in the editor and press `Mod+Alt+M` — or open the text menu with `m` — to start a comment, and toggle the Comments panel itself with `Mod+Shift+C`. ZenNotes stores note comments beside the note in vault metadata, then highlights the anchored text and line when the comment is active. In the panel, move with `j` / `k` and use `e` to edit, `r` to resolve, and `d` to delete.'
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
      'Tasks scans every note for checkboxes, Tags lets you browse notes that carry all of the selected tags (toggle Match to Any for a union), Archive gives you a dedicated list of cold-storage notes, and Trash gives you a recovery surface for deleted notes without turning the left rail into a second browser.'
  },
  {
    title: 'The Tasks calendar schedules and reschedules',
    body:
      "Switch Tasks to Calendar (button or `2`) to see tasks laid out by due date. A task written inside a daily note automatically shows on that day — no `due:` needed — so the day you wrote it on is the day it lands. Type in the box under the grid to add a task to the selected day (it’s created in that day’s daily note, offering to create the note first for a day that has none). Reschedule by dragging a task onto another day, or from the keyboard: `Tab` picks a task in the day list, `<` / `>` shifts it a day earlier/later, and `T` moves it to today."
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
    title: 'Templates scaffold new notes',
    body:
      'Templates turn a repeated note shape into one keystroke. ZenNotes ships built-in templates for engineering (ADR, RFC, Bug Report, Postmortem, Meeting Notes, 1:1) and personal use (Daily Note, Weekly Review, Reading Notes, Journal, Project Kickoff, To-do), and you can author your own under Settings → Templates. A template is plain markdown with optional frontmatter and variables — `{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{week}}`, and `{{cursor}}` — substituted at creation time. Custom templates are stored as `.md` files in `.zennotes/templates/`, so they stay portable like everything else. Daily and weekly notes can each be assigned a template so dated notes start pre-filled.'
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
      'Drop files into a note to insert local files. By default, ZenNotes keeps them as ordinary files in the vault root, can reveal them from the app, and opens images, SVGs, PDFs, audio, video, and generic files inside ZenNotes tabs or reference panes where possible.'
  },
  {
    title: 'Any CSV is a database',
    body:
      'A `.csv` file in your vault is a full Notion-style database, with zero new dependencies. The same data shows up as an editable Table (inline cell editing) and as a Board grouped by a select field; add and switch views freely. Fields are typed — text, number, checkbox, date, select, multi-select — and support sort, filter, and a raw-CSV toggle, while every row keeps a stable id so external edits round-trip cleanly. Open any row as a real Markdown note — a “record page” in a per-database folder — whose frontmatter mirrors the row’s properties and whose body is a freeform page. Create one with “New Database” in the command palette or by right-clicking a folder → New database.'
  },
  {
    title: 'The CLI is the bridge to launchers',
    body:
      'The `zen` command-line tool can list, read, search, capture, edit, archive, trash, inspect tasks, and start the MCP server without the app running. Raycast uses it for search, then uses `zennotes://open` and `zennotes://open-window` links to bring the selected note back into ZenNotes. On macOS, Settings → CLI can install the bundled Raycast extension locally so users do not need to wait for the Raycast Store version.'
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
      { keys: 'Shift+Mod+N', action: 'New Quick Note', detail: 'Create a quick capture note in the main window and focus its title.' },
      { keys: 'Shift+Mod+Space', action: 'Open quick capture window', detail: 'Open the floating, always-on-top capture window. Bound system-wide (CommandOrControl+Shift+Space by default) so it works over any app; change it under Settings → Editor.' },
      { keys: 'Mod+,', action: 'Open Settings', detail: 'Open settings for appearance, editor behavior, fonts, vault controls, and app details.' },
      { keys: 'Mod+1', action: 'Toggle sidebar', detail: 'Hide or show the left sidebar.' },
      { keys: 'Mod+2', action: 'Toggle connections', detail: 'Toggle the connections panel for the active editor pane.' },
      { keys: 'Mod+Shift+C', action: 'Toggle comments panel', detail: 'Show or hide the Comments panel for the active pane.' },
      { keys: 'Mod+Alt+M', action: 'Add comment', detail: 'Start a comment on the selected text (or the current line) without reaching for the mouse.' },
      { keys: 'Alt+H / Alt+J / Alt+K / Alt+L', action: 'Focus pane left / down / up / right', detail: 'Always-on pane-focus motions — they work even with Vim mode off and skip the Ctrl+W prefix some Linux setups intercept. (Ctrl+W h/j/k/l still works in Vim mode.)' },
      { keys: 'Mod+.', action: 'Toggle Zen mode', detail: 'Hide or restore the app chrome so only the active editor, preview, or split view stays on screen.' },
      { keys: 'Mod+W', action: 'Close active tab', detail: 'Close the current note or virtual tab.' },
      { keys: 'Shift+Mod+E', action: 'Export note as PDF', detail: 'Export the active note as a PDF file.' },
      { keys: 'Mod+=', action: 'Zoom in', detail: 'Scale the whole app up, including chrome, editor, and preview.' },
      { keys: 'Mod+-', action: 'Zoom out', detail: 'Scale the whole app down when the UI feels too large.' },
      { keys: 'Mod+0', action: 'Reset zoom', detail: 'Return the app to its default scale.' },
      { keys: 'Alt+Z', action: 'Toggle word wrap', detail: 'Switch between wrapped lines and horizontal scrolling.' },
      { keys: 'Esc', action: 'Dismiss overlay', detail: 'Close note search or the command palette when they are open.' }
    ]
  },
  {
    id: 'quick-capture-window',
    title: 'Quick capture window',
    description: 'These apply inside the floating capture window, opened with the quick capture hotkey.',
    items: [
      { keys: 'Mod+Enter', action: 'Save and hide', detail: 'Save the note into Quick Notes and hide the window. A fresh capture clears for next time; an opened note is left as you left it.' },
      { keys: 'Mod+N', action: 'New note', detail: 'Save the current note, then open a fresh blank capture without hiding the window — for jotting several in a row.' },
      { keys: 'Mod+P', action: 'Open a note', detail: 'Search the vault and load an existing note into the window to edit it in place.' },
      { keys: 'Shift+Mod+P', action: 'Command palette', detail: 'Run a capture command: save, save without hiding, start a new note, or open another note.' },
      { keys: 'Esc', action: 'Dismiss', detail: 'Close an open overlay; otherwise save and hide the window.' }
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
      { keys: '[b / ]b', action: 'Previous / next buffer', detail: 'Move across open buffers, falling back to recent notes when only one buffer is open.' },
      { keys: 'Space o', action: 'Open buffers', detail: 'Show a searchable list of every open buffer across every pane.' },
      { keys: 'Space f', action: 'Search notes', detail: 'Open the vault-wide note search palette.' },
      { keys: 'Space s t', action: 'Search vault text', detail: 'Fuzzy-search matching text lines across notes in Inbox, Quick Notes, and Archive.' },
      { keys: 'Space e', action: 'Toggle left sidebar', detail: 'Show or hide the folder/tag sidebar without touching the mouse.' },
      { keys: 'Space p', action: 'Note outline', detail: 'Jump to any heading in the active note via a searchable overlay.' },
      { keys: 'Space v', action: 'Switch vault', detail: 'Open the command palette directly to the local vault switcher.' },
      { keys: 'Space, then pause', action: 'Show leader hints', detail: 'If enabled in Settings, open a which-key style guide for the next available leader actions. Sticky mode keeps it open until `Space` or `Esc`.' },
      { keys: 'Mod+3', action: 'Toggle outline panel', detail: 'Show or hide the persistent outline in the active pane.' },
      { keys: 'zc / zo', action: 'Fold / unfold heading', detail: 'Collapse or expand the section below the heading at the cursor.' },
      { keys: 'zM / zR', action: 'Fold / unfold all', detail: 'Collapse or expand every heading section in the note.' },
      { keys: 'Ctrl-o', action: 'Go back', detail: 'Jump to the previous note location in history.' },
      { keys: 'Ctrl-i', action: 'Go forward', detail: 'Jump forward in note history.' },
      { keys: 'Space h', action: 'Hint mode', detail: 'Show jump labels over clickable targets — links, buttons, sidebar rows, tabs — so you can activate any of them from the keyboard. Works outside insert mode, including in the Tasks and Tags views.' }
    ]
  },
  {
    id: 'palettes-and-pickers',
    title: 'Palettes and pickers',
    description:
      'These apply once a palette, search overlay, or picker already has focus — the command palette, note search, vault text search, outline, buffer switcher, the [[ reference picker, the / slash menu, and the date and template pickers.',
    items: [
      { keys: 'ArrowDown / Ctrl+N / Ctrl+J', action: 'Next result', detail: 'Move the selection down. Ctrl+J / Ctrl+K behave the same in every picker, so they no longer collide with the global Search-notes shortcut on Windows and Linux.' },
      { keys: 'ArrowUp / Ctrl+P / Ctrl+K', action: 'Previous result', detail: 'Move the selection up.' },
      { keys: 'Enter', action: 'Run or open', detail: 'Open the selected note, heading, buffer, command, or search hit.' },
      { keys: 'Type to filter', action: 'Narrow the list', detail: 'Each picker filters its own data live as you type.' },
      { keys: 'Esc', action: 'Close the picker', detail: 'Dismiss the overlay and return focus to the previous surface.' }
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
      { keys: 'Cmd/Ctrl-click', action: 'Toggle multi-select', detail: 'Add or remove one visible note or folder from the sidebar selection.' },
      { keys: 'Shift-click', action: 'Select range', detail: 'Select the visible range between the last selection anchor and the clicked sidebar item.' },
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
        keys: 'Select text, then m',
        action: 'Open text menu',
        detail:
          'Open the editor right-click menu from the keyboard. The first action adds a comment to the selected text, matching the review flow used in document editors.'
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
    description: 'These virtual views each run their own keyboard loop in the main pane, and the Vim leader works here too (for example Space h for hint mode).',
    items: [
      { keys: 'j / k', action: 'Move row cursor', detail: 'Step through task rows, tagged notes, or trashed notes.' },
      { keys: 'g g / G', action: 'Jump to top or bottom', detail: 'Move to the first or last visible result.' },
      { keys: 'Enter / o', action: 'Open current result', detail: 'Open the selected task source note, tagged note, or trashed note.' },
      { keys: 'x', action: 'Toggle task', detail: 'Tasks view only: check or uncheck the selected task. Space also toggles unless Space is your Vim leader key, in which case it starts a leader sequence.' },
      { keys: 'r', action: 'Restore trashed note', detail: 'Trash view only: restore the selected trashed note.' },
      { keys: 'x / d', action: 'Delete forever', detail: 'Trash view only: permanently delete the selected trashed note after confirmation.' },
      { keys: '/', action: 'Filter the view', detail: 'Focus the local filter box for tasks, tag matches, or trashed notes.' },
      { keys: ':', action: 'Open local ex prompt', detail: 'Run the view-specific command line inside Tasks or Tags.' },
      { keys: 'Esc', action: 'Clear the filter', detail: 'Clears an active filter. These views are tabs, so Esc no longer closes them — close with :q or the ✕ in the tab header.' }
    ]
  },
  {
    id: 'database-grid',
    title: 'Database grid (Table view)',
    description: 'Vim-style motions when a CSV database table has focus. The grid yields to these keys so they do not collide with global motions.',
    items: [
      { keys: 'h / j / k / l', action: 'Move the cell cursor', detail: 'Arrow keys also work. 0 / ^ jump to the first column, $ to the last.' },
      { keys: 'g g / G', action: 'Jump to first / last row', detail: 'Fast travel within the current column.' },
      { keys: 'i / Enter', action: 'Edit the cell', detail: 'On a checkbox cell this toggles it instead of opening an editor.' },
      { keys: 'Space / x', action: 'Select the row', detail: 'Toggle the row’s selection for bulk actions.' },
      { keys: 'o', action: 'Open the record page', detail: 'Open the row as a Markdown note in the per-database folder.' },
      { keys: 'a', action: 'Add a row', detail: 'Append a new empty record and move the cursor to it.' },
      { keys: 'd d', action: 'Delete the row', detail: 'Remove the record at the cursor.' },
      { keys: 'Esc', action: 'Clear selection / leave the grid', detail: 'Clears a multi-row selection first, then blurs the grid.' }
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
    command: ':template / :tmpl',
    summary: 'New note from a template',
    detail: 'Open the template picker. With an argument like `:template ADR` it skips the picker and creates from the best-matching template directly.'
  },
  {
    command: ':daily',
    summary: "Open today's daily note",
    detail: 'Open or create today’s daily note (requires daily notes enabled in Settings → Vault). Uses the assigned daily template if one is set.'
  },
  {
    command: ':weekly',
    summary: "Open this week's note",
    detail: 'Open or create this week’s note with the configured weekly note pattern (requires weekly notes enabled in Settings → Vault). Uses the assigned weekly template if one is set.'
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
    detail: 'Move to the next or previous tab, or the next most-recent note when only one tab is open. The default normal-mode keymaps are `]b` and `[b`, and both can be remapped in Settings.'
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
    command: '<Space> l y',
    summary: 'Leader-copy note as Markdown',
    detail: "Copy the whole note's Markdown source to the clipboard from the editor (also available as the “Copy Note as Markdown” command)."
  },
  {
    command: '<Space> (pause)',
    summary: 'Show leader hints',
    detail: 'When Leader key hints are enabled, pressing the configured Leader key shows a which-key style overlay for the next available leader actions. Settings let you choose a timed timeout or a sticky mode that stays open until you dismiss it. Turning Vim mode off disables the leader system too.'
  },
  {
    command: '<Space> h',
    summary: 'Leader hint mode',
    detail: 'Show jump labels over clickable targets — links, buttons, sidebar rows, tabs — to activate any of them from the keyboard. Works in the editor, sidebar, and the Tasks and Tags views.'
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
    command: '<Space> v',
    summary: 'Leader vault switcher',
    detail: 'Open the command palette directly to the local vault switcher.'
  },
  {
    command: '<Space> t',
    summary: 'Leader new from template',
    detail: 'Open the template picker to create a note from a built-in or custom template.'
  },
  {
    command: '<Space> d',
    summary: "Leader today's daily note",
    detail: 'Open or create today’s daily note (when daily notes are enabled in Settings → Vault).'
  },
  {
    command: '<Space> w',
    summary: "Leader this week's note",
    detail: 'Open or create this week’s note (when weekly notes are enabled in Settings → Vault).'
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
      { label: 'Theme, mode, and variant', detail: 'Pick a theme family — Apple, Gruvbox, Catppuccin, GitHub, Solarized, One, Nord, Tokyo Night, Kanagawa (Wave / Dragon / Lotus), or the monochrome, true-black (OLED-friendly) Black Metal — plus light or dark mode and the active flavor or contrast where the theme supports it.' },
      { label: 'Dark sidebar', detail: 'Tint the sidebar slightly darker than the canvas so the chrome reads as a distinct surface.' },
      { label: 'Sidebar arrows', detail: 'Show or hide disclosure arrows for collapsible sidebar folders and sections.' }
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
      { label: 'Date-titled Quick Notes', detail: 'Name quick notes by date instead of timestamp-based titles.' },
      { label: 'Quick Note prefix', detail: 'Choose the prefix used for new quick note titles, or leave it blank for a bare timestamp/date.' }
    ]
  },
  {
    title: 'Typography and layout',
    items: [
      { label: 'Interface, text, and monospace fonts', detail: 'Choose different fonts for chrome, reading text, and code blocks.' },
      { label: 'Font size and line height', detail: 'Tune reading density in the editor and preview.' },
      { label: 'Reading width and editor width', detail: 'Cap long lines so wide windows stay readable.' },
      { label: 'Content alignment', detail: 'Center note content in its column or left-align it to the pane edge.' },
      { label: 'Line numbers', detail: 'Switch between off, absolute, and relative gutter numbering.' },
      { label: 'Line number position', detail: 'Keep the gutter next to the centered text or pin it to the editor edge.' }
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
      { label: 'Primary notes location', detail: 'Treat `inbox/` as the main notes area, or use the vault root directly for an Obsidian-style flat vault.' },
      { label: 'Daily notes', detail: "Enable a daily-notes workflow, choose a directory pattern, naming pattern, locale, and template so each day’s note starts in the right place. Supported tokens are `yyyy`, `yy`, `M`, `MM`, `MMM`, `MMMM`, `d`, `dd`, `EEE`, `EEEE`, `w`, and `ww`; quote literal words like `'Daily Notes'/yyyy/MM-MMM`. Open today’s note with `Space d`, `:daily`, or the command palette. Two task options live here too: “Tasks are due on the note’s date” makes tasks in a daily note show on the calendar for that day (on by default), and “Roll over unfinished tasks to today” moves every unchecked task from past daily notes into today when you open it (off by default; also runnable from the command palette)." },
      { label: 'Weekly notes', detail: "Enable weekly notes with a directory pattern, naming pattern, locale, and template. Weekly patterns support the same tokens as daily notes plus ISO week `w` and `ww`; the default title pattern is `yyyy-'W'ww`. Open this week’s note with `Space w`, `:weekly`, or the command palette." },
      { label: 'System folder labels', detail: 'Rename how Inbox, Quick Notes, Archive, and Trash appear in the UI without renaming the real folders on disk.' }
    ]
  },
  {
    title: 'Templates',
    items: [
      { label: 'Template library', detail: 'Browse every template — built-in and custom. Built-ins cover engineering (ADR, RFC, Bug Report, Postmortem, Meeting Notes, 1:1) and personal use (Daily Note, Weekly Review, Reading Notes, Journal, Project Kickoff, To-do).' },
      { label: 'Create a custom template', detail: 'Author a new template as markdown with optional frontmatter (`name`, `description`, `category`, `titleTemplate`, `targetFolder`, `targetSubpath`) and variables like `{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{week}}`, and `{{cursor}}`. It is saved as a `.md` file in `.zennotes/templates/`.' },
      { label: 'Edit or reset built-ins', detail: 'Press Edit on a built-in to fork an editable copy that shadows the original everywhere; Reset removes the copy and restores the built-in. Custom templates can be edited or deleted directly.' },
      { label: 'Where templates appear', detail: 'Use a template via the picker (`Space t` / `:template` / “New Note from Template…”), from a folder’s right-click “New from template”, or as the assigned daily/weekly note template. Custom templates require a local vault; built-ins work everywhere.' }
    ]
  },
  {
    title: 'CLI',
    items: [
      { label: 'Install Command-Line Tool', detail: 'Symlink the bundled `zen` wrapper into a usable PATH location so any terminal session can capture, search, and edit notes. ZenNotes prefers user-writable directories and only prompts for admin access when no writable PATH target is available. The CLI runtime stays packaged with the app, including the dependencies needed by `zen mcp`, so updates ship together.' },
      { label: 'Status, path, and quick reference', detail: 'Settings → CLI shows whether `zen` is installed, where the symlink lives, and a copy-able quick reference of the most useful commands. If the chosen directory is not on PATH yet, Settings shows the exact shell command to add it. An "External install" badge appears when something else owns `zen` so ZenNotes never clobbers an unmanaged binary.' },
      { label: 'Paths with spaces', detail: 'Quote note paths like `zen read "hellointerview/system design.md"` or pass them with `--path "hellointerview/system design.md"` so your shell keeps the path as one argument.' },
      { label: 'Raycast on macOS', detail: 'The Raycast extension requires `zen` and can be installed locally from this settings page. ZenNotes copies the bundled extension into app data, installs dependencies, builds it, and imports it into Raycast. It searches with `zen list --json`, then opens notes in ZenNotes through `zennotes://open` or `zennotes://open-window` and exposes archive, unarchive, trash, reveal, copy path, and copy wikilink actions from Raycast.' },
      { label: 'Uninstall', detail: 'Removes only the ZenNotes-managed symlink — never an arbitrary unmanaged binary named `zen`. The CLI stays inside the app bundle for next time.' }
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

export const HELP_CLI: HelpCard[] = [
  {
    title: 'What the CLI is for',
    body:
      '`zen` is a command-line companion that talks to your vault directly. It reads and writes the same markdown files the app does, so anything you do in a terminal — capture, search, append, archive, list tasks — shows up in the app instantly. Use it for shell pipelines, scripts, cron jobs, editor plugins (vim, emacs, helix), launcher integrations (Raycast, Alfred), or just because the keyboard is faster.'
  },
  {
    title: 'Install it once from Settings',
    body:
      'Open Settings → CLI and click Install. ZenNotes symlinks the bundled wrapper into a usable PATH location, preferring user-writable directories and only asking for admin access when no writable PATH target is available. After that, `zen --help` works in any new terminal. You can also run the install from the command palette via "Install Command-Line Tool (zen)".'
  },
  {
    title: 'No app required',
    body:
      'The CLI reads from the same vault folder the desktop app uses, so it works whether or not ZenNotes is open. When the app is open, file watchers pick up CLI changes automatically — captures and edits show up live in the sidebar.'
  },
  {
    title: 'Capture is the gateway drug',
    body:
      'The fastest way to add a note is `zen capture "..."`. Pipe-friendly: `pbpaste | zen capture --tag idea` lifts the clipboard into a tagged note. The first non-empty line becomes the title.'
  },
  {
    title: 'Read and search from the terminal',
    body:
      'Use `zen list` to see recent notes, `zen list --tag work --limit 5` to filter, `zen read inbox/Project.md` to print a body, and `zen search "deadline"` for full-text matches with file:line previews. Quote paths with spaces, like `zen read "hellointerview/system design.md"`, or use `--path`. Add `--json` to any command to get structured output you can pipe into `jq`.'
  },
  {
    title: 'Raycast uses the same CLI',
    body:
      'On macOS, install the Raycast extension locally from Settings → CLI after `zen` is installed. ZenNotes copies the bundled extension into app data, runs the local build, and imports it into Raycast, so you do not need the Raycast Store version. The Search Notes command reads from `zen list --json`, then uses `zennotes://open` to open notes in the main app or `zennotes://open-window` to open a floating window. Cmd+K actions also archive, unarchive, move to Trash, reveal in Finder, copy the path, and copy a wikilink.'
  },
  {
    title: 'Raycast local install requirements',
    body:
      'The local Raycast installer is macOS-only. It needs Raycast, the `zen` CLI, Node.js 22.14 or newer, and npm 7 or newer available from your login shell. Settings shows each requirement, the local extension path, and whether the installed copy is current with the bundled ZenNotes version.'
  },
  {
    title: 'Edit incrementally',
    body:
      'Prefer `zen append` and `zen prepend` over `zen write` for journals and running lists — they preserve the rest of the body. Both accept `--body "literal"` or `--body -` to read stdin (so `cat ideas.txt | zen append daily.md --body -` works).'
  },
  {
    title: 'Tasks and folders',
    body:
      '`zen task list` enumerates open checkboxes across the vault with stable ids. `zen task toggle <id>` flips a task without opening the note. `zen folder list / create / rename / delete` keep your subfolder tree manageable from the terminal.'
  },
  {
    title: 'MCP for AI agents',
    body:
      '`zen mcp` starts the ZenNotes MCP server in stdio mode — the same one Claude Code, Claude Desktop, and Codex use under the hood. Once `zen` is installed, Settings → MCP installs configure the clients to launch `zen mcp` directly, so the install path is one stable absolute path that survives app moves.'
  }
]
