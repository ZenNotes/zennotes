#!/usr/bin/env node
/**
 * Carry electron-builder's macOS keychain fix until a v26 release ships it.
 *
 * app-builder-lib 26.15 and 26.16 create a temporary signing keychain with a
 * random password, then hand `security set-key-partition-list -k` the
 * certificate's import password instead. Older macOS ignored the mismatch on
 * an already-unlocked keychain; the macOS 26.6 runner image verifies it and
 * signing dies with "SecKeychainUnlock: The user name or passphrase you
 * entered is not correct" (electron-builder #10066). The fix (#10101) is
 * merged upstream and backported to v26 but not published, so the release
 * workflow applies the same two-line change to the installed copy. The script
 * is idempotent and exits 0 without touching a copy that already carries the
 * fix, so it can stay in the workflow past the upgrade; it fails loudly if the
 * file no longer looks like either version, which is the cue to drop it.
 *
 * Usage: node tooling/scripts/patch-electron-builder-keychain.mjs [path/to/macCodeSign.js]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const candidates = [
  path.join(repoRoot, 'apps', 'desktop', 'node_modules', 'app-builder-lib', 'out', 'codeSign', 'macCodeSign.js'),
  path.join(repoRoot, 'node_modules', 'app-builder-lib', 'out', 'codeSign', 'macCodeSign.js')
]
const target = process.argv[2] ?? candidates.find((candidate) => existsSync(candidate))
if (!target || !existsSync(target)) {
  console.error('patch-electron-builder-keychain: app-builder-lib macCodeSign.js not found')
  process.exit(1)
}

const source = readFileSync(target, 'utf8')
const fixedCall = 'return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);'
if (source.includes(fixedCall)) {
  console.log(`patch-electron-builder-keychain: already fixed, nothing to do (${target})`)
  process.exit(0)
}

const replacements = [
  ['return await importCerts(keychainFile, certPaths, cscPasswords);', fixedCall],
  [
    'async function importCerts(keychainFile, paths, keyPasswords) {',
    'async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {'
  ],
  [
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]',
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]'
  ]
]
let patched = source
for (const [from, to] of replacements) {
  const occurrences = patched.split(from).length - 1
  if (occurrences !== 1) {
    console.error(
      `patch-electron-builder-keychain: expected exactly one occurrence of ${JSON.stringify(from)}, found ${occurrences}; the installed app-builder-lib no longer matches the known bug, review and drop this script`
    )
    process.exit(1)
  }
  patched = patched.replace(from, to)
}
writeFileSync(target, patched)
console.log(`patch-electron-builder-keychain: patched ${target}`)
