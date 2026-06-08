# Linux packaging (Arch / CachyOS)

This directory holds the AUR packaging for ZenNotes and notes for the
Arch-family Linux distribution.

## Why this exists

Two problems were reported on Arch-based distros (e.g. CachyOS) in
[#65](https://github.com/ZenNotes/zennotes/issues/65):

1. **The AppImage doesn't start.** AppImages need **FUSE 2** (`libfuse2`) to
   mount themselves, but Arch/CachyOS ship only FUSE 3 by default, so the image
   fails to launch.
2. **No `yay`-installable package.**

## Fixes

### Native Arch package from the release pipeline

`apps/desktop/package.json` now builds a **`pacman`** target alongside
`AppImage` and `deb`, so each release produces a native
`ZenNotes-<version>-linux-x86_64.pacman` artifact that installs with
`sudo pacman -U ZenNotes-*.pacman` — no FUSE involved.

> Build note: the `pacman` target uses `fpm`, the same tool the existing `deb`
> target relies on, and must be built on a Linux host (same as `deb`). Verify
> `npm run dist:linux` still completes after this change.

### AUR package (`yay -S zennotes-bin`)

`PKGBUILD` here defines `zennotes-bin`. It downloads the official AppImage and
**extracts** it at build time (`--appimage-extract`, which does not need FUSE),
installing the unpacked app to `/opt`. The installed app therefore runs on
CachyOS/Arch without `libfuse2`.

To publish / update:

```sh
cd packaging/aur
# 1. bump pkgver to the release tag (no leading "v")
# 2. fill in the checksum
updpkgsums
# 3. regenerate metadata
makepkg --printsrcinfo > .SRCINFO
# 4. test on an Arch/CachyOS box
makepkg -si
# 5. push PKGBUILD + .SRCINFO to the AUR git remote (ssh://aur@aur.archlinux.org/zennotes-bin.git)
```

## Workaround for users on the raw AppImage today

Until the native package lands, AppImage users on Arch/CachyOS can either:

```sh
# Option A: install FUSE 2
sudo pacman -S fuse2

# Option B: run without FUSE (extract-and-run)
./ZenNotes-<version>-linux-x86_64.AppImage --appimage-extract-and-run
```

If the app starts but shows a sandbox error, append `--no-sandbox` (or install
via the AUR/pacman package, which sets the setuid sandbox helper correctly).
