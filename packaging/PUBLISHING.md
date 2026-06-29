# Linux packaging — release publishing guide

How every Linux distribution channel for ZenNotes gets published, in the order
you have to do it. Written for the maintainer (Adib) who has **no Linux/Arch
machine** — every step below is doable from macOS + GitHub CI.

There are **four** Linux channels (plus Docker, which is separate):

| Channel                                           | Where it lives                            | Published by              | Per-release work                    |
| ------------------------------------------------- | ----------------------------------------- | ------------------------- | ----------------------------------- |
| **Installers** (AppImage / deb / pacman / tar.gz) | GitHub Release assets                     | `release.yml` on tag push | **Automatic** — just push the tag   |
| **AUR** (`zennotes-bin`)                          | `aur.archlinux.org` git repo              | You, manually             | Bump + sha256 + push                |
| **Nix flake**                                     | `flake.nix` in this repo                  | Merge to `main`           | Bump `release-data.json` (3 hashes) |
| **Flatpak**                                       | `packaging/flatpak/` (not on Flathub yet) | Local build only          | Bump url+sha256 (Flathub = future)  |
| **Homebrew** (`brew install --cask`, macOS)       | `packaging/homebrew/` → `ZenNotes/homebrew-tap` | You, manually       | Bump + sha256 + push to the tap     |

> Docker (`adibhanna/zennotes`) is handled separately by `docker-publish.yml` —
> not a Linux desktop package, not covered here.

---

## The dependency chain (why order matters)

Every manual channel **pins a hash of a GitHub Release asset**, so those assets
must exist _first_. The release is the root of the tree:

```
1. bump version  →  2. merge release branch → main  →  3. tag vX.Y.Z + push
                                                              │
                                          release.yml builds & uploads installers
                                                              │
                       ┌──────────────────────┬──────────────┴───────────────┐
                   4a. AUR                 4b. Flatpak                     4c. Nix
              (sha256 of tar.gz)      (sha256 of AppImage)      (source/npm/vendor hashes)
```

Do **not** start 4a/4b/4c until the v`X.Y.Z` assets have finished uploading.

---

## 0. Pre-flight fix (do once) — upload the tar.gz

⚠️ **Current gap:** electron-builder builds `tar.gz`, and the AUR PKGBUILD
sources `ZenNotes-<ver>-linux-x64.tar.gz` from the release — but
`.github/workflows/release.yml`'s upload step does **not** include `*.tar.gz` in
its `find` glob, so the tarball is built and then dropped. `yay -S zennotes-bin`
will 404 on the source until this is fixed.

In `release.yml`, add `*.tar.gz` to the upload glob:

```sh
find dist -maxdepth 1 -type f \
  \( -name '*.dmg' -o -name '*.zip' -o -name '*.exe' -o -name '*.AppImage' \
     -o -name '*.deb' -o -name '*.pacman' -o -name '*.tar.gz' \
     -o -name '*.blockmap' -o -name 'latest*.yml' -o -name 'latest*.yaml' \)
```

---

## 1. GitHub Release installers — automatic

- **Trigger:** push a tag matching `v*` (e.g. `v2.4.0`).
- **What runs:** `release.yml` → creates the release, then `npm run dist:linux`
  (electron-builder) on `ubuntu-latest` and uploads the assets. macOS/Windows
  build in parallel on their own runners. CI does the Linux build, so you don't
  need a Linux box.
- **Your job:** push the tag, then **verify all four Linux assets attached:**

  ```sh
  gh release view vX.Y.Z --repo ZenNotes/zennotes | grep -i linux
  # expect:
  #   ZenNotes-X.Y.Z-linux-x86_64.AppImage
  #   ZenNotes-X.Y.Z-linux-amd64.deb
  #   ZenNotes-X.Y.Z-linux-x86_64.pacman
  #   ZenNotes-X.Y.Z-linux-x64.tar.gz      ← only after step 0 is fixed
  ```

---

## 2. AUR (`zennotes-bin`) — manual push

**Heads-up:** the in-repo `packaging/aur/PKGBUILD` is already modernized (tar.gz
method, `pkgver=2.4.0`), but the **actual AUR clone** at
`~/Developer/opensource/zennotes-bin` is still the **old 2.3.0
AppImage-extraction** PKGBUILD. At v2.4.0 you must sync the new one over.

After the release tarball is live:

1. **Copy the modernized PKGBUILD into the AUR clone:**
   ```sh
   cp packaging/aur/PKGBUILD ~/Developer/opensource/zennotes-bin/PKGBUILD
   ```
2. **Pin the real sha256** (no Arch box needed — hash the uploaded asset on your Mac):
   ```sh
   curl -fL -o /tmp/zn.tar.gz \
     https://github.com/ZenNotes/zennotes/releases/download/vX.Y.Z/ZenNotes-X.Y.Z-linux-x64.tar.gz
   shasum -a 256 /tmp/zn.tar.gz
   ```
   Replace `sha256sums=('SKIP')` with the real hash in **both** the AUR clone's
   PKGBUILD and the in-repo `packaging/aur/PKGBUILD`.
   _(Use `shasum`, not `updpkgsums` — you have no Arch tooling locally.)_
3. **Regenerate `.SRCINFO`** (mirrors the PKGBUILD; `makepkg --printsrcinfo`
   needs Arch). Since you have no Arch box, either:
   - hand-edit `.SRCINFO`'s `pkgver` + `sha256sums` to match the PKGBUILD (it's a
     flat key/value mirror), **or**
   - let CI do the verifying — `aur-check.yml` runs a real `makepkg` + a
     `.SRCINFO` diff in an Arch container once the release asset exists.
