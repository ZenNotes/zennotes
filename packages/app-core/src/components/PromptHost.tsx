import { lazy, Suspense, useEffect, useState } from 'react'
import {
  getPromptRequest,
  settlePromptRequest,
  subscribePromptRequests,
  type PromptRequest
} from '../lib/prompt-requests'
import {
  getRemoteAuthRequest,
  settleRemoteAuthRequest,
  subscribeRemoteAuthRequests,
  type RemoteAuthRequest
} from '../lib/remote-auth-requests'

const PromptModal = lazy(async () => {
  const module = await import('./PromptModal')
  return { default: module.PromptModal }
})

const RemoteAuthModal = lazy(async () => {
  const module = await import('./RemoteAuthModal')
  return { default: module.RemoteAuthModal }
})

export function PromptHost(): JSX.Element | null {
  const [request, setRequest] = useState<PromptRequest | null>(getPromptRequest)
  const [remoteAuth, setRemoteAuth] = useState<RemoteAuthRequest | null>(getRemoteAuthRequest)

  useEffect(() => {
    return subscribePromptRequests(setRequest)
  }, [])

  useEffect(() => {
    return subscribeRemoteAuthRequests(setRemoteAuth)
  }, [])

  if (remoteAuth) {
    return (
      <Suspense fallback={null}>
        <RemoteAuthModal
          onSubmit={(value) => settleRemoteAuthRequest(remoteAuth, value)}
          onCancel={() => settleRemoteAuthRequest(remoteAuth, null)}
        />
      </Suspense>
    )
  }

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
