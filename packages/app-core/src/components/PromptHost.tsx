import { lazy, Suspense, useEffect, useState } from 'react'
import {
  getPromptRequest,
  settlePromptRequest,
  subscribePromptRequests,
  type PromptRequest
} from '../lib/prompt-requests'

const PromptModal = lazy(async () => {
  const module = await import('./PromptModal')
  return { default: module.PromptModal }
})

export function PromptHost(): JSX.Element | null {
  const [request, setRequest] = useState<PromptRequest | null>(getPromptRequest)

  useEffect(() => {
    return subscribePromptRequests(setRequest)
  }, [])

  if (!request) return null

  return (
    <Suspense fallback={null}>
      <PromptModal
        options={request.options}
        onSubmit={(value) => settlePromptRequest(request, value)}
        onCancel={() => settlePromptRequest(request, null)}
      />
    </Suspense>
  )
}
