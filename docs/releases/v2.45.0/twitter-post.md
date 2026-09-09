# Twitter/X thread for ZenNotes 2.45.0

## Tweet 1

ZenNotes 2.45.0 is out. Two fixes from the community this week.

⌨️ The arrow keys move through the [[ , @ and / menus again in the main editor. They used to close the menu and move the caret, so only Ctrl+N/P worked. Thanks @ArditZubaku for the fix and OmnivorousKumquat for the report that led to it.

https://github.com/ZenNotes/zennotes/releases/tag/v2.45.0

## Tweet 2

🌐 Self-hosting behind a reverse proxy that does not pass WebSockets? The desktop used to freeze its note list at connect time, so a note renamed on your phone failed with "404 not found" when you trashed it on the laptop. It now refreshes every 30 seconds on its own, and a stale note says exactly what happened and refreshes the list. Thanks mptpro for the report.

## Tweet 3

📝 Also new: the docs and the [[ picker itself now say how to move through it (↑/↓, Ctrl+J/K, Enter, Tab, Esc).

Free, open source, local-first Markdown notes.
https://zennotes.org

Issues closed: #739, #734. Pull request merged: #707.
