/**
 * Sign in with Notion, as a desktop app does it: OAuth with PKCE against
 * Notion's hosted service, registering a client on the spot and listening on a
 * loopback port for the redirect. No secret ships in the app and no server of
 * ours sits in the middle, so the tokens only ever go between this machine and
 * Notion. They live in the system's secure storage and never reach the renderer.
 *
 * No electron in here: browser, fetch and storage come as arguments, so a test
 * can run the whole flow against a stand-in.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** Refresh a little early: a long import shouldn't race an expiring token. */
const EXPIRY_MARGIN_MS = 60_000

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>ZenNotes</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0">
<p>Signed in. You can close this tab and go back to ZenNotes.</p></body>`

export interface NotionSession {
  clientId: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

export interface NotionSignInDeps {
  baseUrl: string
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  openExternal: (url: string) => Promise<unknown>
  load: () => Promise<string | null>
  save: (value: string) => Promise<boolean>
  remove: () => Promise<void>
  now?: () => number
}

interface AuthServerMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export function createNotionSignIn(deps: NotionSignInDeps) {
  const now = deps.now ?? Date.now
  let refreshing: Promise<string | null> | null = null
  let cancelPending: (() => void) | null = null

  const metadata = async (): Promise<AuthServerMetadata> => {
    const response = await deps.fetch(`${deps.baseUrl}/.well-known/oauth-authorization-server`)
    if (!response.ok) throw new Error(`Notion's sign-in answered ${response.status}.`)
    return (await response.json()) as AuthServerMetadata
  }

  const readSession = async (): Promise<NotionSession | null> => {
    const raw = await deps.load()
    if (!raw) return null
    try {
      return JSON.parse(raw) as NotionSession
    } catch {
      return null
    }
  }

  const writeSession = async (session: NotionSession): Promise<void> => {
    if (!(await deps.save(JSON.stringify(session)))) {
      throw new Error('This system has no secure storage to keep a sign-in in.')
    }
  }

  const fromTokenAnswer = (
    clientId: string,
    answer: { access_token: string; refresh_token?: string; expires_in?: number },
    previousRefresh?: string
  ): NotionSession => ({
    clientId,
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? previousRefresh,
    ...(answer.expires_in ? { expiresAt: now() + answer.expires_in * 1000 } : {})
  })

  /** The redirect, on a port the system picked. Refuses anything without the
   *  state this sign-in made. */
  const waitForRedirect = (state: string) => {
    let server: Server
    let port = 0
    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS)
      cancelPending = () => {
        clearTimeout(timer)
        reject(new Error('Sign-in cancelled.'))
      }
      server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          response.writeHead(404).end()
          return
        }
        if (url.searchParams.get('state') !== state) {
          response.writeHead(400).end('Sign-in state did not match.')
          return
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CALLBACK_PAGE)
        clearTimeout(timer)
        const answer = url.searchParams.get('code')
        if (answer) resolve(answer)
        else reject(new Error(url.searchParams.get('error_description') ?? 'Notion did not grant access.'))
      })
    })
    const listening = new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
    return {
      code,
      listening,
      redirectUri: (): string => `http://127.0.0.1:${port}/callback`,
      close: (): void => {
        server.close()
        server.closeAllConnections?.()
      }
    }
  }

  return {
    async signedIn(): Promise<boolean> {
      return (await readSession()) !== null
    },

    /** Resolves once Notion has answered and the session is stored. */
    async signIn(): Promise<void> {
      const server = await metadata()
      const state = base64Url(randomBytes(24))
      const verifier = base64Url(randomBytes(48))
      const challenge = base64Url(createHash('sha256').update(verifier).digest())
      const redirect = waitForRedirect(state)
      await redirect.listening
      try {
        const registered = await deps.fetch(server.registration_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: 'ZenNotes',
            redirect_uris: [redirect.redirectUri()],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none'
          })
        })
        if (!registered.ok) throw new Error(`Notion's sign-in answered ${registered.status}.`)
        const { client_id: clientId } = (await registered.json()) as { client_id: string }

        const authorize = new URL(server.authorization_endpoint)
        authorize.search = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirect.redirectUri(),
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: `${deps.baseUrl}/mcp`
        }).toString()
        await deps.openExternal(authorize.toString())

        const code = await redirect.code
        const exchanged = await deps.fetch(server.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirect.redirectUri(),
            client_id: clientId,
            code_verifier: verifier,
            resource: `${deps.baseUrl}/mcp`
          }).toString()
        })
        if (!exchanged.ok) throw new Error(`Notion's sign-in answered ${exchanged.status}.`)
        await writeSession(
          fromTokenAnswer(clientId, (await exchanged.json()) as { access_token: string })
        )
      } finally {
        cancelPending = null
        redirect.close()
      }
    },

    cancelSignIn(): void {
      cancelPending?.()
    },

    /** Swaps the refresh token for new ones; Notion rotates both. Null means
     *  the person has to sign in again. Calls in flight share one swap, since
     *  a rotated token only works once. */
    refresh(): Promise<string | null> {
      refreshing ??= (async () => {
        const session = await readSession()
        if (!session?.refreshToken) return null
        const server = await metadata()
        const answer = await deps.fetch(server.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: session.clientId
          }).toString()
        })
        if (!answer.ok) return null
        const next = fromTokenAnswer(
          session.clientId,
          (await answer.json()) as { access_token: string },
          session.refreshToken
        )
        await writeSession(next)
        return next.accessToken
      })().finally(() => {
        refreshing = null
      })
      return refreshing
    },

    async accessToken(): Promise<string> {
      const session = await readSession()
      if (!session) throw new Error('Sign in to Notion first.')
      if (session.expiresAt && session.expiresAt - now() < EXPIRY_MARGIN_MS) {
        const fresh = await this.refresh()
        if (fresh) return fresh
      }
      return session.accessToken
    },

    async signOut(): Promise<void> {
      await deps.remove()
    }
  }
}
