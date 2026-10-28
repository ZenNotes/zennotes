/**
 * Whether the status bar along the bottom of the workspace is drawn.
 *
 * Zen mode always clears it. Otherwise it needs something to say: a note's
 * stats, or a Cloud status. Turned off (Settings, Appearance, Chrome, Status
 * bar; `show_status_bar` in config.toml), it stays away except while Cloud
 * needs the person (`cloudSyncNeedsUser`): a failed or stopped run, files or
 * the settings question waiting, a vault that went away, a device signed out.
 * Those come back until they are dealt with, so turning the bar off never
 * hides the one place that says sync has stopped.
 *
 * Phones (Piotr, on Discord) mostly see the Cloud half of the bar, and the
 * bar not being drawn is what gives its row back: the shells size their Cloud
 * row and lift the circle from the bar's `data-cloud-sync-*` hooks.
 */
export function statusBarVisible(input: {
  zenMode: boolean
  hasNote: boolean
  cloudShown: boolean
  showStatusBar: boolean
  cloudNeedsUser: boolean
}): boolean {
  if (input.zenMode) return false
  if (!input.hasNote && !input.cloudShown) return false
  return input.showStatusBar || input.cloudNeedsUser
}
