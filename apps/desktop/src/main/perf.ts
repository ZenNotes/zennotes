const MAIN_PERF_ENABLED =
  process.env['NODE_ENV'] !== 'production' || process.env['ZEN_PERF'] === '1'

export function recordMainPerf(
  name: string,
  durationMs: number,
  detail?: Record<string, unknown>
): void {
  if (!MAIN_PERF_ENABLED) return
  const rounded = Math.round(durationMs * 100) / 100
  console.info(`[zen:perf] ${name} ${rounded.toFixed(1)}ms`, detail ?? {})
}

/**
 * Boot-timeline mark: the value is `process.uptime()` at the moment of the
 * mark, i.e. "this phase was reached N ms after the process started". The
 * existing window marks time themselves relative to `createWindow`, which
 * hides where a slow launch actually spends its time (e.g. a Linux AppImage
 * stuck in Chromium/fontconfig/portal init long before our code runs). Run
 * with `ZEN_PERF=1` in production to see these.
 */
export function recordBootMark(name: string, detail?: Record<string, unknown>): void {
  recordMainPerf(name, process.uptime() * 1000, detail)
}
