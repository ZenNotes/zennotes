/** Settings pages other surfaces can open directly: the Cloud page from the
 *  status bar, the Keymaps page from `:unbind` when the action id is missing
 *  or unknown. */
export type SettingsNavigationTarget = "cloud" | "keymaps";

let pendingSettingsTarget: SettingsNavigationTarget | null = null;

export function requestSettingsTarget(target: SettingsNavigationTarget): void {
  pendingSettingsTarget = target;
}

export function consumeSettingsTarget(): SettingsNavigationTarget | null {
  const target = pendingSettingsTarget;
  pendingSettingsTarget = null;
  return target;
}
