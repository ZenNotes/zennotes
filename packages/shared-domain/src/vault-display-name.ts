// A vault's display name (#692): what the app calls the vault, kept in
// `.zennotes/vault.json` as `displayName`, distinct from the folder's name on
// disk. Several `docs/` folders, one per repo, can each carry the project's
// name in the sidebar and the vault switcher while staying `docs/` for git.
//
// Absent means the folder name, so a vault that never set one behaves exactly
// as before, and clearing the field is the same as never having set it.
//
// Desktop main, the renderer and the CLI import these helpers; the Go server
// mirrors them in internal/vault (VaultSettings.DisplayName). Change one,
// change both, and keep the rules byte-compatible: a name that survives one
// runtime's round-trip must survive the other's.

/** Longer than any name that fits a sidebar header; a limit rather than a
 *  layout rule, so a pasted paragraph cannot become the vault's name. Counted
 *  in UTF-16 code units (`String.length`); the Go side counts the same way. */
export const VAULT_DISPLAY_NAME_MAX_LENGTH = 64

// C0 and C1 controls other than the whitespace ones (tab, the newlines, the
// feeds), which stay for the whitespace pass so a pasted `API\tdocs` keeps
// its word break. Nothing a name needs.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g

/**
 * The name as it is stored and shown, in this order: control characters
 * dropped, runs of whitespace (tabs, newlines and the Unicode separators
 * included) collapsed to one space, trimmed, cut at the limit without
 * splitting a surrogate pair. Undefined when nothing usable is left (or the
 * input is not a string), so vault.json is written without the key rather
 * than with an empty one, and every reader's `displayName ?? folderName`
 * fallback holds.
 */
export function normalizeVaultDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw.replace(CONTROL_CHARS_RE, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  return cleaned.length > VAULT_DISPLAY_NAME_MAX_LENGTH
    ? cutAtUtf16Units(cleaned, VAULT_DISPLAY_NAME_MAX_LENGTH)
    : cleaned
}

/** The longest prefix of `text` within `limit` UTF-16 units that ends on a
 *  whole code point, with the space a cut can leave at the end removed. */
function cutAtUtf16Units(text: string, limit: number): string {
  let end = 0
  for (const codePoint of text) {
    if (end + codePoint.length > limit) break
    end += codePoint.length
  }
  return text.slice(0, end).trimEnd()
}

/** The name a vault goes by: its display name when it has one, else the
 *  folder name the caller derived from its path. */
export function resolveVaultName(displayName: unknown, folderName: string): string {
  return normalizeVaultDisplayName(displayName) ?? folderName
}
