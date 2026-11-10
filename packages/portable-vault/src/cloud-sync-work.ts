/** Shared with the iOS shell. Async filesystem calls do not move the
 * following JavaScript off the editor's thread. Give input a real turn.
 * https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield
 * The timer fallback also supports iOS 15 / older Android WebViews. */
export function yieldToUi(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> }
  }).scheduler
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0))
}

export function cloudSyncWorkBudget(): () => Promise<void> | undefined {
  let started = performance.now()
  return () => {
    if (performance.now() - started < 8) return
    return yieldToUi().then(() => { started = performance.now() })
  }
}

/** Decode in bounded chunks instead of Uint8Array.from(string, callback),
 * which visits every byte through an allocating JS iterator. Keep the
 * original base64 for binary uploads rather than encoding the bytes again. */
export async function decodeCloudSyncBase64(value: string): Promise<{
  bytes: Uint8Array<ArrayBuffer>
  base64: string
}> {
  if (value.length >= 262_144) await yieldToUi()
  const base64 = (value.includes(',') ? value.slice(value.indexOf(',') + 1) : value).replace(/\s/g, '')
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array(Math.max(0, Math.floor(base64.length * 3 / 4) - padding))
  const checkpoint = cloudSyncWorkBudget()
  let offset = 0
  // Multiples of four keep each base64 chunk independently decodable.
  for (let start = 0; start < base64.length; start += 65_536) {
    const binary = atob(base64.slice(start, start + 65_536))
    for (let i = 0; i < binary.length; i++) bytes[offset++] = binary.charCodeAt(i)
    await checkpoint()
  }
  if (offset !== bytes.length) throw new Error('Invalid Cloud file encoding.')
  return { bytes, base64 }
}
