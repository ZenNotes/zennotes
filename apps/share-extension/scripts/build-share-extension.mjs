// Builds the Share extension (ZenNotesShare.appex) into a packaged
// ZenNotes.app: Share > ZenNotes in Safari and other apps. electron-builder's
// afterPack hook calls this for each macOS architecture, before the app is
// signed. electron-builder never signs anything under Contents/PlugIns, so
// the extension arrives signed here, sandboxed (macOS loads no other kind),
// with the same identity the app is signed with.
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const sources = join(here, '..', 'macos')

export const SHARE_BUNDLE = 'ZenNotesShare.appex'
/** Where shares wait, relative to the home folder: inside the app's own
 *  Application Support, the one folder the extension's sandbox opens. The
 *  app's main process reads it back from the extension's Info.plist. */
export const SHARE_INBOX = 'Library/Application Support/ZenNotes/Share Inbox'
const SWIFT_TARGETS = { arm64: 'arm64-apple-macos12.0', x64: 'x86_64-apple-macos12.0' }

/**
 * @param {object} options
 * @param {string} options.appPath  the packaged ZenNotes.app
 * @param {'arm64'|'x64'} options.arch
 * @param {string} options.appId    the app's bundle identifier
 * @param {string} options.version
 * @param {string} options.iconPath the app's .icns, shown in the Share menu
 * @param {{ identity: string, keychain: string | null, timestamp?: string } | null} options.signing
 *   null signs ad hoc
 * @param {boolean} [options.selfTest]  compile the save self-test used when validating a build
 */
export async function buildShareExtension({ appPath, arch, appId, version, iconPath, signing, selfTest = false }) {
  const target = SWIFT_TARGETS[arch]
  if (!target) throw new Error(`Unsupported Share extension architecture: ${arch}`)
  const work = await mkdtemp(join(tmpdir(), 'zennotes-share-'))
  try {
    const appex = join(work, SHARE_BUNDLE)
    await mkdir(join(appex, 'Contents', 'MacOS'), { recursive: true })
    await mkdir(join(appex, 'Contents', 'Resources'), { recursive: true })
    const fill = (text) =>
      text.replaceAll('__APP_ID__', appId).replaceAll('__SHARE_INBOX__', SHARE_INBOX).replaceAll('__VERSION__', version)
    await writeFile(join(appex, 'Contents', 'Info.plist'), fill(await readFile(join(sources, 'Info.plist'), 'utf8')))
    const entitlements = join(work, 'Extension.entitlements')
    await writeFile(entitlements, fill(await readFile(join(sources, 'Extension.entitlements'), 'utf8')))
    await copyFile(iconPath, join(appex, 'Contents', 'Resources', 'icon.icns'))
    await copyFile(join(sources, 'ShareExtensionPreprocessing.js'), join(appex, 'Contents', 'Resources', 'ShareExtensionPreprocessing.js'))

    const sdk = (await run('xcrun', ['--show-sdk-path', '--sdk', 'macosx'])).stdout.trim()
    await run('xcrun', [
      'swiftc', '-target', target, '-sdk', sdk, '-O',
      ...(selfTest ? ['-D', 'SHARE_SELFTEST'] : []),
      '-parse-as-library', '-application-extension',
      '-module-name', 'ZenNotesShare',
      '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
      '-framework', 'Cocoa', '-framework', 'UniformTypeIdentifiers',
      '-o', join(appex, 'Contents', 'MacOS', 'ZenNotesShare'),
      join(sources, 'ShareViewController.swift')
    ], { maxBuffer: 16 * 1024 * 1024 })

    const args = ['--force', '--options', 'runtime']
    if (signing) {
      args.push('--sign', signing.identity, signing.timestamp ? `--timestamp=${signing.timestamp}` : '--timestamp')
      if (signing.keychain) args.push('--keychain', signing.keychain)
    } else {
      args.push('--sign', '-')
    }
    await run('codesign', [...args, '--entitlements', entitlements, appex])

    const plugIns = join(appPath, 'Contents', 'PlugIns')
    await mkdir(plugIns, { recursive: true })
    await rm(join(plugIns, SHARE_BUNDLE), { recursive: true, force: true })
    await run('ditto', [appex, join(plugIns, SHARE_BUNDLE)])
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
