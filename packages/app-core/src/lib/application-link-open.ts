import { classifyApplicationLink } from '@shared/application-links'
import { useStore } from '../store'
import { requestSettingsTarget } from './settings-navigation'
import { useToastStore } from './toast'

/** Consume application URLs before they can become a missing-note offer. */
export function followApplicationLink(href: string): boolean {
  const link = classifyApplicationLink(href)
  if (!link) return false
  const toast = useToastStore.getState().addToast
  if (link.blocked) {
    toast('This link type or address cannot be opened.', 'error')
    return true
  }
  void (async () => {
    try {
      const result = await window.zen.openExternalUrl?.(link.url)
      if (result?.ok) return
      if (result?.error === 'scheme-disabled') {
        toast(
          `Enable ${link.scheme} links in Settings → Editor → Links.`,
          'info',
          {
            label: 'Open settings',
            onClick: () => {
              requestSettingsTarget('external-links')
              useStore.getState().setSettingsOpen(true)
            }
          },
          10000
        )
      } else if (!result || result.error === 'desktop-only') {
        toast('External application links are available in the desktop app.', 'info')
      } else if (result.error === 'blocked') {
        toast('This link type or address cannot be opened.', 'error')
      } else {
        toast(
          `Could not open this ${link.scheme} link. Check that its application is installed.`,
          'error'
        )
      }
    } catch {
      toast(
        `Could not open this ${link.scheme} link. Check that its application is installed.`,
        'error'
      )
    }
  })()
  return true
}
