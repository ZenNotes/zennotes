/**
 * Whether the native window controls (minimize/maximize/close) should
 * be shown. They call Electron-only APIs, so they're hidden on mac
 * (native traffic lights instead) and in the web runtime, where there
 * is no native window to control.
 */
export function shouldShowWindowControls(platform: string, runtime: string): boolean {
  return platform !== 'darwin' && runtime !== 'web'
}