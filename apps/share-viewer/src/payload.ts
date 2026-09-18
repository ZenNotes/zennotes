/** The JSON document the Laravel share page embeds in #zen-share-data. */
export interface SharePagePayload {
  title: string
  markdown: string
  /** Markdown ref (decoded) → absolute public URL. */
  assets: Record<string, string>
  /** sha1(raw tikz fence body) → pre-rendered SVG. */
  tikz: Record<string, string>
  appearance: { theme: string; logo_url: string | null }
  published_at: string | null
  updated_at: string | null
}

export function readSharePagePayload(): SharePagePayload | null {
  const el = document.getElementById('zen-share-data')
  if (!el?.textContent) return null
  try {
    const parsed = JSON.parse(el.textContent) as Partial<SharePagePayload>
    if (typeof parsed.markdown !== 'string') return null
    return {
      title: typeof parsed.title === 'string' ? parsed.title : 'Untitled',
      markdown: parsed.markdown,
      assets: isStringRecord(parsed.assets) ? parsed.assets : {},
      tikz: isStringRecord(parsed.tikz) ? parsed.tikz : {},
      appearance: { theme: typeof parsed.appearance?.theme === 'string' ? parsed.appearance.theme : 'system',
        logo_url: typeof parsed.appearance?.logo_url === 'string' ? parsed.appearance.logo_url : null },
      published_at: typeof parsed.published_at === 'string' ? parsed.published_at : null,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null
    }
  } catch {
    return null
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'string')
}
