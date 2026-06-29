# Homebrew packaging (macOS)

This directory holds the **Homebrew Cask** for ZenNotes and the steps to publish
and update it.

ZenNotes is a GUI app, so it ships as a **Cask** (not a formula). The Cask
downloads the signed + notarized `.dmg` from the GitHub release — the same
artifact the website links to — so `brew install` is just a thin, checksum-pinned
wrapper over the official build.

## Install (for users)

```sh
brew install --cask zennotes/tap/zennotes
```

(Equivalently: `brew tap zennotes/tap && brew install --cask zennotes`.)

Updates: the app updates itself via its built-in updater (`auto_updates true`),
so Homebrew won't fight it. `brew upgrade` still re-pins to the latest release.

## How this is wired

There are two pieces:

1. **The Cask source of truth** lives here: [`Casks/zennotes.rb`](./Casks/zennotes.rb).
   This is the file users actually install.
2. **The tap repo** is a separate GitHub repo, **`ZenNotes/homebrew-tap`**, whose
   only job is to host `Casks/zennotes.rb`. `brew install --cask zennotes/tap/zennotes`
   resolves `zennotes/tap` → `github.com/ZenNotes/homebrew-tap`.

We keep the canonical Cask in this monorepo (next to the AUR/Flatpak/Nix
packaging) and mirror it into the tap on each release, so all packaging lives in
one place.

Like every other channel (AUR, Nix, Flatpak), the Cask **pins a SHA-256 of a
GitHub Release asset**, so the release must exist first.

## One-time setup (creating the tap)

```sh
# 1. Create the tap repo (must be named exactly "homebrew-tap").
gh repo create ZenNotes/homebrew-tap --public \
  -d "Homebrew tap for ZenNotes (brew install --cask zennotes/tap/zennotes)"

# 2. Seed it with the Cask.
tmp="$(mktemp -d)"; git -C "$tmp" clone https://github.com/ZenNotes/homebrew-tap .
mkdir -p "$tmp/Casks"
cp packaging/homebrew/Casks/zennotes.rb "$tmp/Casks/zennotes.rb"
git -C "$tmp" add Casks/zennotes.rb
git -C "$tmp" commit -m "zennotes: add cask"
git -C "$tmp" push
```

Verify end-to-end:

```sh
brew install --cask zennotes/tap/zennotes
brew audit --cask --online zennotes/tap/zennotes   # optional, catches style/url issues
```

## Per-release update

After a new `vX.Y.Z` release is tagged and its macOS DMGs have finished
uploading:

```sh
# 1. Bump version + pin both arm64/x64 checksums (pulled from the release).
packaging/homebrew/update-cask.sh X.Y.Z

# 2. Commit the updated Cask in this repo (alongside the AUR/Nix bumps).

# 3. Mirror it into the tap and push.
tap="$(mktemp -d)"; git -C "$tap" clone https://github.com/ZenNotes/homebrew-tap .
cp packaging/homebrew/Casks/zennotes.rb "$tap/Casks/zennotes.rb"
git -C "$tap" commit -am "zennotes X.Y.Z"
git -C "$tap" push
```

The checksums come from the GitHub API's asset `digest` field, so step 1 does
**not** download the (large) DMGs.

## Notes

- **Signed + notarized.** `release.yml` signs and notarizes the macOS build
  (`APPLE_ID` / `APPLE_TEAM_ID` / `CSC_LINK`), so the Cask needs no
  `quarantine` workaround — the app opens without a Gatekeeper prompt.
- **Per-arch.** electron-builder emits separate `…-mac-arm64.dmg` and
  `…-mac-x64.dmg`; the Cask selects with `arch arm: "arm64", intel: "x64"`.
- **Official `homebrew/cask`** (so users could drop the tap and run
  `brew install --cask zennotes`) is a possible later step. It has a higher bar
  (review, notability, stable history); the custom tap above ships now and we
  control updates directly.
