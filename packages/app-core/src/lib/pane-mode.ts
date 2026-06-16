export type PaneMode = 'edit' | 'preview' | 'split'

export const ZEN_SET_PANE_MODE_EVENT = 'zen:set-pane-mode'
export const DEFAULT_PANE_MODE: PaneMode = 'edit'

export type PaneModesByPath = Record<string, PaneMode>

export function paneModeForPath(
  modesByPath: PaneModesByPath,
  path: string | null
): PaneMode {
  return path ? modesByPath[path] ?? DEFAULT_PANE_MODE : DEFAULT_PANE_MODE
}

export function paneModesWithPathMode(
  modesByPath: PaneModesByPath,
  path: string | null,
  mode: PaneMode
): PaneModesByPath {
  if (!path || modesByPath[path] === mode) return modesByPath
  return { ...modesByPath, [path]: mode }
}

export function requestPaneMode(mode: PaneMode): void {
  window.dispatchEvent(
    new CustomEvent<{ mode: PaneMode }>(ZEN_SET_PANE_MODE_EVENT, {
      detail: { mode }
    })
  )
}
