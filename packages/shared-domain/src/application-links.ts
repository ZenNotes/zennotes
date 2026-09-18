export type { ExternalUrlResult } from '@zennotes/bridge-contract/application-links'

/** Application links are classified before note lookup, even when disabled. */
const SCHEME_RE = /^([a-z][a-z\d+.-]*):/i
const STANDARD_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])
const RESERVED_SCHEMES = new Set([
  'javascript',
  'vbscript',
  'data',
  'blob',
  'file',
  'filesystem',
  'about',
  'chrome',
  'chrome-extension',
  'devtools',
  'electron',
  'resource',
  'view-source',
  'zen'
])

function isApplicationScheme(scheme: string): boolean {
  return (
    !STANDARD_SCHEMES.has(scheme) && !RESERVED_SCHEMES.has(scheme) && !scheme.startsWith('zen-')
  )
}

export function normalizeApplicationSchemes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.flatMap((entry) => {
        if (typeof entry !== 'string') return []
        const scheme = entry
          .trim()
          .toLowerCase()
          .replace(/:(?:\/\/)?$/, '')
        return /^[a-z][a-z\d+.-]*$/.test(scheme) && isApplicationScheme(scheme) ? [scheme] : []
      })
    )
  ]
}

export type ApplicationLink = { url: string; scheme: string; blocked: boolean }

export function classifyApplicationLink(href: string): ApplicationLink | null {
  const url = href.trim()
  // A Windows drive path is a file, not a one-letter application scheme.
  if (/^[a-z]:[\\/](?!\/)/i.test(url)) return null
  const scheme = SCHEME_RE.exec(url)?.[1].toLowerCase()
  if (
    !scheme ||
    STANDARD_SCHEMES.has(scheme) ||
    scheme === 'file' ||
    scheme === 'zen' ||
    scheme.startsWith('zen-')
  )
    return null
  return {
    url,
    scheme,
    blocked:
      !isApplicationScheme(scheme) ||
      /[\u0000-\u0020\u007f]/.test(url) ||
      url.length > 8192 ||
      url.length === scheme.length + 1
  }
}
