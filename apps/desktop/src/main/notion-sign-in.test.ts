import { describe, expect, it } from 'vitest'
import { createNotionSignIn } from './notion-sign-in'

const BASE = 'https://notion.test'

function harness(overrides: { tokenStatus?: number } = {}) {
  const stored: { value: string | null } = { value: null }
  const requests: Array<{ url: string; body: string; method?: string }> = []
  let authorizeUrl = ''
  let tokenCount = 0

  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({ url, body: String(init?.body ?? ''), method: init?.method })
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return Response.json({
        authorization_endpoint: `${BASE}/authorize`,
        token_endpoint: `${BASE}/token`,
        registration_endpoint: `${BASE}/register`
      })
    }
    if (url === `${BASE}/register`) return Response.json({ client_id: 'client-1' })
    if (url === `${BASE}/token`) {
      tokenCount += 1
      if (overrides.tokenStatus) return new Response('no', { status: overrides.tokenStatus })
      return Response.json({
        access_token: `access-${tokenCount}`,
        refresh_token: `refresh-${tokenCount}`,
        expires_in: 3600
      })
    }
    return new Response('?', { status: 404 })
  }

  let time = 1_000_000
  const signIn = createNotionSignIn({
    baseUrl: BASE,
    fetch,
    openExternal: async (url) => {
      authorizeUrl = url
    },
    load: async () => stored.value,
    save: async (value) => {
      stored.value = value
      return true
    },
    remove: async () => {
      stored.value = null
    },
    now: () => time
  })

  const approve = async (params?: (url: URL) => Record<string, string>): Promise<Response> => {
    for (let i = 0; i < 200 && !authorizeUrl; i++) await new Promise((r) => setTimeout(r, 5))
    const auth = new URL(authorizeUrl)
    const redirect = new URL(auth.searchParams.get('redirect_uri') as string)
    const query = params?.(auth) ?? { code: 'the-code', state: auth.searchParams.get('state') as string }
    redirect.search = new URLSearchParams(query).toString()
    return globalThis.fetch(redirect)
  }

  return {
    signIn,
    stored,
    requests,
    approve,
    authorize: () => new URL(authorizeUrl),
    advance: (ms: number) => {
      time += ms
    }
  }
}

describe('Sign in with Notion', () => {
  it('runs the flow with PKCE, on a loopback redirect, and stores the session', async () => {
    const h = harness()
    const done = h.signIn.signIn()
    const page = await h.approve()
    expect(await page.text()).toContain('close this tab')
    await done

    const auth = h.authorize()
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(auth.searchParams.get('resource')).toBe(`${BASE}/mcp`)

    const exchange = new URLSearchParams(h.requests.find((r) => r.url === `${BASE}/token`)?.body)
    expect(exchange.get('code')).toBe('the-code')
    expect(exchange.get('code_verifier')).toBeTruthy()
    expect(exchange.has('client_secret')).toBe(false)

    expect(JSON.parse(h.stored.value as string)).toMatchObject({
      clientId: 'client-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1'
    })
    await expect(h.signIn.signedIn()).resolves.toBe(true)
  })

  it('ignores a redirect carrying the wrong state', async () => {
    const h = harness()
    const done = h.signIn.signIn()
    const forged = await h.approve(() => ({ code: 'stolen', state: 'nope' }))
    expect(forged.status).toBe(400)
    await h.approve()
    await done
    const exchange = new URLSearchParams(h.requests.find((r) => r.url === `${BASE}/token`)?.body)
    expect(exchange.get('code')).toBe('the-code')
  })

  it('reports a refusal, and stores nothing', async () => {
    const h = harness()
    const done = h.signIn.signIn()
    const failing = expect(done).rejects.toThrow('nope')
    await h.approve((auth) => ({
      error: 'access_denied',
      error_description: 'nope',
      state: auth.searchParams.get('state') as string
    }))
    await failing
    expect(h.stored.value).toBeNull()
  })

  it('can be cancelled while it waits', async () => {
    const h = harness()
    const done = h.signIn.signIn()
    const failing = expect(done).rejects.toThrow('cancelled')
    for (let i = 0; i < 200 && h.requests.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
    h.signIn.cancelSignIn()
    await failing
  })

  it('refreshes a token about to expire, and keeps the rotated one', async () => {
    const h = harness()
    const done = h.signIn.signIn()
    await h.approve()
    await done
    await expect(h.signIn.accessToken()).resolves.toBe('access-1')
    h.advance(3600_000)
    await expect(h.signIn.accessToken()).resolves.toBe('access-2')
    expect(JSON.parse(h.stored.value as string).refreshToken).toBe('refresh-2')
    const refresh = new URLSearchParams(h.requests.filter((r) => r.url === `${BASE}/token`)[1].body)
    expect(refresh.get('grant_type')).toBe('refresh_token')
    expect(refresh.get('refresh_token')).toBe('refresh-1')
  })

  it('shares one refresh between calls, since a rotated token works once', async () => {
    const h = harness()
    const done = h.signIn.signIn()
    await h.approve()
    await done
    const [a, b] = await Promise.all([h.signIn.refresh(), h.signIn.refresh()])
    expect(a).toBe(b)
    expect(h.requests.filter((r) => r.url === `${BASE}/token`)).toHaveLength(2)
  })

  it('forgets the session on sign-out', async () => {
    const h = harness()
    const done = h.signIn.signIn()
    await h.approve()
    await done
    await h.signIn.signOut()
    await expect(h.signIn.signedIn()).resolves.toBe(false)
    await expect(h.signIn.accessToken()).rejects.toThrow('Sign in')
  })
})
