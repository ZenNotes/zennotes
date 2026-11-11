# Clip web pages with the ZenNotes Web Clipper

This guide shows how to install the ZenNotes Web Clipper in your browser, clip a page into a
note, and fix the few things that can stop a clip from arriving.

The clipper is a browser extension, built in its own repository
([ZenNotes/web-clipper](https://github.com/ZenNotes/web-clipper)). It turns a page into Markdown,
puts the note on the clipboard and opens a `zennotes://new` or `zennotes://daily` link. The
ZenNotes app writes the file. Nothing passes through a server and there is no account.

## Requirements

- ZenNotes desktop 2.85.0 or newer on macOS, Windows or Linux
- One of these browsers:
  - Chrome, Edge, Brave or Arc: install from the Chrome Web Store
  - Firefox: install from Firefox Add-ons
  - Safari on a Mac: install the ZenNotes Web Clipper app from the App Store, open it once, then
    turn the extension on in Safari Settings, Extensions

On iPhone and iPad, Safari's clipper copies the note for you to paste into ZenNotes or anywhere
else; the phone apps do not take clip links yet.

## 1. Clip a page

1. Open the page you want to keep.
2. Press `Alt+Shift+Z` (`Option+Shift+Z` on a Mac), or click the clipper's toolbar button.
3. Check the note's name and folder. The folder is `Clippings` unless you change it in the
   clipper's settings or in a template.
4. Pick where it goes: a new note, the top or bottom of a note you already have, or the top or
   bottom of today's daily note.
5. Press `Mod+Enter`.

ZenNotes comes forward with the note open. If it was closed, it starts and files the clip once
it is ready.

## 2. What ZenNotes does with a clip

- **It never overwrites a note.** A taken name gets the next free one (`My Article 2`).
- **The folder is inside your notes area.** In a vault that keeps notes at its top level,
  `Clippings` sits beside your other notes; otherwise it is inside the Inbox. A remapped Inbox
  folder is honored.
- **An open note keeps your typing.** Adding to a note that is open goes through the editor, so
  text you have not saved stays, and undo takes the clip back out.
- **The vault is matched by name.** With more than one vault, the clipper can name one; ZenNotes
  matches the vault's name or folder name, never a path. A name that matches no vault, or two,
  writes nothing and says so.

## 3. If a clip does not arrive

**"The clip did not arrive (the clipboard changed). Clip it again."** ZenNotes files the clipboard
only when it holds exactly the note the link vouches for, so a web page cannot make it save
something else you copied. If you copied something between the clip and ZenNotes reading it,
clip again.

**Nothing happens at all.** The browser could not find an app for `zennotes://` links:

- macOS and Windows: open ZenNotes once. It registers itself as the handler at every start.
- Linux: the `.deb`, `.rpm`, AUR and Nix packages register ZenNotes for these links. A bare
  AppImage does not until something integrates it with your desktop, such as AppImageLauncher.

**The browser asks whether to open ZenNotes.** That is the browser's own prompt for an external
link. Allow it, and tick "always allow" if the browser offers it.

## Use the links from other tools

Raycast, Shortcuts, Alfred or a script can hand ZenNotes a note the same way. The links, their
parameters and their safety rules are in [`docs/web-clipper-link.md`](../web-clipper-link.md).
