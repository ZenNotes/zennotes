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
      'Type `/` to insert headings, lists, callouts, code blocks, tables, links, images, and other markdown structures. Type `@` to insert date shortcuts like Today and Tomorrow as ISO dates, `@time` / `@now` for the current time, or `@date` to pick any other day from a calendar.'
  },
  {
    title: 'Format a selection',
    body:
      'Select text to pop up a formatting toolbar: bold, italic, strikethrough, highlight, code, math, link, comment, and a “Turn into” menu that re-types the block (Text, Heading 1–3, lists, quote, code). The same actions have keyboard shortcuts that work on every platform, in or out of Vim mode: Mod+B bold, Mod+I italic, Mod+E code, Mod+K link, Shift+Mod+S strikethrough, Shift+Mod+H highlight, Shift+Mod+M math (Mod is ⌘ on macOS, Ctrl on Windows/Linux). Press Mod+/ to focus the toolbar and walk it with the arrow keys; Enter applies, Esc returns to the text. Once a formatted word is typed, **Ctrl+.** (Windows/Linux: **Alt+]**) steps the cursor past the closing markers so you can keep writing outside them, and **Ctrl+,** (Windows/Linux: **Alt+[**) steps back over the previous ones. Repeat either to walk the line pair by pair, brackets included. (The Mac stays off Option chords on purpose: Option+5 is how German-family layouts type `[`.) Pressing the format shortcut a second time (Mod+B again) also leaves the span. All three work in Vim mode and out of it, and the two hops can be rebound in Settings → Keymaps.'
  },
  {
    title: 'Switch between write and read modes',
    body:
      'Use Edit when you want raw markdown control, Split when you want source and rendered output together, and Preview when you want a clean reading surface with keyboard navigation. Switching into Preview opens the reading view at the line you were editing instead of the top of the note. Coming back follows where you read: if you only peeked and your cursor line is still in view, the cursor stays put; if you scrolled on to another part of the note, Edit or Split opens with the cursor on the section you were reading (Split also re-aligns the reading view beside it). To edit a specific passage, double-click it in Preview and the editor opens right there; the “Edit this block” button on an image embed does the same. Each note remembers its own last mode; pick what notes open in before that with Settings → Editor → Default view mode (Edit, Split, or Preview), which travels with your portable config.'
  },
  {
    title: 'Find things in the right place',
    body:
      'Use note search when you know the note title or path, vault text search when you know a phrase inside the note, and the command palette when you know the action you want but not where it lives. Each note search result shows the folder its note lives in, so notes that share a name are easy to tell apart. When note search turns up nothing, Shift+Enter opens a small New note form with your search as the name; pick a folder and tags if you like, press Enter, and the note opens in the editor. A search that comes up empty is two keystrokes from becoming the note.'
  },
  {
    title: 'Keep supporting material nearby',
    body:
      'Tabs, splits, floating windows, the reference pane, and the connections panel are all there to help you keep related material visible while you write instead of forcing constant back-and-forth navigation. The Connections, Outline, Comments, Calendar and Timeline panels stay as you set them while you move between notes. If you would rather each note kept its own, turn off Settings → Editor → Keep panels when switching notes (or run Remember Panels per Note from the command palette): a note then comes back with the panels you left it with, after a restart too (the memory is saved with your tabs and layout, never in the note), and a note you have not opened yet starts with none. With the automatic calendar on, a daily or weekly note whose calendar you closed stays closed when you return to it. The setting travels with your portable config as `keep_panels_across_notes` under `[view]`. The note always keeps a readable width: in a narrow pane (a split, a small window) the panels first shrink, and if they still do not fit, the ones you opened longest ago are tucked into a slim rail at the pane\'s right edge. They stay open; click one in the rail, or press its usual shortcut, to bring it forward.'
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
      'Press the quick capture hotkey (CommandOrControl+Shift+Space by default, configurable under Settings → Editor) to drop a small always-on-top window over whatever app you are using. You type in one place: the first line becomes the note title and the rest is the body. Mod+Enter saves the note into Quick Notes and hides the window; Mod+N saves and immediately opens a fresh blank capture so you can jot several in a row; Mod+P loads an existing note to edit instead. Editing the first line of a Quick note renames that note in place rather than creating a duplicate, and you can drag the window by its top bar to reposition it.'
  },
  {
    title: 'Save a page or text from Safari and other apps (Share → ZenNotes)',
    body:
      'On macOS, choose Share → ZenNotes in Safari or any app with a Share menu to save the page you are on, the text you selected, or both, as a note: in Quick Notes unless you choose another place. The sheet shows what you are saving and, in its heading, where it will go, a line for an optional note, and, when you use more than one vault, the vault it goes to: your local and Cloud vaults and the servers you have connected to. Return saves and Escape cancels; ⌘1 to ⌘9 pick a vault in the order the menu lists them, and the sheet remembers the vault you picked last. A page becomes a note named after the page, with your selection quoted, your note under it and a link back to the page; text on its own becomes a note named from its first line, the way the quick capture window names one. Settings → Vault → Notes → **Default shares location** decides where shares land, per vault: Quick Notes (the default), your primary notes location, or a specific folder inside it such as `Clippings`; a Quick Notes or Inbox folder you remapped is honored, and a vault on a self-hosted server offers the setting once that server runs 2.79 or later (an older server keeps Quick Notes). With ZenNotes running the note appears right away; when it is not running, the share waits and is filed the next time you open ZenNotes, and a share for a server is filed once ZenNotes is connected to that server. The extension comes with the app and registers once you have opened ZenNotes; macOS may list it switched off at first, so if ZenNotes is missing from a Share menu, choose Edit Extensions… at the bottom of that menu and turn ZenNotes on, or turn it on in System Settings → General → Login Items & Extensions → Sharing.'
  },
  {
    title: 'Create a note in the folder you are already in',
    body:
      'When you are browsing a folder, use the current-folder note command instead of creating in Inbox and moving later. That keeps new notes close to the project or area you were already working in.'
  },
  {
    title: 'Start a note from a template',
    body:
      'Open the template picker with `Space t`, the `:template` (or `:tmpl`) ex command, or the “New Note from Template…” command palette entry. It has a shortcut of its own too, which works with Vim mode on or off: `Alt+Mod+T` (⌘⌥T) on macOS, and on Linux and Windows whatever key you give “New note from template” under Settings → Keymap. Pick a built-in template (engineering ones like ADR, RFC/Design Doc, Bug Report, Postmortem, Meeting Notes, and 1:1, or personal ones like Daily Note, Weekly Review, Reading Notes, Journal, Project Kickoff, and To-do) or one of your own. ZenNotes then asks which folder to create it in (defaulting to the folder you are viewing) and fills in variables like the date and week before placing your cursor where the template marks it. To create straight into a specific folder, right-click that folder in the sidebar and choose “New from template”.'
  },
  {
    title: 'Make and edit your own templates',
    body:
      'Open Settings → Templates. Press "New template" to author one: a template is just markdown with optional YAML frontmatter (`name`, `description`, `category`, `titleTemplate`, `targetFolder`, `targetSubpath`) and a body. Use the variables `{{title}}`, `{{date}}`, `{{date:FORMAT}}` (e.g. `{{date:YYYY-MM-DD}}`), `{{time}}`, `{{week}}`, and `{{cursor}}` (where the caret lands). Three more stay live instead of being substituted: `{{modified_date}}`, `{{modified_time}}` and `{{modified_datetime}}` are left in the note and always show when the file was last saved, so an `Updated:` line keeps itself current; `{{modified_date:FORMAT}}` takes the same date tokens. The date format accepts the same tokens as the daily/weekly note directory and title patterns: `yyyy`/`yy`, `MMMM`/`MMM`/`MM`/`M`, `dd`/`d`, `EEEE`/`EEE` (weekday), `ww`/`w` (ISO week), as well as moment-style `YYYY`/`DD`/`dddd`; wrap literal letters in `[brackets]`. Custom templates are saved as plain `.md` files under `.zennotes/templates/`. You can also fork a built-in by pressing Edit on it: that creates an editable copy that shadows the original, and Reset restores the built-in. From any note, the "Save Current Note as Template…" command captures it as a new template.'
  },
  {
    title: 'Draw diagrams with Excalidraw',
    body:
      'Run "New Drawing" from the command palette to create a `.excalidraw` file and open it in a built-in Excalidraw editor tab. Drawings are first-class vault files: they appear in the sidebar, can be moved and archived like notes, and auto-refresh when edited. To embed a drawing inside a note, use "Embed Existing Drawing…" (pick from a searchable list) or "Embed New Drawing" (create one at the cursor and switch to its editor). The embed syntax is `![[name.excalidraw]]`, the same as images, and supports optional size hints like `![[name.excalidraw|600]]` or `![[name.excalidraw|600x400]]`. Clicking an embed opens the drawing in a new tab. Obsidian-style `.excalidraw.md` files are also supported.'
  },
  {
    title: 'Automate repetitive edits with Workflows',
    body:
      'Workflows turn a vault ritual (find the notes tagged `#book`, keep the ones rated 4 or higher, write them as a table into the reading log, tag the rest `#someday`) into a file you run with one key. The feature is off by default: turn it on once under Settings → Workflows and the view appears in the sidebar (also `Space a` in Vim mode, or "Open Workflows" in the command palette). Start from the recipe gallery ("New workflow"): each recipe is an ordinary `.md` file that copies into `.zennotes/workflows/` and opens in the same editor as anything you write yourself, as a canvas and as text, whichever you prefer. Press `R` (or the Run button) and nothing happens blind: a dry-run confirmation lists every change first, grouped and counted, and after you apply, Undo restores every file the run wrote, byte for byte. That promise survives the worst case: a run the app never finished (a crash mid-apply) is found on the next launch and offered back as an undo, and undoing a run names any file you edited after it ran instead of reverting your work silently. You can also run any active workflow without opening the view at all: every one is a command-palette entry, and "Run Workflow…" opens a picker; the receipt arrives as a toast carrying the Undo button. New workflows start as inert drafts until you activate them, and importing a workflow someone shared is a review, never an install. New to all of this? Settings → Workflows → Start tutorial walks the whole loop hands-on, on a practice folder it seeds and then removes.'
  },
  {
    title: 'Turn a CSV into a database',
    body:
      'Run “New Database” from the command palette (or right-click a folder in the sidebar → New database) to create one, or just open an existing `.csv` file from the vault. ZenNotes stores a database as a `<Name>.base` folder: `data.csv` (the rows), `schema.json` (field types, select options, saved views), and the record-page notes rows open into. A database opens from its sidebar row like a note: click it, or press Enter or `l` on it in Vim mode (the row’s `m` menu carries Open database too); the chevron still expands the folder to browse its record pages, and the open grid closes like any tab. Edit cells inline in the Table view, group records in a Board by any select field, switch the raw-CSV toggle to see the underlying file, and open a row as a full Markdown page whose frontmatter mirrors the row’s properties (its Open button, Open page in its menu, or `o` in Vim mode). The whole grid is keyboard-driven. See the Database grid shortcuts.'
  },
  {
    title: 'Set the width of a table column',
    body:
      'In the editor, drag the right border of a column’s header to set how wide it is. The note keeps the widths on a line under the table, `<!-- zen:cols=120,auto,90 -->`, which other Markdown apps never show, and Preview, split view and PDF export draw the same widths. A table wider than its column scrolls sideways, in the editor and in Preview alike, instead of squeezing every column; a PDF page cannot scroll, so there the table shrinks to fit. For more room in Preview, raise Settings → Typography → Reading width (up to 1600 px, like Editor width).'
  },
  {
    title: 'Convert a Markdown table into a database',
    body:
      'A note often starts with a small pipe table that outgrows inline editing. Put the cursor in it and run “Convert Table to Database…” from the command palette (`:table_to_database` on the ex line, or `Space l d` in Vim mode); in a rendered table, the same entry sits at the bottom of the cell menu (right-click, or `m` in Vim mode). Confirm a name (prefilled from the heading above the table, or the note’s title) and ZenNotes creates a `<Name>.base` database where new databases go (Settings → Vault → New Drawings, Databases & Tasks location), then replaces the table in the note with a `[[Name]]` link that opens the grid. Every column becomes a field, typed the way an opened CSV is (checkbox, number, date, text) so the Board and filters work at once; cell text travels verbatim, inline Markdown included, and the CSV layer takes care of commas and quotes. Column widths you dragged in the editor carry over; alignment does not, since a grid has none. The swap is an ordinary edit: `u` (or Undo) brings the table back while the database stays in the vault, and the confirmation toast offers an Open button if you want to jump straight to the grid.'
  },
  {
    title: 'Give a note a cover image',
    body:
      'A cover is a wide banner image across the top of a note. Press `Space l c` in Vim mode, run “Add Cover…” from the command palette, or type `:cover` to open the cover picker. Type to search it, move with the arrow keys and press Enter to pick a gradient, a photograph from the gallery (public-domain works from The Met and NASA), or an image already in the vault. Upload image… takes a file from disk, and an image you paste (⌘V / Ctrl+V) or drop anywhere in the picker becomes the cover; paste an https link into the search field to use a picture from the web, or press Tab for the Unsplash tab and its free photos (see the next guide). Gradients, gallery photos and uploads are copied into the vault’s `assets/` folder like a pasted image, so the cover works offline, on a self-hosted server and through Cloud sync, end-to-end encrypted vaults included. Hover the cover for Change cover, Reposition and Remove, or drop an image straight onto it. Reposition (also “Reposition Cover” in the palette and `:cover reposition`) lets you drag the picture up or down, or move it with ↑/↓ (j/k in Vim mode, Shift for small steps); Enter keeps the new position and Escape puts the old one back. The cover is plain frontmatter, `banner: "![[assets/photo.jpg]]"` with the focal point in `banner_y` (0 is the top edge, 1 the bottom), the keys Obsidian’s banner plugins read, so a shared vault shows the same banner there; a `cover:` image, or one written as a plain `[[link]]`, shows too. In Edit and Split those lines fold into one muted line in the note’s properties, such as `cover · lisbon.jpg` or `cover · Unsplash photo by Jane Doe`, since the cover above already shows the picture; the other properties stay as they are. Move the cursor onto that line (the arrow keys, or `j`/`k` in Vim mode) or click it and the raw lines open for editing; they fold again when the cursor leaves. The file itself never changes, so copying, searching and undo work on the lines as written, and with Live Preview off or covers hidden in Settings they show in full. The Assets view counts a cover image as used, renaming or moving the image updates the note, and `u` (or Undo) takes back a cover change made in the editor. Settings → Typography → Note covers decides whether the cover scrolls away with the text, stays pinned above the editor and Read view, or is hidden. A published note’s public page shows its cover too, and so does Quick Look when you press Space on a note in Finder on macOS: both draw it read-only at the note’s focal point. Quick Look follows the Hidden setting and leaves out a cover from the web, since a preview never goes online.'
  },
  {
    title: 'Use an Unsplash photo as a cover',
    body:
      'The cover picker has a second tab, Unsplash, that searches Unsplash’s free photos with an access key of your own. The first time, the tab says how to get one: at unsplash.com/developers, open Your apps, create a New Application (a free Unsplash account is enough) and copy its Access Key; then press Enter on Open Settings and paste the key into Settings → Typography → Covers → Unsplash access key (“Set Unsplash Access Key…” in the command palette goes there too). Save checks the key with one request to Unsplash and keeps it unless Unsplash refuses it, Test asks again and says how many of the hour’s requests are left, and Clear removes it. The desktop app keeps the key in your system’s secure storage and the web client in your browser, never in `config.toml` or the vault, and sends it only to api.unsplash.com: searches go from your machine straight to Unsplash, and zennotes.org takes no part. A new Unsplash app allows 50 requests an hour until Unsplash approves it for production; when they run out the tab says so, and if Unsplash stops accepting the key it offers Change key. Press Tab in the picker to switch between Covers and Unsplash (what you typed comes along), press `Space l u` in Vim mode, run “Add Cover from Unsplash…” from the command palette, or type `:cover unsplash mountains` to open the tab on a search. Photos appear as you type; move with the arrow keys (or Ctrl+N/P, Ctrl+J/K) and press Enter to make the selected one the cover. The line under the grid credits the selected photo’s photographer, with links to their profile and to Unsplash. Unsplash’s rules keep its photos on Unsplash, so unlike a gradient or a gallery photo the picture is not copied into `assets/`: the note links to it, `banner: "https://images.unsplash.com/…"`, with the credit on the two lines under it, `banner_credit` (the photographer) and `banner_credit_url` (their Unsplash profile). In the editor the three lines fold into one, `cover · Unsplash photo by …`, until the cursor moves onto it. Hover the cover to see “Photo by … on Unsplash” with both links; a published note’s page always shows it. The picture needs a connection to load. One you have seen before usually still shows offline; otherwise the cover says it could not load the picture from images.unsplash.com. To keep a photo for offline use, download it from unsplash.com and drop it on the picker. The Covers tab never goes online. Choosing another cover or removing this one takes the credit away with it.'
  },
  {
    title: 'See a folder as a gallery of its covers',
    body:
      'The Gallery shows one folder’s notes as a grid of cards: each card leads with the note’s cover (an image in the vault, an Unsplash photo or a gradient, cropped to fill the card at the cover’s focal point), then its title and date. A note without a cover gets a quiet card with the first letter of its title. Right-click a folder in the sidebar and choose Open as Gallery, run Open Folder Gallery from the command palette, press `Space G` in Vim mode, or type `:gallery`. The palette, `Space G` and a bare `:gallery` open the folder under the sidebar cursor while the sidebar has focus, and the open note’s folder otherwise; `:gallery Projects/Website` names a folder (a path in the vault, a folder in your notes, or a system folder such as `archive`). Each folder opens as a tab of its own, named after the folder. The header shows how many notes there are, a Sort menu (Updated, the default, puts the last edited first; Created puts the newest first; Title goes A to Z), and an Include subfolders switch, off by default, that adds the notes in the folder’s subfolders. Both choices apply to every Gallery and are kept in `config.toml` as `gallery_sort` and `gallery_include_subfolders` under `[view]`. A database’s record pages and drawings are left out. In Vim mode h / j / k / l move across the grid, gg / G jump to the first and last card, Enter or `o` opens the note and / filters the cards by title; with Vim mode off the arrow keys move, Enter opens and you click into the filter to type. Escape clears the filter. Click a card to open its note; Ctrl+O comes back to the Gallery, on the card you opened. Only the cards on screen are drawn, and a note is read for its cover only when its card scrolls into view, so a folder of thousands of notes opens at once. It works the same in a vault on a self-hosted server and in the web app, and at phone width it keeps two columns.'
  },
  {
    title: 'Give a vault a name of its own',
    body:
      'A vault is named after its folder, which is fine until several vaults are all called `docs` (one per project repo, say). Rename the vault without touching the folder: run “Rename Vault…” from the command palette (`:vault_rename` on the ex line), pick it from the sidebar’s vault menu (click the vault name at the top of the sidebar), or type the name into Settings → Vault → Location → Vault name. The name shows in the sidebar header, the vault switcher (`Space v`), the title bar and `zn vault list`; the folder keeps its name on disk, and clearing the field goes back to it. It is saved in the vault’s own `.zennotes/vault.json` as `displayName`, so it travels with the folder to every machine that opens it and shows up in the switcher after the vault has been opened there once. A temporary folder session and a remote workspace do not offer it: the first writes nothing into its folder, and the second’s settings belong to its server.'
  },
  {
    title: 'Move a note without dragging',
    body:
      'Use the note context menu, search for `move` or `mv` in the command palette, or run `:move` or `:mv`. With no argument, ZenNotes opens a folder picker that speaks the sidebar\'s language: folders of your notes area as you see them there (`Work/Research`, no `inbox/` in front, and empty for the notes root, which is Inbox or the vault root depending on your Primary notes location), plus `archive/…` for the Archive. With a target like `:mv Work/Research` or `:mv archive/Reference`, it moves the note directly; `inbox/Work` still works on an Inbox vault.'
  },
  {
    title: 'Give any command a key',
    body:
      'Every command in the command palette can take a key of its own, from Move Note to Trash to Toggle Word Wrap; all of them start unbound. In the palette, highlight a command and press `Alt+Enter` (Option+Enter on macOS): a recorder opens over the palette, you press the key, Enter saves and Escape goes back to the same row, which now shows its key. Or open Settings → Keymap, where the Commands group lists every command with its category and id (filter by title, category, keywords or id; Settings search finds a command by its title too), and use Change…, Unbind and Reset as on any other row. A command’s key is a chord with Ctrl, Alt or Cmd, such as `Mod+Backspace`, or a function key; with Vim mode on it can also be a leader sequence, the leader and then one to three keys, such as `Space x t`. Sequences run through the leader like the built-in ones and show in the leader hints; with Vim mode off they do nothing, and Settings marks them “Inert with Vim off”. Built-in leader keys always win, so a sequence may not start on one: `Space t` is the template picker, so `Space t x` is refused. A key you give a command wins over every default, the editor’s own keys included (a command on `Mod+Backspace` runs even in the editor, where that key would delete to the line start), and the recorder says which default it takes over. Two of your own keys cannot share one: the recorder refuses a key another of your bindings holds, and marks both rows when config.toml has made them share. When the command cannot run where you are, the key does nothing and a short note says why, for example “Restore from Trash only works on a note in the Trash”. From the ex line, `:bind <C-BS> note.trash` or `:bind <leader>xa note.archive` binds and `:unbind command note.trash` takes the key away. In `config.toml` the keys live under `[keymaps.commands]`, as `"note.trash" = "Mod+Backspace"` or `"note.archive" = "Leader x a"`.'
  },
  {
    title: 'Act on multiple sidebar items',
    body:
      'Use Cmd-click on macOS or Ctrl-click on Windows/Linux to toggle notes and folders in the sidebar. Use Shift-click to select a visible range. The context menu then applies to the selected set, including open in tabs, move, archive, trash, restore, delete folders, copy paths, and drag/drop moves where those actions make sense.'
  },
  {
    title: 'Trash notes from the sidebar',
    body:
      'With the sidebar focused, `Mod+Backspace` (⌘⌫ on macOS, Ctrl+Backspace on Windows and Linux) moves the note under the sidebar cursor to the Trash, after the same confirm Move Note to Trash shows; in Vim mode `x` does the same. When that note is part of a multi-selection, the whole selection goes, with one confirm (“Move 3 notes to Trash?”). Escape on the confirm leaves everything as it was, and after the move the cursor sits on the row that took the note’s place, still in the sidebar. A folder is not trashed this way, since deleting a folder takes everything inside and cannot be undone: delete it from its menu (`m`, or right-click). The palette’s Move Note to Trash and Move Note to Archive, and any key you gave them, follow the sidebar the same way: with the sidebar focused and its cursor on a note, they act on that note (or the selection it is in) rather than the note open in the editor. Rebind the chord as Move sidebar note to Trash (`nav.sidebarTrash`) under Settings → Keymap, or unbind it; `x` is Delete selected result (`nav.delete`).'
  },
  {
    title: 'Ctrl, Alt and Cmd keys in list views',
    body:
      'An action in a list view (Archive, Trash, Quick Notes, Tags, Tasks, Unresolved Links, a folder’s Gallery, Workflows, the Timeline) can take a chord such as `"nav.delete" = "Ctrl+Backspace"` or `"nav.delete" = "Mod+Backspace"` in `config.toml`, or from Settings → Keymap, and so can the sidebar’s Delete selected result. Unlike the single letters, such a chord works with Vim mode on or off. `Mod` means ⌘ on macOS and Ctrl on Windows and Linux, so one config.toml serves both. A global shortcut keeps its key everywhere, though: an action bound to Mod+P would lose to Search notes, so Settings marks such a binding “Never fires” and names the shortcut that has the key.'
  },
  {
    title: 'Read a note beside its source',
    body:
      'Switch the active pane to Split mode when you want markdown on one side and rendered output on the other. Use Preview when you only want the rendered view, or keep Edit when you want the least visual noise while writing.'
  },
  {
    title: 'Find links to notes you have not written yet',
    body:
      'Link a note before it exists, like `[[Garden Plan]]`, and the Unresolved Links view keeps it for you: every `[[wikilink]]` in the vault that points at a note that does not exist yet, grouped by the missing note with the most-linked first, and under each one the notes that link to it and the line each link sits on. Open it with `Space u` in Vim mode, `:unresolved`, Open Unresolved Links in the command palette, or the All unresolved links row under a note\'s missing links in the Connections panel. Enter on a name creates the note where `gD` would (in Inbox, named after the link) and opens it, and the name leaves the list; Enter on a line opens the linking note with the cursor on the link; `K` (Shift+Cmd+K, or Shift+Ctrl+K on Windows and Linux) writes the missing note in the link popover without leaving the list. In Vim mode j / k move, gg / G jump to the ends and / filters; with Vim mode off the arrows, Enter and Escape do the work. A link is listed exactly when the editor draws it as unresolved: a heading (`[[Note#Heading]]`), block (`[[Note^id]]`) or display-text (`[[Note|text]]`) link to an existing note resolves, so does a link to a file in the vault or to a `.base` database, and a `[[link]]` inside a code block or inline code is text, not a link.'
  },
  {
    title: 'Edit or create a linked note without leaving yours',
    body:
      'Rest the pointer on a `[[wikilink]]` in the editor and the link popover opens: the note the link names, in a small floating editor over the note you are in. It is the note itself, not a preview: what you type there is saved to it like any other edit, and shows up in any tab that has it open. Move the pointer away and it closes; click or type in it and it stays until you press Escape or click outside it. A link to a note that does not exist yet offers Create note instead: press Enter (or click it) and the note is created where `gD` would put it, then opens in the popover, ready for its first line. From the keyboard, put the cursor on a link and press `K` in Vim mode, or Shift+Cmd+K (Shift+Ctrl+K on Windows and Linux) with Vim mode on or off. The popover takes the keyboard: `K` on a link inside it moves on to that note, Cmd+Enter (Ctrl+Enter) opens the note in a tab, and Escape closes it and puts you back on the link you came from, cursor where it was. In Vim mode the first Escape leaves insert mode as usual and the next one closes the popover. A `[[Note#Heading]]` link opens it on that heading. To keep the popover to the keyboard only, turn off Settings → Writing → Link popover on hover.'
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
    title: 'Preview a note in Finder with Quick Look',
    body:
      'On macOS, select a Markdown file in Finder and press Space: Quick Look shows it the way ZenNotes renders it, in your theme and fonts, with callouts, tasks, tables, code, math, Mermaid diagrams and the images the note embeds. Press Open in ZenNotes to open it in the app: a note inside a vault you use opens there, any other file in its own window. Once you click into the preview, Enter does the same, and with Vim mode on `o` opens it too while `j` / `k`, Ctrl+D / Ctrl+U, `gg` and `G` move through the note. The preview is read-only and never goes online: links to websites open in your browser, wikilinks and tags stay plain text, and pictures on the web are not loaded. The preview comes with the app and turns on after you open ZenNotes once; to use another app\'s preview, turn ZenNotes off in System Settings → General → Login Items & Extensions → Quick Look.'
  },
  {
    title: 'Check for updates and install them',
    body:
      'Use Check for Updates from the app menu, the command palette, or Settings → About. ZenNotes also checks on its own shortly after launch. If that check finds no network (Settings → About then says "Waiting for network"), nothing needs doing: it checks again by itself once the connection is back, and keeps trying at growing intervals if GitHub stays out of reach. A check that runs while a new release is still being published says so (for example "ZenNotes 2.79.0 is still being published"): try again in a few minutes. Any other failed check or download is one sentence in Settings → About, with the technical text under Details, where Copy details and Report an Issue help with a bug report. When a release is available, ZenNotes can download it in the background and then prompt you to install and relaunch. A copy installed by a package manager (the AUR package, or a tarball unpacked by hand) is only told that a newer version exists; install it the way you installed ZenNotes, since the package manager owns those files. On Arch, a `.pacman` build installs through a graphical polkit prompt; dismissing it keeps the download ready to retry, and if no graphical agent can run, Details in Settings → About shows the manual install command.'
  },
  {
    title: 'Run the self-hosted web version with Docker',
    body:
      'Prefer ZenNotes in a browser instead of the desktop app? Pull the prebuilt, multi-arch image from Docker Hub with `docker pull adibhanna/zennotes`, generate a login token and keep a copy (`openssl rand -hex 32`), then start the container with your vault mounted:\n`docker run -d -p 127.0.0.1:7878:7878 \\\n  -e ZENNOTES_AUTH_TOKEN=<your-token> \\\n  -v "$HOME/Documents/MyVault:/workspace" \\\n  -v "$HOME/zennotes-data:/data" \\\n  adibhanna/zennotes:latest`\nThe server binds to 0.0.0.0, so it will not start without that token. Open http://localhost:7878 and paste the token on first connect. Your notes stay as ordinary .md files on the host, and the desktop app can point at the same server. The full walkthrough, including reverse-proxy and TLS hardening, lives at zennotes.org/docs. The image is built from the server’s own repository, ZenNotes/znserver, whose releases also carry standalone `zennotes-server` binaries for running it without Docker.'
  },
  {
    title: 'Share Typst definitions across notes with tags',
    body:
      'With the **Typst** math renderer, Settings → Editor → **Typst definitions from tags** lets a note\'s tags decide which Typst definitions its formulas compile against, so `vector()` can be an arrow in physics and bold in maths without redefining it in every note. Write a preamble as an ordinary note inside the preamble folder (named `typst` unless you change it), titled with the tag path in dots: `typst/physics.md` applies to `#physics`, `typst/physics.mechanics.md` to `#physics/mechanics`. Nested tags layer general → specific, so the narrower tag wins, and a note carrying several tags gets them in alphabetical order so the same tags always compile the same way. Preamble notes are ordinary notes: they sync, they are searchable, and editing one re-renders every note that uses it. Off by default, and it costs nothing when off.\n\nOne thing preambles do **not** do is add tags. A preamble is Typst source, where `#let vec(x) = bold(x)` defines a variable and formulas refer to it as `#vec`, so treating those as hashtags filled the tag list with `let` and every variable name. Notes in the preamble folder are left out of the tag index on every runtime: the app, the `zn` CLI, MCP, and the self-hosted server. If you already keep ordinary tagged notes in a folder called `typst`, point Settings → Editor → **Typst preamble folder** somewhere else and those notes get their tags back. The name is stored in the vault, so it travels with it.'
  },
  {
    title: 'Connect the desktop app to a self-hosted server',
    body:
      'Settings → Vault → Remote workspace takes the server URL and its token. **On macOS**, a server on your own network also needs the system Local Network permission: macOS asks the first time ZenNotes reaches a local address, and if you dismiss that prompt the connection fails with no packets sent and no further warning: it looks exactly like a server that is down. Turn it back on under System Settings → Privacy & Security → Local Network. A server reached over the public internet is unaffected. Live updates travel over a WebSocket at /api/watch. If a reverse proxy in front of the server does not pass WebSocket upgrades, the app refreshes on its own every 30 seconds instead, so a note renamed or trashed on another device can show its old name for up to half a minute; passing the upgrade through gives instant updates.'
  },
  {
    title: 'Encrypt a Cloud vault end to end',
    body:
      'End-to-end encryption keeps a Cloud vault\'s notes, attachments, file and folder names, and the vault\'s own name unreadable to ZenNotes Cloud: your devices encrypt everything before it is uploaded, with a key only you hold. Settings → Cloud shows **End-to-end encryption** (beta) once it is available for your account. Set it up there: choose a passphrase of at least 12 characters (four or more unrelated words work well), then save the 24-word recovery key it shows and type three of its words back. Either one unlocks encryption on your other devices, once per device. ZenNotes never receives them and cannot reset them; if you lose both, the encrypted Cloud copy cannot be read, but the notes on your devices are untouched.\n\nTo encrypt a new vault, tick **End-to-end encrypt this vault** when you create it. To move an existing one, choose **Encrypt this vault** in Settings → Cloud: ZenNotes makes a new encrypted vault with the same name, uploads this device\'s copy, then deletes the readable Cloud copy along with its version history and backups, so download a backup first if you want one. Other devices linked to the old vault stop syncing it; unlock encryption on each one, then open the encrypted vault from Settings → Cloud. Publishing a note from an encrypted vault still makes a readable public copy until you unpublish it. The website cannot export an encrypted vault as a ZIP. In the desktop app, **Save archive** under Backups saves a readable archive; the phone apps send you there. Change the passphrase, make a new recovery key, or lock this device from the same section; zennotes.org/security lists what ZenNotes can and cannot see.'
  },
  {
    title: 'When Cloud reports a problem',
    body:
      'When ZenNotes Cloud can\'t finish something, the status bar and Settings → Cloud say what happened and what you can do, in plain words: **Can\'t reach Cloud** when this device is offline or Cloud is unreachable, or **Signed out of Cloud** when this device was removed from your account on the website. Your notes stay on this device either way. Under the message, **Details** holds the technical line (Cloud\'s answer, its HTTP status and code); **Copy details** puts it on the clipboard, and **Report an Issue** opens the ZenNotes issue tracker on GitHub so you can paste it into a report. The status bar shows these even when you have turned it off under Settings → Appearance → Chrome.'
  },
  {
    title: 'Customize the look: themes vs. overrides',
    body:
      'ZenNotes has two CSS-based ways to change how it looks. A **theme** is a complete palette you select under Settings → Appearance → Custom. An **override** is a small CSS file that layers on top of whichever theme is active, toggled on or off under Settings → Appearance → Overrides. Reach for a theme to design a whole look; reach for an override to change one or two things (a different accent, a darker background) without forking a theme. Both apply live, no restart.'
  },
  {
    title: 'Build a custom theme',
    body:
      'Settings → Appearance → Custom → New theme scaffolds a folder at `~/.config/zennotes/themes/<name>/` with a `manifest.json` and a `theme.css`, reveals it, and adds a card you click to apply. Edits to `theme.css` apply live. Only the active theme CSS is loaded, so write `:root { … }` for the light/shared values and `:root[data-theme-mode="dark"] { … }` for dark. You never put the theme name in a selector. Colors are the `--z-*` tokens, written as space-separated RGB (`--z-accent: 255 59 48;`): backgrounds `--z-bg` / `--z-bg-softer` / `--z-bg-1`…`--z-bg-4`, text `--z-fg-1` / `--z-fg-2` / `--z-grey-0`…`--z-grey-2`, accent `--z-accent` / `--z-accent-soft` / `--z-accent-muted`, and the syntax hues `--z-red` / `--z-green` / `--z-yellow` / `--z-blue` / `--z-purple` / `--z-aqua`. `manifest.json` carries name, author, version, description, `modes` (light | dark | both), and an optional preview swatch.'
  },
  {
    title: 'Set a code block’s language',
    body:
      'In Edit mode every fenced code block carries its language at the top right, as a button reading `typescript ▾` (or `text ▾` when the fence names none), with a copy button beside it. Press the language to open the “Code block language” picker: a find field, then every language the editor can highlight, by name, the current one checked. Type to narrow the list: a language’s tags count, so `golang`, `yml` or `sh` find Go, YAML and Shell, and an exact name comes first, so `c` then Enter is C. A pick rewrites only the opening fence’s language word, so ```` ``` ```` becomes ```` ```typescript ````, keeping the fence’s backticks or tildes, their count and anything after the word, such as a title; the cursor stays where it was, and one Undo takes it back. “Text (plain)” takes the language away. Languages you installed under Settings → Editor → Languages are listed too. A block that names no language is guessed at, when it is long enough to tell: it is highlighted with the guess and its button reads `python · detected`, muted, in a dashed outline. The guess is never written to the note; the picker’s first row, “Python (detected)”, writes it. Tiny or ambiguous blocks stay text, and the reading view colours exactly the blocks the editor guesses, in the same language. From the keyboard, run “Set Code Block Language…” from the command palette, or press `Space l l` in Vim mode, with the cursor in a block; it can take a key of its own (Alt+Enter on its row). In the picker the arrows, Ctrl+N / Ctrl+P, Enter and Escape work with Vim mode on or off; with Vim mode off the find field has the keyboard and every letter is text, and with it on the list does, where j / k move and `/` goes to the find field. Turn the guessing off with Settings → Editor → Detect code block languages.'
  },
  {
    title: 'Add syntax highlighting for another language',
    body:
      'In the desktop app, open Settings → Editor → Languages and select a self-contained `.tmLanguage.json` TextMate grammar. Choose its fenced-code tag and aliases, then edit the sample to verify the live preview before installing it. Enabled languages highlight the same fences in Edit, Split, and Preview without changing your Markdown files. Built-in language and diagram tags stay reserved. ZenNotes stores installed packs machine-wide under `~/.config/zennotes/languages/`; this first version adds highlighting only, not completion, formatting, indentation, or language-server features.'
  },
  {
    title: 'Override one thing on any theme',
    body:
      'An override is a `.css` file in `~/.config/zennotes/overrides/`, toggled under Settings → Appearance → Overrides. Enabled overrides inject on top of the active theme in filename order, so they win the cascade. Target `:root[data-theme] { … }` so the rule beats both built-in and custom themes. Because they sit on top, one override re-themes everything: `:root[data-theme] { --z-accent: 255 59 48; }` turns the accent hot pink on every theme. Overrides stack, so keep several small ones and flip each independently. The seeded `example.css` is a commented cookbook with the full token list and ready-to-uncomment recipes. To find what controls an element, use the **Developer tools** button in that same Overrides section and inspect it.'
  },
  {
    title: 'Bundle fonts and images in a theme',
    body:
      'Ship an asset with a theme by dropping the file in the theme folder and referencing it with the `zen-theme://` scheme, where the host is the folder name: `@font-face { font-family: "Display"; src: url(zen-theme://my-theme/display.woff2); }`. Remote http/https URLs are never loaded, so themes stay self-contained and work offline; small images can also be inlined as `data:` URIs. Font family and text size are not theme tokens. Set those under Settings → Typography.'
  }
]

