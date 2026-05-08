import type { PromptOptions } from '../components/PromptModal'

export type PromptRequest = {
  options: PromptOptions
  resolve: (value: string | null) => void
}

let currentRequest: PromptRequest | null = null
const listeners = new Set<(request: PromptRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function getPromptRequest(): PromptRequest | null {
  return currentRequest
}

export function subscribePromptRequests(
  listener: (request: PromptRequest | null) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function promptApp(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    currentRequest = { options, resolve }
    emit()
  })
}

export function settlePromptRequest(request: PromptRequest, value: string | null): void {
  const resolve = request.resolve
  if (currentRequest === request) {
    currentRequest = null
    emit()
  }
  queueMicrotask(() => resolve(value))
}
