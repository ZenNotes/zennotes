import { useSyncExternalStore } from 'react'
import { useStore } from './store'

export interface SettingsSnapshot {
  readonly themeId: string
  readonly themeMode: 'light' | 'dark' | 'auto'
  readonly open: boolean
  readonly editorFontSize: number
  readonly dailyNotesEnabled: boolean
  readonly calendarAvailable: boolean
}
let snapshot: SettingsSnapshot | undefined
export function getSettingsSnapshot(): SettingsSnapshot {
  const state = useStore.getState()
  const next = { themeId: state.themeId, themeMode: state.themeMode, open: state.settingsOpen, editorFontSize: state.editorFontSize,
    dailyNotesEnabled: state.vaultSettings.dailyNotes.enabled,
    calendarAvailable: state.vaultSettings.dailyNotes.enabled || state.vaultSettings.weeklyNotes.enabled }
  if (!snapshot || (Object.keys(next) as Array<keyof SettingsSnapshot>).some(key => snapshot![key] !== next[key]))
    snapshot = Object.freeze(next)
  return snapshot
}
export function subscribeSettings(listener: (next: SettingsSnapshot, previous: SettingsSnapshot) => void): () => void {
  let previous = getSettingsSnapshot()
  return useStore.subscribe(() => {
    const next = getSettingsSnapshot()
    if (next === previous) return
    const before = previous; previous = next; listener(next, before)
  })
}
function subscribeReact(notify: () => void): () => void { return subscribeSettings(() => notify()) }
export function useSettingsSnapshot(): SettingsSnapshot { return useSyncExternalStore(subscribeReact, getSettingsSnapshot, getSettingsSnapshot) }
export function setSettingsVisible(open: boolean): void { useStore.getState().setSettingsOpen(open) }
export function setEditorFontSize(size: number, options?: { persist?: boolean }): void {
  if (!Number.isFinite(size)) return
  const clamped = Math.max(12, Math.min(28, Math.round(size)))
  if (options?.persist === false) useStore.setState({ editorFontSize: clamped })
  else useStore.getState().setEditorFontSize(clamped)
}
