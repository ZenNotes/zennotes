export type ExternalUrlResult = {
  ok: boolean
  error?: 'scheme-disabled' | 'blocked' | 'open-failed' | 'desktop-only'
  scheme?: string
}
