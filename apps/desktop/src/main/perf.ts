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
