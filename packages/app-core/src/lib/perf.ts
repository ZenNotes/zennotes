export interface RendererPerfSample {
  name: string
  durationMs: number
  at: number
  detail?: Record<string, unknown>
}

declare global {
  interface Window {
    __ZEN_PERF__?: {
      samples: RendererPerfSample[]
      getSamples: () => RendererPerfSample[]
      clear: () => void
    }
  }
}

const MAX_RENDERER_PERF_SAMPLES = 200

function perfEnabled(): boolean {
  if (typeof window === 'undefined') return false
  if (import.meta.env.DEV) return true
  try {
    return window.localStorage.getItem('zen:perf') === '1'
  } catch {
    return false
  }
}

function ensurePerfStore():
  | {
      samples: RendererPerfSample[]
      getSamples: () => RendererPerfSample[]
      clear: () => void
    }
  | null {
  if (!perfEnabled()) return null
  if (!window.__ZEN_PERF__) {
    const samples: RendererPerfSample[] = []
    window.__ZEN_PERF__ = {
      samples,
      getSamples: () => [...samples],
      clear: () => {
        samples.length = 0
      }
    }
  }
  return window.__ZEN_PERF__
}

export function recordRendererPerf(
  name: string,
  durationMs: number,
  detail?: Record<string, unknown>
): void {
  const store = ensurePerfStore()
  if (!store) return

  const sample: RendererPerfSample = {
    name,
    durationMs: Math.round(durationMs * 100) / 100,
    at: Date.now(),
    ...(detail ? { detail } : {})
  }

  store.samples.push(sample)
  if (store.samples.length > MAX_RENDERER_PERF_SAMPLES) {
    store.samples.splice(0, store.samples.length - MAX_RENDERER_PERF_SAMPLES)
  }

  if (sample.durationMs >= 16) {
    console.debug(`[zen:perf] ${name} ${sample.durationMs.toFixed(1)}ms`, detail ?? {})
  }
}
