/**
 * System font enumeration. Uses the main-process `font-list` bridge
 * which shells out to the native font database on each platform.
 * Chromium's `queryLocalFonts()` in Electron sometimes returns a
 * restricted subset (missing user-installed fonts), so we go through
 * IPC for full coverage.
 */

let cache: string[] | null = null

export function hasSystemFontAccess(): boolean {
  return typeof window.zen?.listSystemFonts === 'function'
}

export async function listSystemFonts(): Promise<string[]> {
  // Only cache non-empty results — otherwise a transient IPC failure
  // would stick forever.
  if (cache && cache.length > 0) return cache
  try {
    const fonts = await window.zen.listSystemFonts()
    console.log(`[zen] system fonts: ${fonts.length}`)
    if (fonts.length > 0) cache = fonts
    return fonts
  } catch (err) {
    console.error('listSystemFonts failed', err)
    return []
  }
}

/** Drop the in-memory cache so the next query re-reads from the OS. */
export function invalidateSystemFontCache(): void {
  cache = null
}
