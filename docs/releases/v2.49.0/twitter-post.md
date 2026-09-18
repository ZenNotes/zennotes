# Twitter/X post for ZenNotes 2.49.0

Post once the GitHub release has all its assets and the channels are verified.

## Single post (bullet list, preferred)

ZenNotes 2.49.0 is out:

• Cloud sync uploads attachments over 5 MB again, no more "object upload failed (411)"
• Every image in a note makes it into the PDF export, not just the ones near the top (#769)
• Space just inside an existing **bold** span inserts a space, not a second marker pair (#770)
• Cmd/Ctrl-click a wikilink at a missing note to create it at once, no prompt; gD does the same from the keyboard (#768)
• Unresolved wikilinks are drawn muted and dashed in the editor, like the reading view (#768)

Download: zennotes.org

## Thread

### Tweet 1

ZenNotes 2.49.0 is out. First, Cloud sync: a file over 5 MB streams straight to object storage, and that request went out without a Content-Length, which the storage refuses with 411. The desktop now sends the length; large attachments sync again. Thanks Sasori and @uNyanda for the Discord reports.

### Tweet 2

PDF export now waits for every image in the note before printing. The preview lazy-loads images, which is right on screen, but the export renders in a hidden window that never scrolls, so anything below the first screen printed as an empty frame with a caption (#769).

### Tweet 3

Pressing Space with the cursor just inside an existing **bold** span used to insert a second marker pair, and Backspace then took the original marker with it. The snippet now reads the rest of the line and stays out of the way when the pair is already closed (#770).

### Tweet 4

Wikilinks at notes that do not exist yet: hold Cmd (macOS) or Ctrl (Linux/Windows) while clicking one and the note is created immediately at the suggested path, no prompt. Keyboard twin: gD in normal mode. A plain click still asks, for when you want a custom path (#768).

### Tweet 5

And you can now tell which wikilinks are live: a link at a missing note is drawn muted with a dashed underline in the editor, the way the reading view already did it, and it flips to the live look the moment the note exists. Thanks @uNyanda and SomeoneInTheRoom for the reports.

Free, open source, local-first Markdown notes.
https://github.com/ZenNotes/zennotes/releases/tag/v2.49.0

Arch: yay -S zennotes-bin

## Short alt

ZenNotes 2.49.0: Cloud sync uploads large attachments again, every image lands in the PDF export, Space inside existing bold behaves, and a missing note is one Cmd/Ctrl-click (or gD) away from its wikilink, with unresolved links drawn apart from live ones. zennotes.org

## Notes

- Issues closed: #769, #770, #768. Discord: the 411 upload report (Sasori, unyanda), no GitHub issue; reply on Discord once released.
- Release PR: https://github.com/ZenNotes/zennotes/pull/771 (merged by the fast-forward of main). Released 2026-09-13; all channels verified the same evening.
- Contributor PR #715 (PDF wikilink images) overlaps #769 with a different diagnosis; decide before the release whether to close it with a note or take its tests.
- Media in `media/`: `zennotes-2.49.0-demo.mp4` (all three fixes, 56 s, 1080p, captioned) plus one clip per issue, `zennotes-2.49.0-issue-769.mp4` (16 s), `-issue-770.mp4` (13 s), `-issue-768.mp4` (22 s); stills `769-pdf-export-bottom-images-after.png` and `768-unresolved-wikilinks-editor.png`. Recorded from the built app over CDP (`scratchpad/demo/demo.mjs`: frame loop + in-page captions + the rendered PDF pages spliced in, assembled with ffmpeg concat).
