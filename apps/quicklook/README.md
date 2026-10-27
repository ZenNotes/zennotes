# Quick Look preview (macOS)

Space on a Markdown file in Finder shows it rendered the ZenNotes way, with an
Open in ZenNotes button. Three pieces ship inside `ZenNotes.app/Contents/PlugIns`:

- `src/`: the page. It renders with app-core's own Preview, in the user's theme
  and fonts from `~/.config/zennotes/config.toml`, read-only. Typst math and the
  plot renderers stay out (KaTeX typesets math), as do the Excalidraw fonts.
- `macos/Extension/`: `ZenNotesQuickLook.appex`, the sandboxed Quick Look
  extension. It serves the page and the files the note embeds (its cover image
  included) over its own `zenql://` scheme, behind a Content-Security-Policy
  that allows nothing else, so a preview never goes online. WebKit's helper
  processes still need the network-client entitlement to start at all.
- `macos/Opener/`: `ZenNotesQuickLookOpener.xpc`, inside the extension. Quick
  Look's sandbox lets a preview launch nothing, so this unsandboxed service opens
  the note in the ZenNotes that contains it (the same route as a Finder
  double-click) and outside links in the browser. It re-checks every request.

## Building

`scripts/build-extension.mjs` builds the page once, compiles both Swift targets
for the architecture, and signs them. electron-builder's afterPack hook
(`apps/desktop/build/after-pack.js`) calls it for each macOS build, with the
identity the app is signed with: electron-builder never signs anything under
`Contents/PlugIns`.

## Testing locally

1. `npm run test:run --workspace @zennotes/quicklook` for the page logic.
2. Pack with the self-test compiled in:
   `cd apps/desktop && ZENNOTES_QUICKLOOK_SELFTEST=1 npx electron-builder --dir`.
   A note containing `quicklook-selftest-open` then presses the button by
   itself, and one containing `quicklook-selftest-keys` sends `j j j`, `G` and
   `gg`; results go to the log (`log show --predicate 'subsystem BEGINSWITH
   "com.adibhanna.zennotes"'`). Release and CI builds never compile it in.
3. Register the packed app's extension and preview a note:
   `pluginkit -a <app>/Contents/PlugIns/ZenNotesQuickLook.appex`, then
   `qlmanage -p note.md`. Registering a copy of the app also registers its URL
   scheme and document types, and the button launches it with your real
   profile: give a test copy its own bundle identifiers (app, extension and
   opener), drop its `CFBundleURLTypes` and `CFBundleDocumentTypes`, add
   `ZEN_PERF=1` and scratch `ZENNOTES_USER_DATA_PATH` / `ZENNOTES_CONFIG_DIR` to
   its `LSEnvironment`, re-sign it, and unregister it afterwards
   (`pluginkit -r`, `lsregister -u`).
