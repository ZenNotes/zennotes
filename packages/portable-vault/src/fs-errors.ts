/**
 * The only native failures a host's VaultFileSystem.isNotFound may read as a
 * verified missing path: Capacitor Filesystem's not-found code and the
 * Android SAF plugin's. That answer decides whether sync reads a link, a sync
 * state or a file as gone, which drives re-bootstrap, deletes and conflicts,
 * so a message that merely says "does not exist" is not one: the same words
 * come back from a permission that was revoked, a provider that timed out, or
 * a web fallback. Android's rule (fs-errors.ts); the iPhone also accepted the
 * message, for the `npm run dev` fallback.
 */
export const NATIVE_NOT_FOUND_CODES: readonly string[] = ['OS-PLUG-FILE-0008', 'ZN-SAF-NOT-FOUND']

export function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && NATIVE_NOT_FOUND_CODES.includes(code)
}
