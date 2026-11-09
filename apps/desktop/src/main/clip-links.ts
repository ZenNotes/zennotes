/**
 * The clip links, `zennotes://new` and `zennotes://daily`: how the web
 * clipper hands the app a note (contract: docs/web-clipper-link.md; parser:
 * `@shared/clip-link`). The extension puts the note on the clipboard and opens
 * a link naming its SHA-256; this module checks the clipboard against it,
 * picks the vault the link names, and has the note written.
 *
 * Who writes is the one rule that matters. A window that shows the vault
 * holds its open notes, unsaved edits included, and a write from here would be
 * overwritten by that window's next save (the renderer never replaces a dirty
 * buffer). So a clip for a vault a window shows goes to that window, which
 * writes it through its store (lib/clip-apply.ts). Only a vault no window
 * shows, where no editor can hold a note, is written here. Both writers decide
 * paths, titles and insertion with `@renderer/lib/clip-plan`.
 *
 * Links are untrusted (any web page can fire one) and are handled one at a
 * time, in the order they arrived, once startup has finished: the config is
 * loaded and the first window knows its vault. The clipboard is read when a
 * link's turn comes, which on a cold start is a moment after the click.
 */
import path from 'node:path'
import {
  MAX_CLIP_NOTE_BYTES,
  parseClipLink,
  verifiedClipboardText,
  type ClipLinkRejection,
  type ClipLinkRequest
} from '@shared/clip-link'
import type { NoteFolder, NoteMeta, VaultSettings } from '@shared/ipc'
import type { ClipApplyRequest, ClipNotice } from '@zennotes/bridge-contract/clip'
import {
  CLIP_MESSAGES,
  clipLandedMessage,
  clipNotePath,
  clipNoteTitle,
  insertClipText
} from '@renderer/lib/clip-plan'
import {
  dailyNoteLocationForDate,
  findDailyNoteForDate,
  normalizeVaultSettings
} from '@renderer/lib/vault-layout'
import { resolveShareTarget, shareVaultsFile, type ShareConfig, type ShareTarget } from './share-inbox'

export type ClipLinkResult = 'none' | 'clip' | 'clip-silent'

/** A window, as this module needs one: an id the host maps back. */
export interface ClipWindow {
  id: number
}

/** The vault file operations a local write needs (desktop main's vault.ts). */
export interface ClipVaultIo {
  createNote: (root: string, folder: NoteFolder, title: string | undefined, subpath: string) => Promise<NoteMeta>
  writeNote: (root: string, rel: string, body: string) => Promise<unknown>
  readNote: (root: string, rel: string) => Promise<{ body: string }>
  listNotes: (root: string) => Promise<NoteMeta[]>
  getVaultSettings: (root: string) => Promise<VaultSettings>
  /** The daily note's starting body from its template, or '' for none. */
  dailyTemplateBody: (root: string, templateId: string | undefined, title: string, date: Date) => Promise<string>
}

export interface ClipLinkDeps {
  loadConfig: () => Promise<ShareConfig>
  readClipboard: () => string
  /** The window that shows this vault, waiting for windows still opening to
   *  learn theirs; null when none does. */
  windowFor: (target: ShareTarget) => Promise<ClipWindow | null>
  sendClip: (win: ClipWindow, request: ClipApplyRequest) => void
  focus: (win: ClipWindow) => void
  io: ClipVaultIo
  /** Show a note of a vault no window shows, in a window of its own. */
  openLocal: (root: string, relPath: string) => void
  /** A clip went wrong: a toast in the window the user is in when one is
   *  up, else a system notification. */
  notifyProblem: (notice: ClipNotice) => void
  /** A clip was written here, silently: a system notification, since no
   *  window shows that vault; clicking it runs `open`. */
  notifyLanded: (message: string, open: () => void) => void
  now?: () => Date
  log?: (message: string) => void
}

export interface ClipLinkHandler {
  /** Claims a clip link (returning whether it asked to stay silent) or
   *  returns 'none' for any other link. Never throws. */
  handle: (rawUrl: string) => ClipLinkResult
  /** Startup is complete: links queued so far, and every later one, run. */
  start: () => void
  /** Resolves when every link handed in so far has been handled (tests). */
  idle: () => Promise<void>
}

