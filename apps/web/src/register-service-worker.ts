// The self-hosted server answers with a Content Security Policy of
// `script-src 'self'`, which blocks inline scripts. Registering from the
// bundle keeps the worker inside that policy; an inline registration in
// index.html was silently refused, so production deployments never got sw.js.
// The relative URL keeps the scope aligned with a prefixed deployment:
// /zennotes/sw.js registers for /zennotes/.
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || window.location.protocol === 'file:') return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {})
  })
}
