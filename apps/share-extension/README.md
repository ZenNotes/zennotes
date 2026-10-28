# Share extension (macOS)

Share > ZenNotes in Safari and any other app with a Share menu saves the page
(its link and title), the selected text, or both into Quick Notes.
`ZenNotesShare.appex` ships inside `ZenNotes.app/Contents/PlugIns`.

- `macos/ShareViewController.swift`: the sheet. It previews what is shared,
  takes an optional note line and a vault, and on Save leaves the share as one
  JSON file in `Captures/` inside the share inbox,
  `~/Library/Application Support/ZenNotes/Share Inbox/`. Return saves, Escape
  cancels, Tab reaches the vault menu.
- The app files the shares: `apps/desktop/src/main/share-inbox.ts` drains
  `Captures/` at startup, as files arrive while it runs, and when a server a
  share names connects. It creates the note with the vault code every other
  note goes through, so a remapped Quick Notes folder is honored, and deletes
  a share only after its note is written. It keeps `vaults.json` in the same
  folder for the sheet's vault menu.

The extension is sandboxed (macOS loads no other kind) and reaches no vault on
its own: a temporary-exception entitlement opens the share inbox to it and
nothing else, the same kind of entitlement the Quick Look extension reads
notes with. Not an App Group: macOS creates a group's folder only for a
process that asks through Foundation, and Electron's main process cannot ask,
so it could never write the vault list before the first share. A share made
while ZenNotes is closed waits in the inbox until the next launch.

## Building

`scripts/build-share-extension.mjs` compiles the Swift for the architecture,
signs it, and copies it into the app. electron-builder's afterPack hook
(`apps/desktop/build/after-pack.js`) calls it for each macOS build with the
identity the app is signed with, because electron-builder never signs
anything under `Contents/PlugIns`.

The inbox path is `SHARE_INBOX` in the build script. It goes into the
extension's Info.plist (`ZenNotesShareInbox`), where the app's main process
reads it back, and into its entitlements, so the two never disagree. The app
itself needs no new entitlement.

## Testing locally

1. `npx vitest run src/main/share-inbox.test.ts` in `apps/desktop` for the
   filing rules (title, note body, vault lookup, keep-on-failure).
2. Pack with the self-test compiled in:
   `ZENNOTES_SHARE_SELFTEST=1 npm run pack`. Sharing anything that contains
   `share-selftest-save` then fills the note line with `selftest note` and
   presses Save by itself, and what the sheet received goes to the log
   (`log show --info --predicate 'subsystem BEGINSWITH "com.adibhanna.zennotes"'`).
   Release and CI builds never compile it in.
3. Use a test copy of the packed app, never a second copy under the real
   identifiers: give the app and the extension their own bundle identifiers
   (keep `CFBundleName`: Electron finds its helper apps by it), drop the copy's
   `CFBundleURLTypes` and `CFBundleDocumentTypes`, add `ZEN_PERF=1` and
   scratch `ZENNOTES_USER_DATA_PATH` / `ZENNOTES_CONFIG_DIR` to its
   `LSEnvironment`, re-sign it inside out with the same entitlements, then
   `lsregister -f` it and `pluginkit -a` its extension. Afterwards
   `pluginkit -r`, `lsregister -u`, delete the copy, and empty the share
   inbox of test files.