const REJECTION_MESSAGES: Record<ClipLinkRejection, string> = {
  'link-too-long': 'That clip is too long for a link. Clip it again from the web clipper.',
  'content-too-long': 'That clip is too long for a link. Clip it again from the web clipper.',
  'bad-file': 'That clip names a place in the vault ZenNotes cannot write to.',
  'bad-vault': 'That clip names a vault ZenNotes cannot read.',
  'bad-encoding': 'That clip link is malformed, so nothing was saved.',
  'duplicate-param': 'That clip link is malformed, so nothing was saved.',
  'bad-hash': 'That clip link is malformed, so nothing was saved.',
  'two-bodies': 'That clip link is malformed, so nothing was saved.',
  'empty-body': 'That clip was empty, so nothing was saved.',
  'append-and-prepend': 'That clip link is malformed, so nothing was saved.',
  'missing-file': 'That clip names no note to add to.',
  'nothing-to-insert': 'That clip had nothing to add.'
}

const NOT_ARRIVED = 'The clip did not arrive (the clipboard changed). Clip it again.'

function sameName(a: string, b: string): boolean {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()
}

/** The vaults a `vault=` name matches: a remembered vault's name, a local
 *  vault's folder name, or a server's profile name. Never a path. */
export function matchClipVaults(name: string, cfg: ShareConfig): ShareTarget[] {
  const matches: ShareTarget[] = []
  for (const choice of shareVaultsFile(cfg).vaults) {
    const folderName = choice.kind === 'local' ? path.basename(choice.id.slice('local:'.length)) : null
    if (!sameName(choice.name, name) && !(folderName && sameName(folderName, name))) continue
    const target = resolveShareTarget(choice.id, cfg)
    if (target && target.key === choice.id) matches.push(target)
  }
  return matches
}

/** The text a request carries, or a sentence saying why there is none. */
async function clipText(
  request: ClipLinkRequest,
  readClipboard: () => string
): Promise<{ text: string | null } | { problem: string }> {
  if (!request.body) return { text: null }
  if ('content' in request.body) return { text: request.body.content }
  let text: string
  try {
    text = readClipboard()
  } catch {
    return { problem: NOT_ARRIVED }
  }
  if (!text) return { problem: NOT_ARRIVED }
  if (new TextEncoder().encode(text).byteLength > MAX_CLIP_NOTE_BYTES) {
    return { problem: 'That clip is larger than 8 MB, so nothing was saved.' }
  }
  const verified = await verifiedClipboardText(text, request.body.clipboard)
  return verified === null ? { problem: NOT_ARRIVED } : { text: verified }
}

export type ClipWriteOutcome = { ok: true; path: string } | { ok: false; message: string }

/**
 * Write a clip into a local vault that no window shows. The renderer's
 * clip-apply makes the same decisions through its store; both take paths,
 * titles and insertion from clip-plan.
 */
export async function writeClipLocally(
  io: ClipVaultIo,
  root: string,
  request: ClipApplyRequest,
  now: Date
): Promise<ClipWriteOutcome> {
  try {
    if (request.action === 'daily') {
      const settings = normalizeVaultSettings(await io.getVaultSettings(root))
      if (!settings.dailyNotes.enabled) return { ok: false, message: CLIP_MESSAGES.dailyOff }
      let note = findDailyNoteForDate(await io.listNotes(root), settings, now)
      if (!note) {
        const { title, subpath } = dailyNoteLocationForDate(now, settings)
        note = await io.createNote(root, 'inbox', title, subpath)
        const body = await io.dailyTemplateBody(root, settings.dailyNotes.templateId, title, now)
        if (body) await io.writeNote(root, note.path, body)
      }
      if (request.text !== null) {
        const current = await io.readNote(root, note.path)
        await io.writeNote(
          root,
          note.path,
          insertClipText(current.body, request.text, request.position === 'prepend' ? 'prepend' : 'append')
        )
      }
      return { ok: true, path: note.path }
    }

    if (request.position !== 'create' && request.name !== null && request.text !== null) {
      const settings = normalizeVaultSettings(await io.getVaultSettings(root))
      const rel = clipNotePath(settings, request.folder, request.name)
      const current = await io.readNote(root, rel).catch(() => null)
      if (current) {
        await io.writeNote(root, rel, insertClipText(current.body, request.text, request.position))
        return { ok: true, path: rel }
      }
    }

    const meta = await io.createNote(
      root,
      'inbox',
      clipNoteTitle(request.name, request.text, now),
      request.folder
    )
    if (request.text !== null) await io.writeNote(root, meta.path, request.text)
    return { ok: true, path: meta.path }
  } catch {
    return { ok: false, message: CLIP_MESSAGES.failed }
  }
}

