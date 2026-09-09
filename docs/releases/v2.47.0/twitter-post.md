# Twitter/X thread for ZenNotes 2.47.0

Draft for release day. Do not post until the release is published and the dependency-audit blocker is cleared.

## Tweet 1

ZenNotes 2.47.0 fixes a data-loss bug in drawings: switching from one Excalidraw drawing to another could overwrite the one you opened with the one you left (#755). Each drawing now saves to its own file, no matter how fast you switch. If you hit this, please update.

## Tweet 2

The Connections panel no longer mistakes an embedded image for a missing note (#757). A wikilink at a file in your vault now shows as a file and opens in its own tab, from the panel, from gd, and from a click. Creating a note is offered only when nothing answers the link.

## Tweet 3

Also in 2.47.0: your tasks stay visible while a Cloud conflict waits. Calendar, Kanban and List show your local tasks with a small "Conflict pending" label. You can review the note later without losing sight of today's work.

## Tweet 4

Made both devices' files identical by copying the whole note? The next sync now clears that conflict and lets the file sync normally again. Genuine differences still need your decision. Unfinished merge drafts are kept safe.

## Tweet 5

Review drafts stay safe across desktop windows too. One window edits a conflict at a time, and sync waits for the latest draft to be saved. Thanks @uNyanda for the reports and gverger for #755. Release PR #752.

Free, open source, local-first Markdown notes.
https://zennotes.org

## Notes

- Release PR: https://github.com/ZenNotes/zennotes/pull/752
- No separate GitHub issue was created for these September 8 reports. Do not mark the older conflict-workflow issue #683 as newly closed.
- Desktop and shared-package fixes only; no Laravel website deployment or mobile release is included.
- No new demo video has been recorded for this release.
