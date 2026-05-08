import type { ConfirmOptions } from '../components/ConfirmModal'

export type ConfirmRequest = {
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

let currentRequest: ConfirmRequest | null = null
const listeners = new Set<(request: ConfirmRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function getConfirmRequest(): ConfirmRequest | null {
  return currentRequest
}

export function subscribeConfirmRequests(
  listener: (request: ConfirmRequest | null) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function confirmApp(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    currentRequest = { options, resolve }
    emit()
  })
}

export function settleConfirmRequest(request: ConfirmRequest, value: boolean): void {
  const resolve = request.resolve
  if (currentRequest === request) {
    currentRequest = null
    emit()
  }
  queueMicrotask(() => resolve(value))
}
