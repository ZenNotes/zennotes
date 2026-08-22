/** A user-showable message from a rejected bridge call. Electron wraps main
 *  process rejections as "Error invoking remote method 'x': Error: <real>";
 *  a toast should carry only the real sentence. */
export function humanIpcError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : ''
  const message = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim()
  return message || fallback
}