export const HELP_CORE_CONCEPTS: HelpCard[] = [
  {
    title: 'Notes are real markdown files',
    body:
      'ZenNotes edits markdown on disk. Rename, move, archive, restore, and floating-window operations all work on the underlying files, not an internal copy. A note’s creation date is app-owned metadata kept beside it under `.zennotes/note-metadata`, moved, renamed and deleted with the note by the desktop, the CLI and MCP, so it survives syncs and filesystems that drop birth times; keep `.zennotes` with the vault in backups.'
  },
  {
    title: 'System folders are workflow buckets',
    body:
      'Inbox, Quick Notes, Archive, and Trash are built-in top-level buckets with specific jobs. You can rename how they appear in the UI without renaming the actual folders on disk, which keeps your workflow flexible without breaking the file layout. Or go the other way: **Settings → Vault → Folder Paths** points any of the four at a directory of your choosing (say `01 - Entry` as your Inbox, Obsidian-style), so an existing vault keeps its layout and ZenNotes adapts to it. The mapping is stored in the vault itself and every surface follows it: counts, tasks, search, workflows, the web app, and the MCP server. Single directory names only, no collisions, reserved names refused.'
  },
  {
    title: 'Primary notes can live at the vault root',
    body:
      'Settings → Vault lets you choose between the original Inbox model and a Vault root model. Vault root mode surfaces top-level notes, folders, and loose files directly, which is better for imported Obsidian-style vaults and flat Markdown folders.'
  },
  {
    title: 'Tabs and splits are first-class',
    body:
      'Each editor pane can hold multiple tabs. Split the current tab right or down, move between panes with pane motions, switch the active note between Edit, Split, and Preview from commands, and, if you hide tabs, use the buffer switcher shortcut or `:buffers`. The active tab also has a full keyboard context menu, so actions like Close Others, Close Tabs to the Right, Pin Tab, Pin as Reference, Open in Floating Window, and Reveal in Finder stay accessible without the mouse. If you disable Vim mode, use the command palette instead. Each note keeps its own undo history while the app is open: switch tabs, or close a note and open it again, and `u` / Mod+Z (and redo) still walk through the edits you made to it. Renaming or moving the note you are editing keeps its caret, scroll position and undo history too. If the note was changed somewhere else in the meantime (another pane, sync, an external editor), it starts a clean history, because the old undo steps would no longer fit the text. The same happens the moment a sync tool, a script or another editor changes the file while you are looking at it: the new text appears in place, the caret stays, and Undo starts over instead of undoing your earlier typing underneath text that arrived from outside. Another pane typing into the same note leaves the history alone. On the desktop app you can also keep undo history after quitting, the way Vim\'s `undofile` does: turn on Settings → Editor → Keep undo history after quitting (or `:set undofile` in Vim mode, or the command palette). It is off by default because the history contains text you deleted; it is stored with the app on this computer, never in your vault, histories nobody returns to expire after 90 days, and turning the setting off erases them all. It travels in `config.toml` as `persist_undo_history` under `[editor]`.'
  },
  {
    title: 'Context menus are part of the keyboard model',
    body:
      'ZenNotes treats context menus as keyboard-reachable UI, not mouse-only escape hatches. Use the configured context-menu binding on the selected sidebar or note-list row. In the editor, select text and press `m` to open the text menu with commenting first; `Shift+F10` / the system Context Menu key still opens the active tab menu when no text is selected. The command palette also exposes the same high-value tab actions directly.'
  },
  {
    title: 'Comments attach to selected text',
    body:
      'Select text in the editor and press `Mod+Alt+M` (or open the text menu with `m`) to start a comment, and toggle the Comments panel itself with `Mod+Shift+C`. ZenNotes stores note comments beside the note in vault metadata, then highlights the anchored text and line when the comment is active. In the panel, move with `j` / `k` and use `a` to reply, `e` to edit, `r` to resolve, and `d` (or Backspace / Delete) to delete. Deleting from the keyboard asks first, since a deleted comment cannot be brought back; the card’s own Delete button does not ask. With Vim mode off the letters are off: the arrows move, Enter or → jumps to the comment’s text, Backspace or Delete deletes after the same confirm, and the card’s buttons do the rest. Comments thread: a reply sits under the comment it answers, and each one names who wrote it, so a note can be discussed the way a pull request is. An AI assistant connected through MCP can take part: `list_comments` reads the threads, `reply_to_comment` answers in one, `add_comment` starts a new thread anchored to a passage, and `resolve_comment` closes it, each signed with the assistant\'s name (Claude, Claude Code, Codex) so its replies stand apart from yours. `zn comment list|add|reply|resolve` does the same from a terminal.'
  },
  {
    title: 'The home view is where you land',
    body:
      'When no note is open (outside Zen mode), ZenNotes shows a light home view instead of a blank pane: a greeting, quick-create actions (new note, database, drawing, plus daily and weekly notes when those are enabled in Settings), your most recently edited notes, your Favorites, and the tasks due today or overdue, with an overdue count. The Favorites section sits right after Recent and mirrors the sidebar’s list in the same order: a favorited note opens in place, a favorited folder opens that folder in the note list (bringing the sidebar back if it was hidden), and the section stays out of the way until you favorite something. Favorite a note from the sidebar row’s context menu, `Space l s`, or the command palette’s “Add Note to Favorites” (on the phones, the same entry sits in the ••• sheet and in the long-press note menu). Click a note or task to open it, tick a checkbox to complete a task in place, and use ↑/↓ (or j/k in Vim mode) then Enter to move and open from the keyboard.'
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
      'Tasks scans every note for checkboxes and groups the open ones by when they are due: Today (due today or overdue), Upcoming, and No due date, then Waiting, Forwarded, Done, and Cancelled. A task written in a daily note counts as due on that note’s date while “Tasks are due on the note’s date” is on (Settings → Daily notes). Inside each group the list keeps the notes’ line order, or puts high priority first when its Order menu, above the list, says Priority (`s` in Vim mode). Tags lets you browse notes that carry all of the selected tags (toggle Match to Any for a union), Archive gives you a dedicated list of cold-storage notes, and Trash gives you a recovery surface for deleted notes without turning the left rail into a second browser. Selected tags accumulate so you can narrow across several at once; clear them with the Selected strip’s “Clear all”, the `c` key, or a right-click on any tag chip (which also offers “Unselect others” to keep just that one). A tag chip’s context menu also carries “Rename Tag…” and “Delete Tag…”, which rewrite or remove that hashtag across the whole vault. Tags work in any script (`#тест` and `#标签` are tags), while headings (`# x`) and hex colors (`#1971c2`) are not.'
  },
  {
    title: 'Tags find the idea, not just the note',
    body:
      'Open a tag (click it in the sidebar or in a note, or run `:tag idea`) and the Tags view lists each matching note with its tagged blocks under the title: every list item, paragraph, quote, or table row inside the note that carries the tag. Several unrelated ideas jotted into one note show up one by one instead of as one note you have to read through. A tagged list item brings its nested items along, and a tag on a heading tags its whole section: the row shows the heading with the first lines under it. Enter, `o`, or a click on a block opens the note at that line and highlights it; Enter on the note row opens the note at the top as before. The header counts both (“3 notes · 5 blocks”). The filter box narrows to the blocks whose text matches what you type, and keeps every block of a note whose title matches. With Vim mode on, `}` and `{` hop from note to note past the blocks. Tags in frontmatter tag the whole note, so a note tagged only there stays a plain row, and a `#tag` inside code is never a tag. A block you type into an open note lists right away.\n\nSearch notes shows the same blocks. Type `#idea` and each matching note lists up to two of its tagged blocks under it, then a “+N more tagged blocks” row that opens the rest in the Tags view; Enter on a block opens the note at that line. Words after the tag narrow the blocks to those containing them (marked in each block), and a note found by such a word deep in its body is listed too, while a note that matched only by its title stays a plain row. With several tags (`#idea #later`) notes still carry all of them, and the blocks carrying all of them come first. Without a `#tag` the palette lists notes as always. If the extra rows feel cluttered, turn off Settings → Editor → Search → **Show tagged blocks in note search** (`tagged_blocks` under `[search]` in config.toml).'
  },
  {
    title: 'Archiving a note retires its tasks',
    body:
      'When a note moves to the Archive, its tasks leave the Tasks list, the Kanban boards, and the calendars with it, keeping Done focused on recent work instead of years of finished projects. Nothing is written: the markdown keeps its checkboxes, and un-archiving the note brings its tasks straight back. Archiving a note that still has open tasks asks first, so live work never disappears silently, and a bulk archive from the sidebar asks once for the whole set. Prefer the old behavior? Settings → Tasks → “Show tasks from archived notes” (or `show_archived_tasks` in `config.toml`) keeps archived tasks on every surface, including the Archive column on the folder Kanban board, which otherwise steps aside.'
  },
  {
    title: 'Not every checkbox is a task',
    body:
      'A reading list is a checklist, not a to-do. Add `tasks: false` (or `off`) to a note’s frontmatter and its checkboxes stay checkboxes: they render and toggle exactly as before, but stop feeding the Tasks list, the boards, the calendars, `zn task list`, and the MCP tools. On a #task note, `tasks: note` keeps the note itself on the board while silencing its internal checklist, so a project note can be one card instead of twenty. To collect tasks from a few folders only, such as a single Tasks folder, right-click each one in the sidebar and choose “Use as Task Folder”: once any Task folder is set, checkboxes everywhere else stay plain checkboxes. To retire a whole folder instead (a media backlog, a reference library), choose “Exclude from Tasks”, which also works inside a Task folder. Both lists live under Settings → Tasks and in the vault’s own settings, so the desktop app, the self-hosted web app, the CLI, and the MCP tools agree. When you do want to see past them, `zn task list --include-excluded` and the MCP `list_tasks` tool’s `includeExcluded` flag list everything.'
  },
  {
    title: 'Check off a task with ⌘L',
    body:
      'Press `⌘L` (`Ctrl+L` on Windows/Linux) in the editor to mark the task under the cursor done, or to turn the current line into a checkbox and toggle it on repeat: plain text becomes `- [ ] text`, an existing bullet or numbered item keeps its marker (`* note` becomes `* [ ] note`), and pressing again flips `[ ]` to `[x]` and back. An in-progress `[/]` checks off to `[x]`; forwarded `[>]` and cancelled `[-]` lines are left alone, since those states have their own commands. It applies to every line of a multi-line selection, works with Vim mode on or off (in Vim it works from normal, insert, and visual mode and leaves you in the mode you were in, so `Vjj` then `⌘L` checks off three tasks and one `u` undoes them), is remappable as `editor.toggleCheckbox` under `[keymaps]` in `config.toml`, and is also in the command palette as “Toggle Checkbox”.'
  },
  {
    title: 'Reflow a hard-wrapped paragraph',
    body:
      'Text pasted from a terminal, an email, or a model reply often arrives hard-wrapped at 80 columns, and in the editor every one of those source lines spills a word or two onto a second row. The preview already reflows such prose; press **Alt+Q** (macOS: **Ctrl+Q**) in the editor to join the lines of the paragraph under the cursor into one line, so the editor wraps it to the pane too. With a selection it reflows every paragraph the selection touches. Headings, list and quote markers, tables, code blocks, `$$` math, and explicit line breaks (two trailing spaces, a backslash, `<br>`) are left alone, and the change is a normal edit, one undo away. It works with Vim mode on or off, is remappable as `editor.reflowParagraph` under `[keymaps]` in `config.toml`, and is in the command palette as “Reflow Paragraph”. In Vim mode it is also the `gq` operator: `gqip` reflows the paragraph, `gqj` two lines, `Vgq` a selection, and `gw` does the same while keeping the cursor in place.'
  },
  {
    title: 'A whole note can be a task (task files)',
    body:
      'Besides inline `- [ ]` checkboxes, a whole note can itself be a task: give its frontmatter a `task` tag (`tags: [task]`) and its metadata lives in frontmatter, including `status` (open / in-progress / done…), `priority` (high / normal / low), `due` and `scheduled` (`YYYY-MM-DD`), plus any `tags`, while the note body holds free-form detail or sub-checkboxes. These "task files" show up in the Tasks views right alongside inline tasks, so both styles live in one vault. This is the TaskNotes convention, so a vault stays interoperable with TaskForge and Obsidian. Quick-add one from the command palette (**New Task**, or **New Task in Folder…** to choose where it lands), the "+ New task" button in the Tasks header, the `a` key (Vim mode), or the `:newtask` / `:task` ex command; `:newtask Projects/Website` drops it straight into a folder so multiple projects stay organized. New task files default to your configured tasks location (Settings → Vault → Notes → **Default tasks location**, or search Settings for "tasks folder"). That is your primary notes area unless you pick the active note’s folder or a specific folder, and a specific folder lives inside the primary notes area: `Tasks` means `inbox/Tasks/` in an Inbox vault and `Tasks/` in a root vault, as the setting itself shows. The folder-picking options override it per task. Checking a task file off rewrites its frontmatter (`status: done` and a `completedDate`) rather than a checkbox character, and rescheduling from the calendar or changing its column on the Kanban board updates the matching frontmatter field. Delete on a task file trashes the whole note (after a confirm).'
  },
  {
    title: 'The Tasks calendar schedules and reschedules',
    body:
      "Switch Tasks to Calendar (button or `2`) to see tasks laid out by due date. A task written inside a daily note automatically shows on that day (no `due:` needed), so the day you wrote it on is the day it lands. Type in the box under the grid to add a task to the selected day (it’s created in that day’s daily note, offering to create the note first for a day that has none). Reschedule by dragging a task onto another day, or from the keyboard: `Tab` picks a task in the day list, `<` / `>` shifts it a day earlier/later, and `T` moves it to today."
  },
  {
    title: 'The Timeline panel shows what is coming up',
    body:
      'The Timeline is a right-hand panel beside your note that lays every open task in the vault with a date down one line, in date order. Open it with `Mod+7`, `Space n` in Vim mode, `:timeline`, Toggle Timeline in the command palette, or its button in the note header. A task’s date is its `due:` date, or for a task in a daily note, that note’s date, the same as the calendars. Overdue tasks sit on top in red, each with how many days late it is; Today follows with the accent ring, then one node for each later day that has work, and a run of empty days in between folds into one “N quiet days” line. Which tasks count is the Tasks view’s rule: open Today and Upcoming work, `[/]` in progress included; done, cancelled, forwarded and @waiting tasks keep to their own groups in Tasks. The header counts what is on the rail (“9 open · 2 overdue”), and the switch under it reaches 2 weeks ahead (the default), a month, or All; tasks past the range are counted at the bottom, and clicking that count shows them all. The choice is kept in config.toml as `timeline_range` under `[view]`. The filter takes the Tasks filter syntax: words, `#tag`, `!high`, `@key:value`. Tag a task `#milestone` to make it a milestone: its day draws as a diamond marked “· milestone”, its row stands out, and it says how many open tasks are due before it, counted from the previous milestone (or from the top of the rail for the first one, overdue included), so each task counts toward exactly one milestone. Nowhere else treats `#milestone` as special. Undated tasks stay off the rail; “N undated in Tasks” at the bottom opens the Tasks view, where they are listed. Click a row (or press Enter) to open the note at the task’s line, tick its box to check it off (it leaves the rail), right-click for the task menu, and rest the pointer on it to read the note. In Vim mode `j` / `k` move, `gg` / `G` jump to the ends, `x` ticks, `m` opens the task menu and `/` focuses the filter; with Vim mode off the arrows, Home / End, Enter and Escape work. Escape (or ←) hands the keyboard back to the note. Like the other panels it resizes from its left edge, tucks into the rail in a narrow pane, and stays open as you move between notes.'
  },
  {
    title: 'The Tasks Kanban board, custom statuses, and any field',
    body:
      'Switch Tasks to Kanban (the button, or `3` in Vim mode) for a column board. "Group by" offers Status (Today / Upcoming / No due date / In progress / Waiting / Done, derived from due dates, `[/]` and `@waiting`), Priority, Folder, Custom status, and one entry per inline `@field` you use. The Folder board gives every note folder its own column (`Projects/alpha`, `Areas`, the Inbox root, Quick Notes), so notes that live together group together with nothing to maintain; point it at one folder under Settings → Tasks → Folder board, with `:folderroot Projects` on the board, or with `kanban_folder_root = "Projects"` in config.toml, and that folder\'s children become the columns, deeper notes roll up to their child, and notes outside it share an Other folders column. Folder columns stay read-only: move a note to change its column. On the Status board a started task (`[/]`) sits in its own In progress column between No due date and Waiting: drop a card there (or send it with `Shift+L`) to mark it `[/]`, drop it back on Today or Upcoming to reopen it with that date (or on No due date to reopen it without one: that drop clears its `due:`, and a daily-note task, whose date is its note’s, cannot take it), and a `@waiting` card keeps its `[/]` underneath so clearing the wait returns it to In progress. Any task field works: tag tasks with `@key:value` tokens like `@status:review`, `@sprint:24`, or `@area:backend`, and each key becomes its own board with a column per value (auto-discovered, so it appears the moment you use it). For the status field, define the columns under Settings → Tasks → Kanban statuses, or list them in order in `config.toml` under `[view]`, e.g. `kanban_statuses = ["backlog", "in_progress", "review", "done"]`; other fields sort their columns automatically. A note-level `status:` in frontmatter sets a default for that note’s tasks. A note tagged `task` is a card of its own: its frontmatter `status:` is its custom status, and without one it sits in the trailing No status column until you move it. Finished and cancelled tasks leave the boards, with one exception: a task note whose `status:` names one of your Kanban statuses stays in that column on the Custom status board, so a `done` column holds the task notes you finished, still checked. Everything is keyboard-first: `h`/`l` move between columns, `j`/`k` between cards, `g` cycles the group-by, `Shift+H` / `Shift+L` send the focused card to the previous/next column (rewriting its `@field` token), `<` / `>` reorder the columns themselves (saved per board), and `Space`/`Enter` toggle/open. Drag does the same with the mouse, including dragging a column header to reorder, and dragging a card to a new spot inside its column to hand-prioritize it (that arrangement is saved per column and restored when you come back to the board). To have the cards follow their dates instead, set **Order** in the board\'s toolbar to Due date (`s` in Vim mode, `:order due` on the ex line, or `kanban_card_sort = "due"` under `[view]` in config.toml): every column on every board, custom status boards included, then sorts by due date, earliest first and cards without one last, and a card dropped into another column lands in its date slot. Your dragged arrangement is kept meanwhile, and Manual brings it back. On a board wider than the window, hold a dragged card or column header near the board\'s left or right edge and the board scrolls that way, faster the closer you get to the edge; a card held near the top or bottom of a long column scrolls the column. After a drop the cursor sits on the card or column you moved, so the keyboard picks up where the mouse left off. Renaming a column (click its title, or `[kanban_column_titles]` in `config.toml`) sets a display label only: the column still shows its underlying `@field:value` beneath the name, and moving a card in writes that value, not the label.'
  },
  {
    title: 'Filter the Tasks views to one project',
    body:
      'The filter box in the Tasks header narrows all three sub-views: the list, the calendar, and the Kanban board (where cards filter out but the columns stay put, so the board keeps its shape while you type). Press `/` to focus it (Vim mode), type in it directly, or run `:filter <text>` from the ex line; `Esc` or a bare `:filter` clears it, and the query survives switching views, so a filtered list stays filtered when you jump to the board. Matching is a simple substring check across the task text, the note title, tags (with the `#`, so `#project-beta` narrows to that tag), `!high`-style priorities, and `@key:value` fields. A task that is a whole note (made with New task, `tags: [task]` in its frontmatter) also matches a `#tag` written anywhere in its body, so you can tag it while you write its notes, where the tag picker helps; a checkbox task matches only the tags on its own line. The fields are the project trick: tag tasks with `@project:alpha`, then filter `@project:alpha` while the board is grouped by status, and you have a one-project board; the header shows how many tasks match. A filtered board is still fully live: drag or `Shift+H`/`L` still move cards, and hand-arranged card order is preserved for the cards the filter is hiding. A query worth typing twice is worth saving: press **Save filter…** in the row under the header (or run `:savefilter <name>`) and it becomes a chip there; click a chip, run `:filter <name>`, or press `F` (Vim mode) to pick one from a list, and the command palette lists every saved filter as "Tasks: name" so you can jump to it from any note. Right-click a chip to rename or delete it. Saved filters are kept in config.toml under `[saved_filters]`, one `"Name" = "query"` line each, so they travel with your dotfiles and a hand edit applies live.'
  },
  {
    title: 'Forward a task to another note',
    body:
      'Forwarding moves a task to a different note while leaving a record behind (the bullet-journal “migrate” gesture). Type `>` inside a task’s checkbox (turning `- [ ]` into `- [>]`) to open a note picker, run “Forward Task to Note…” from the command palette with the cursor on a task, or press `>` on a task in the Tasks list. The picker filters as you type and preselects the first match, so typing part of a note’s name and pressing Enter forwards straight there; ↑↓, Ctrl+J / Ctrl+K, and Ctrl+N / Ctrl+P step between the matches. The original stays as `- [>] … [[Target]]` (a forwarded marker linking to where it went), and a fresh `- [ ] … [[Source]]` copy is added to the note you pick, backlinked home. A task’s indented subtasks travel with it: the copy carries the whole block, done and cancelled children included, so the destination reflects the task’s current state, while open subtasks in the source flip to `[>]` alongside the parent (done and cancelled ones keep their state as history). Forwarded tasks collect under their own “Forwarded” group in the Tasks list, kept out of Today and Done.'
  },
  {
    title: 'Cancel a task',
    body:
      'Cancelling marks a task as intentionally abandoned, distinct from done (finished) or forwarded (moved). Write `- [-]` directly, run “Cancel Task” from the command palette with the cursor on a task, or press `c` on a task in the Tasks list (press `c` again to un-cancel). A cancelled task renders with a muted `✕` and struck-through text, and collects under its own “Cancelled” group in the Tasks list, kept out of Today, Done, and the Kanban board. A whole-note task file cancels the same way, writing `status: cancelled` to its frontmatter.'
  },
  {
    title: 'Right-click a task for actions',
    body:
      'Every task surface has the same right-click menu: the Tasks list, the Kanban board, the Tasks calendar, the calendar side panel, and the Timeline panel. It carries Open note, Mark done, Mark in progress, Cancel, @waiting, Forward to note…, due-date presets (today / tomorrow / next week / clear) with Choose a date… for any other day, priority, and Delete, with the keyboard equivalent shown beside each one so the menu doubles as a reminder of the shortcut. Right-clicking also moves the cursor to that task, so the menu and the keyboard always act on the same row. The menu takes typing as a filter: right-click, type “prio”, and only the priority entries stay. Editing a task inline is offered on the calendar surfaces and the Timeline, which have an edit field; elsewhere “Open note” takes you to the line.'
  },
  {
    title: 'Mark a task in progress',
    body:
      'A task you have started but not finished can say so: `- [/]`. Write it directly, run “Mark Task In Progress” from the command palette with the cursor on a task, or press `i` on a task in the Tasks list (press `i` again to set it back to open). It renders as a half-filled box in the editor and the reading view, and that box is clickable on both surfaces: a click checks the task off, the same `[/]` to `[x]` the toggle command performs (the forwarded and cancelled markers stay unclickable records). Moving an in-progress card between live Kanban columns keeps the `/` too. Unlike forwarded or cancelled, an in-progress task is still live work: it keeps its place in Today, Upcoming, or No due date, stays on the calendar and the Kanban board, and rolls forward with your unfinished tasks when you roll over a daily note, `/` and all. A whole-note task file uses `status: in-progress` in its frontmatter (`doing`, `started` and `wip` are read the same way).'
  },
  {
    title: 'Subtask progress on the parent',
    body:
      'A parent task with subtasks shows how far along they are: a `2/5` chip sits at the end of the parent line in the editor and the reading view, turning green when every child is done. The count is derived while rendering and is never written into the markdown, so it stays correct no matter which app last edited the file. Direct children only, one nesting level down, and a grandchild rolls into its own parent. Cancelled (`- [-]`) and forwarded (`- [>]`) children leave the count entirely; an in-progress child (`- [/]`) counts as not yet done.'
  },
  {
    title: 'Style completed tasks',
    body:
      'By default, checking a task (`- [x]`) just fills its checkbox. Settings → Editor → Completed task style can also dim the text, strike it through, or both, so finished items visually recede in the editor and reading view while the checkbox stays checked. The command palette has direct entries (“Completed Tasks: Strikethrough”, “Gray”, “Strikethrough + Gray”, “No Style”). Nested sub-tasks keep their own state, so a completed parent never strikes an unchecked child.'
  },
  {
    title: 'Moving notes is path-first',
    body:
      'Use the note context menu, search `move` or `mv` in the command palette, or run `:move` / `:mv` from the ex line to move the active note into a folder of your notes area or the Archive. With no argument, the command opens the folder picker; with a target like `:mv Work/Research` or `:mv archive/Reference`, it moves the note directly (`:move inbox/Work` still works on an Inbox vault). The picker spells destinations the way the sidebar does: no `inbox/` in front, empty for the notes root (Inbox, or the vault root when your notes live there), `archive/…` for the Archive, and it autocompletes folder paths, so you can type and Tab through existing destinations instead of dragging. “Duplicate” (palette or context menu) copies a note in place, appending “ (copy)” to the name.'
  },
  {
    title: 'Renaming a note fixes its links',
    body:
      'Rename a note and every `[[wikilink]]` pointing at it across the vault rewrites itself to the new name, so no link goes dead. Every form is handled (`[[Note]]`, `[[Note|alias]]` keeping your display text, `[[Note#heading]]`, `[[Note^block]]`, embeds `![[Note]]`, and path-style `[[folder/Note]]`), anything inside fenced or inline code is skipped, and only links that actually resolved to that note are touched, so notes sharing a title never get cross-wired. It runs in the vault layer, so the editor, the CLI, the MCP tools, and the HTTP API all get it, on desktop and the self-hosted server alike.'
  },
  {
    title: 'The note list sorts, groups, and reveals',
    body:
      'The note list header has a sort menu (Name, Updated, Created, or a Manual order; also “Sort Notes: …” in the palette), a “Group by Kind” toggle that separates folders from notes, and “Auto-Reveal Active Note”, which expands a note’s ancestor folders and scrolls it into view in the sidebar whenever you open it.'
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
    title: 'Label and fold headings and lists',
    body:
      'Settings → Editor → Writing can show H1 through H6 labels before Markdown headings. Every heading also has a disclosure arrow that folds its section, and so does every list item with indented lines under it (a bullet, a numbered item or a task): the arrow beside its marker folds those lines, in Edit and in Preview, and the item line stays in view. Click the arrow, use Ctrl+Alt+F and Ctrl+Alt+U (Cmd+Option+F and Cmd+Option+U on macOS), or use zc and zo in Vim mode; on one of the lines under a list item, they fold the item itself. Fold All (zM) folds every heading and every list item, nested, so opening a heading shows its tasks one line each. Folding only hides lines: the note, and the Tasks view, are unchanged.'
  },
  {
    title: 'Create text replacements',
    body:
      'Open Settings → Editor → Text replacements to expand short triggers as you type. The default rule turns `->` into `→`, and you can add symbols, words, or longer phrases. The longest matching trigger wins.'
  },
  {
    title: 'Tune indentation and switch notes quickly',
    body:
      'Set the editor tab size from 1 through 8 spaces under Settings → Editor → Writing. Tab and Shift+Tab indent and outdent lines (`>>` and `<<` in Vim mode). Headings stay at the margin: Markdown reads a heading indented four spaces as a code block, so indenting leaves heading lines where they are and indents the rest. Press Ctrl+Tab to switch to the most recently used note, then press it again to alternate between the same two notes.'
  },
  {
    title: 'Callouts highlight the important bits',
    body:
      'Turn a blockquote into a colored callout (an Obsidian-style admonition) by starting its first line with `> [!type]`, optionally followed by a title: `> [!warning] Heads up`. Typing `[!` inside a blockquote opens an insert menu of the callout types: filter by name (aliases match too, so `warn` finds Warning and `tldr` finds Abstract), move with the arrow keys or the Vim/Emacs completion chords (Ctrl+J / Ctrl+K, Ctrl+N / Ctrl+P), and press Enter, Tab, Ctrl+Y, or click to drop in the syntax. The type sets the color: `note`, `info`, `abstract` / `summary` / `tldr` render blue; `tip` / `hint` / `important` and `success` / `check` / `done` green; `question` / `help` / `faq` and `example` purple; `warning` / `caution` / `attention` yellow; `danger` / `error`, `bug`, and `failure` / `fail` red; and `quote` / `cite` a neutral gray. Types are case-insensitive, and an unrecognized one still renders as a neutral note, so callouts pasted in from Obsidian keep working. Put `-` or `+` right after the type to make a callout foldable, as in Obsidian: `> [!example]- Screenshots` starts collapsed and `> [!example]+ Screenshots` starts expanded. Click the title row in Preview, or the chevron after the title in Edit mode, to open or close it; the fold keys (zc and zo, or Ctrl+Alt+F and Ctrl+Alt+U, Cmd+Option+F and Cmd+Option+U on macOS) work on it from its title line or any line inside it, and Fold All (zM) includes it. A collapsed callout starts closed each time the note opens and prints open in a PDF export; folding never changes the note. To make one without typing the syntax, or to change or remove one, use the callout menu (next card).'
  },
  {
    title: 'Turn text into a callout from the menu',
    body:
      'Right-click text in the editor and choose “Turn into callout…”. A second menu opens in the same spot, “Callout type”, listing every type with its icon: Note, Info, Abstract, Tip, Success, Question, Example, Warning, Danger (Error), Bug, Failure and Quote. An Error callout is a Danger one, since `error` is its alias. Move with the arrow keys and press Enter, click, or type to filter: aliases count, so `error`, `caution` or `tldr` find their type. Selected lines become the callout whole, line by line. With nothing selected, the paragraph under the pointer does, a whole list when it is in one. A plain blockquote just gains the `> [!type]` line on top. A callout made from part of a paragraph, or right beside a quote, gets a blank line so it stands on its own. Right-click inside a callout, written out or drawn as a card in Live Preview, for “Change callout type…” and “Remove callout”. Change type checks the current type, and keeps the title and any `+` or `-` fold marker. Remove drops the title line, keeps a custom title as a plain first line, and takes one level of `>` off the text, so a quote or callout nested inside stays as it was. From the keyboard, run “Set Callout Type…” from the command palette, or press `Space l a` in Vim mode, to open the same menu at the cursor. “Remove Callout” is in the palette too, and either command can take a key of its own (Alt+Enter on its row). In Vim mode, `m` or Shift+F10 on a selection opens the whole right-click menu. Each change is one step for Undo. Code blocks and the note’s properties never become callouts: there the menu shows “Turn into callout…” greyed out with the reason, and the command says why. With Vim mode off, the menus answer to the arrow keys, Enter and Escape, and letters filter.'
  },
  {
    title: '@ inserts dates and links notes',
    body:
      'Typing `@` in normal text opens suggestions: the date shortcuts (Today, Yesterday, Tomorrow), the current time (Now: type `@time` or `@now`), plus any notes matching what you type. Choosing a date inserts an ISO date like `2026-04-15`; choosing Now inserts the current time in your configured 12-hour or 24-hour format (Settings → Editor → Time format); choosing a note inserts a `[[wikilink]]`, so `@` is a quick alternative to `[[`. A bare `@` leads with the dates and Now. Start typing letters and matching notes appear.'
  },
  {
    title: '[[ opens the wikilink picker',
    body:
      'Type `[[` and the wikilink picker lists matching notes, images, PDFs, SVGs, and CSV databases; keep typing to narrow it. ↑/↓ or Ctrl+J/K (Ctrl+N/P) move through the suggestions, Enter inserts the link, Tab inserts it and keeps the caret inside the brackets so you can add a `#heading`, and Esc closes the picker. Press `|` to take the highlighted suggestion and start its display text: you get `[[Note|]]` with the caret behind the `|` (to give display text to a name that is not in the list, press Esc first). Type `/path/to/note` for an exact link; picking a database drops a `[[Database]]` link that opens its grid.'
  },
  {
    title: 'Templates scaffold new notes',
    body:
      'Templates turn a repeated note shape into one keystroke. ZenNotes ships built-in templates for engineering (ADR, RFC, Bug Report, Postmortem, Meeting Notes, 1:1) and personal use (Daily Note, Weekly Review, Reading Notes, Journal, Project Kickoff, To-do), and you can author your own under Settings → Templates. A template is plain markdown with optional frontmatter and variables (`{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{week}}`, and `{{cursor}}`) substituted at creation time, plus the live `{{modified_date}}`, `{{modified_time}}` and `{{modified_datetime}}`, which stay in the note and show its last-saved time. Custom templates are stored as `.md` files in `.zennotes/templates/`, so they stay portable like everything else. Daily and weekly notes can each be assigned a template so dated notes start pre-filled.'
  },
  {
    title: 'Reference and connections support research-heavy work',
    body:
      'Pin a companion note or PDF in the reference pane, then toggle the connections panel to inspect backlinks and unresolved links while you draft. Connections count both `[[wikilinks]]` and standard Markdown links (`[text](Note.md)`), so incoming and outgoing associations show up even if you never use wikilinks. A wikilink at a file in the vault, such as an embedded image or a PDF, is listed as a file and opens in its own tab; the panel only offers to create a note for a wikilink that reaches nothing, and under those missing links the All unresolved links in the vault row opens the Unresolved Links view, the same list for the whole vault.'
  },
  {
    title: 'Zen mode removes chrome',
    body:
      'Use the configured Zen shortcut to strip away the title bar, sidebar, note list, tabs, pane headers, side panels, and status bar so only the active editor, preview, or split view stays visible.'
  },
  {
    title: 'Links are actionable',
    body:
      'Use [[wikilinks]] or markdown links. Following a link (click it, Cmd/Ctrl-click it, or use the follow-link motion `gd` in normal mode) opens the note under the cursor and pins PDFs into the reference pane. If the note does not exist yet, following the link offers to create it (after you confirm) rather than leaving a dead link; hold Cmd (macOS) or Ctrl (Windows/Linux) while clicking the link, or use `gD` in normal mode, to create it at once at the suggested path: Inbox, named after the link text. A link named like one of your daily, weekly or monthly notes, such as `[[2026-11-03]]` while daily notes are on, creates that note instead, in its folder and from its template, the way the calendar does, so it shows up on that day; a link that names a folder (`[[journal/2026-11-03]]`) still makes a plain note there. A link at a note that does not exist yet is drawn muted with a dashed underline, in the editor and in the reading view, so you can tell live links from ones that would create a note; the Unresolved Links view (`Space u`) lists all of them in the vault. Rest the pointer on a wikilink, or press `K` on it in Vim mode, to edit or create its note in the link popover without leaving the note you are in. Prefix a wikilink with `!` to embed rather than link: `![[Note]]` inlines the target note content in the reading view and PDF export (recursively, with cycle protection), so a master note can pull in sub-notes and export to PDF as one document. `![[image.png]]` embeds an image and `![[drawing.excalidraw]]` embeds an Excalidraw drawing as a PNG preview; both take optional `|width` or `|WxH` size hints (`![[image.png|300]]`, `![[image.png|600x400]]`), and the markdown form carries the same hint after the alt text (`![caption|300](image.png)`). In the editor, drag the handle on a picture\'s right edge to resize it; the width is written back as that hint, so the reading view, exports and Obsidian all show the same size. Resize Image… in the command palette (or `:imgwidth 480` in Vim mode, `:imgw auto` to reset) sets it by number for the image under the cursor. Right-click a web link or an email address, in the editor or the reading view, to open it or copy it (the address itself, without `mailto:`); `gy` in normal mode, or Copy Link Under Cursor in the palette, copies the one under the caret.'
  },
  {
    title: 'Open links in other applications',
    body:
      'On desktop, enable application prefixes such as zotero, obsidian, or vscode under Settings → Editor → Links → External application links. Separate prefixes with commas; they are saved in config.toml. Use ordinary Markdown, for example [Paper](zotero://open-pdf/library/items/W78FUE98). Editor clicks, Cmd/Ctrl-click, preview links, and Vim gd open enabled links in the installed application. A disabled application link offers Open settings, never note creation. If the application cannot open the link, ZenNotes shows an error.'
  },
  {
    title: 'Point at one block, not a whole note',
    body:
      'End any line with a `^block-id` marker (letters, digits and hyphens, e.g. `- Ship the picker ^ship-it`) to name that block, then link at it with `[[Note^ship-it]]`. Following the link opens the note scrolled to that exact block, the way `[[Note#Heading]]` reaches a section. Put the marker on its own line to tag the paragraph above it without touching its text. Typing `^` inside a wikilink lists the target note\'s ids with the block text beside each one, so you can pick without leaving the keyboard, and `[[^id]]` points at a block in the note you are already in. Embedding follows the same rule: `![[Note^ship-it]]` inlines just that block rather than the whole note, bringing a bullet\'s children along with it. Obsidian\'s spellings work as-is, so a vault you share with Obsidian keeps its block links: `[[Note#^id]]`, `[[#^id]]`, and markdown-style `[text](Note.md#^id)` all reach the block. The marker itself is addressing, not prose, so it stays hidden in the reading view and in the editor until your cursor is on the line to edit it. The Connections panel says which block a note reached for instead of only that it linked here.'
  },
  {
    title: 'Embed videos and link cards',
    body:
      'Paste a YouTube or Vimeo link on an empty line (Cmd/Ctrl+V, or `p` in normal mode) and a small "Paste as" menu offers Embed, Bookmark, or plain URL; `j`/`k`, the arrows, and Enter drive it, Esc dismisses it. An embed is an `embed` code fence holding the URL. It renders as the video poster with a play badge, in the editor and in the reading view alike, and no player exists until you click play, so the cursor walks straight over it and nothing can take the keyboard away from the note. Once a video is running, clicking inside it hands the keyboard to the player (its own shortcuts apply); press Esc (desktop) to hand it back to the note. A bookmark is a `bookmark` fence rendered as a rich link card built from the page metadata; clicking the card opens the link externally. In the editor, hover an embed or card for its Edit pill, or step into it with `j`/`k`, to reveal and edit the source.'
  },
  {
    title: 'Files stay local',
    body:
      'Drop files into a note to insert local files. ZenNotes copies them into the vault’s `assets/` folder (the same place pasted images land; a pasted screenshot is named for the moment you pasted it, such as `Pasted Image 2026-10-19 142312.png`, while a copied file keeps its own name), so they stay together instead of cluttering your notes area, whether you keep notes in `inbox/` or at the vault root. It can reveal them from the app, and opens images, SVGs, PDFs, audio, video, and generic files inside ZenNotes tabs or reference panes where possible. In the sidebar you can drag an image, PDF, or any attachment onto a folder to move it, just like a note, or use its Move… context-menu entry. Renaming or moving an asset (from the sidebar, the Assets view, a rendered image’s menu, or by dragging it onto a folder) rewrites every note that referenced it, `![[assets/old.png]]` embeds and `![](old.png)` links alike, in the style each link was written, the same way renaming a note updates its wikilinks.'
  },
  {
    title: 'Any CSV is a database',
    body:
      'A `.csv` file in your vault is a full Notion-style database, with zero new dependencies. The same data shows up as an editable Table (inline cell editing) and as a Board grouped by a select field; add and switch views freely. Fields are typed as text, number, checkbox, date, select, multi-select, or note link (single or multi), and support sort, filter, and a raw-CSV toggle, while every row keeps a stable id so external edits round-trip cleanly. Each saved view keeps its own columns and rows, so one wide CSV can carry several narrow views. A table view’s Columns button, beside Filter, reads “Columns 5 of 44” once some are hidden and opens a checklist of the view’s columns with a find field, Show all and Hide all (press `c` in the grid in Vim mode); a column’s ⋯ menu has Hide column too, and the last visible column always stays. The + beside the view tabs makes a New table view (which opens Columns straight away), a New board view, or a duplicate of this view with its filters, sorts, columns and picked rows; a view tab’s right-click menu has Duplicate view as well. To show only certain rows, select them (the row checkboxes, Space in the grid, or x in Vim mode) and choose Show only these in this view: the view then keeps those picked rows, applies its filters and sorts to them, and says “Showing N picked rows” under the header, with Edit picks and Show all rows. A row you add in that view joins its picks, a deleted row simply drops out, and a Board view shows its picked rows the same way. The command palette has Choose Database Columns, New Table View, Duplicate View, Show Only Selected Rows and Show All Rows, and each can take a key of its own. Open any row as a real Markdown note, a “record page” in a per-database folder, whose frontmatter mirrors the row’s properties and whose body is a freeform page. A record can be linked once it has a page; to give every record one at once (a database converted from a CSV starts with none), choose Create pages for all records in the database’s ⋯ menu or the command palette, or press `O` in the grid in Vim mode. Create one with “New Database” in the command palette or by right-clicking a folder → New database.'
  },
  {
    title: 'Databases discover your notes',
    body:
      'Database cells can link to the notes you already have instead of hard-coding every value. Typing `[[` in a text cell opens the same note search as the editor and inserts a `[[wikilink]]`. A Note link column (types “Note link” / “Note links” in the field menu) stores wikilinks properly: pick notes from a searchable list, and the saved chips show each note’s title and open it on click. And a Select or Multi-select column can auto-discover its options from your vault: open the column’s `⋯` menu and choose Options: all notes, notes in folder…, or notes with tag…; the cell popover then suggests matching notes live (a meeting database can offer every note in `projects/` as its Project options, say), and anything you pick is saved as an ordinary option so boards and filters keep working. Every picker is fully keyboard-driven: type to search, ↑/↓ or Ctrl+N/P to move, Enter to pick, Escape to close.'
  },
  {
    title: 'The CLI is the bridge to launchers',
    body:
      'The `zn` command-line tool can list, read, search, capture, edit, archive, trash, inspect tasks, work with databases (`zn base list / rows / get / add / set / create / pages`: add rows with record pages, give every record its page with `zn base pages`, set fields with the grid’s exact semantics, locally or against a self-hosted server; renaming a record page with `zn rename` keeps its row pointing at it), and start the MCP server without the app running. With no `--vault` or `--server` flag, `zn` works on the vault the app has open, a connected server included (it sends the token `zn connect` saved for that server, or `ZENNOTES_REMOTE_TOKEN` / `--token`). Raycast uses it for search, then uses `zennotes://open` and `zennotes://open-window` links to bring the selected note back into ZenNotes. On macOS, Settings → CLI can install the bundled Raycast extension locally so users do not need to wait for the Raycast Store version.'
  },
  {
    title: 'Excalidraw drawings are first-class files',
    body:
      'A `.excalidraw` file is a note type alongside Markdown and databases: listed in the sidebar, opened in a dedicated Excalidraw editor tab, and saved back as JSON. Embed one inside a note with `![[drawing.excalidraw]]` (same syntax as images, with optional `|width` or `|WxH` size hints). The embed renders as a PNG preview in both the editor and reading view, refreshes live when the drawing is edited, and opens in a new tab on click. Obsidian `.excalidraw.md` files are also recognized.'
  },
  {
    title: 'Math, diagrams, and plots render from plain fences',
    body:
      'Inline `$…$` and display `$$…$$` math render via KaTeX by default. Settings ▸ Editor ▸ Math renderer switches the typesetter to Typst, which reads the same `$…$` / `$$…$$` blocks as Typst markup instead of LaTeX (a note’s math is written for whichever engine you pick). Both typesetters complete commands as you write math: type two letters inside a math region to get Greek letters, operators, arrows, sets, and functions with rendered previews, and argument-taking commands insert editable snippets such as `frac(a, b)`. Beyond math, five fenced block languages turn into live diagrams in preview and split mode: `mermaid` for flow, sequence, class, state, ER, gantt, pie, mindmap, timeline, and every other diagram type Mermaid has built in, drawn by Pele (pele.run) in your theme’s colours and fonts, so a layout can differ from mermaid.live or GitHub while the syntax stays Mermaid’s; labels take `<br>` breaks, markdown bold or italic, the HTML tags `<b>`, `<i>`, `<u>`, `<sub>`, `<sup>`, `<code>` and `<kbd>` (code and keys in your code font), and `$$…$$` math, which is LaTeX typeset with KaTeX even when your math renderer is Typst (in flowchart, swimlane, sequence, state, class, ER, mindmap, kanban, block, requirement and use case diagrams; class members and titles keep it as written), while any other tag is dropped with its text kept; `d2` (D2, d2lang.com) for architecture and system diagrams, with nested containers, `shape: sql_table` data models, sequence diagrams and sketch mode, coloured from your theme unless the diagram picks a D2 theme of its own (`theme-id` in `d2-config`), with Markdown labels allowed but icons, images and links left out so a diagram never reaches the network (the D2 compiler is a large download that loads the first time a note holds a `d2` fence, so that first diagram takes a moment); `mermaid` and `d2` also draw inline in the editor with live preview on, the diagram standing in for the fence until your cursor enters it, which brings the source back for editing; `tikz` for LaTeX-native coordinate systems, commutative diagrams, and figure-quality plots (the TeX engine runs on-device so no network is required); `jsxgraph` for interactive geometry and function plots driven by a small JSON config; and `function-plot` for compact Cartesian function plotting. Each block is ordinary markdown on disk, so the source remains portable and diffable.'
  },
  {
    title: 'Equation environments number themselves',
    body:
      'With the KaTeX renderer, each unstarred `\\begin{equation}…\\end{equation}` inside a display math block receives the next number in document order. Numbering stays consistent between the live editor and Preview.'
  },
  {
    title: 'Footer actions expose utility views',
    body:
      'The sidebar footer gives you direct access to Files, Help, and Settings, so utility screens stay discoverable even when you are new to the app. A narrow sidebar degrades the row in steps instead of clipping: first the file count folds into the Files tooltip, then the labels drop and the three actions stand as icons.'
  },
  {
    title: 'Destructive actions ask first',
    body:
      'Moving a note to Trash now asks for confirmation before anything is deleted from the active workspace, and the Trash view separates restore from permanent delete. Open a trashed note and the editor header offers the same two actions, Restore and Delete permanently, in place of Archive and Move to Trash. “Empty Trash” clears the whole bin in one confirmed step, and assets deleted from the Files view land in Trash too, restorable to their original location.'
  },
  {
    title: 'Updates are release-driven',
    body:
      'In-app updates read the published GitHub release feed. That means update checks, download prompts, and release notes are all driven by the same public releases you can open manually from the app menu or command palette.'
  },
  {
    title: 'Workflows plan first and write second',
    body:
      'A workflow is a plain `.md` file under `.zennotes/workflows/`: frontmatter plus one pipeline per line, like `good = books | where rating >= 4`. Wires carry sets of notes, so every wire on the canvas shows the live count flowing through it, and the canvas and the text are lossless projections of the same file (layout is computed, so no coordinates ever land in your vault). The engine can only propose changes: running shows the full dry-run diff before anything is applied, applying journals every file\'s pre-run bytes so Undo restores them exactly, and a run that fails midway rolls the whole thing back on its own. There are no code steps, no shell, and no network, which is why a workflow you did not write is safe to read and run. A workflow runs when you run it, and since 2.55 also on its own when its `trigger:` names an event: `on note-created`, `on note-saved`, `on note-moved` or `on tag-added` fires for the note you change in this app, a moment after it settles, with no confirmation and a receipt toast that carries Undo (see the Event triggers card); a `schedule` trigger parses but does not fire yet. Local desktop vaults, self-hosted web servers, and desktop remote workspaces can all author and run workflows; a remote workspace needs a server on 2.29 or newer, and against an older server workflows stay read-only. The feature is off by default; enable it under Settings → Workflows.'
  },
  {
    title: 'The workflow grammar in one card',
    body:
      'Six sources open a set: `all`, `folder inbox`, `tag #book`, `search reading list`, `current`, `selection` (the Trash and Archive stay out unless you name them, like `folder trash`; the four system names `inbox`, `quick`, `archive`, `trash` mean those folders wherever the vault keeps them, so on a vault whose notes live at the root `folder inbox` is the vault root). Thirteen steps filter and shape it: `where rating >= 4`, `tagged` / `not-tagged #x`, `no-tags`, `in inbox/projects`, `matching inbox/**/*.md`, `contains TODO`, `since 7d`, `sort finished desc`, `limit 25`, `dedupe`, and `union` / `subtract <wire>` to combine named wires. `tag`, `tagged` and `not-tagged` also take a comma-separated list and match any tag in it, so `all | not-tagged #someday, #reference` keeps the notes carrying neither, and `all | no-tags` keeps the notes with no tag at all. Mutating steps change every note on the wire, always behind the dry-run confirmation: `set status done`, `add-tag` / `remove-tag`, `move`, `rename {{date}}-{{title}}`, `append` / `prepend`, `apply-template`, `archive`, `trash`. Outputs turn the wire into text: `render table title, rating` feeds `write "Log.md"`, `write-section "Log.md" "Finished"`, `create-each "inbox/{{title}}.md"`, `notify`, or `clipboard`, and `call <workflow>` folds another workflow into the same run. `{{title}}`, `{{date}}`, `{{count}}` and any frontmatter field expand per note. Press `?` in the Workflows view for the live reference, with a one-line description and a real example for every step.'
  },
  {
    title: 'Event triggers',
    body:
      'Set `trigger: on note-saved` (or `on note-created`, `on note-moved`, `on tag-added`) on an active workflow and it runs by itself when you make that change in this app, about a second and a half after the note settles: a burst of autosaves while you type is one run, and a note you are still typing in waits for its next save. `note-moved` fires with the note\'s new path for a rename, a move, Archive, Trash and Restore; `tag-added` fires for a save that gave the note a tag it did not have. The run sees only the note that changed: every source (`all`, `folder`, `tag`, `search`, `current`) resolves over that one note, so `all | contains type: topic | move Topics` means "file this note under Topics when it says so", and nothing is read across the vault on every save. Add a condition to fire only when the note matches: `trigger: on note-saved where folder = inbox` takes the same `field op value` a `where` step takes. There is no confirmation; the receipt toast carries Undo, a run that changed nothing says nothing, and a note the run would write that has unsaved edits is left alone and named. Only edits made in this app fire: a change that arrives by sync or from another device does not, what a run itself writes never fires again, a folder rename does not fire for the notes inside it, and the phone apps do not fire at all. `status: draft` or `trigger: manual` silences one workflow; Settings → Workflows → Event triggers (`workflow_event_triggers` under `[view]` in config.toml) silences them all on this device. A `schedule` trigger still parses without firing.'
  }
]

