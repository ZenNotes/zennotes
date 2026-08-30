/**
 * Plain-text clipboard write that prefers the desktop bridge (Electron's
 * clipboard works without focus or a user gesture) and falls back to the
 * browser API for the web client. Returns false when neither could be used.
 */
export function writeClipboardText(text: string): boolean {
  if (typeof window === 'undefined') return false

  try {
    const bridge = (
      window as Window & {
        zen?: { clipboardWriteText?: (value: string) => void }
      }
    ).zen
    if (typeof bridge?.clipboardWriteText === 'function') {
      bridge.clipboardWriteText(text)
      return true
    }

    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }

  return false
}
