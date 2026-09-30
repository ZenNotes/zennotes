// electron-builder hard-links copied resources to save space, so the icons in
// `resources/arch-extras/icons` end up sharing an inode with the desktop-
// integration icons generated from `build/icons`. When fpm/tar then build the
// .deb, one is stored as a hard link to the other — and `dpkg` can't recreate
// that link when `/opt` and `/usr` live on different filesystems, failing the
// install with "Invalid cross-device link" (#223).
//
// `arch-extras/` only exists for the AUR package (which repackages the tar.gz),
// so the .deb/pacman/AppImage never need it cross-linked. Rewrite every file
// under it as a brand-new file (fresh inode) so nothing is hard-linked into the
// package. Cheap — these are a handful of small PNGs plus a .desktop file.
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function rewriteAsFreshFiles(dir) {
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return // arch-extras absent for this build — nothing to do
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await rewriteAsFreshFiles(target)
    } else if (entry.isFile()) {
      const data = await fs.promises.readFile(target)
      const tmp = `${target}.cross-device-unlink`
      // Write a new file then atomically replace the directory entry: the old
      // (possibly hard-linked) inode keeps its other references untouched, and
      // this path now points at a fresh, unshared inode.
      await fs.promises.writeFile(tmp, data)
      await fs.promises.rename(tmp, target)
    }
  }
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  if (platform === 'darwin' || platform === 'linux') {
    const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
    if (!arch) throw new Error(`Unsupported terminal package architecture: ${context.arch}`)
    const localDirectory = process.env.ZENNOTES_TERMINAL_ARTIFACT_DIR
    const allowLocal = process.env.ZENNOTES_ALLOW_LOCAL_TERMINAL === '1' && !process.env.CI
    const { stageTerminalArtifact } = await import(pathToFileURL(path.resolve(__dirname, '../../../tooling/scripts/terminal-artifact.mjs')).href)
    const resources = platform === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources')
    // `zn-cli`, not the `terminal` of 2.52.0 to 2.57.0: those releases shipped
    // `terminal` as root-owned 0700 (#869), and dpkg and pacman keep an
    // existing folder's mode on upgrade, so fixing the mode alone never
    // reached installed copies. A new name is created fresh with the packaged
    // mode, and the old folder is removed with the old package's files.
    // cli-install.ts reads the same name.
    await stageTerminalArtifact({ platform, arch, localDirectory, allowLocal, output: path.join(resources, 'zn-cli') })
  }
  if (platform !== 'linux') return
  await rewriteAsFreshFiles(path.join(context.appOutDir, 'resources', 'arch-extras'))
}
