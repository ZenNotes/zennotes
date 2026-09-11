# Twitter/X post for ZenNotes 2.48.0

Post once the GitHub release has all its assets and the channels are verified.

## Single post (bullet list, preferred)

ZenNotes 2.48.0 is out:

• Resolving a Cloud conflict saves one note, without downloading the whole vault first
• A saved decision stays saved, even when the sync after it is slow or fails
• Queued conflicts merge on their own once both sides can be combined safely
• Interrupted large uploads clean up properly, no more "Controller is already closed"
• Cloud Settings shows the current sync state, not the last one
• Escape cancels a Quick Capture selection without closing the window (#765)
• Nix package builds against nixpkgs 25.11+ (#763, thanks @blueagledev)

Download: zennotes.org

## Thread

### Tweet 1

ZenNotes 2.48.0 is out. It follows up on the 2.47.0 Cloud conflict work: choosing a version for a conflicted note now saves that one note right away, instead of waiting on a download of the whole vault. On a vault with many attachments that wait could time out with nothing saved.

### Tweet 2

A saved decision now stays saved. The review moves on the moment the note is safe, and the rest of the vault syncs in the background. If that later sync fails you see "Note saved. Remaining vault sync failed:" with the reason, instead of an open review on a note that was already resolved.

### Tweet 3

Edited different parts of the same note on two devices? Sync now rechecks queued conflicts and merges the ones that combine cleanly, such as a new date at the top on one device and a paragraph added at the bottom on the other. Real overlaps, unfinished drafts and renames still wait for you.

### Tweet 4

Interrupted large uploads clean up after themselves (no more "Controller is already closed"), and Cloud Settings follows the live sync state: no stale "up to date" during a failure, no old error after a successful retry.

### Tweet 5

Escape now cancels a Quick Capture selection without closing the window (#765). The Nix package uses the top-level X11 libraries and builds on nixpkgs 25.11 and later (#763). Thanks @uNyanda for the reports and @blueagledev for the Nix PR.

Free, open source, local-first Markdown notes.
https://github.com/ZenNotes/zennotes/releases/tag/v2.48.0

Arch: yay -S zennotes-bin

## Short alt

ZenNotes 2.48.0: Cloud conflict decisions save one note and stay saved, queued conflicts merge on their own when they safely can, interrupted uploads clean up, and Escape cancels a Quick Capture selection without closing the window. zennotes.org

## Notes

- Release PR: https://github.com/ZenNotes/zennotes/pull/766
- Issues closed: #765. PRs merged: #763 (Nix), #760 (dependencies).
- Task visibility during conflicts and identical-file convergence shipped in 2.47.0; do not present them as new.
- Desktop and shared-package work only; no website deployment or mobile release.
- No demo clip was recorded for this release.
