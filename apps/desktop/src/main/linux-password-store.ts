/**
 * Chromium picks the safeStorage keyring backend from desktop-environment
 * detection (XDG_CURRENT_DESKTOP and friends, base/nix/xdg_util.cc), never by
 * probing the session bus for a Secret Service. A session it does not
 * recognize (Niri, Hyprland, Sway, and other niche compositors) lands on the
 * plaintext basic_text backend, safeStorage then reports encryption as
 * unavailable, and ZenNotes refuses to persist cloud and remote-workspace
 * credentials even though a healthy gnome-keyring is sitting on the bus.
 *
 * The escape hatch is Chromium's `--password-store=gnome-libsecret` switch,
 * which skips detection and talks to the Secret Service directly. Forcing it
 * on unrecognized sessions is safe: when the Secret Service is genuinely
 * absent, Chromium falls back to basic_text, which is exactly the behavior
 * without the switch.
 */

/**
 * Tokens Chromium's desktop detection recognizes. When one is present,
 * Chromium either wires a real keyring on its own (the GNOME family via
 * libsecret, KDE via KWallet) or deliberately chose plaintext for that
 * desktop (XFCE, LXQt); ZenNotes defers to that choice either way. Matching
 * is a case-insensitive substring test over the combined session variables,
 * which over-approximates on purpose: a false bail-out keeps the stock
 * behavior, a false positive would override a working KWallet.
 */
const RECOGNIZED_DESKTOP_TOKENS = [
  'cinnamon',
  'deepin',
  'gnome',
  'kde',
  'lxqt',
  'mate',
  'pantheon',
  'plasma',
  'ukui',
  'unity',
  'xfce',
  'xubuntu'
]

export function shouldForceGnomeLibsecret(env: Record<string, string | undefined>): boolean {
  const session = `${env.XDG_CURRENT_DESKTOP ?? ''}:${env.DESKTOP_SESSION ?? ''}`.toLowerCase()
  if (RECOGNIZED_DESKTOP_TOKENS.some((token) => session.includes(token))) return false
  // Chromium's last-resort detection reads these legacy session markers.
  if (env.GNOME_DESKTOP_SESSION_ID || env.KDE_FULL_SESSION) return false
  return true
}
