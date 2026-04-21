import { useEffect, useState } from 'react'
import { PromptModal, type PromptOptions } from './PromptModal'

type PromptRequest = {
  options: PromptOptions
  resolve: (value: string | null) => void
}

let currentRequest: PromptRequest | null = null
const listeners = new Set<(request: PromptRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function promptApp(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    currentRequest = { options, resolve }
    emit()
  })
}

export function PromptHost(): JSX.Element | null {
  const [request, setRequest] = useState<PromptRequest | null>(currentRequest)

  useEffect(() => {
    listeners.add(setRequest)
    return () => {
      listeners.delete(setRequest)
    }
  }, [])

  if (!request) return null

  return (
    <PromptModal
      options={request.options}
      onSubmit={(value) => {
        const resolve = request.resolve
        currentRequest = null
        setRequest(null)
        queueMicrotask(() => resolve(value))
        emit()
      }}
      onCancel={() => {
        const resolve = request.resolve
        currentRequest = null
        setRequest(null)
        queueMicrotask(() => resolve(null))
        emit()
      }}
    />
  )
}
