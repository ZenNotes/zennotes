/**
 * On-device `fetchLinkMetadata` for Notion-style URL embeds / bookmark cards.
 *
 * Parsing and safety guards ported 1:1 from the desktop main process
 * (`apps/desktop/src/main/link-metadata.ts`), keep in sync. The fetch goes
 * through the host's HTTP (CapacitorHttp, native URLSession, on the phones)
 * because a WebView `fetch` of an arbitrary page is CORS-blocked. Where the
 * host has only window fetch (a plain-browser dev session, the browser
 * build), cross-origin URLs just resolve `ok: false` and the card degrades to
 * a bare link: same contract as the web bridge.
 *
 * Guards: https only; loopback / private hosts are refused (a note is
 * untrusted content, so it must not point the fetch at internal services);
 * native connect/read timeouts; the HTML is parsed only up to a cap
 * (metadata lives in `<head>`, so the whole page is never needed).
 */
import { portableHost } from './host'
import type { LinkMetadata } from '@zennotes/shared-domain/ipc'

const TIMEOUT_MS = 6000
const MAX_CHARS = 512 * 1024
const USER_AGENT =
  'Mozilla/5.0 (compatible; ZenNotes/1.0; +https://zennotes.app) LinkPreview'

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0.0.0.0') return true
  // IPv4 private / loopback / link-local ranges.
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  return false
}

/** &amp; goes last: decoded first, "&amp;lt;" (text that reads "&lt;") would
 *  come out as "<". */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** Read a `<meta property=".." content="..">` (or `name=`), order-agnostic. */
function metaTag(html: string, key: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i'
  )
  const tag = html.match(re)?.[0]
  if (!tag) return undefined
  const content = tag.match(/content=["']([^"']*)["']/i)?.[1]
  return content ? decodeEntities(content).trim() : undefined
}

function firstFavicon(html: string, base: URL): string | undefined {
  const links = html.match(/<link[^>]+>/gi) ?? []
  for (const link of links) {
    if (!/rel=["'][^"']*icon[^"']*["']/i.test(link)) continue
    const href = link.match(/href=["']([^"']+)["']/i)?.[1]
    if (href) {
      try {
        return new URL(decodeEntities(href), base).href
      } catch {
        /* skip malformed */
      }
    }
  }
  return `${base.origin}/favicon.ico`
}

function absolute(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value, base).href
  } catch {
    return undefined
  }
}

export async function fetchLinkMetadataOnDevice(rawUrl: string): Promise<LinkMetadata> {
  const url = String(rawUrl ?? '').trim()
  const fail: LinkMetadata = { url, ok: false }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return fail
  }
  if (parsed.protocol !== 'https:' || isBlockedHost(parsed.hostname)) return fail

  try {
    const res = await portableHost().http.request({
      method: 'GET',
      url: parsed.href,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      connectTimeout: TIMEOUT_MS,
      readTimeout: TIMEOUT_MS,
      responseType: 'text'
    })
    if (res.status < 200 || res.status >= 300 || typeof res.data !== 'string') return fail
    const finalUrl = new URL(res.url || parsed.href)
    if (isBlockedHost(finalUrl.hostname)) return fail

    // CapacitorHttp can't stream, so cap after receipt instead of during read.
    const html = res.data.slice(0, MAX_CHARS)

    const titleTag =
      decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim() || undefined
    const title = metaTag(html, 'og:title') ?? metaTag(html, 'twitter:title') ?? titleTag
    const description =
      metaTag(html, 'og:description') ??
      metaTag(html, 'twitter:description') ??
      metaTag(html, 'description')
    const image = absolute(
      metaTag(html, 'og:image') ?? metaTag(html, 'twitter:image'),
      finalUrl
    )
    const siteName = metaTag(html, 'og:site_name')
    const favicon = firstFavicon(html, finalUrl)

    return {
      url,
      ok: true,
      title,
      description,
      image,
      siteName: siteName ?? finalUrl.hostname.replace(/^www\./, ''),
      favicon
    }
  } catch {
    return fail
  }
}
