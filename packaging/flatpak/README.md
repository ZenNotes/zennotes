# Linux packaging (Flatpak)

This directory holds the Flatpak packaging for ZenNotes.

## Why this exists

The same class of problem reported in
[#65](https://github.com/ZenNotes/zennotes/issues/65) — the AppImage failing to
start on some distros — also hits other setups. AppImages rely on the host's
`libfuse2` and system libraries; on Fedora Atomic/Silverblue, some Arch
variants, and minimal installs the image simply won't launch.

Flatpak sidesteps all of that: the app ships against a self-contained
[org.freedesktop.Platform](https://docs.flatpak.org/) runtime plus the
[Electron base app](https://github.com/flathub/org.electronjs.Electron2.BaseApp),
so it does not depend on host FUSE or system libraries, and it runs sandboxed.

## How it works

Like the AUR `PKGBUILD`, this manifest downloads the official AppImage from the
GitHub release and **extracts** it at build time (`--appimage-extract`, which
does not need FUSE). No source rebuild is required. The unpacked Electron app is
installed into `/app` and launched through
[`zypak`](https://github.com/refi64/zypak) (provided by the Electron base app),
which makes Chromium's sandbox work inside the Flatpak sandbox without the SUID
`chrome-sandbox` helper.

Files:

- `org.zennotes.ZenNotes.yml` — flatpak-builder manifest
- `zennotes.sh` — launcher that wraps the binary with `zypak-wrapper`
- `org.zennotes.ZenNotes.desktop` — desktop entry (Markdown + `zennotes://` handler)
- `org.zennotes.ZenNotes.metainfo.xml` — AppStream metadata

## Build & install locally

Requires `flatpak` and `flatpak-builder`.

```sh
cd packaging/flatpak

# one-time: runtime, SDK and Electron base app (from Flathub)
flatpak install -y flathub org.freedesktop.Platform//25.08 \
  org.freedesktop.Sdk//25.08 org.electronjs.Electron2.BaseApp//25.08

flatpak-builder --user --install --force-clean build-dir org.zennotes.ZenNotes.yml

flatpak run org.zennotes.ZenNotes
```

## Updating to a new release

```sh
cd packaging/flatpak
# 1. bump the `url` in org.zennotes.ZenNotes.yml to the new release tag
# 2. update the `sha256`:
curl -L -o /tmp/ZenNotes.AppImage \
  https://github.com/ZenNotes/zennotes/releases/download/v<version>/ZenNotes-<version>-linux-x86_64.AppImage
sha256sum /tmp/ZenNotes.AppImage
# 3. bump the <release> entry in org.zennotes.ZenNotes.metainfo.xml
# 4. rebuild and smoke-test (see above)
```

## Notes & limitations

- **Sandbox permissions:** `--filesystem=home` is granted so notes (plain
  Markdown files) are reachable. Tighten it to a specific path (e.g.
  `--filesystem=~/Notes`) if you prefer.
- **Auto-update is disabled** inside Flatpak (`electron-updater` cannot replace a
  read-only `/app`). Update via `flatpak update` once published, or rebuild with
  a new `url`/`sha256` for a local install.
- **Publishing to Flathub** would be a follow-up: it needs the `com.adibhanna.*`
  app-id owner's sign-off plus screenshots in the AppStream metadata.
