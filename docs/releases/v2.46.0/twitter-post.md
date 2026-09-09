# Twitter/X thread for ZenNotes 2.46.0

## Tweet 1

ZenNotes 2.46.0 is out.

💬 Review a note with your assistant, inside the note. Comments now thread and carry a name, and over MCP Claude Code (or Codex, or Claude Desktop) reads a note's comment threads, answers under yours, opens threads of its own anchored to a passage, and resolves settled ones. Its replies land in the Comments panel live, signed with its name. Thanks @gverger (#738).

https://github.com/ZenNotes/zennotes/releases/tag/v2.46.0

## Tweet 2

🗂 The Kanban Folder board now gives every note folder its own column, and :folderroot Projects turns one folder's children into the columns (deeper notes roll up, the rest share Other folders). No more @status tokens derived from paths. Thanks @andradejoelwp (#730).

## Tweet 3

⌨️ Home-row mods on Kanata, QMK or ZMK? The no-op key your tap-hold layer sends used to reset jk, dd and leader chords. Record it under Settings → Keymap → Ignored keys (or :ignorekey KanaMode, or ignored_keys in config.toml) and the app never sees it again. Thanks @potter1402 (#732).

## Tweet 4

⌨️ You can now remove a shortcut instead of remapping it onto some chord you will never press. Every row in Settings → Keymap has an Unbind button: the row reads Unbound, nothing fires the action any more, and Reset brings the default back whenever you want it.

## Tweet 5

Vim users: `:unbind vim.leaderOpenBuffers` does the same from the ex line, with a toast naming the key it took away. The leader hints, the command palette and the manual stop advertising it. Bare :unbind opens the Keymap page, which lists every action id.

## Tweet 6

🧳 It travels with your dotfiles. An unbind is `"global.commandPalette" = ""` under [keymaps] in config.toml, the file explains the convention next to the table, and a hand edit applies live.

## Tweet 7

🌐 Self-hosting? Custom templates now work in the web client and on a desktop connected to your ZenNotes server. Same .zennotes/templates/ folder as a local vault, same editor, and a template saved on one device shows up on the others through the change feed. Thanks @ajselzilic for the spec (#723).

## Tweet 8

📅 The @ menu now ends with Date…: a keyboard-first calendar for any day, next to Today, Yesterday, Tomorrow and Now. Arrows move, PageUp/PageDown change the month, Enter inserts the ISO date where the @ was. Know the date? Type it outright. h j k l and t work with Vim mode on. Thanks @uNyanda (#743).

## Tweet 9

🔖 Tasks filters you can keep. Save a query under a name and it becomes a chip under the Tasks header, a "Tasks: name" entry in the command palette, and :filter <name> in the view; F opens a picker with Vim on. The list lives in config.toml as [saved_filters], so it diffs and syncs with your dotfiles. Thanks @andradejoelwp (#731).

## Tweet 10

🛠 Fixed: on a vault in root mode, zn create and the MCP create_note tool filed new notes into inbox/ and vault_info said inbox. They now follow vault.json like the app does. Thanks @diazkev314 (#745).

## Tweet 11

🧮 Fixed: a $$ display block inside a callout now renders in both the editor and the reading view, with Typst and KaTeX alike. It used to stay raw in the editor and, with Typst, swallow the rest of the note in the reading view. Thanks @OstrichDowneyJr (#748).

## Tweet 12

📐 Fixed: Typst formulas were a fifth smaller than KaTeX's next to the same text, and a square root bar stayed black on dark themes. They now use the same 1.21 size factor KaTeX uses for Computer Modern, and every rule follows the text color. Thanks @cyperion (#746).

Free, open source, local-first Markdown notes.
https://zennotes.org

Issues closed: #723, #730, #731, #732, #738, #743, #745, #746, #748.