4. **Push to AUR** (local branch is `main`, AUR remote branch is `master`):
   ```sh
   cd ~/Developer/opensource/zennotes-bin
   git add -A && git commit -m "zennotes-bin X.Y.Z-1"
   git push origin main:master
   ```
5. **Verify:** `aur-check.yml` (in this repo) builds the PKGBUILD in a real Arch
   container after the asset is live; on a real Arch/CachyOS box `yay -S zennotes-bin`.

> Keep `packaging/aur/PKGBUILD` + `.SRCINFO` (in this repo) in lockstep with the
> AUR clone — CI enforces the `.SRCINFO` sync.

---

## 3. Nix flake — merge to `main`, then bump hashes

- **"Publishing" = the flake on the default branch.** `nix run
github:ZenNotes/zennotes` reads the repo's default branch (`main`), so the
  flake goes live the moment `release/v2.4.0` merges to `main` (step 2 of the
  chain). No registry push.
- Until you bump the pin, it installs the **last tagged version** (currently
  2.3.0) — which builds and works; it just lags.
- **To track the new release**, after the tag exists bump
  `packaging/nix/release-data.json`:

  | field         | how to get it                                                   |
  | ------------- | --------------------------------------------------------------- |
  | `version`     | `X.Y.Z`                                                         |
  | `hash`        | `nix-prefetch-github ZenNotes zennotes --rev vX.Y.Z`            |
  | `npmDepsHash` | `prefetch-npm-deps package-lock.json`                           |
  | `vendorHash`  | run `nix build`, read the expected hash from the mismatch error |

  Then verify:

  ```sh
  nix build && ./result/bin/zennotes-desktop
  nix build .#zennotes-server && ./result/bin/zennotes-server
  ```

- **Needs Nix.** The flake targets darwin too, so you can do this on your Mac with
  Nix installed — or let the packaging contributors (@hallwack / @justkrysteq)
  send a one-line follow-up PR bumping the hashes each release.
- **Optional, later:** submit to the official **nixpkgs** repo (a PR to
  NixOS/nixpkgs) so users can `nix profile install nixpkgs#zennotes` without
  adding a flake input. Bigger lift + ongoing maintainer duty; not required for
  the flake-input method above.

---

## 4. Flatpak — local only for now

The manifest under `packaging/flatpak/` builds and runs locally, but **is not on
Flathub**, so end users can't `flatpak install` it yet.

- **Keep the local manifest current each release** — in
  `packaging/flatpak/org.zennotes.ZenNotes.yml`:
  - bump the source `url` to the new `vX.Y.Z` AppImage,
  - update `sha256` — `shasum -a 256` of that uploaded AppImage (same hash you'd
    compute for AUR's old AppImage method),
  - bump the `<release>` entry in `org.zennotes.ZenNotes.metainfo.xml`.
- **To actually publish to users:** submit to **Flathub** — a PR to the Flathub
  repo for app-id `org.zennotes.ZenNotes`, with screenshots in the AppStream
  metainfo and your sign-off as the app-id owner. Biggest lift of the four;
  currently a planned follow-up.

---

## 5. Homebrew (macOS) — manual push

The macOS counterpart to AUR: a **Homebrew Cask** that pins the signed +
notarized `.dmg` from the release. Lives in `packaging/homebrew/` (canonical
source) and is mirrored into the **`ZenNotes/homebrew-tap`** repo, which is what
`brew install --cask zennotes/tap/zennotes` resolves to.

- **One-time:** create the `ZenNotes/homebrew-tap` repo and seed it with the
  Cask — see [`packaging/homebrew/README.md`](./homebrew/README.md).
- **Each release:**

  ```sh
  packaging/homebrew/update-cask.sh X.Y.Z   # pins version + both arch sha256s from the release
  # commit the updated Cask here, then mirror Casks/zennotes.rb into the tap and push
  ```

  Checksums come from the GitHub API's asset `digest` field, so no DMG download.
  Because the app self-updates (`auto_updates true`), this only needs to be
  current enough for fresh `brew install`s — not every patch.

---

## TL;DR — v2.4.0 release runbook

1. **(once)** Add `*.tar.gz` to the `release.yml` upload glob (§0).
2. Bump version across the 8 `package.json` + lockfile, commit.
3. Merge `release/v2.4.0` → `main` (carries Nix + Flatpak + new AUR PKGBUILD into main).
4. Tag `v2.4.0`, push the tag → CI builds & uploads installers.
5. **Verify** the four Linux assets are attached (§1).
6. **AUR:** copy the new PKGBUILD to the AUR clone, pin sha256 (`shasum`), sync
   `.SRCINFO`, `git push origin main:master` (§2).
7. **Nix:** bump `release-data.json`'s 3 hashes — on your Mac with Nix, or a
   contributor PR (§3).
8. **Flatpak:** bump url + sha256 + metainfo locally; Flathub submission is a
   separate future task (§4).
9. **Docker:** confirm `docker-publish.yml` ran and pushed `adibhanna/zennotes`.
10. **Homebrew (macOS):** `packaging/homebrew/update-cask.sh X.Y.Z`, commit, then
    mirror `Casks/zennotes.rb` into `ZenNotes/homebrew-tap` and push (§5).

**Fully automatic:** GitHub installers (incl. tar.gz once §0 lands), Docker.
**Needs you every release:** AUR push, Nix hash bump, Flatpak local bump, Homebrew push.
**One-time future setups:** Flathub submission, nixpkgs submission, create the Homebrew tap.
