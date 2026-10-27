/**
 * Following a Markdown link to a file that lives OUTSIDE the vault.
 *
 * `[script](~/.local/bin/build.sh)` and friends are neither notes, vault
 * assets, nor web URLs, so without this they fell through to "create a note"
 * (offering `~/.local/bin/build.sh.md`) — see #424. When a link href is an
 * unambiguous local filesystem path, we instead open it with the OS default
 * app, after confirming (it could launch an app or a script).
 *
 * Deliberately conservative about what counts as an external file so we never
 * hijack a legitimate note/asset link: only `file://` URLs, `~/…` home paths,
 * Windows drive paths, and absolute POSIX paths that name a non-Markdown file.
 * Vault-relative links (`./…`, `../…`, bare names) stay note/asset links.
 */
import { confirmApp } from './confirm-requests'
import { useToastStore } from './toast'

/**
 * The href if it's a link to a local file outside the vault, else null. Callers
 * should try note/asset/URL resolution first and only fall back to this.
 */
export function externalFileLink(href: string): string | null {
  const h = href.trim()
  if (!h) return null
  // `file://` URL to a local file.
  if (/^file:\/\//i.test(h)) return h
  // Home-relative path.
  if (h === '~' || h.startsWith('~/')) return h
  // Windows absolute path (`C:\…` or `C:/…`). Checked before the generic scheme
  // test below, since a drive letter (`C:`) also looks like a URL scheme.
  if (/^[a-zA-Z]:[\\/]/.test(h)) return h
  // Any other URL scheme (http:, mailto:, zen-asset:, …) is not a file link.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(h)) return null
  // Absolute POSIX path that names a concrete file. A leading `/` otherwise
  // means "vault-root relative" here, and a bare `/notes/plan` (no extension)
  // or a `.md` target should keep going to the note/create path.
  if (h.startsWith('/')) {
    const pathOnly = h.split(/[?#]/)[0] ?? h
    if (/\.[a-z0-9]{1,12}$/i.test(pathOnly) && !/\.md$/i.test(pathOnly)) return h
  }
  return null
}

/**
 * Confirm, then open `href` (an {@link externalFileLink}) with the OS default
 * app via the desktop bridge. On the web, or on failure, shows a toast.
 */
/**
 * Confirm, then open a VAULT asset (vault-relative path) with the OS default
 * app. Distinct from {@link openExternalFileLink} on purpose: joining the
 * vault root onto the path in the renderer breaks on remote workspaces, where
 * the root is a directory on the SERVER. The bridge resolves the vault it
 * actually has — local opens in place, remote downloads to a temp file first
 * — and the confirm shows the vault-relative path, not a foreign server path.
 *
 * `confirm: false` skips the question for a document whose opener runs
 * nothing: a PDF on a phone, whose WebView cannot show it in place, goes
 * straight to the viewer the user tapped for.
 */
export async function openVaultAssetExternally(
  assetVaultRel: string,
  options: { confirm?: boolean } = {}
): Promise<void> {
  const open = window.zen?.openAssetExternally
  const toast = useToastStore.getState().addToast

  if (typeof open !== 'function') {
    toast('Opening attachments is only available in the desktop app.', 'info')
    return
  }

  if (options.confirm !== false) {
    const ok = await confirmApp({
      title: 'Open attachment?',
      description: `This opens ${assetVaultRel} with your system's default app.`,
      confirmLabel: 'Open'
    })
    if (!ok) return
  }

  try {
    const result = await open(assetVaultRel)
    if (result.ok) return
    if (result.error === 'desktop-only') {
      toast('Opening attachments is only available in the desktop app.', 'info')
    } else {
      toast(result.error ? `Could not open file: ${result.error}` : 'Could not open file.', 'error')
    }
  } catch (err) {
    toast(`Could not open file: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

export async function openExternalFileLink(href: string): Promise<void> {
  const open = window.zen?.openExternalFile
  const toast = useToastStore.getState().addToast

  if (typeof open !== 'function') {
    toast('Opening local files is only available in the desktop app.', 'info')
    return
  }

  const ok = await confirmApp({
    title: 'Open external file?',
    description: `This opens ${href} with your system's default app.`,
    confirmLabel: 'Open'
  })
  if (!ok) return

  try {
    const result = await open(href)
    if (result.ok) return
    if (result.error === 'desktop-only') {
      toast('Opening local files is only available in the desktop app.', 'info')
    } else {
      toast(result.error ? `Could not open file: ${result.error}` : 'Could not open file.', 'error')
    }
  } catch (err) {
    toast(`Could not open file: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}
