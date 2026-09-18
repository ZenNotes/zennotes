import {
  classifyApplicationLink,
  normalizeApplicationSchemes,
  type ExternalUrlResult
} from '@shared/application-links'

/** The main process owns permission to launch an application from a note. */
export async function openExternalUrl(
  value: unknown,
  enabledSchemes: unknown,
  open: (url: string) => Promise<void>
): Promise<ExternalUrlResult> {
  if (typeof value !== 'string') return { ok: false, error: 'blocked' }
  const url = value.trim()
  if (!url || url.length > 8192 || /[\u0000-\u0020\u007f]/.test(url)) {
    return { ok: false, error: 'blocked' }
  }
  const application = classifyApplicationLink(url)
  if (application) {
    if (application.blocked) return { ok: false, error: 'blocked', scheme: application.scheme }
    if (!normalizeApplicationSchemes(enabledSchemes).includes(application.scheme)) {
      return { ok: false, error: 'scheme-disabled', scheme: application.scheme }
    }
  } else if (!/^(https?:|mailto:|tel:)/i.test(url)) {
    return { ok: false, error: 'blocked' }
  }
  try {
    new URL(url)
  } catch {
    return { ok: false, error: 'blocked' }
  }
  try {
    await open(url)
    return { ok: true }
  } catch {
    return { ok: false, error: 'open-failed', scheme: application?.scheme }
  }
}