export const HELP_SHORTCUT_SECTIONS: HelpShortcutSection[] = [
  {
    id: 'global-shortcuts',
    title: 'Global shortcuts',
    description: 'These work across the main app shell. With Vim mode on and the editor focused, an app shortcut on a Ctrl chord wins over Vim\u2019s own use of that chord, except the ones Vim mode keeps on purpose: Ctrl+W (the pane prefix), Ctrl+O and Ctrl+I (the jumplist), and Ctrl+D and Ctrl+U (half-page scroll). On macOS these shortcuts use Cmd and never collide.',
    items: [
      { keys: 'Mod+P', action: 'Search notes', detail: 'Open the note search palette, from the editor too: on Linux and Windows this wins over Vim\u2019s Ctrl+P (cursor up).' },
      { keys: 'Ctrl+D (in Search notes)', action: 'Move the highlighted note to Trash', detail: 'Trash a note straight from the search results, with the usual confirmation; the palette stays open, so a clean-up pass is search, Ctrl+D, search, Ctrl+D. It acts on note rows only, never on a tagged block row.' },
      { keys: 'Enter on a tagged block (in Search notes)', action: 'Open the note at that block', detail: 'With a #tag in the query, notes list their tagged blocks; Enter opens the note at the block’s line, highlighted, and Ctrl+O comes back. Enter on “+N more tagged blocks” opens the rest in the Tags view, your words still filtering.' },
      { keys: 'Shift+Enter (in Search notes)', action: 'Create a note named after your search', detail: 'The last row of the results offers to create the note you typed: Shift+Enter (or Enter on that row) opens a New note form with three fields. Name starts as your search text, selected so you can retype it. Folder starts empty (your Inbox) or as the path you typed, like projects/roadmap; landing in it lists every folder, typing narrows the list, Enter picks the highlighted one and ArrowUp keeps a folder that does not exist yet. Tags starts with any #tag words from your search; type to pick an existing tag or add a new one, Space or comma commits, Backspace on an empty field removes the last one. The line under the fields tells you what will happen. A note with the same name in that folder blocks Create until you change the name, and Shift+↵ opens the existing note instead; the same name elsewhere only warns. Enter in Name, or Ctrl/Cmd+Enter anywhere, creates the note and opens it; Escape goes back to the results.' },
      { keys: 'Mod+F', action: 'Search notes (non-Vim mode)', detail: 'Open the note search palette directly when Vim mode is off.' },
      { keys: 'Mod+F (in the editor)', action: 'Find and replace in the note', detail: 'In Edit and Split, open the editor’s find-and-replace bar: Tab moves between the Find and Replace fields, with match-case, whole-word, and regex toggles. Esc closes it. With Vim mode off, Mod+F in the main window opens note search instead (the row above); unbind or move Search notes in non-Vim mode under Settings \u2192 Keymap to give Mod+F to the bar, or use F3. With Vim mode on, Linux and Windows keep Ctrl+F as Vim\u2019s page-forward (search with / instead); macOS keeps Cmd+F for the bar. A floating window has no note search, so there Mod+F opens the bar with Vim mode off too.' },
      { keys: 'F3 / Mod+G (in the editor)', action: 'Find the next match in the note', detail: 'With the find bar closed, open it with your last search filled in and selected, ready to retype or to press F3 again; with it open, move to the next match. Shift+F3 or Shift+Mod+G moves to the previous one. The same with Vim mode on or off, in every window.' },
      { keys: 'Shift+Mod+P', action: 'Open commands', detail: 'Open the command palette.' },
      { keys: 'Alt+Enter (in the command palette)', action: 'Give the highlighted command a key', detail: 'Record a key for the command under the cursor without leaving the palette (Option+Enter on macOS). Enter saves, Escape returns to the same row, which then shows its key. Every command can take one; the same keys live in Settings → Keymap → Commands.' },
      { keys: 'Mod+N', action: 'New note in current folder', detail: 'Create a note in the active note\u2019s folder (or the browsed folder when no note is open) and focus its title. On Linux and Windows this wins over Vim\u2019s Ctrl+N (cursor down). Rebindable under Settings \u2192 Keymaps.' },
      { keys: 'Shift+Mod+N', action: 'New Quick Note', detail: 'Create a quick capture note in the main window and focus its title.' },
      { keys: 'Alt+Mod+T (macOS)', action: 'New note from template', detail: 'Open the template picker to create a note, with Vim mode on or off. Bound by default on macOS; on Linux and Windows it starts unbound, since Ctrl+Alt+T opens a terminal on most Linux desktops, so set a key under Settings → Keymap.' },
      { keys: 'Unbound', action: 'Insert template into current note', detail: 'Pick a template and insert it at the cursor of the active note, with Vim mode on or off. Unbound until you set a key under Settings → Keymap.' },
      { keys: 'Shift+Mod+Space', action: 'Open quick capture window', detail: 'Open the floating, always-on-top capture window. Bound system-wide (CommandOrControl+Shift+Space by default) so it works over any app; change it under Settings → Editor.' },
      { keys: 'Mod+,', action: 'Open Settings', detail: 'Open settings for appearance, editor behavior, fonts, vault controls, and app details. Settings opens on its search: type to filter, move through the results with ↑/↓ (or Ctrl+J / Ctrl+K), and press Enter to jump to the picked setting. From anywhere in Settings, Mod+F (or / in Vim mode) returns to the search.' },
      { keys: 'Mod+1', action: 'Toggle sidebar', detail: 'Hide or show the left sidebar.' },
      { keys: 'Mod+2', action: 'Toggle connections', detail: 'Toggle the connections panel for the active editor pane.' },
      { keys: 'Mod+Shift+C', action: 'Toggle comments panel', detail: 'Show or hide the Comments panel for the active pane.' },
      { keys: 'Mod+7', action: 'Toggle timeline panel', detail: 'Show or hide the Timeline panel for the active pane: every open task with a date, in date order, overdue tasks and `#milestone` tasks marked. Also `Space n` in Vim mode, `:timeline`, and Toggle Timeline in the command palette.' },
      { keys: 'Mod+Alt+M', action: 'Add comment', detail: 'Start a comment on the selected text (or the current line) without reaching for the mouse.' },
      { keys: 'a', action: 'Reply in a comment thread', detail: 'Comments panel: open a reply box under the selected comment; `Mod+Enter` sends it, `Esc` cancels.' },
      { keys: 'Alt+H / Alt+J / Alt+K / Alt+L', action: 'Focus pane left / down / up / right', detail: 'Always-on pane-focus motions: they work even with Vim mode off and skip the Ctrl+W prefix some Linux setups intercept. (Ctrl+W h/j/k/l still works in Vim mode.) Both walk the same cycle, in the order the panels appear on screen: sidebar → note list → editor → connections → comments → outline → calendar → timeline, and back again.' },
      { keys: '↑ / ↓ / → / ← / Enter / Esc', action: 'Move inside a focused panel', detail: 'Once a panel has focus (the sidebar, the note list, connections, the outline or comments), the arrows move its row cursor, Enter or → opens the row under the cursor, Esc returns focus to the editor, and ← goes back the way `h` does there: from the note list to the sidebar, from connections, the outline and comments to the editor. Shift+F10 or the Context Menu key opens the row’s menu in the sidebar and the note list. In comments, Enter or → jumps to the comment’s text, and Backspace or Delete deletes it after a confirm. With Vim mode off, Home and End jump to the ends and Page Up / Page Down move a screenful of rows; the single-key motions (j / k, gg / G) and the panels’ letter keys stay Vim-only. The sidebar, reached with Alt+H or Focus Sidebar in the command palette, works like a tree: → opens the row or expands its folder, ← collapses a folder, or from a note folds its folder and lands on it (Esc still returns to the editor).' },
      { keys: 'Mod+.', action: 'Toggle Zen mode', detail: 'Hide or restore the app chrome so only the active editor, preview, or split view stays on screen.' },
      { keys: 'Mod+W', action: 'Close active tab', detail: 'Close the current note or virtual tab. With Settings open it closes Settings instead, and in a floating window or the quick capture window it closes that window, like its close button. While a dialog, palette or menu is open it does nothing, so it never closes the tab behind it; press Esc to dismiss those first. With Vim mode on, Linux and Windows keep Ctrl+W as the pane prefix while a tab is open: close the tab with :q or :bd, from the tab menu, or rebind this.' },
      { keys: 'Ctrl+Tab', action: 'Switch to previous note', detail: 'Switch to the most recently used note. Press again to alternate between the last two notes.' },
      { keys: 'Alt+1 … Alt+9', action: 'Go to tab 1 through 9', detail: 'Jump straight to a tab by position, browser-style (Ctrl+1 … Ctrl+9 on macOS, where Option types characters and the ⌘ digits are taken). Tab numbers count across panes in the same order gt cycles; rebindable under Settings → Keymaps. Vim users get the same jump as {count}gt. Heads-up for macOS with multiple Spaces: Mission Control claims Ctrl+digit for Switch to Desktop, so rebind here or free the key under System Settings → Keyboard Shortcuts.' },
      { keys: 'Ctrl+PageDown / Ctrl+PageUp', action: 'Next / previous tab', detail: 'Step through the open tabs, counted across panes in the same order gt and gT cycle, wrapping at either end. Works with Vim mode on or off, and from the command palette as Next Tab and Previous Tab. On macOS the defaults are Cmd+Option+Right and Cmd+Option+Left. Rebindable under Settings → Keymaps, to Ctrl+Tab for example if you would rather have that than Switch to previous note.' },
      { keys: 'Shift+Mod+T', action: 'Reopen closed tab', detail: 'Reopen the most recently closed tab, restoring its position and pinned state. Repeat to walk back through your close history.' },
      { keys: 'Mod+O', action: 'Open file', detail: 'Desktop only: pick a Markdown file with the native dialog. A file inside a known vault opens against that vault; anything else opens in a standalone external-file window. Links in that window follow from the file\'s own folder: a relative link such as `../README.md` opens the file it names, and a `[[wikilink]]` finds a page of that name in the folder or below it, each in its own window (or in its vault, when the target lives in one).' },
      { keys: 'Mod+4 / Mod+5 / Mod+6', action: 'Edit / Split / Preview mode', detail: 'Switch the active note between the raw editor, side-by-side split, and rendered preview. Preview opens at the line you were editing; Edit and Split open on the section you were reading when you scrolled away from the cursor in Preview, and keep the cursor where it was when you only peeked.' },
      { keys: 'Mod+A', action: 'Select the note\u2019s text', detail: 'In the editor, select everything under the note\u2019s `# ` title heading, the line a new note starts with; press again to select the whole note, title and frontmatter included. With the cursor on the title, or in a note that does not start with a `# ` heading, the first press selects the whole note. With Vim mode on Linux and Windows, Ctrl+A in normal and visual mode stays Vim\u2019s increment (and does nothing without a number); it selects from insert mode, and `ggVG` selects in normal mode.' },
      { keys: 'Mod+L', action: 'Toggle checkbox', detail: 'Turn the current line into a checkbox and toggle it on repeat. See the “Check off a task with ⌘L” card in Core concepts for the full state rules.' },
      { keys: 'Shift+Mod+K', action: 'Open link popover', detail: 'Open the link popover for the [[wikilink]] under the cursor, keyboard inside: edit the note it names in place, or create it when it does not exist yet. Escape closes it and returns to the link; Mod+Enter opens the note in a tab. Works with Vim mode on or off (Vim mode also has `K`). Remappable as editor.linkPopover.' },
      { keys: 'Alt+Q (macOS: Ctrl+Q)', action: 'Reflow paragraph', detail: 'Join the hard-wrapped lines of the paragraph under the cursor (or every paragraph in the selection) into one line, so the editor wraps it to the pane. Headings, lists, tables, code, and explicit line breaks are untouched. See the “Reflow a hard-wrapped paragraph” card. Remappable as editor.reflowParagraph.' },
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
      { keys: 'Mod+N', action: 'New note', detail: 'Save the current note, then open a fresh blank capture without hiding the window, for jotting several in a row.' },
      { keys: 'Mod+P', action: 'Open a note', detail: 'Search the vault and load an existing note into the window to edit it in place.' },
      { keys: 'Shift+Mod+P', action: 'Command palette', detail: 'Run a capture command: save, save without hiding, start a new note, or open another note.' },
      { keys: 'Mod+W', action: 'Hide without saving', detail: 'Hide the window like its close button. Nothing is saved, and the draft is still there the next time you open the window. This is your Close active tab key, so it follows a rebind.' },
      { keys: 'Ctrl+N / Ctrl+P', action: 'Move in a list', detail: 'With the note picker or the command palette open, move the selection down or up, as the arrow keys do. While no list is open they start a new note and open the picker, as above.' },
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
      { keys: '[b / ]b', action: 'Previous / next buffer', detail: 'Move across open buffers, falling back to recent notes when only one buffer is open. Both take a count: `3]b` jumps three buffers forward, wrapping around the ring.' },
      { keys: 'Space o', action: 'Open buffers', detail: 'Show a searchable list of every open buffer across every pane. Press Ctrl+D to close the highlighted buffer without leaving the list.' },
      { keys: 'Space f', action: 'Search notes', detail: 'Open the vault-wide note search palette. Inside it, Shift+Enter opens a New note form named after your search, with a folder picker and tags; Enter creates the note and opens it.' },
      { keys: 'Space s t', action: 'Search vault text', detail: 'Fuzzy-search matching text lines across notes in Inbox, Quick Notes, and Archive.' },
      { keys: 'Space e', action: 'Toggle left sidebar', detail: 'Show or hide the folder/tag sidebar without touching the mouse.' },
      { keys: ']] / [[', action: 'Next / previous heading', detail: 'Jump the cursor to the next or previous markdown heading in the note, the way Vim’s section motions move between sections. It is a motion, so it composes: `d]]` deletes to the next heading, `v]]` selects to it, `3]]` skips three, and `Ctrl+O` jumps back. Headings inside code fences and frontmatter are skipped, matching the outline. With no heading left that way, the cursor goes to the end or start of the note.' },
      { keys: 'gq{motion} / gw{motion}', action: 'Reflow paragraph', detail: 'Vim’s format operator, tuned for an editor that wraps to the pane: `gqip` joins the hard-wrapped lines of the paragraph into one line, `gqj` joins two lines, `Vgq` a visual selection. `gq` lands on the first formatted line like Vim; `gw` keeps the cursor where it was. Headings, list markers, tables, code, math, and explicit line breaks are left alone.' },
      { keys: 'Ctrl+V', action: 'Visual block', detail: 'Select a rectangle across rows; `I`, `A` and `c` apply the edit to every row of the block, short rows included.' },
      { keys: 'Space p', action: 'Note outline', detail: 'Jump to any heading in the active note via a searchable overlay.' },
      { keys: 'Space u', action: 'Unresolved links', detail: 'Open the Unresolved Links view: every link in the vault to a note that does not exist yet, with the notes and lines that link to it. Enter on a name creates the note, Enter on a line opens the note at the link, and K writes the missing note in the link popover. Also `:unresolved`.' },
      { keys: 'Space G', action: 'Folder gallery', detail: 'Open the Gallery of the folder under the sidebar cursor (while the sidebar has focus) or of the open note’s folder: its notes as cards led by their covers. h / j / k / l move, Enter opens, / filters by title. A capital G, since `Space g` is the Atlas.' },
      { keys: 'Space v', action: 'Switch vault', detail: 'Open the command palette directly to the local vault switcher.' },
      { keys: 'Space a', action: 'Open workflows', detail: 'Open the Workflows view, where saved pipelines over your notes are built and run. Workflows are off by default; turn them on under Settings → Workflows first.' },
      { keys: 'Space r', action: 'Review Cloud conflicts', detail: 'Open whatever Cloud sync is waiting on: the queue of files two devices changed at once, one decision at a time, or the vault settings question, which lists each setting that differs with this device’s value beside the cloud’s and lets you pick a side per setting. When the open note is one of the waiting files, the queue starts on it. A waiting note also says so across its top, in Edit and Preview alike: sync is paused for it until you choose what to keep, and its Review button opens the queue on it. Choosing the other device’s version puts the file where that device left it; when this device already has a different file there, that file moves beside it under the next free name, such as Untitled 2.md. A notification with Review appears once when a new conflict arrives. When the Cloud vault this vault syncs with is deleted, on this device, another device or the website, the status bar says Cloud vault deleted and the binding opens Settings → Cloud instead, where This vault says what happened until you choose a cloud vault, start a new one, or dismiss the notice. If another device moved it into an end-to-end encrypted vault, the status bar says Cloud vault now encrypted instead, and This vault asks you to unlock this device if needed, then choose the encrypted vault. The binding and the command palette entry appear only while something is waiting, and open the same place as Review in the status bar.' },
      { keys: 'Space g', action: 'Open atlas', detail: 'Open the Atlas view: the whole vault drawn as a map of notes and links.' },
      { keys: 'Space q', action: 'Quick capture window', detail: 'Open the floating, always-on-top capture window, same as the global hotkey.' },
      { keys: 'Space b', action: 'Hide to tray', detail: 'With Settings → Appearance → Keep running in the tray on, hide this window. ZenNotes keeps running, Cloud sync and the Quick capture hotkey keep working, and the tray icon brings the window back. Hide Window to Tray in the command palette does the same.' },
      { keys: 'Space i', action: 'Insert template into note', detail: 'Pick a template and insert it at the cursor of the active note, instead of creating a new note from it. Without Vim mode, give “Insert template into current note” a key under Settings → Keymap.' },
      { keys: 'Space c', action: 'Toggle calendar', detail: 'Show or hide the calendar panel for the active pane.' },
      { keys: 'Space n', action: 'Toggle timeline', detail: 'Show or hide the Timeline panel for the active pane, and move the keyboard into it: j / k move, gg / G jump to the ends, x ticks the task, Enter opens it at its line, m opens the task menu, / focuses the filter, and Esc goes back to the note. Mod+7 toggles it in any mode.' },
      { keys: 'Space l s', action: 'Toggle favorite', detail: 'Add or remove the active note from the Favorites section shown in the sidebar and on the home view. Folders join it from their context menu.' },
      { keys: 'Space l c', action: 'Cover image', detail: 'Open the cover picker for the active note: a gradient, a gallery photo, an image in the vault, an upload, a pasted image or an https link. Also “Add Cover…” in the command palette and `:cover`.' },
      { keys: 'Space l u', action: 'Cover from Unsplash', detail: 'Open the cover picker on its Unsplash tab to search free photos for the active note’s cover. Also “Add Cover from Unsplash…” in the command palette and `:cover unsplash {search}`.' },
      { keys: 'Space l a', action: 'Callout type', detail: 'Open the callout type menu at the cursor: pick a type to turn the paragraph or the selected lines into a callout, or to change the type of the callout the cursor is in. Also “Set Callout Type…” in the command palette, and “Turn into callout…” or “Change callout type…” in the right-click menu, where “Remove callout” sits too.' },
      { keys: 'Space l l', action: 'Code block language', detail: 'Open the code block language picker for the code block the cursor is in: pick a language to write after its opening fence, “Text (plain)” to take it away, or the detected guess at the top to keep it. Also “Set Code Block Language…” in the command palette, and the language button at the top right of each block in Edit mode.' },
      { keys: 'Space l d', action: 'Convert table to database', detail: 'Turn the Markdown table under the cursor (or the rendered table whose cell you are in) into a `.base` database and leave a `[[link]]` to it in the note. Also “Convert Table to Database…” in the command palette, `:table_to_database`, and the bottom of the table cell menu.' },
      { keys: 'Space, then pause', action: 'Show leader hints', detail: 'If enabled in Settings, open a which-key style guide for the next available leader actions. Sticky mode keeps it open until `Space` or `Esc`.' },
      { keys: 'Mod+3', action: 'Toggle outline panel', detail: 'Show or hide the persistent outline in the active pane. Once focused (Ctrl+W l or Alt+L from the editor), j / k (or the arrows) walk the headings, gg / G jump to the first and last, Enter jumps the editor to the heading under the cursor, and Esc hands focus back.' },
      { keys: 'zc / zo', action: 'Fold / unfold heading or list item', detail: 'Collapse or expand the section below the heading at the cursor, the lines under the list item at the cursor, or the callout whose title it is on. On a line under a list item or inside a foldable callout, zc folds that.' },
      { keys: 'Ctrl+Alt+F / U', action: 'Fold / unfold, Vim on or off', detail: 'The same as zc / zo, with Vim mode on or off. On macOS, use Cmd+Option+F / U.' },
      { keys: 'zM / zR', action: 'Fold / unfold all', detail: 'Collapse or expand every heading section, every list item and every foldable callout in the note. zM folds them nested, so opening a heading shows its list items still folded.' },
      { keys: ']s / [s', action: 'Next / previous Harper suggestion', detail: 'With Grammar and spelling with Harper on, jump the cursor to the next or previous underlined problem, the way Vim walks misspellings.' },
      { keys: 'z=', action: 'Harper suggestions', detail: 'Open the fixes for the problem under the cursor (or the first one on its line). A digit or Enter applies one, j/k move, Esc closes.' },
      { keys: 'zg', action: 'Add word to Harper dictionary', detail: 'Teach this vault\'s dictionary the word under the cursor. Stored in vault.json, so it travels and syncs with the vault.' },
      { keys: 'zG', action: 'Ignore Harper suggestion', detail: 'Hide this one suggestion here from now on without teaching the dictionary a word, the temporary sibling of zg as in Vim.' },
      { keys: 'Ctrl-o', action: 'Go back', detail: 'Jump to the previous note location in history.' },
      { keys: 'Ctrl-i', action: 'Go forward', detail: 'Jump forward in note history.' },
      { keys: 'Space h', action: 'Hint mode', detail: 'Show jump labels over clickable targets (links, buttons, sidebar rows, tabs) so you can activate any of them from the keyboard. Works outside insert mode, including in the Tasks and Tags views. Home-row-mod keyboards work too: a bare modifier tap or an uppercase label no longer cancels the hints.' }
    ]
  },
  {
    id: 'palettes-and-pickers',
    title: 'Palettes and pickers',
    description:
      'These apply once a palette, search overlay, or picker already has focus: the command palette, note search, vault text search, outline, buffer switcher, the [[ wikilink picker, the / slash menu, and the date and template pickers.',
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
    description: 'These bindings work when the sidebar or note list owns focus in Vim mode. With Vim mode off both keep the arrows, Enter, Esc, Home / End, Page Up / Page Down and Shift+F10 (see Move inside a focused panel), and Mod+Backspace works in the sidebar too.',
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
      { keys: 'x', action: 'Move to Trash', detail: 'Move the note under the cursor to the Trash after a confirm, or the whole multi-selection when that note is part of it. The cursor stays in the sidebar, on the row that took the note’s place. Folders are left alone: delete one from its menu (`m`).' },
      { keys: 'Mod+Backspace', action: 'Move to Trash, Vim on or off', detail: 'The same as `x`, with Vim mode on or off: ⌘⌫ on macOS, Ctrl+Backspace on Windows and Linux. Rebind or unbind it as Move sidebar note to Trash under Settings → Keymap.' },
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
          'Show inline suggestions for Today, Yesterday, Tomorrow, the current time (`@time` / `@now`), and Date…, a calendar for any other day (`@date`: arrows move, PageUp/PageDown change the month, Enter inserts), so you can insert dates and times without leaving the keyboard.'
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
    description: 'These virtual views each run their own keyboard loop in the main pane, and the Vim leader works here too (for example Space h for hint mode). The single keys below belong to Vim mode: with it off only the arrows, Enter and Escape stay live everywhere, plus Shift+J/K to reorder in the list, Tab to pick a task on the calendar and Space to toggle one on the board or the calendar; everything else sits in the right-click menu. An action you rebind to a chord with Ctrl, Alt or Cmd works with Vim mode on or off.',
    items: [
      { keys: 'j / k', action: 'Move row cursor', detail: 'Step through task rows, tagged notes and their tagged blocks, or trashed notes.' },
      { keys: 'g g / G', action: 'Jump to top or bottom', detail: 'Move to the first or last visible result.' },
      { keys: 'Enter / o', action: 'Open current result', detail: 'Open the selected task source note, tagged note, or trashed note. On a tagged block, open its note at that line, highlighted.' },
      { keys: '} / {', action: 'Next or previous note', detail: 'Tags view only: hop to the next note past the current note\'s tagged blocks, or back to the previous note (from a block, to its own note).' },
      { keys: 'x', action: 'Toggle task', detail: 'Tasks view only: check or uncheck the selected task. A checked task lingers in place for a couple of seconds before it drops into Done, so you can toggle it again to undo. Space also toggles unless Space is your Vim leader key, in which case it starts a leader sequence.' },
      { keys: '>', action: 'Forward task', detail: 'Tasks list only: forward the selected task to another note. Opens a note picker that filters as you type and preselects the first match, so Enter forwards without reaching for an arrow key. The original becomes a forwarded record (`[>]`) linking to the target, and a fresh copy is added there, backlinked home, subtasks and all. Forwarded tasks live under a “Forwarded” group.' },
      { keys: 'i', action: 'Mark task in progress', detail: 'Tasks list only: mark the selected task as started (`- [/]`), or set it back to open. In-progress tasks keep their group and their day on the calendar, so the row keeps its place.' },
      { keys: 'c', action: 'Cancel task', detail: 'Tasks list only: mark the selected task as intentionally abandoned (`- [-]`), or un-cancel it. Cancelled tasks live under a “Cancelled” group, out of Today and Done.' },
      { keys: '@', action: 'Choose due date', detail: 'Tasks list, board, and calendar: give the selected task any due date from the month calendar that typing `@date` opens in a note, the same as Choose a date… in its right-click menu. It starts on the task’s due date (today without one); arrows move, Enter sets the day, or type a date.' },
      { keys: 'K / J', action: 'Move task up / down', detail: 'Tasks list only: reorder the selected task within its group. Works with Vim mode on or off, in Note order (see `s`).' },
      { keys: 's', action: 'Order the list', detail: 'Tasks list only: switch the order inside each group between the notes’ line order and priority (high, then medium, low, and none, ties by due date). Same as the Order menu above the list, `:order priority` / `:order note`, and `tasks_list_order` under `[view]` in config.toml.' },
      { keys: 'r', action: 'Restore trashed note', detail: 'Trash view only: restore the selected trashed note.' },
      { keys: 'x / d', action: 'Delete forever', detail: 'Trash view only: permanently delete the selected trashed note after confirmation.' },
      { keys: '/', action: 'Filter the view', detail: 'Focus the local filter box for tasks, tag matches, or trashed notes. In Tags, a word from a tagged block narrows the list to that block.' },
      { keys: 'F', action: 'Pick a saved Tasks filter', detail: 'Tasks view: open the list of saved filters and apply one. Save the current query with the Save filter… chip or `:savefilter <name>`.' },
      { keys: ':', action: 'Open local ex prompt', detail: 'Run the view-specific command line inside Tasks or Tags.' },
      { keys: 'Esc', action: 'Clear the filter', detail: 'Clears an active filter. These views are tabs, so Esc no longer closes them. Close with :q or the ✕ in the tab header.' }
    ]
  },
  {
    id: 'atlas-view',
    title: 'Atlas view',
    description:
      'On by default; switch it off under Settings → Atlas. Single-letter keys are Vim-mode only; arrows, Enter, and Esc always work, and every action is also on the toolbar chips along the bottom.',
    items: [
      { keys: 'f', action: 'Hint jump', detail: 'Two-letter labels appear over visible notes; type one to fly there. The same hint mode as everywhere else in the app.' },
      { keys: 'h j k l', action: 'Move the camera', detail: 'Pan the map in 2D; orbit and tilt the sky in 3D. Arrow keys do the same in either Vim mode.' },
      { keys: '+ / -', action: 'Zoom', detail: 'Fly closer or further. The mouse wheel and pinch do the same.' },
      { keys: 'v', action: 'Map or sky', detail: 'Toggle between the flat 2D map and the 3D sky. Both use the same frozen layout, so nothing ever shuffles.' },
      { keys: '1 2 3 4', action: 'Lenses', detail: 'Structure, Heat (recent editing glows), Orphans (notes with no links), and Bridges (notes holding regions together).' },
      { keys: '[ / ]', action: 'Previous / next region', detail: 'Fly between regions. Regions are your top-level folders.' },
      { keys: 'c', action: 'Links quiet, all, off', detail: 'How much of the link web is drawn. Quiet keeps lines faint until a note is hovered or focused.' },
      { keys: 'Enter', action: 'Open the focused note', detail: 'Click once to focus a note, twice (or Enter) to open it in the editor.' },
      { keys: '/', action: 'Filter', detail: 'Dim every note not matching a title or tag search, live.' }
    ]
  },
  {
    id: 'gallery-view',
    title: 'Gallery view',
    description:
      'A folder’s notes as cards, led by their covers. The view runs its own keyboard loop in the main pane, and the Vim leader works here too. The single-letter keys are Vim-mode only; with Vim mode off the arrows, Enter and Escape do the work, and typing into the filter field always works.',
    items: [
      { keys: 'h / j / k / l', action: 'Move across the grid', detail: 'Left and right walk the cards in reading order, from one row to the next; up and down keep the column. Down from a column the last row does not reach lands on the last card. The arrow keys do the same with Vim mode on or off.' },
      { keys: 'g g / G', action: 'First or last card', detail: 'Jump to the first or the last card in the current order.' },
      { keys: 'Enter / o', action: 'Open the note', detail: 'Open the note under the cursor and move into the editor. Ctrl+O comes back to the Gallery, on that card. A click opens it too.' },
      { keys: '/', action: 'Filter by title', detail: 'Move into the filter field: only cards whose title holds every word you type stay. Enter or ↓ goes back to the grid with the filter kept.' },
      { keys: 'Esc', action: 'Clear the filter', detail: 'Clears an active filter, in the field or on the grid.' }
    ]
  },
  {
    id: 'workflows-view',
    title: 'Workflows view',
    description:
      'Off by default; enable under Settings → Workflows. The single-letter keys below are Vim-mode only, like every list in the app; arrows, Enter, and Esc always work, and Shift+F10 (or the ContextMenu key) opens the row menu in either mode.',
    items: [
      { keys: 'j / k', action: 'Move between workflows', detail: 'Step through the list on the left. g g / G jump to the first and last.' },
      { keys: 'Enter', action: 'Open for editing', detail: 'Open the selected workflow on the canvas.' },
      { keys: 'R', action: 'Run', detail: 'Plan the selected workflow and show the dry-run confirmation: every change grouped and counted before anything is written. Applying journals each file, so the run can be undone byte for byte from the receipt.' },
      { keys: 't', action: 'Toggle draft / active', detail: 'A draft is saved but inert: it cannot run, from here or from the palette. Activating a workflow that writes lists exactly what it changes first.' },
      { keys: 'a', action: 'Add a step', detail: 'Start a new line with a source, picked from the registry with its arguments explained. To insert into an existing line, use Add step after on the node itself.' },
      { keys: 'e', action: 'Edit as text', detail: 'Flip between the canvas and the raw file. Both edit the same workflow; neither is the "real" one.' },
      { keys: 'n', action: 'New workflow', detail: 'Open the recipe gallery. Every recipe is a plain file that copies into your vault and opens in this same editor. Press x on a recipe to hide it from the gallery; hide or restore them all under Settings → Workflows.' },
      { keys: 'y / p', action: 'Copy / import via clipboard', detail: 'y puts the selected workflow file on the clipboard as text; p reviews whatever workflow text is on the clipboard before it can land, always as a manual-trigger draft.' },
      { keys: 'd', action: 'Delete', detail: 'Delete the selected workflow file, after confirmation.' },
      { keys: 'm', action: 'Row menu', detail: 'Open the context menu for the selected workflow: duplicate, export, reveal, and the rest.' },
      { keys: '?', action: 'Syntax reference', detail: 'Every step the format knows, with a real example each.' },
      { keys: 'r', action: 'Reload from disk', detail: 'Re-read the workflows directory, for files that arrived by sync or by hand.' },
      { keys: 'Shift/⌘ + click', action: 'Select several steps', detail: 'On the canvas, hold Shift (or ⌘ on macOS, Ctrl elsewhere) and click to add a step to the selection, or drag a box across the canvas with Shift held. Dragging any member of the group moves the whole group together. The options panel edits one step at a time, so it steps aside while a group is selected; Esc clears the selection.' },
      { keys: 'Mod+A', action: 'Select every step', detail: 'On the canvas, select all the steps in this workflow, ready to be moved as one. Inside a text box it still selects the text.' }
    ]
  },
  {
    id: 'database-grid',
    title: 'Database grid (Table view)',
    description: 'Keys for a CSV database table while its grid has focus; the grid takes them before any global motion. The single-letter keys (h / j / k / l, H / L, 0 / ^ / $, g g / G, i, x, o, O, c, m, a, d d) and Ctrl-o / Ctrl-w belong to Vim mode, like every list in the app. With Vim mode off the arrows, Enter, Space, Esc and Shift+F10 (or the Context Menu key) stay live, and the rest is in the row and column menus, the header buttons and the command palette.',
    items: [
      { keys: '↑ / ↓ / ← / →', action: 'Move the cell cursor', detail: 'In either mode. ↑ from the first row reaches the column-header row, where Enter renames the field and Shift+F10 opens its column menu. In Vim mode h / j / k / l move too, k climbs onto the header the same way, and 0 / ^ jump to the first column, $ to the last.' },
      { keys: 'Enter', action: 'Edit the cell', detail: 'In either mode; i does it too in Vim mode. On a checkbox cell this toggles it instead of opening an editor, and on the column header it renames the field.' },
      { keys: 'Space', action: 'Select the row', detail: 'In either mode; x does it too in Vim mode. On a checkbox cell Space toggles the checkbox instead. Selected rows get the selection bar: Delete, or Show only these in this view, which makes the selection the view’s picked rows (also Show Only Selected Rows in the command palette). The view then says “Showing N picked rows” under the header, with Edit picks and Show all rows.' },
      { keys: 'Shift+F10', action: 'Open the row menu', detail: 'In either mode, or the Context Menu key; m does it too in Vim mode. On a cell it is the record’s right-click menu (Open page, Delete row, and the rest); with rows selected it offers Show only selected rows, and in a view showing picked rows, Remove from this view’s picks. On the column header it is the column menu, with Hide column and Choose columns….' },
      { keys: 'Esc', action: 'Clear selection / leave the grid', detail: 'In either mode. Leaves Edit picks without changing them, else clears a multi-row selection, then blurs the grid.' },
      { keys: '[[ (in a text cell)', action: 'Link a note from the cell', detail: 'While editing a text cell, `[[` opens the same note search as the editor; ↑/↓ or Ctrl+N/P move, Enter inserts the `[[wikilink]]`, Escape closes the list and keeps typing.' },
      { keys: '↑ / ↓ · Enter (in a picker)', action: 'Pick options and notes', detail: 'Select, Multi-select, and Note link popovers are searchable lists: type to filter, arrows or Ctrl+N/P move the highlight, Enter picks it (with nothing highlighted, Enter adds the typed text as a new option), Escape closes.' },
      { keys: 'H / L', action: 'Move the current column left / right', detail: 'Vim mode. Reorders columns from the keyboard and the cursor follows. In either mode you can also drag a column header, or use Move left / Move right in the column menu.' },
      { keys: 'g g / G', action: 'Jump to first / last row', detail: 'Vim mode. Fast travel within the current column.' },
      { keys: 'c', action: 'Choose the columns this view shows', detail: 'Vim mode. Opens the Columns popover: j / k move, Space or x shows or hides the column, / jumps to the find field, Escape closes. With Vim mode off, use the Columns button beside Filter: the arrows move, Space or Enter toggles. Each saved view keeps its own columns, and the last visible one always stays. Also Choose Database Columns in the command palette.' },
      { keys: 'o', action: 'Open the record page', detail: 'Vim mode. Open the row as a Markdown note in the per-database folder. In either mode, Open page is in the row menu and on the row itself.' },
      { keys: 'O', action: 'Create pages for all records', detail: 'Vim mode. Give every record that has no page its note in the per-database folder, so each one can be linked with [[wikilinks]]. Records that already have a page keep it, a page file already in the folder under a record’s name is linked instead of copied, and rows with an empty title are left out. Asks first. In either mode it is also in the database’s ⋯ menu and the command palette.' },
      { keys: 'a', action: 'Add a row', detail: 'Vim mode. Append a new empty record and move the cursor to it; in either mode New row under the table and + Row in the header do the same. In a view showing picked rows the new row joins the picks, so it stays in view.' },
      { keys: 'd d', action: 'Delete the row', detail: 'Vim mode. Remove the record at the cursor. In either mode Delete row is in the row menu, and Delete in the selection bar removes the selected rows.' },
      { keys: 'Ctrl-o', action: 'Jump back to the grid', detail: 'Vim mode. From a record page, return to the database grid, whether you opened it as a .csv file or via New Database.' },
      { keys: 'Ctrl-w k / j / h / l', action: 'Move to tabs or panes', detail: 'Vim mode. Move between the grid, the tab strip, and split panes, exactly like from the editor.' }
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
    command: ':set [no]statusbar',
    summary: 'Show or hide the status bar',
    detail: 'The same switch as Settings, Appearance, Chrome, Status bar: `:set nostatusbar` hides the bar along the bottom, `:set statusbar` brings it back and `:set statusbar?` says which it is (`stb` for short). Hidden, the bar still shows while ZenNotes Cloud needs you.'
  },
  {
    command: ':harper [on|off]',
    summary: 'Grammar and spelling with Harper',
    detail: 'Turn Harper on or off for the editor, or toggle it with no argument. The same switch as Settings, Editor, Grammar and spelling with Harper.'
  },
  {
    command: ':unbind action.id',
    summary: 'Remove an action’s or a command’s key entirely',
    detail: 'Leave an action with no key at all, instead of parking it on some obscure chord: `:unbind global.zoomIn` takes Zoom in off its key until it is rebound or reset under Settings, Keymaps. `:unbind command note.trash` does the same for a command palette command. A bare id that names no action but does name a command unbinds the command; `nav.back`, both an action (`h`, back out) and the Go Back command, is the action, and `:unbind command nav.back` the command. Bare `:unbind` opens that page, which lists every id. The unbind travels in `config.toml` as `\"global.zoomIn\" = \"\"`.'
  },
  {
    command: ':bind <keys> command.id',
    summary: 'Give a command palette command a key',
    detail: 'The ex twin of Alt+Enter in the palette: `:bind <C-BS> note.trash`, `:bind <D-BS> note.trash` (Cmd+Backspace on macOS), `:bind <leader>xa note.archive` or `:bind <Space>xa note.archive`. Keys are written in Vim’s notation (`<C-…>` Ctrl, `<A-…>` or `<M-…>` Alt, `<S-…>` Shift, `<D-…>` Cmd, `<BS>`, `<CR>`, `<F5>`, `<leader>`) or the way Settings and config.toml write them (`Mod+Backspace`, `Space x a`); the command id is the last word. A key another of your bindings holds is refused, as is a sequence that starts on a built-in leader key. Bare `:bind` opens Settings, Keymap, which lists every command id.'
  },
  {
    command: ':ignorekey <key>',
    summary: 'Ignore a key everywhere',
    detail: 'Adds a key the app should never see, such as the KanaMode no-op a Kanata or QMK tap-hold layer sends with every keystroke, so it stops resetting `jk`, `dd`, leader chords and hints. Bare `:ignorekey` opens Settings, Keymap, where the recorder names the key. Same as `ignored_keys` under `[editor]` in config.toml.'
  },
  {
    command: ':filter <text or name>',
    summary: 'Filter the Tasks views',
    detail: 'In the Tasks view, narrows the list, the calendar, and the Kanban board to tasks matching the text; when the text is the name of a saved filter, that filter is applied instead. Bare `:filter` (or `:f`) clears it.'
  },
  {
    command: ':savefilter <name>',
    summary: 'Save the current Tasks filter under a name',
    detail: 'Keeps the query in the Tasks filter box as a saved filter called `<name>` (bare `:savefilter`, or `:sf`, asks for the name). It shows up as a chip under the Tasks header, in the command palette as “Tasks: name”, and in config.toml under `[saved_filters]`.'
  },
  {
    command: ':order due | manual | priority | note',
    summary: 'Order Kanban cards by due date or by hand, or the list by priority',
    detail: 'In the Tasks view, `:order due` sorts the cards in every Kanban column by due date, earliest first and cards without one last; `:order manual` brings back the order you dragged them into, which ordering by date never overwrites. On the board or the calendar, bare `:order` switches between the two, like `s` on the board in Vim mode. Same as `kanban_card_sort` under `[view]` in config.toml. In the list, `:order priority` puts high priority first inside each group and `:order note` brings back the notes’ line order; bare `:order` there switches between the two, like `s`. Same as `tasks_list_order` under `[view]`.'
  },
  {
    command: ':delfilter <name>',
    summary: 'Delete a saved Tasks filter',
    detail: 'Forgets the saved filter called `<name>` (`:df` for short). Deleting the line under `[saved_filters]` in config.toml does the same.'
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
    command: ':imgwidth {px}',
    summary: 'Resize the image on the cursor line',
    detail: 'Writes the `|width` size hint into the image embed under the cursor, the same edit as dragging the handle on the picture. `:imgw auto` strips the hint; `:imgw` with no argument opens the Resize Image prompt.'
  },
  {
    command: ':cover [image]',
    summary: 'Set the note’s cover image',
    detail: 'Bare `:cover` (or `:cov`) opens the cover picker. With an argument it sets the cover: an https URL, a vault image by path or unique file name, or a built-in cover by name (`:cover dusk`, `:cover earthrise`). `:cover unsplash fog` opens the picker’s Unsplash tab on that search (Enter picks the first photo), `:cover paste` uses the image on the clipboard, `:cover reposition` enters reposition mode, `:cover 30%` sets the focal point, and `:cover!` (or `:cover remove`) removes the cover.'
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
    command: ':version / :ve',
    summary: 'Show version details for a bug report',
    detail: 'Print the ZenNotes version, operating system and architecture, the Electron or browser engine, how this copy was installed (AppImage, deb, package manager, macOS app bundle, and so on), and the remote server version when connected to one. `:version copy` (or `:version!`) also puts the lines on the clipboard. The same details, with a Copy button, sit in Settings → About.'
  },
  {
    command: ':whatsnew',
    summary: 'Show what this version brought',
    detail: 'Open the What’s New window for this version of ZenNotes: its highlights and any announcement, with a link to the full release notes. The window also opens by itself the first time ZenNotes starts after an update, once per version. Desktop app.'
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
    detail: 'Both names are supported explicitly. Without an argument they open the move prompt; with a path like `Work/Research` (a folder of your notes area, as the sidebar shows it) or `archive/Reference` they move the active note there directly. `inbox/Work` still works on an Inbox vault.'
  },
  {
    command: ':bn / :bp',
    summary: 'Cycle tabs',
    detail: 'Move to the next or previous tab, or the next most-recent note when only one tab is open. The default normal-mode keymaps are `]b` and `[b`, both remappable in Settings, and both accept a count: `3]b` jumps three tabs forward, wrapping around the ring.'
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
    command: ':qa / :quitall / :xa / :wqa',
    summary: 'Close every tab everywhere',
    detail: 'Closes all tabs across all panes. The write-and-quit aliases save on the way out.'
  },
  {
    command: ':wa / :wall',
    summary: 'Write every unsaved note',
    detail: 'Saves all dirty notes across all panes without closing anything, like vim.'
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
    command: 'gD',
    summary: 'Create the note for the link under the cursor',
    detail: 'Like `gd`, but a link at a note that does not exist yet creates it at once at the suggested path (Inbox, named after the link) instead of asking first. A link named like a daily, weekly or monthly note, such as `[[2026-11-03]]`, creates that note where the calendar would. The keyboard twin of Cmd/Ctrl-clicking an unresolved wikilink.'
  },
  {
    command: 'K',
    summary: 'Open the link popover for the link under the cursor',
    detail: 'Opens the note the `[[wikilink]]` under the cursor names in a floating editor over this note, with the keyboard in it; a link to a note that does not exist yet offers Create note, and the new note opens there ready for typing. `K` on a link inside the popover moves on to that note. Escape in normal mode closes it and puts the cursor back on the link. Vim\'s own `K` looks up the word under the cursor; this one looks up the note. Rebind it as `vim.linkPopover`.'
  },
  {
    command: ':gallery [folder]',
    summary: 'Open a folder as a Gallery',
    detail: 'Opens the Gallery of the open note’s folder: its notes as cards led by their covers. With a folder, opens that one instead, given as a path in the vault (`:gallery inbox/Projects`), a folder in your notes (`:gallery Projects/Website`) or a system folder (`:gallery archive`). `:gal` for short; `Space G` and Open Folder Gallery in the palette do the same.'
  },
  {
    command: ':unresolved',
    summary: 'Open the Unresolved Links view',
    detail: 'Lists every `[[wikilink]]` in the vault that points at a note that does not exist yet, with the notes and lines that link to it. `:unres` for short; `Space u` does the same.'
  },
  {
    command: 'gy',
    summary: 'Copy the link under the cursor',
    detail: 'Copies a web link\'s URL, or the address behind a `mailto:` link, to the clipboard. The same as right-clicking the link and choosing Copy link.'
  },
  {
    command: 'o / O',
    summary: 'Open a line, continuing the list',
    detail: 'On a list item, `o` (below) and `O` (above) carry the marker forward like pressing Enter: bullets repeat, numbered lists advance and renumber, checkboxes start a fresh unchecked box, and indentation is kept. On a non-list line they open a plain new line as usual.'
  },
  {
    command: 'Mod+L',
    summary: 'Check off the task under the cursor',
    detail: 'Flips the checkbox on the cursor line between `[ ]` and `[x]` without leaving the mode you are in: normal mode stays normal, insert mode keeps typing. In visual mode it toggles every selected line (`Vjj` then Mod+L checks off three tasks), and one `u` undoes the lot. An in-progress `[/]` checks off to `[x]`, forwarded `[>]` and cancelled `[-]` lines are left alone, and a line with no checkbox becomes one. Rebind it as `editor.toggleCheckbox` (a single key chord, not a Vim sequence).'
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
    detail: 'Show jump labels over clickable targets (links, buttons, sidebar rows, tabs) to activate any of them from the keyboard. Works in the editor, sidebar, and the Tasks and Tags views, and survives home-row-mod keyboards: a bare modifier tap or an uppercase label no longer cancels the hints.'
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
    command: '<Space> i',
    summary: 'Leader insert template',
    detail: 'Pick a template and insert it at the cursor of the active note, instead of creating a new note from it.'
  },
  {
    command: '<Space> q',
    summary: 'Leader quick capture',
    detail: 'Open the floating, always-on-top capture window, same as the global hotkey.'
  },
  {
    command: '<Space> c',
    summary: 'Leader toggle calendar',
    detail: 'Show or hide the calendar panel for the active pane.'
  },
  {
    command: '<Space> n',
    summary: 'Leader toggle timeline',
    detail: 'Show or hide the Timeline panel (open tasks in date order, overdue and `#milestone` tasks marked) and move the keyboard into it.'
  },
  {
    command: '<Space> l s',
    summary: 'Leader toggle favorite',
    detail: 'Add or remove the active note from the Favorites section shown in the sidebar and on the home view.'
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
    command: 'gt / gT',
    summary: 'Next / previous tab',
    detail: 'Move through the open tabs, across panes. Also `:tabnext` / `:tabprevious` on the ex line, and rebindable under Settings → Keymaps. With Vim mode off, Ctrl+PageDown / Ctrl+PageUp (Cmd+Option+Right / Left on macOS) do the same.'
  },
  {
    command: '{count}gt / {count}gT',
    summary: 'Jump straight to a tab',
    detail: 'Vim-style direct tab selection: `2gt` goes to tab 2, `5gt` to tab 5 (a count past the end lands on the last tab). `{count}gT` walks that many tabs back instead. Tab numbers count across panes in the same order plain `gt` cycles.'
  },
  {
    command: ':closepanel / :closep',
    summary: 'Close the right panel',
    detail: 'Dismiss whichever right-hand panel is open (connections, outline, comments, calendar, timeline). Also a “Close Right Panel” command in the palette.'
  },
  {
    command: ':timeline',
    summary: 'Toggle the Timeline panel',
    detail: 'Show or hide the Timeline panel in the active pane, the same as Mod+7 or `Space n`.'
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
    summary: 'Toggle the heading, list item or callout at the cursor',
    detail: 'Collapse or expand the section beneath the heading at the current line, the lines under the list item there, or the callout whose title it is. This is the ex-line path to the editor fold and unfold motions.'
  },
  {
    command: ':foldall / :unfoldall',
    summary: 'Fold every heading, list item and foldable callout',
    detail: 'Collapse or expand every heading section, every list item with lines under it and every foldable callout at once, nested. This is the ex-line path to the editor-wide fold motions.'
  }
]

export const HELP_SETTINGS: HelpSettingsSection[] = [
  {
    title: 'Appearance',
    items: [
      { label: 'Theme, mode, and variant', detail: 'Pick a theme family: Apple, Gruvbox, Catppuccin, GitHub, Solarized, One, Nord, Tokyo Night, Kanagawa (Wave / Dragon / Paper Ink (Custom) / Lotus), Rosé Pine (Rosé Pine / Moon / Dawn), or the monochrome, true-black (OLED-friendly) Black Metal, plus light or dark mode and the active flavor or contrast where the theme supports it.' },
      { label: 'Window title bar', detail: 'Under Settings → Appearance → Chrome, turn off Window title bar to remove the main window title and controls on macOS, Windows, and Linux, including tiling desktops such as Hyprland. The sidebar and editor stay visible, and the change applies to open vault windows without a restart. Drag blank space in the tab strip, the sidebar header or the note list header to move the window, or use your window manager shortcuts. Press Cmd/Ctrl+, to restore the setting. The preference is saved as [appearance].show_window_title_bar in config.toml. In the browser app the same switch is called Title bar: it hides the bar with the open note’s title, in that browser.' },
      { label: 'Status bar', detail: 'Under Settings → Appearance → Chrome, Status bar shows or hides the bar along the bottom of the window: the ZenNotes Cloud status (Synced, Sync now, Set up) and, on desktop, the open note’s backlinks, words, characters, reading time and cursor position. It is on by default. Turned off, the bar stays hidden except while Cloud needs you: a sync that stopped or failed, files or vault settings waiting for review, a Cloud vault that went away, or a device that was signed out. Then it comes back until that is dealt with, so nothing that needs an answer goes silent. On Android the bar is the Cloud row at the bottom of the screen, and turning it off gives that row back to the note; the iPhone already shows that row only while Cloud needs you. Toggle it from the command palette (Toggle Status Bar) or, in Vim mode, with `:set nostatusbar` and `:set statusbar`. The preference is saved as [appearance].show_status_bar in config.toml.' },
      { label: 'Keep running in the tray', detail: 'Off by default. Under Settings → Appearance → Window, turn it on and closing the last window hides it instead of ending the session: a ZenNotes icon in the system tray (the menu bar on macOS) stays, Cloud sync and the Quick capture hotkey keep working, and the icon\'s tooltip and menu show the sync state while a Cloud vault is linked. Click the icon, or choose Open ZenNotes in its menu, to bring the window back; on macOS the Dock icon does too. Quit from the icon\'s menu, with Quit ZenNotes in the command palette, or with Cmd+Q on macOS. On a desktop with no tray host the icon does not appear: open ZenNotes again and the window comes back. `Space b` (Hide Window to Tray in the palette) hides the window on purpose, which a tiling window manager cannot do with minimise. The setting belongs to this computer and is not part of config.toml. While ZenNotes runs it also checks for updates every six hours, not only at launch.' },
      { label: 'Dark sidebar', detail: 'Tint the sidebar slightly darker than the canvas so the chrome reads as a distinct surface.' },
      { label: 'Sidebar arrows', detail: 'Show or hide disclosure arrows for collapsible sidebar folders and sections.' },
      { label: 'Use theme for PDF export', detail: 'Under Settings → Appearance → PDF export. Off by default, so exported PDFs use a clean light print theme. Turn it on to export in your current look instead: your theme (colors and dark/light, including custom themes), plus your enabled CSS snippets and color tweaks, as a full-bleed page. This toggle is the single switch for how the PDF looks; your CSS snippets style the export only while it is on, so you customize the PDF by editing your snippets, not with a separate print stylesheet.' }
    ]
  },
  {
    title: 'Editor behavior',
    items: [
      { label: 'Vim mode', detail: 'Turn CodeMirror Vim bindings on or off for the editor and reference pane.' },
      { label: 'Wrapped line motions', detail: 'Choose whether Vim $, I, A, and dependent operators such as v$, y$, d$, and c$ stop at the current visible display row or the full logical line when Word wrap is on. Explicit display-row motions g0, g^, and g$ stay display-row based in either mode.' },
      { label: 'Sync clipboard with Vim registers', detail: 'Mirror Vim and the system clipboard in both directions (like Vim\'s clipboard=unnamed): yank, delete, and change (y/d/c/x) copy to the clipboard, and p / P paste whatever is on the clipboard, so you can move text between ZenNotes and other apps without leaving normal mode. An image on the clipboard is saved into `assets/` and embedded, as with Cmd/Ctrl+V. With the setting off, `"+p`, `"*p` and insert-mode `Ctrl-R +` still read the system clipboard, images included. Only available when Vim mode is enabled.' },
      { label: 'Keep the input method out of normal mode', detail: 'With a Korean, Chinese, or Japanese input method active, a normal-mode key used to be composed into a syllable instead of running as a motion, so `j` typed ㅓ and `i` inserted an i before entering insert mode (#84, #464). On by default: outside insert mode the editor accepts no text input, so h j k l stay motions and i / a start a clean composition; insert and replace mode work as before. Skipped on touch devices, where hiding the keyboard would strand you. `[vim] block_ime_in_normal_mode` in config.toml.' },
      { label: 'Leader key hints', detail: 'Show a which-key style guide after pressing the configured Leader key so available leader actions stay visible while you decide. This setting is only available when Vim mode is enabled.' },
      { label: 'Leader hint behavior', detail: 'Choose whether leader hints auto-hide after a timeout or stay open until you dismiss them with the Leader key or Esc. These controls only appear when Vim mode is enabled.' },
      { label: 'Leader hint duration', detail: 'When behavior is Timed, control how long the which-key overlay stays visible and how long the pending leader sequence remains active after pressing the Leader key. This setting is only available in Vim mode.' },
      { label: 'Scroll offset', detail: 'Vim scrolloff: keep N lines visible above and below the cursor so it never hugs the top or bottom edge. Default 0 (off). Only applies with Vim mode on.' },
      { label: 'Smooth preview scroll', detail: 'Animate Ctrl+D / Ctrl+U half-page scrolling in the preview pane.' },
      { label: 'Vault text search backend and binary paths', detail: 'Choose Auto, the built-in searcher, ripgrep, or fzf for vault-wide text search. Auto prefers system tools when they are installed and falls back cleanly when they are not, you can provide explicit binary paths for ripgrep or fzf if they are not on your PATH, and Settings now shows the resolved runtime backend that will actually be used.' },
      { label: 'Live preview', detail: 'Hide markdown syntax on lines you are not actively editing. Also draws math, tables, and `mermaid` and `d2` diagrams in place; each turns back into its source when the cursor enters it.' },
      { label: 'Math size', detail: 'Scales inline `$…$` and block `$$…$$` math relative to the surrounding text, 50 to 200 percent, in the editor and the reading view, for both KaTeX and Typst; `math_font_scale` under `[editor]` in `config.toml`.' },
      { label: 'Render tables in live preview', detail: 'Show Markdown tables as interactive WYSIWYG widgets (edit cells, drag, right-click/`m` menu). Turn it off to keep tables as plain markdown text so you can edit them with the keyboard and Vim motions like any other line. When widgets are on, Arrow keys (and h/j/k/l) navigate cells; Shift+V then Shift+J/Shift+K move whole lines in the raw source. In Vim mode the cell cursor speaks the editor\'s language: motions (w/b/e, f/t, 0/$), operators (d/c/y with motions and text objects), visual selections, and yank/paste (y/p/P) through the same registers as the rest of the note, so you can yank in a cell and paste in the body, or the other way around. Shift+V selects whole rows: y takes them as Markdown table rows (from the header, with its divider row), so p in the note pastes a working table, and ⌘C (Ctrl+C on Windows and Linux) copies a selection without changing it. The `m` menu can also copy the whole table as Markdown or duplicate it below. Typing `[[` in a cell opens the same note picker as in a paragraph, with the same keys, and `|` starts the display text.' },
      { label: 'Detect code block languages', detail: 'On by default. Guess the language of a code block that names none, when it is long enough to tell, and highlight it with the guess in Edit mode and the reading view alike; Edit mode labels the block `python · detected`. The guess is never written to the note: pick it from the block’s language button to keep it. Off, such a block is plain text in both. `detect_code_languages` under `[editor]` in config.toml.' },
      { label: 'Sync title heading on rename', detail: 'On by default. A new note is created as `# <title>`, and with this on a rename carries that heading along: rename `Untitled` to `Groceries` and line one becomes `# Groceries`, from the breadcrumb, the sidebar, or the note list alike. Only an existing top-level `#` heading is rewritten and one is never invented, so a note that opens with prose, a list, or a `##` heading is untouched; deleting the `#` line opts that note out permanently. The heading is found after any frontmatter, and the rest of the note is left byte for byte as it was.' },
      { label: 'Grammar and spelling with Harper', detail: 'Off by default. Turn it on to underline grammar and spelling problems as you write, checked on this device by Harper (writewithharper.com); no text leaves the app. Hover a mark for the fixes, or in Vim mode press z= at the problem, ]s and [s to move between problems, zg to add a word to this vault\'s dictionary and zG to ignore one suggestion. Choose the English dialect below the toggle. Code, links and frontmatter are never checked, and notes past 120,000 characters are skipped.' },
      { label: 'Heading level labels', detail: 'Show H1 through H6 badges before headings. Heading fold arrows stay available whether labels are on or off.' },
      { label: 'Tab size', detail: 'Choose how many spaces a tab occupies when rendered and when indenting in every Markdown editor surface. Nested list levels also render this many columns deep, whatever the note’s source spacing, so levels stay tellable apart on any monitor.' },
      { label: 'Indent guides', detail: 'Draw a vertical guide line at each nested list level in the editor, at the Tab size columns. On by default; the raw markup is never changed either way.' },
      { label: 'Link popover on hover', detail: 'On by default. Resting the pointer on a `[[wikilink]]` in the editor opens the link popover, where the linked note can be edited, or created when it does not exist yet, without leaving the note you are in. Off, the popover opens only from the keyboard: `K` in Vim mode, or Shift+Cmd+K (Shift+Ctrl+K on Windows and Linux). `link_popover_on_hover` under `[editor]` in config.toml.' },
      { label: 'Text replacements', detail: 'Enable or disable typed expansions and manage the trigger-to-text rules under the dedicated Text replacements tab.' },
      { label: 'Note tabs and wrap tabs', detail: 'Enable or disable tab-based editing and split-friendly note workflows, and wrap the tab strip onto extra rows when it overflows.' },
      { label: 'Word wrap', detail: 'Wrap long lines to the editor width or let them scroll horizontally.' },
      { label: 'Blinking cursor', detail: 'Blink the editor caret and the Vim block cursor, or turn it off for a solid cursor (for example, to match the macOS "Prefer non-blinking cursor" accessibility setting). Applies to both the insert-mode caret and the Vim normal-mode block cursor.' },
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
      { label: 'Note covers', detail: 'Where a note’s cover image shows: on top of the text, scrolling away with it (the default); pinned above the editor and Read view so it stays in sight; or hidden. Hidden only stops drawing covers; the `banner` frontmatter stays in the note, the editor shows its lines in full instead of folding them into one `cover` line, and Quick Look on macOS follows it too.' },
      { label: 'Line numbers', detail: 'Switch between off, absolute, and relative gutter numbering.' },
      { label: 'Line number position', detail: 'Keep the gutter next to the centered text or pin it to the editor edge.' }
    ]
  },
  {
    title: 'Keymaps',
    items: [
      { label: 'Shortcut overrides', detail: 'Remap global app shortcuts, Vim-specific bindings, panel navigation keys, and view actions from one place, and give any command palette command a key of its own.' },
      { label: 'Commands', detail: 'The fifth group lists every command in the command palette, each with its title, category and id, all unbound to start: every command can take a key. A key is a chord with Ctrl, Alt or Cmd, or a function key, or with Vim mode on a leader sequence (the leader and one to three keys, `Space x t`), which does nothing with Vim mode off and is marked so. A command that already has a leader chord, like Toggle Note Favorite’s `Space l s`, keeps it, and its own key is added. The filter finds a command by title, category, keywords or id, and Settings search finds it by title. `Alt+Enter` on a palette row records a key without coming here, `:bind <keys> <command.id>` does it from the ex line, and in `config.toml` the keys live under `[keymaps.commands]`.' },
      { label: 'Recorded sequences', detail: 'Capture single shortcuts or multi-step sequences such as Leader flows, pane prefixes, `g g`, `g d`, or fold motions without editing raw config files.' },
      { label: 'Conflict detection', detail: 'When you record a global shortcut that another action already uses, the recorder names the clash and disables Save, so two actions can no longer silently share one key. The same goes between commands and actions, both ways: a key another of your bindings holds is refused. A command’s key that lands on a built-in default is allowed, since your key wins, and the recorder and both rows say which default stops answering it. A leader sequence that starts on a built-in leader key is refused, because built-in leader keys always win. Any existing clash shows a badge on the affected rows. Vim, navigation, and view keys that deliberately reuse a key by context are left alone.' },
      { label: 'Context-menu bindings', detail: 'The same keymap table controls the context-menu action used in the sidebar, note list, and preview-side active-tab menu, so mouse-free navigation stays configurable.' },
      { label: 'Unbind a key', detail: 'Unbind removes an action’s key entirely instead of parking it on some obscure chord: nothing triggers the action until you record a new key or reset it, the row reads “Unbound”, and the which-key hints, the command palette, and this manual stop advertising it. Unbind sits next to Change on every row and inside the recorder; `:unbind <action.id>` (for example `:unbind global.zoomIn`) does the same from the ex line, and in `config.toml` the entry is `"global.zoomIn" = ""`.' },
      { label: 'Reset controls', detail: 'Clear an individual override, including an unbind, or reset the entire keymap table back to the shipped defaults; Reset all also takes every command’s key away.' },
      { label: 'Ignored keys', detail: 'Keys the app never sees. Keyboard remappers with tap-hold layers (Kanata, QMK, ZMK) send a harmless extra key with every keystroke, on Linux usually the Katakana/Hiragana key, which reads as KanaMode, and each one used to reset a pending `jk`, `dd`, leader chord or hint. Record the key here (or `:ignorekey KanaMode`, or `ignored_keys = ["KanaMode"]` under `[editor]` in config.toml) and it is swallowed before the editor or any panel reacts.' }
    ]
  },
  {
    title: 'Vault',
    items: [
      { label: 'Vault location', detail: 'Reveal or change the root folder ZenNotes treats as the active vault.' },
      { label: 'Vault name', detail: 'What the sidebar header, the vault switcher and the title bar call this vault; the folder keeps its own name on disk. Leave it empty to use the folder name. Saved in the vault’s `.zennotes/vault.json`, so it follows the folder wherever it is opened. Also “Rename Vault…” in the command palette (`:vault_rename`) and the sidebar’s vault menu. Local vaults only.' },
      { label: 'Primary notes location', detail: 'Treat `inbox/` as the main notes area, or use the vault root directly for an Obsidian-style flat vault.' },
      { label: 'New Drawings, Databases & Tasks location', detail: 'Choose where new Excalidraw drawings, databases, and task files are created so they do not pile up in the vault root: the primary notes location (the default), the folder of the note you are currently viewing, or a specific folder you name (e.g. `assets/drawings` or `Tasks`). A specific folder lives inside the primary notes area, so `Tasks` means `inbox/Tasks/` in an Inbox vault and `Tasks/` in a root vault; the folder field shows the exact destination. Search Settings for "tasks folder" or "drawings folder" to jump there. Only new files are affected; existing ones stay put.' },
      { label: 'Shares location (macOS)', detail: 'Where a page or text shared from Safari and other apps with Share → ZenNotes is filed in this vault: Quick Notes (the default), the primary notes location, or a specific folder you name inside it. Saved in the vault’s `.zennotes/vault.json`. On a self-hosted server it needs server 2.79 or later; an older server keeps Quick Notes.' },
      { label: 'Daily notes', detail: "Enable a daily-notes workflow, choose a directory pattern, naming pattern, locale, and template so each day’s note starts in the right place. Supported tokens are `yyyy`, `yy`, `M`, `MM`, `MMM`, `MMMM`, `d`, `dd`, `EEE`, `EEEE`, `w`, and `ww`; quote literal words like `'Daily Notes'/yyyy/MM-MMM`. Open today’s note with `Space d`, `:daily`, or the command palette. For another day, past or future, double-click it in the calendar panel, or follow a link like `[[2026-11-03]]` to a day that has no note yet: both create that day’s note in the right place, from its template. Hover a day in the calendar panel to read its note, drawn the way it reads, without opening it. Two task options live here too: “Tasks are due on the note’s date” makes tasks in a daily note show on the calendar for that day (on by default), and “Roll over unfinished tasks to today” moves every unchecked task from past daily notes into today when you open it (off by default; also runnable from the command palette)." },
      { label: 'Weekly notes', detail: "Enable weekly notes with a directory pattern, naming pattern, locale, and template. Weekly patterns support the same tokens as daily notes plus ISO week `w` and `ww`; the default title pattern is `yyyy-'W'ww`. Open this week’s note with `Space w`, `:weekly`, or the command palette." },
      { label: 'Monthly notes', detail: 'Enable monthly notes with a directory pattern, naming pattern, locale, and template. It creates one note per calendar month, handy for monthly reviews and reflections. The default title pattern is `yyyy-MM` (e.g. `2026-07`). Open this month’s note with `Space m`, `:monthly`, or the command palette. Each notes section in Settings now collapses its fields when its toggle is off.' },
      { label: 'Folder Paths', detail: 'Point any of the four system folders (Inbox, Quick Notes, Archive, Trash) at a directory of your choosing, labels included; stored as `systemFolderPaths` in `vault.json` so the vault stays portable. Relabeling without moving anything on disk works too.' },
      { label: 'Folder icons', detail: 'Right-click a folder in the sidebar and choose a custom icon that follows the current theme colors.' },
      { label: 'Saved Remote Workspaces', detail: 'Save multiple remote servers or vaults, reconnect from Settings or the command palette, and edit or remove them later. When connected remotely, Settings also exposes Change Remote Vault…, Return to Local Vault, and Open Local Vault….' }
    ]
  },
  {
    title: 'Templates',
    items: [
      { label: 'Template library', detail: 'Browse every template, built-in and custom. Built-ins cover engineering (ADR, RFC, Bug Report, Postmortem, Meeting Notes, 1:1) and personal use (Daily Note, Weekly Review, Reading Notes, Journal, Project Kickoff, To-do).' },
      { label: 'Create a custom template', detail: 'Author a new template as markdown with optional frontmatter (`name`, `description`, `category`, `titleTemplate`, `targetFolder`, `targetSubpath`) and variables like `{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{week}}`, `{{cursor}}`, and the live `{{modified_date}}` / `{{modified_time}}` / `{{modified_datetime}}` (rendered from the note’s last-saved time rather than substituted). It is saved as a `.md` file in `.zennotes/templates/`.' },
      { label: 'Edit or reset built-ins', detail: 'Press Edit on a built-in to fork an editable copy that shadows the original everywhere; Reset removes the copy and restores the built-in. Custom templates can be edited or deleted directly.' },
      { label: 'Remove or restore built-ins', detail: 'Hide all the shipped templates with “Remove Built-in Templates” (a button here, or the command palette; it asks first), and bring them back with “Restore Built-in Templates”. Your custom templates, and anything already pointing at a built-in by id, keep working.' },
      { label: 'Where templates appear', detail: 'Use a template via the picker (`Space t` / `:template` / “New Note from Template…”), from a folder’s right-click “New from template”, or as the assigned daily/weekly note template. Custom templates work on a local vault, in the self-hosted web client, and on a remote vault served by ZenNotes server 2.46 or later; they are `.md` files in the vault’s `.zennotes/templates/`, so one saved in any client shows up in the others. Built-ins work everywhere.' }
    ]
  },
  {
    title: 'CLI',
    items: [
      { label: 'Install Command-Line Tool', detail: 'Symlink the bundled `zn` wrapper into a usable PATH location so any terminal session can capture, search, and edit notes. ZenNotes prefers user-writable directories and only prompts for admin access when no writable PATH target is available. The app carries the tested CLI runtime, so desktop-managed updates ship together. Builds with the terminal app install a persistent copy that also works after desktop closes.' },
      { label: 'Status, path, and quick reference', detail: 'Settings → CLI shows whether `zn` is installed, where the symlink lives, and a copy-able quick reference of the most useful commands. If the chosen directory is not on PATH yet, Settings shows the exact shell command to add it. An "External install" badge appears when something else owns `zn` so ZenNotes never clobbers an unmanaged binary.' },
      { label: 'Paths with spaces', detail: 'Quote note paths like `zn read "hellointerview/system design.md"` or pass them with `--path "hellointerview/system design.md"` so your shell keeps the path as one argument.' },
      { label: 'Raycast on macOS', detail: 'The Raycast extension requires `zn` and can be installed locally from this settings page. ZenNotes copies the bundled extension into app data, installs dependencies, builds it, and imports it into Raycast. It searches with `zn list --json`, then opens notes in ZenNotes through `zennotes://open` or `zennotes://open-window` and exposes archive, unarchive, trash, reveal, copy path, and copy wikilink actions from Raycast.' },
      { label: 'Uninstall', detail: 'Removes only the ZenNotes-managed symlink, never an arbitrary unmanaged binary named `zn`. The CLI stays inside the app bundle for next time.' }
    ]
  },
  {
    title: 'Tasks',
    items: [
      { label: 'Show tasks from archived notes', detail: 'Off by default: archiving a note retires its tasks from the Tasks list, calendar, and Kanban. Turn this on to keep them visible everywhere, Archive column included. The raw key is `show_archived_tasks` in `config.toml`.' },
      { label: 'Kanban statuses', detail: 'Define the ordered columns of the custom-status Kanban board here; `kanban_statuses` under `[view]` in `config.toml` is the file-level equivalent.' },
      { label: 'Tasks list order', detail: 'Note order keeps each group of the Tasks list in its notes’ line order, which Shift+J/K and dragging rearrange; Priority puts high priority first, then medium, low, and none, ties by due date. The list’s Order menu sets the same thing, and the raw key is `tasks_list_order` (`note` or `priority`) under `[view]` in `config.toml`.' },
      { label: 'Kanban card order', detail: 'Manual keeps the cards in the order you drag them into; Due date sorts every Kanban column by due date, cards without one last, and keeps your manual order for when you switch back. The board\'s Order menu sets the same thing, and the raw key is `kanban_card_sort` (`manual` or `due`) under `[view]` in `config.toml`.' }
    ]
  },
  {
    title: 'Atlas',
    items: [
      { label: 'Atlas', detail: 'On by default. The vault drawn as a map: every note a point sized by how linked it is, every wikilink a line, regions from your top-level folders, in 2D or 3D. Positions are computed once and cached so the map stays a place you know. Turning it off hides the sidebar row, the command, and the Space g binding. Theme authors can restyle it with the --z-atlas-bg and --z-atlas-region-1 through --z-atlas-region-8 variables.' }
    ]
  },
  {
    title: 'Workflows',
    items: [
      { label: 'Workflows', detail: 'Off by default. Turn it on to add the Workflows view (sidebar row, palette commands, and the Space a leader binding in Vim mode): saved, repeatable pipelines over your notes, edited on a canvas and run behind a dry-run confirmation with whole-run undo. Turning it off hides all of that again and closes the view if it is open.' }
    ]
  },
  {
    title: 'About',
    items: [
      { label: 'App identity', detail: 'See the ZenNotes app icon, current version, and a short description of the app as a keyboard-first markdown workflow with Vim motions and plain local files.' },
      { label: 'Version details', detail: 'Under the version, a Version details block lists what a bug report needs: operating system and architecture, the Electron or browser engine, how this copy was installed, and the remote server version when connected to one. Copy details puts the block on the clipboard. In Vim mode, `:version` prints the same lines and `:version copy` copies them.' },
      { label: 'What’s New', detail: 'The first time ZenNotes starts after an update, a window shows what the version brought, once: its highlights, any announcement, and a link to the full release notes. Escape or Close dismisses it. Open it again any time with What’s New in ZenNotes in the command palette, or `:whatsnew` in Vim mode.' },
      { label: 'Count this copy anonymously', detail: 'Once when ZenNotes is installed and once per update, the desktop app sends zennotes.org the version, operating system, architecture and install type, so we know how many copies are in use. It carries no identifier and nothing about your notes, vaults or account, and only daily totals are kept. On by default; turn it off here to send nothing. Set in config.toml as `[privacy] usage_count`.' },
      { label: 'Updates and releases', detail: 'Check for updates, download a newer build, install and relaunch, or jump straight to the latest GitHub release from inside the app. AUR and tarball installs get the check and the notice only; the package manager does the install.' },
      { label: 'Website, community, and issue links', detail: 'The app now exposes direct links to the ZenNotes website, Discord, GitHub repository, and issue tracker so support paths stay discoverable.' },
      { label: 'Configuration file', detail: 'Your preferences (theme, editor, Vim, keymaps, fonts, search backend, and more) are mirrored to a plain-text `config.toml` so you can sync them across machines with git, stow, or chezmoi. It lives at `$XDG_CONFIG_HOME/zennotes/config.toml` (`~/.config/zennotes/config.toml` on macOS and Linux, `%APPDATA%\\zennotes\\config.toml` on Windows), or wherever `$ZENNOTES_CONFIG_DIR` points. The file is self-documenting: every available setting is listed with its allowed values, and every keymap action is listed with its default binding (commented out: uncomment a line and edit it to remap, or set it to `""` to remove the key entirely), and every command palette command is listed under `[keymaps.commands]` (`"note.trash" = "Mod+Backspace"`, or `"note.archive" = "Leader x a"` for a leader sequence; a command id written straight under `[keymaps]` is read as a command key too and moved to that table on the next save), so you can discover and change anything without opening the app. That list reads the same on every OS: where macOS has its own default, the line notes it, as in `# "tabs.select1" = "Alt+1"  # Go to tab 1 (macOS: "Ctrl+1")`, so a file synced between a Mac and a Linux or Windows machine changes only when you change a setting. Settings → About has Reveal and Copy-path buttons. Existing setups are written out automatically the first time you launch this version, and edits to the file, by hand or via a synced dotfile, apply live without a restart. Machine-specific layout (window size, pane widths, collapsed folders) stays local so the file does not churn.' },
      { label: 'Lumary Labs', detail: 'The About section links to Lumary Labs at lumarylabs.com so company details stay easy to find from inside the app.' }
    ]
  }
]

export const HELP_CLI: HelpCard[] = [
  {
    title: 'What the CLI is for',
    body:
      '`zn` is a command-line companion that talks to your vault directly. It reads and writes the same markdown files the app does, so anything you do in a terminal (capture, search, append, archive, list tasks) shows up in the app instantly. Use it for shell pipelines, scripts, cron jobs, editor plugins (vim, emacs, helix), launcher integrations (Raycast, Alfred), or just because the keyboard is faster.'
  },
  {
    title: 'Install it once from Settings',
    body:
      'Open Settings → CLI and click Install. ZenNotes symlinks the bundled wrapper into a usable PATH location, preferring user-writable directories and only asking for admin access when no writable PATH target is available. After that, `zn --help` works in any new terminal. You can also run the install from the command palette via "Install Command-Line Tool (zn)".'
  },
  {
    title: 'The terminal app and existing installations',
    body:
      'Builds with the Go terminal tool include `zn tui`. An existing desktop-managed CLI keeps itself up to date (see Updates arrive without a ZenNotes update); keep using the same `zn` commands. Settings shows the installed terminal version and offers Repair if an upgrade needs attention. Desktop-installed commands keep following the desktop vault, while the TUI remembers its own selection. Explicit `--vault` and `--server` flags still win. Set `ZENNOTES_WORKSPACE_SOURCE=terminal` to use the terminal default for a command, or `ZENNOTES_CLI_ENGINE=legacy` to run the previous CLI during the transition. Homebrew and manual installations stay managed by their own installer. A shortcut left behind by a moved Mac app or an old AppImage can be repaired from Settings: review the old target, replacement and backup path before choosing Repair shortcut. Note saves preserve creation dates in small files under `.zennotes/note-metadata` without changing Markdown; keep the `.zennotes` folder with vault backups. Explicit legacy rollback needs the original app resources to remain available.'
  },
  {
    title: 'CLI 0.12.2 in desktop 2.78.0',
    body:
      'On macOS and Linux, desktop 2.78.0 bundles CLI 0.12.2. Run `zn` in an interactive terminal or `zn tui` to open the editor. It includes editable settings, restored splits and sessions, comments, attachments, templates, bulk actions, and cross-note yank and paste. Use `:version` in the TUI for a persistent report and press `c` or `y` to copy it. `zn status`, `zn doctor`, `zn config`, and `zn completion` help with setup and scripts; `zn server` manages native local servers, also available through `:servers`. Since 0.6.1, `zn vault list` marks each entry `app` (saved by this desktop app) or `terminal` (saved by zn itself) and says which of them `zn use`, `zn disconnect` and `zn vault remove` act on; every command starts without waiting on terminals that do not answer a background-color query; and the help output lines up. 0.6.2 is the first release with a signed manifest, which is how this app keeps its managed zn current, 0.6.3 reads a line over a lone `-` as a paragraph, as the app does (#898), and 0.7.0’s `zn mcp` records an assistant’s edits for review in this app and no longer lets an assistant write into `.zennotes`. 0.7.1 leaves cancelled tasks out of the open ones in `zn task list` and in `zn mcp`’s `list_tasks` (#929), and when a server needs a token, its message points to Settings → MCP → Server token. 0.7.2 reads tasks in numbered lists and quotes the way the app does, in `zn task` and in `zn mcp`, and 0.8.0 adds `zn task watch`, which prints each task status change as it happens, and gives each task’s status in `zn task list --json` and in `list_tasks`. 0.8.1 keeps a finished task note in its Custom status column and gives `zn mcp` this app’s assistant instructions again, and 0.9.0 follows the vault’s Task folders in `zn task list`, `zn task watch` and `zn mcp`, and the TUI’s Settings saves both Tasks folder lists where every app reads them. 0.9.1 keeps a wikilink of more than one word from widening the TUI preview’s row and scrolling the whole screen. 0.9.2 lets a second `$` on a wrapped line reach the end of the line and makes three backticks a code fence, 0.10.0 adds `zn base pages`, which gives every database record its record page so each can be linked, and 0.11.0 gives a task without a due date its own No due date group and Status board column, as this app does (#990), and orders the task list by priority with `O` or `:order priority` (#989). 0.12.0 can draw display math and TikZ in the TUI preview with `[terminal] math = "latex"`, using TeX installed on your computer (zn does not include TeX; `zn doctor` prints the install commands), 0.12.1 fits pictures in the preview to the pane as it grows or shrinks, and 0.12.2 says which TeX tool is missing and how to install it. Run `zn update --check` to see the latest CLI release; for a desktop-managed CLI, ZenNotes installs it. The full command reference is at https://zennotes.org/tui/docs.'
  },
  {
    title: 'Updates arrive without a ZenNotes update',
    body:
      'For a zn installed from Settings → CLI, ZenNotes checks the latest zn release once a day and installs it when it is newer than the zn you have, so a CLI fix no longer waits for a ZenNotes release. Every release carries a manifest signed with the ZenNotes release key: ZenNotes checks that signature and the download\'s checksum, then runs the new zn once to confirm it answers before switching to it, so a failed or tampered download never replaces a working CLI. The zn a ZenNotes build ships is its floor: a newer release stays installed across restarts, and a ZenNotes update that ships something newer takes over. A release that needs a newer ZenNotes waits until you update ZenNotes. Turn off Update zn automatically in Settings → CLI → Updates to be told instead; Check for updates there, or Check for zn Updates… in the command palette, checks right away. A zn installed with Homebrew, Go or by hand keeps updating through its own installer (`zn update`).'
  },
  {
    title: 'No app required',
    body:
      'The CLI reads from the same vault folder the desktop app uses, so it works whether or not ZenNotes is open. When the app is open, file watchers pick up CLI changes automatically, so captures and edits show up live in the sidebar.'
  },
  {
    title: 'Point it at a self-hosted server',
    body:
      'Every command works against a vault behind a ZenNotes server, not just one on this disk. Once you have connected the desktop app to a server, that server is nameable from the terminal: `zn list --server home`, `zn capture "..." --server home`. `zn vault list` shows local vaults and servers together, and `--vault <name>` resolves either kind, so the short name you already type keeps working. Pass a URL directly for a server you have not saved (`zn list --server 192.168.1.10:7878`) and `--token` for its auth token. For CI or a headless box, set `ZENNOTES_SERVER` and `ZENNOTES_REMOTE_TOKEN` instead of storing anything on disk. `zn open` is the one exception: it hands file paths to the desktop app, so it needs a local vault.'
  },
  {
    title: 'Capture is the gateway drug',
    body:
      'The fastest way to add a note is `zn capture "..."`. Pipe-friendly: `pbpaste | zn capture --tag idea` lifts the clipboard into a tagged note. The first non-empty line becomes the title. Markdown works too: `zn capture "- [ ] buy milk"` keeps the leading `- [ ]` as a task in the body (so it appears in the Tasks view) while the title reads "buy milk".'
  },
  {
    title: 'Read and search from the terminal',
    body:
      'Use `zn list` to see recent notes, `zn list --tag work --limit 5` to filter, `zn read inbox/Project.md` to print a body, and `zn search "deadline"` for full-text matches with file:line previews. Quote paths with spaces, like `zn read "hellointerview/system design.md"`, or use `--path`. Add `--json` to any command to get structured output you can pipe into `jq`.'
  },
  {
    title: 'Open notes, folders, and a second window',
    body:
      '`zn open inbox/Today.md` brings the ZenNotes window to the front with that note loaded, and `zn open ~/code/project/docs` opens a folder as a focused session without turning it into a vault. When a window already shows the vault or folder, `zn open` raises that window. Add `-n` (or `--new-window`) for a second window on the same notes instead, with its own tabs, leaving the first window where it was: `zn open -n ~/notes`. A markdown file outside every vault always reuses its editor window, since nothing keeps two standalone editors of one file in sync.'
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
      'Prefer `zn append` and `zn prepend` over `zn write` for journals and running lists: they preserve the rest of the body. Both accept `--body "literal"` or `--body -` to read stdin (so `cat ideas.txt | zn append daily.md --body -` works).'
  },
  {
    title: 'Tasks and folders',
    body:
      '`zn task list` enumerates open checkboxes across the vault with stable ids; with `--json`, each task also carries its status. `zn task toggle <id>` flips a task without opening the note. `zn task watch` prints a line each time a task’s status changes, with the previous and the new status: a card moved on the Kanban board, a task note’s `status:` or a line’s `@status:` edited, or a box checked. With `--json` each change is one line of JSON, so a script can start an agent when a task becomes ready; zn only reports, and whatever runs is your own script. `zn folder list / create / rename / delete` keep your subfolder tree manageable from the terminal.'
  },
  {
    title: 'MCP for AI agents',
    body:
      '`zn mcp` starts the ZenNotes MCP server in stdio mode, the same one Claude Code, Claude Desktop, and Codex use under the hood. The Claude desktop app\'s Code tab runs Claude Code, so it reads the **Claude Code (CLI + Desktop Code tab)** entry in Settings → MCP; **Claude Desktop (Chat)** reaches only its Chat tab. Once `zn` is installed from Settings → CLI, Settings → MCP installs configure the clients to launch `zn mcp` directly, so the install path is one stable absolute path that survives app moves; otherwise, a `zn` installed some other way included, they run the server bundled with the app. The server works on the vault the app has open: a folder on this machine, or a self-hosted ZenNotes server you connected from Settings → Vault. `vault_info` says which. Switch vaults in the app and the server follows: the assistant\'s next tool call is refused with a note naming the old and the new vault, and once `vault_info` confirms the switch it carries on in the new one, so nothing planned in one vault lands in the other. A server that requires a token needs one the MCP server can read, because the app keeps its own copy in the OS secret store. Settings → MCP → Server token → **Let assistants use it** saves it to `credentials.toml` in the config folder, the file `zn connect` writes and both servers read (`zn mcp` and the bundled one), and the assistant\'s next call uses it. Any program running as you can read that file, so it is your choice: **Stop sharing** removes the token, forgetting the server in Settings → Vault removes it too, and a new token you save for the server replaces it. From a terminal, `zn connect <server-url> --no-default` saves it the same way without changing which vault `zn` follows, and `ZENNOTES_REMOTE_TOKEN` in the MCP client\'s environment works as well. To point an agent somewhere else, give the command the same flags every other `zn` command takes: `zn mcp --vault work` or `zn mcp --server home --token <token>` in the client\'s config, or `ZENNOTES_SERVER` / `ZENNOTES_VAULT` in its environment. Beyond reading and writing notes, the server can hold a review with you through comments: ask the assistant to read a note\'s comments and answer them, and its replies land in the Comments panel under yours, signed with its name (`list_comments`, `add_comment`, `reply_to_comment`, `resolve_comment`).'
  },
  {
    title: 'Review an assistant’s edits',
    body:
      'When an assistant changes a note through MCP (`write_note`, `append_to_note`, `prepend_to_note`, `insert_at_line`, `replace_in_note`, `toggle_task`), ZenNotes keeps what the note said before, beside it in `.zennotes/agent-edits/`. The note then shows a banner, “Claude Code changed this note 4 minutes ago”, and **Review changes** opens the review in the note itself: each change inline, the removed lines above the new ones, with **Accept** and **Reject** on each and **Accept all**, **Reject all** and **Done** on top. Reject puts the old text back. The note is read-only while you review, and once every change is decided the kept copy is deleted. What you typed after the assistant is yours and is not part of the review. Keys: Ctrl+Alt+↓ and Ctrl+Alt+↑ (Cmd+Option on macOS) move between changes, Ctrl+Shift+Enter (Cmd+Shift+Enter) accepts and Ctrl+Shift+Backspace (Cmd+Shift+Backspace) rejects; in Vim mode, Vim’s diff-mode keys: `]c` and `[c` move, `dp` keeps a change and `do` puts back what it replaced. Escape or **Done** leaves the review and keeps what is undecided. The palette lists every note waiting (**Review Agent Changes**). To tell the assistant why, comment on a change before you decide it; it reads comments with `list_comments`. Turn it off in Settings → MCP → **Review agent edits**. Not kept yet: notes in a vault on a self-hosted server, new notes an assistant creates, and moves, renames and deletions (Trash keeps those).'
  }
]
