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
      'Type `/` to insert headings, lists, callouts, code blocks, tables, links, images, and other markdown structures. Type `@` to insert date shortcuts like Today and Tomorrow as ISO dates, or `@time` / `@now` for the current time.'
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
      'Images, SVGs, PDFs, audio, video, Excalidraw drawings, and other local files can appear in the vault tree and open in ZenNotes tabs or reference panes. The files stay ordinary vault files, but opening them does not have to bounce you out to another app.'
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
      'Open Settings → Templates. Press "New template" to author one: a template is just markdown with optional YAML frontmatter (`name`, `description`, `category`, `titleTemplate`, `targetFolder`, `targetSubpath`) and a body. Use the variables `{{title}}`, `{{date}}`, `{{date:YYYY-MM-DD}}` (any moment-style format), `{{time}}`, `{{week}}`, and `{{cursor}}` (where the caret lands). Custom templates are saved as plain `.md` files under `.zennotes/templates/`. You can also fork a built-in by pressing Edit on it — that creates an editable copy that shadows the original, and Reset restores the built-in. From any note, the "Save Current Note as Template…" command captures it as a new template.'
  },
  {
    title: 'Draw diagrams with Excalidraw',
    body:
      'Run "New Drawing" from the command palette to create a `.excalidraw` file and open it in a built-in Excalidraw editor tab. Drawings are first-class vault files — they appear in the sidebar, can be moved and archived like notes, and auto-refresh when edited. To embed a drawing inside a note, use "Embed Existing Drawing…" (pick from a searchable list) or "Embed New Drawing" (create one at the cursor and switch to its editor). The embed syntax is `![[name.excalidraw]]`, the same as images, and supports optional size hints like `![[name.excalidraw|600]]` or `![[name.excalidraw|600x400]]`. Clicking an embed opens the drawing in a new tab. Obsidian-style `.excalidraw.md` files are also supported.'
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
      'Install the `zn` CLI from Settings → CLI, then use the Raycast Extension section on the same page to install ZenNotes for Raycast locally. Raycast can search notes, filter by folder or tag, open a note in the app, open it in a floating window, archive or unarchive, move to Trash, reveal in Finder, copy the note path, and copy a wikilink.'
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
  },
  {
    title: 'Customize the look: themes vs. overrides',
    body:
      'ZenNotes has two CSS-based ways to change how it looks. A **theme** is a complete palette you select under Settings → Appearance → Custom. An **override** is a small CSS file that layers on top of whichever theme is active, toggled on or off under Settings → Appearance → Overrides. Reach for a theme to design a whole look; reach for an override to change one or two things — a different accent, a darker background — without forking a theme. Both apply live, no restart.'
  },
  {
    title: 'Build a custom theme',
    body:
      'Settings → Appearance → Custom → New theme scaffolds a folder at `~/.config/zennotes/themes/<name>/` with a `manifest.json` and a `theme.css`, reveals it, and adds a card you click to apply. Edits to `theme.css` apply live. Only the active theme CSS is loaded, so write `:root { … }` for the light/shared values and `:root[data-theme-mode="dark"] { … }` for dark — you never put the theme name in a selector. Colors are the `--z-*` tokens, written as space-separated RGB (`--z-accent: 255 59 48;`): backgrounds `--z-bg` / `--z-bg-softer` / `--z-bg-1`…`--z-bg-4`, text `--z-fg-1` / `--z-fg-2` / `--z-grey-0`…`--z-grey-2`, accent `--z-accent` / `--z-accent-soft` / `--z-accent-muted`, and the syntax hues `--z-red` / `--z-green` / `--z-yellow` / `--z-blue` / `--z-purple` / `--z-aqua`. `manifest.json` carries name, author, version, description, `modes` (light | dark | both), and an optional preview swatch.'
  },
  {
    title: 'Override one thing on any theme',
    body:
      'An override is a `.css` file in `~/.config/zennotes/overrides/`, toggled under Settings → Appearance → Overrides. Enabled overrides inject on top of the active theme in filename order, so they win the cascade — target `:root[data-theme] { … }` so the rule beats both built-in and custom themes. Because they sit on top, one override re-themes everything: `:root[data-theme] { --z-accent: 255 59 48; }` turns the accent hot pink on every theme. Overrides stack, so keep several small ones and flip each independently. The seeded `example.css` is a commented cookbook with the full token list and ready-to-uncomment recipes. To find what controls an element, use the **Developer tools** button in that same Overrides section and inspect it.'
  },
  {
    title: 'Bundle fonts and images in a theme',
    body:
      'Ship an asset with a theme by dropping the file in the theme folder and referencing it with the `zen-theme://` scheme, where the host is the folder name: `@font-face { font-family: "Display"; src: url(zen-theme://my-theme/display.woff2); }`. Remote http/https URLs are never loaded, so themes stay self-contained and work offline; small images can also be inlined as `data:` URIs. Font family and text size are not theme tokens — set those under Settings → Typography.'
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
    title: 'The home view is where you land',
    body:
      'When no note is open (outside Zen mode), ZenNotes shows a light home view instead of a blank pane: a greeting, quick-create actions (new note, database, drawing — plus daily and weekly notes when those are enabled in Settings), your most recently edited notes, and today’s open tasks with an overdue count. Click a note or task to open it, tick a checkbox to complete a task in place, and use ↑/↓ — or j/k in Vim mode — then Enter to move and open from the keyboard.'
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
      'Tasks scans every note for checkboxes, Tags lets you browse notes that carry all of the selected tags (toggle Match to Any for a union), Archive gives you a dedicated list of cold-storage notes, and Trash gives you a recovery surface for deleted notes without turning the left rail into a second browser. Selected tags accumulate so you can narrow across several at once; clear them with the Selected strip’s “Clear all”, the `c` key, or a right-click on any tag chip (which also offers “Unselect others” to keep just that one).'
  },
  {
    title: 'The Tasks calendar schedules and reschedules',
    body:
      "Switch Tasks to Calendar (button or `2`) to see tasks laid out by due date. A task written inside a daily note automatically shows on that day — no `due:` needed — so the day you wrote it on is the day it lands. Type in the box under the grid to add a task to the selected day (it’s created in that day’s daily note, offering to create the note first for a day that has none). Reschedule by dragging a task onto another day, or from the keyboard: `Tab` picks a task in the day list, `<` / `>` shifts it a day earlier/later, and `T` moves it to today."
  },
  {
    title: 'The Tasks Kanban board, custom statuses, and any field',
    body:
      'Switch Tasks to Kanban (button or `3`) for a column board. "Group by" offers Status (Today / Upcoming / Waiting / Done, derived from due dates and `@waiting`), Priority, Folder, Custom status, and one entry per inline `@field` you use. Any task field works: tag tasks with `@key:value` tokens like `@status:review`, `@sprint:24`, or `@area:backend`, and each key becomes its own board with a column per value (auto-discovered, so it appears the moment you use it). For the status field, list the columns in order in `config.toml` under `[view]`, e.g. `kanban_statuses = ["backlog", "in_progress", "review", "done"]`; other fields sort their columns automatically. A note-level `status:` in frontmatter sets a default for that note’s tasks. Everything is keyboard-first: `h`/`l` move between columns, `j`/`k` between cards, `g` cycles the group-by, `Shift+H` / `Shift+L` send the focused card to the previous/next column (rewriting its `@field` token), `<` / `>` reorder the columns themselves (saved per board), and `Space`/`Enter` toggle/open. Drag does the same with the mouse — including dragging a column header to reorder. Renaming a column (click its title, or `[kanban_column_titles]` in `config.toml`) sets a display label only: the column still shows its underlying `@field:value` beneath the name, and moving a card in writes that value, not the label.'
  },
  {
    title: 'Forward a task to another note',
    body:
      'Forwarding moves a task to a different note while leaving a record behind — the bullet-journal “migrate” gesture. Type `>` inside a task’s checkbox (turning `- [ ]` into `- [>]`) to open a note picker, run “Forward Task to Note…” from the command palette with the cursor on a task, or press `>` on a task in the Tasks list. The original stays as `- [>] … [[Target]]` (a forwarded marker linking to where it went), and a fresh `- [ ] … [[Source]]` copy is added to the note you pick, backlinked home. Forwarded tasks collect under their own “Forwarded” group in the Tasks list, kept out of Today and Done.'
  },
  {
    title: 'Style completed tasks',
    body:
      'By default, checking a task (`- [x]`) just fills its checkbox. Settings → Editor → Completed task style can also dim the text, strike it through, or both, so finished items visually recede in the editor and reading view while the checkbox stays checked. The command palette has direct entries (“Completed Tasks: Strikethrough”, “Gray”, “Strikethrough + Gray”, “No Style”). Nested sub-tasks keep their own state, so a completed parent never strikes an unchecked child.'
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
    title: 'Callouts highlight the important bits',
    body:
      'Turn a blockquote into a colored callout (an Obsidian-style admonition) by starting its first line with `> [!type]`, optionally followed by a title: `> [!warning] Heads up`. Typing `[!` inside a blockquote opens an insert menu of the callout types — filter by name (aliases match too, so `warn` finds Warning and `tldr` finds Abstract), move with the arrow keys or the Vim/Emacs completion chords (Ctrl+J / Ctrl+K, Ctrl+N / Ctrl+P), and press Enter, Tab, Ctrl+Y, or click to drop in the syntax. The type sets the color: `note`, `info`, `abstract` / `summary` / `tldr` render blue; `tip` / `hint` / `important` and `success` / `check` / `done` green; `question` / `help` / `faq` and `example` purple; `warning` / `caution` / `attention` yellow; `danger` / `error`, `bug`, and `failure` / `fail` red; and `quote` / `cite` a neutral gray. Types are case-insensitive, and an unrecognized one still renders as a neutral note, so callouts pasted in from Obsidian keep working.'
  },
  {
    title: '@ inserts dates and links notes',
    body:
      'Typing `@` in normal text opens suggestions: the date shortcuts (Today, Yesterday, Tomorrow), the current time (Now — type `@time` or `@now`), plus any notes matching what you type. Choosing a date inserts an ISO date like `2026-04-15`; choosing Now inserts the current time in your configured 12-hour or 24-hour format (Settings → Editor → Time format); choosing a note inserts a `[[wikilink]]`, so `@` is a quick alternative to `[[`. A bare `@` leads with the dates and Now — start typing letters and matching notes appear.'
  },
  {
    title: 'Templates scaffold new notes',
    body:
      'Templates turn a repeated note shape into one keystroke. ZenNotes ships built-in templates for engineering (ADR, RFC, Bug Report, Postmortem, Meeting Notes, 1:1) and personal use (Daily Note, Weekly Review, Reading Notes, Journal, Project Kickoff, To-do), and you can author your own under Settings → Templates. A template is plain markdown with optional frontmatter and variables — `{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{week}}`, and `{{cursor}}` — substituted at creation time. Custom templates are stored as `.md` files in `.zennotes/templates/`, so they stay portable like everything else. Daily and weekly notes can each be assigned a template so dated notes start pre-filled.'
  },
  {
    title: 'Reference and connections support research-heavy work',
    body:
      'Pin a companion note or PDF in the reference pane, then toggle the connections panel to inspect backlinks and unresolved links while you draft. Connections count both `[[wikilinks]]` and standard Markdown links (`[text](Note.md)`), so incoming and outgoing associations show up even if you never use wikilinks.'
  },
  {
    title: 'Zen mode removes chrome',
    body:
      'Use the configured Zen shortcut to strip away the title bar, sidebar, note list, tabs, pane headers, side panels, and status bar so only the active editor, preview, or split view stays visible.'
  },
  {
    title: 'Links are actionable',
    body:
      'Use [[wikilinks]] or markdown links. Following a link — click it, Cmd/Ctrl-click it, or use the follow-link motion (`gd`) in normal mode — opens the note under the cursor and pins PDFs into the reference pane. If the note does not exist yet, following the link offers to create it (after you confirm) rather than leaving a dead link. Prefix a wikilink with `!` to embed rather than link: `![[Note]]` inlines the target note content in the reading view and PDF export — recursively, with cycle protection — so a master note can pull in sub-notes and export to PDF as one document. `![[image.png]]` embeds an image, and `![[drawing.excalidraw]]` embeds an Excalidraw drawing as a PNG preview.'
  },
  {
    title: 'Files stay local',
    body:
      'Drop files into a note to insert local files. ZenNotes copies them into the vault’s `assets/` folder — the same place pasted images land — so they stay together instead of cluttering your notes area, whether you keep notes in `inbox/` or at the vault root. It can reveal them from the app, and opens images, SVGs, PDFs, audio, video, and generic files inside ZenNotes tabs or reference panes where possible. In the sidebar you can drag an image, PDF, or any attachment onto a folder to move it, just like a note, or use its Move… context-menu entry.'
  },
  {
    title: 'Any CSV is a database',
    body:
      'A `.csv` file in your vault is a full Notion-style database, with zero new dependencies. The same data shows up as an editable Table (inline cell editing) and as a Board grouped by a select field; add and switch views freely. Fields are typed — text, number, checkbox, date, select, multi-select — and support sort, filter, and a raw-CSV toggle, while every row keeps a stable id so external edits round-trip cleanly. Open any row as a real Markdown note — a “record page” in a per-database folder — whose frontmatter mirrors the row’s properties and whose body is a freeform page. Create one with “New Database” in the command palette or by right-clicking a folder → New database.'
  },
  {
    title: 'The CLI is the bridge to launchers',
    body:
      'The `zn` command-line tool can list, read, search, capture, edit, archive, trash, inspect tasks, and start the MCP server without the app running. Raycast uses it for search, then uses `zennotes://open` and `zennotes://open-window` links to bring the selected note back into ZenNotes. On macOS, Settings → CLI can install the bundled Raycast extension locally so users do not need to wait for the Raycast Store version.'
  },
  {
    title: 'Excalidraw drawings are first-class files',
    body:
      'A `.excalidraw` file is a note type alongside Markdown and databases — listed in the sidebar, opened in a dedicated Excalidraw editor tab, and saved back as JSON. Embed one inside a note with `![[drawing.excalidraw]]` (same syntax as images, with optional `|width` or `|WxH` size hints). The embed renders as a PNG preview in both the editor and reading view, refreshes live when the drawing is edited, and opens in a new tab on click. Obsidian `.excalidraw.md` files are also recognized.'
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
      { keys: 'Shift+Mod+T', action: 'Reopen closed tab', detail: 'Reopen the most recently closed tab, restoring its position and pinned state. Repeat to walk back through your close history.' },
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
        action: 'Open date/time shortcuts',
        detail:
          'Show inline suggestions for Today, Yesterday, Tomorrow, and the current time (`@time` / `@now`) while writing so you can insert dates and times without leaving the keyboard.'
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
      { keys: 'x', action: 'Toggle task', detail: 'Tasks view only: check or uncheck the selected task. A checked task lingers in place for a couple of seconds before it drops into Done, so you can toggle it again to undo. Space also toggles unless Space is your Vim leader key, in which case it starts a leader sequence.' },
      { keys: '>', action: 'Forward task', detail: 'Tasks list only: forward the selected task to another note. Opens a note picker; the original becomes a forwarded record (`[>]`) linking to the target, and a fresh copy is added there, backlinked home. Forwarded tasks live under a “Forwarded” group.' },
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
      { keys: 'H / L', action: 'Move the current column left / right', detail: 'Reorders columns from the keyboard and the cursor follows. You can also drag a column header, or use “Move left / Move right” in the field menu (⋯).' },
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
    command: ':saveas name / :sav name',
    summary: 'Save the note under a new name',
    detail: 'Like Vim: writes a copy of the current note under the given title and keeps the original, then switches to editing the copy.'
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
    detail: 'Open or create today’s daily note (requires daily notes enabled in Settings → Vault → Periodic notes). Uses the assigned daily template if one is set.'
  },
  {
    command: ':weekly',
    summary: "Open this week's note",
    detail: 'Open or create this week’s note with the configured weekly note pattern (requires weekly notes enabled in Settings → Vault → Periodic notes). Uses the assigned weekly template if one is set.'
  },
  {
    command: ':monthly',
    summary: "Open this month's note",
    detail: 'Open or create this month’s note with the configured monthly note pattern (requires monthly notes enabled in Settings → Vault → Periodic notes). Uses the assigned monthly template if one is set.'
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
    command: 'o / O',
    summary: 'Open a line, continuing the list',
    detail: 'On a list item, `o` (below) and `O` (above) carry the marker forward like pressing Enter: bullets repeat, numbered lists advance and renumber, checkboxes start a fresh unchecked box, and indentation is kept. On a non-list line they open a plain new line as usual.'
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
    detail: 'Open or create today’s daily note (when daily notes are enabled in Settings → Vault → Periodic notes).'
  },
  {
    command: '<Space> w',
    summary: "Leader this week's note",
    detail: 'Open or create this week’s note (when weekly notes are enabled in Settings → Vault → Periodic notes).'
  },
  {
    command: '<Space> m',
    summary: "Leader this month's note",
    detail: 'Open or create this month’s note (when monthly notes are enabled in Settings → Vault → Periodic notes).'
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
      { label: 'Theme, mode, and variant', detail: 'Pick a theme family — Apple, Gruvbox, Catppuccin, GitHub, Solarized, One, Nord, Tokyo Night, Kanagawa (Wave / Dragon / Paper Ink (Custom) / Lotus), Rosé Pine (Rosé Pine / Moon / Dawn), or the monochrome, true-black (OLED-friendly) Black Metal — plus light or dark mode and the active flavor or contrast where the theme supports it.' },
      { label: 'Dark sidebar', detail: 'Tint the sidebar slightly darker than the canvas so the chrome reads as a distinct surface.' },
      { label: 'Sidebar arrows', detail: 'Show or hide disclosure arrows for collapsible sidebar folders and sections.' },
      { label: 'Use theme for PDF export', detail: 'Under Settings → Appearance → PDF export. Off by default, so exported PDFs use a clean light print theme. Turn it on to export in your current look instead: your theme (colors and dark/light, including custom themes), plus your enabled CSS snippets and color tweaks, as a full-bleed page. This toggle is the single switch for how the PDF looks; your CSS snippets style the export only while it is on, so you customize the PDF by editing your snippets, not with a separate print stylesheet.' }
    ]
  },
  {
    title: 'Editor behavior',
    items: [
      { label: 'Vim mode', detail: 'Turn CodeMirror Vim bindings on or off for the editor and reference pane.' },
      { label: 'Sync clipboard with Vim registers', detail: 'Mirror Vim and the system clipboard in both directions (like Vim\'s clipboard=unnamed): yank, delete, and change (y/d/c/x) copy to the clipboard, and p / P paste whatever is on the clipboard, so you can move text between ZenNotes and other apps without leaving normal mode. Only available when Vim mode is enabled.' },
      { label: 'Leader key hints', detail: 'Show a which-key style guide after pressing the configured Leader key so available leader actions stay visible while you decide. This setting is only available when Vim mode is enabled.' },
      { label: 'Leader hint behavior', detail: 'Choose whether leader hints auto-hide after a timeout or stay open until you dismiss them with the Leader key or Esc. These controls only appear when Vim mode is enabled.' },
      { label: 'Leader hint duration', detail: 'When behavior is Timed, control how long the which-key overlay stays visible and how long the pending leader sequence remains active after pressing the Leader key. This setting is only available in Vim mode.' },
      { label: 'Vault text search backend and binary paths', detail: 'Choose Auto, the built-in searcher, ripgrep, or fzf for vault-wide text search. Auto prefers system tools when they are installed and falls back cleanly when they are not, you can provide explicit binary paths for ripgrep or fzf if they are not on your PATH, and Settings now shows the resolved runtime backend that will actually be used.' },
      { label: 'Live preview', detail: 'Hide markdown syntax on lines you are not actively editing.' },
      { label: 'Render tables in live preview', detail: 'Show Markdown tables as interactive WYSIWYG widgets (edit cells, drag, right-click/`m` menu). Turn it off to keep tables as plain markdown text so you can edit them with the keyboard and Vim motions like any other line. When widgets are on, Arrow keys (and h/j/k/l) navigate cells; Shift+V then Shift+J/Shift+K move whole lines in the raw source.' },
      { label: 'Note tabs', detail: 'Enable or disable tab-based editing and split-friendly note workflows.' },
      { label: 'Word wrap', detail: 'Wrap long lines to the editor width or let them scroll horizontally.' },
      { label: 'Blinking cursor', detail: 'Blink the editor caret and the Vim block cursor, or turn it off for a solid cursor — for example to match the macOS "Prefer non-blinking cursor" accessibility setting. Applies to both the insert-mode caret and the Vim normal-mode block cursor.' },
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
      { label: 'Conflict detection', detail: 'When you record a global shortcut that another action already uses, the recorder names the clash and disables Save, so two actions can no longer silently share one key. Any existing clash shows a badge on the affected rows. Vim, navigation, and view keys that deliberately reuse a key by context are left alone.' },
      { label: 'Context-menu bindings', detail: 'The same keymap table controls the context-menu action used in the sidebar, note list, and preview-side active-tab menu, so mouse-free navigation stays configurable.' },
      { label: 'Reset controls', detail: 'Clear an individual override or reset the entire keymap table back to the shipped defaults.' }
    ]
  },
  {
    title: 'Vault',
    items: [
      { label: 'Vault location', detail: 'Reveal or change the root folder ZenNotes treats as the active vault.' },
      { label: 'Primary notes location', detail: 'Treat `inbox/` as the main notes area, or use the vault root directly for an Obsidian-style flat vault.' },
      { label: 'New Drawings & Databases location', detail: 'Choose where new Excalidraw drawings and databases are created so they do not pile up in the vault root: the primary notes location (the default), the folder of the note you are currently viewing, or a specific subfolder you name (e.g. `assets/drawings`). Only new files are affected; existing ones stay put.' },
      { label: 'Daily notes', detail: "Enable a daily-notes workflow, choose a directory pattern, naming pattern, locale, and template so each day’s note starts in the right place. Supported tokens are `yyyy`, `yy`, `M`, `MM`, `MMM`, `MMMM`, `d`, `dd`, `EEE`, `EEEE`, `w`, and `ww`; quote literal words like `'Daily Notes'/yyyy/MM-MMM`. Open today’s note with `Space d`, `:daily`, or the command palette. Two task options live here too: “Tasks are due on the note’s date” makes tasks in a daily note show on the calendar for that day (on by default), and “Roll over unfinished tasks to today” moves every unchecked task from past daily notes into today when you open it (off by default; also runnable from the command palette)." },
      { label: 'Weekly notes', detail: "Enable weekly notes with a directory pattern, naming pattern, locale, and template. Weekly patterns support the same tokens as daily notes plus ISO week `w` and `ww`; the default title pattern is `yyyy-'W'ww`. Open this week’s note with `Space w`, `:weekly`, or the command palette." },
      { label: 'Monthly notes', detail: 'Enable monthly notes with a directory pattern, naming pattern, locale, and template. It creates one note per calendar month, handy for monthly reviews and reflections. The default title pattern is `yyyy-MM` (e.g. `2026-07`). Open this month’s note with `Space m`, `:monthly`, or the command palette. Each notes section in Settings now collapses its fields when its toggle is off.' },
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
      { label: 'Install Command-Line Tool', detail: 'Symlink the bundled `zn` wrapper into a usable PATH location so any terminal session can capture, search, and edit notes. ZenNotes prefers user-writable directories and only prompts for admin access when no writable PATH target is available. The CLI runtime stays packaged with the app, including the dependencies needed by `zn mcp`, so updates ship together.' },
      { label: 'Status, path, and quick reference', detail: 'Settings → CLI shows whether `zn` is installed, where the symlink lives, and a copy-able quick reference of the most useful commands. If the chosen directory is not on PATH yet, Settings shows the exact shell command to add it. An "External install" badge appears when something else owns `zn` so ZenNotes never clobbers an unmanaged binary.' },
      { label: 'Paths with spaces', detail: 'Quote note paths like `zn read "hellointerview/system design.md"` or pass them with `--path "hellointerview/system design.md"` so your shell keeps the path as one argument.' },
      { label: 'Raycast on macOS', detail: 'The Raycast extension requires `zn` and can be installed locally from this settings page. ZenNotes copies the bundled extension into app data, installs dependencies, builds it, and imports it into Raycast. It searches with `zn list --json`, then opens notes in ZenNotes through `zennotes://open` or `zennotes://open-window` and exposes archive, unarchive, trash, reveal, copy path, and copy wikilink actions from Raycast.' },
      { label: 'Uninstall', detail: 'Removes only the ZenNotes-managed symlink — never an arbitrary unmanaged binary named `zn`. The CLI stays inside the app bundle for next time.' }
    ]
  },
  {
    title: 'About',
    items: [
      { label: 'App identity', detail: 'See the ZenNotes app icon, current version, and a short description of the app as a keyboard-first markdown workflow with Vim motions and plain local files.' },
      { label: 'Updates and releases', detail: 'Check for updates, download a newer build, install and relaunch, or jump straight to the latest GitHub release from inside the app.' },
      { label: 'Website, community, and issue links', detail: 'The app now exposes direct links to the ZenNotes website, Discord, GitHub repository, and issue tracker so support paths stay discoverable.' },
      { label: 'Configuration file', detail: 'Your preferences — theme, editor, Vim, keymaps, fonts, search backend, and more — are mirrored to a plain-text `config.toml` so you can sync them across machines with git, stow, or chezmoi. It lives at `$XDG_CONFIG_HOME/zennotes/config.toml` (`~/.config/zennotes/config.toml` on macOS and Linux, `%APPDATA%\\zennotes\\config.toml` on Windows), or wherever `$ZENNOTES_CONFIG_DIR` points. The file is self-documenting: every available setting is listed with its allowed values, and every keymap action is listed with its default binding (commented out — uncomment a line and edit it to remap), so you can discover and change anything without opening the app. Settings → About has Reveal and Copy-path buttons. Existing setups are written out automatically the first time you launch this version, and edits to the file — by hand or via a synced dotfile — apply live without a restart. Machine-specific layout (window size, pane widths, collapsed folders) stays local so the file does not churn.' },
      { label: 'Lumary Labs', detail: 'The About section links to Lumary Labs at lumarylabs.com so company details stay easy to find from inside the app.' }
    ]
  }
]