export function createClipLinkHandler(deps: ClipLinkDeps): ClipLinkHandler {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  type Pending = { kind: 'request'; request: ClipLinkRequest } | { kind: 'refused'; reason: ClipLinkRejection }
  const queue: Pending[] = []
  let started = false
  let chain: Promise<void> = Promise.resolve()

  async function run(item: Pending): Promise<void> {
    if (item.kind === 'refused') {
      log(`[clip] refused: ${item.reason}`)
      deps.notifyProblem({ kind: 'error', message: REJECTION_MESSAGES[item.reason] })
      return
    }
    const { request } = item

    const text = await clipText(request, deps.readClipboard)
    if ('problem' in text) {
      log('[clip] clipboard did not match')
      deps.notifyProblem({ kind: 'error', message: text.problem })
      return
    }

    const cfg = await deps.loadConfig()
    let target: ShareTarget | null
    if (request.vault) {
      const matches = matchClipVaults(request.vault, cfg)
      if (matches.length === 0) {
        deps.notifyProblem({ kind: 'error', message: `No vault is named "${request.vault}". Check the vault name in the web clipper.` })
        return
      }
      if (matches.length > 1) {
        deps.notifyProblem({ kind: 'error', message: `More than one vault is named "${request.vault}". Use its folder name instead.` })
        return
      }
      target = matches[0]
    } else {
      target = resolveShareTarget(null, cfg)
    }
    if (!target) {
      deps.notifyProblem({ kind: 'error', message: 'Open a vault in ZenNotes, then clip again.' })
      return
    }

    const apply: ClipApplyRequest = {
      vaultRoot: target.kind === 'local' ? target.root : null,
      action: request.action,
      folder: request.action === 'new' ? request.folder : '',
      name: request.action === 'new' ? request.name : null,
      text: text.text,
      position: request.position,
      silent: request.silent
    }

    const win = await deps.windowFor(target)
    if (win) {
      log(`[clip] ${request.action} handed to window ${win.id}`)
      deps.sendClip(win, apply)
      if (!request.silent) deps.focus(win)
      return
    }

    if (target.kind === 'remote') {
      const { profileId } = target
      const profile = cfg.remoteWorkspaceProfiles.find((entry) => entry.id === profileId)
      deps.notifyProblem({
        kind: 'error',
        message: `Connect to "${profile?.name ?? 'that server'}" in ZenNotes, then clip again.`
      })
      return
    }

    const outcome = await writeClipLocally(deps.io, target.root, apply, now())
    if (!outcome.ok) {
      deps.notifyProblem({ kind: 'error', message: outcome.message })
      return
    }
    log(`[clip] ${request.action} written in main: ${outcome.path}`)
    const { root } = target
    const landed = outcome.path
    if (!request.silent) deps.openLocal(root, landed)
    // A link that only opens or makes a note clipped nothing to report.
    else if (apply.text !== null) deps.notifyLanded(clipLandedMessage(landed), () => deps.openLocal(root, landed))
  }

  function pump(): void {
    if (!started) return
    for (const item of queue.splice(0)) {
      chain = chain.then(() =>
        run(item).catch((err) => {
          log(`[clip] failed: ${String(err)}`)
          deps.notifyProblem({ kind: 'error', message: CLIP_MESSAGES.failed })
        })
      )
    }
  }

  return {
    handle(rawUrl) {
      const parsed = parseClipLink(rawUrl)
      if (!parsed) return 'none'
      if (!parsed.ok) {
        queue.push({ kind: 'refused', reason: parsed.reason })
        pump()
        return 'clip'
      }
      queue.push({ kind: 'request', request: parsed.request })
      pump()
      return parsed.request.silent ? 'clip-silent' : 'clip'
    },
    start() {
      started = true
      pump()
    },
    idle() {
      return chain
    }
  }
}
