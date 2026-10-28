/** Settings pages other surfaces can open directly: the Cloud page from the
 *  status bar, Space r and the palette (it lands on This vault, where what
 *  they reported waits), the Keymaps page from `:unbind` when the action id
 *  is missing or unknown, the CLI page from Open CLI Settings, Periodic
 *  notes from the phones' Calendar entry while daily notes are off, and the
 *  Unsplash access key field from the cover picker's Unsplash tab (the
 *  keyboard lands in the field). */
export type SettingsNavigationTarget =
  | "cloud"
  | "keymaps"
  | "external-links"
  | "about"
  | "cli"
  | "periodic-notes"
  | "unsplash";

let pendingSettingsTarget: SettingsNavigationTarget | null = null;

export function requestSettingsTarget(target: SettingsNavigationTarget): void {
  pendingSettingsTarget = target;
}

export function consumeSettingsTarget(): SettingsNavigationTarget | null {
  const target = pendingSettingsTarget;
  pendingSettingsTarget = null;
  return target;
}