export const HELP_CLI: HelpCard[] = [
  {
    title: 'What the CLI is for',
    body:
      '`zn` is a command-line companion that talks to your vault directly. It reads and writes the same markdown files the app does, so anything you do in a terminal — capture, search, append, archive, list tasks — shows up in the app instantly. Use it for shell pipelines, scripts, cron jobs, editor plugins (vim, emacs, helix), launcher integrations (Raycast, Alfred), or just because the keyboard is faster.'
  },
  {
    title: 'Install it once from Settings',
    body:
      'Open Settings → CLI and click Install. ZenNotes symlinks the bundled wrapper into a usable PATH location, preferring user-writable directories and only asking for admin access when no writable PATH target is available. After that, `zn --help` works in any new terminal. You can also run the install from the command palette via "Install Command-Line Tool (zn)".'
  },
  {
    title: 'No app required',
    body:
      'The CLI reads from the same vault folder the desktop app uses, so it works whether or not ZenNotes is open. When the app is open, file watchers pick up CLI changes automatically — captures and edits show up live in the sidebar.'
  },
  {
    title: 'Capture is the gateway drug',
    body:
      'The fastest way to add a note is `zn capture "..."`. Pipe-friendly: `pbpaste | zn capture --tag idea` lifts the clipboard into a tagged note. The first non-empty line becomes the title. Markdown works too — `zn capture "- [ ] buy milk"` keeps the leading `- [ ]` as a task in the body (so it appears in the Tasks view) while the title reads "buy milk".'
  },
  {
    title: 'Read and search from the terminal',
    body:
      'Use `zn list` to see recent notes, `zn list --tag work --limit 5` to filter, `zn read inbox/Project.md` to print a body, and `zn search "deadline"` for full-text matches with file:line previews. Quote paths with spaces, like `zn read "hellointerview/system design.md"`, or use `--path`. Add `--json` to any command to get structured output you can pipe into `jq`.'
  },
  {
    title: 'Raycast uses the same CLI',
    body:
      'On macOS, install the Raycast extension locally from Settings → CLI after `zn` is installed. ZenNotes copies the bundled extension into app data, runs the local build, and imports it into Raycast, so you do not need the Raycast Store version. The Search Notes command reads from `zn list --json`, then uses `zennotes://open` to open notes in the main app or `zennotes://open-window` to open a floating window. Cmd+K actions also archive, unarchive, move to Trash, reveal in Finder, copy the path, and copy a wikilink.'
  },
  {
    title: 'Raycast local install requirements',
    body:
      'The local Raycast installer is macOS-only. It needs Raycast, the `zn` CLI, Node.js 22.14 or newer, and npm 7 or newer available from your login shell. Settings shows each requirement, the local extension path, and whether the installed copy is current with the bundled ZenNotes version.'
  },
  {
    title: 'Edit incrementally',
    body:
      'Prefer `zn append` and `zn prepend` over `zn write` for journals and running lists — they preserve the rest of the body. Both accept `--body "literal"` or `--body -` to read stdin (so `cat ideas.txt | zn append daily.md --body -` works).'
  },
  {
    title: 'Tasks and folders',
    body:
      '`zn task list` enumerates open checkboxes across the vault with stable ids. `zn task toggle <id>` flips a task without opening the note. `zn folder list / create / rename / delete` keep your subfolder tree manageable from the terminal.'
  },
  {
    title: 'MCP for AI agents',
    body:
      '`zn mcp` starts the ZenNotes MCP server in stdio mode — the same one Claude Code, Claude Desktop, and Codex use under the hood. Once `zn` is installed, Settings → MCP installs configure the clients to launch `zn mcp` directly, so the install path is one stable absolute path that survives app moves.'
  }
]
