import type { RemoteHeaderInput } from '@shared/ipc'

/** The Auth Token step of Connect to Remote Vault, with its extra headers
 *  (#1091). A separate queue from promptApp, whose answer is one string. */
export interface RemoteAuthAnswer {
  authToken: string
  headers: RemoteHeaderInput[]
}

export interface RemoteAuthRequest {
  resolve: (value: RemoteAuthAnswer | null) => void
}

let currentRequest: RemoteAuthRequest | null = null
const listeners = new Set<(request: RemoteAuthRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function getRemoteAuthRequest(): RemoteAuthRequest | null {
  return currentRequest
}

export function subscribeRemoteAuthRequests(
  listener: (request: RemoteAuthRequest | null) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function promptRemoteAuthApp(): Promise<RemoteAuthAnswer | null> {
  return new Promise((resolve) => {
    currentRequest = { resolve }
    emit()
  })
}

export function settleRemoteAuthRequest(
  request: RemoteAuthRequest,
  value: RemoteAuthAnswer | null
): void {
  const resolve = request.resolve
  if (currentRequest === request) {
    currentRequest = null
    emit()
  }
  queueMicrotask(() => resolve(value))
}
