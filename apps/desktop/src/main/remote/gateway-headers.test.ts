import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteRequestError, RemoteServerClient } from './server-client'
import { gatewayRedirectMessage, remoteJsonRequest, requestErrorMessage } from './connection'

// #1091: a server behind an access gateway (Cloudflare Access service tokens)
// is only reachable with two extra headers on every request, the change
// feed's WebSocket handshake included.
const HEADERS = [
  { name: 'CF-Access-Client-Id', value: 'abc123.access' },
  { name: 'CF-Access-Client-Secret', value: 's3cr3t' }
]

function passesGateway(req: http.IncomingMessage): boolean {
  return (
    req.headers['cf-access-client-id'] === 'abc123.access' &&
    req.headers['cf-access-client-secret'] === 's3cr3t'
  )
}

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (servers.length) await servers.pop()!()
})

/** A ZenNotes stand-in behind a gateway: no headers, an HTML 403. */
async function startGatedServer(): Promise<{ baseUrl: string; seen: string[] }> {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${passesGateway(req) ? 'pass' : 'blocked'}`)
    if (!passesGateway(req)) {
      res.writeHead(403, { 'content-type': 'text/html' })
      res.end('<html><body>Forbidden</body></html>')
      return
    }
    if (req.url === '/api/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ supportsWatch: true }))
      return
    }
    if (req.url?.startsWith('/api/assets/raw')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('bytes')
      return
    }
    if (req.url === '/api/assets/upload') {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: 'assets/a.png' }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    seen.push(`UPGRADE ${req.url} ${passesGateway(req) ? 'pass' : 'blocked'}`)
    if (!passesGateway(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ kind: 'add', path: 'gated.md', folder: 'inbox' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => server.close(resolve))
  })
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, seen }
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('extra headers reach a gated server (#1091)', () => {
  it('the app client sends them on JSON, asset, upload and change-feed requests', async () => {
    const { baseUrl, seen } = await startGatedServer()
    const client = new RemoteServerClient({ baseUrl, authToken: 'tok', headers: HEADERS })

    await expect(client.getCapabilities()).resolves.toEqual({ supportsWatch: true })
    await expect((await client.fetchAssetResponse('a.png')).text()).resolves.toBe('bytes')
    await expect(client.uploadAsset('inbox/n.md', 'a.png', new Uint8Array([1]))).resolves.toEqual({
      path: 'assets/a.png'
    })

    const events: string[] = []
    const stop = client.watchVaultChanges((event) => events.push(event.path))
    try {
      await waitFor(() => events.includes('gated.md'), 'the change feed event')
    } finally {
      stop()
    }
    expect(seen.every((line) => line.endsWith('pass'))).toBe(true)
    expect(seen.some((line) => line.startsWith('UPGRADE /api/watch'))).toBe(true)
  })

  it('without them the gateway refusal reads as a gateway, not a ZenNotes error', async () => {
    const { baseUrl } = await startGatedServer()
    const client = new RemoteServerClient({ baseUrl, authToken: 'tok' })
    const err = await client.getCapabilities().then(
      () => null,
      (error: unknown) => error
    )
    expect(err).toBeInstanceOf(RemoteRequestError)
    expect((err as RemoteRequestError).status).toBe(403)
    expect((err as Error).message).toContain('access gateway such as Cloudflare Access')
    expect((err as Error).message).not.toContain('<html>')
  })

  it('a header list that does not parse is dropped whole, never sent in part', () => {
    const client = new RemoteServerClient({
      baseUrl: 'http://127.0.0.1:1',
      headers: [...HEADERS, { name: 'Host', value: 'elsewhere' }]
    })
    expect(client.headers).toEqual([])
  })

  it('the CLI and MCP request helper sends them too', async () => {
    const { baseUrl, seen } = await startGatedServer()
    await expect(
      remoteJsonRequest('/api/capabilities', { baseUrl, headers: HEADERS })
    ).resolves.toEqual({ supportsWatch: true })
    await expect(remoteJsonRequest('/api/capabilities', { baseUrl })).rejects.toThrow(
      'access gateway'
    )
    expect(seen).toEqual(['GET /api/capabilities pass', 'GET /api/capabilities blocked'])
  })
})

describe('gateway messages', () => {
  it('names a redirect to a sign-in page on another host', () => {
    const message = gatewayRedirectMessage('https://notes.example.com', {
      redirected: true,
      url: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/notes.example.com'
    })
    expect(message).toContain('team.cloudflareaccess.com')
  })

  it('lets a redirect that stays on the server host through (http to https)', () => {
    expect(
      gatewayRedirectMessage('http://notes.example.com', {
        redirected: true,
        url: 'https://notes.example.com/api/vault'
      })
    ).toBeNull()
    expect(
      gatewayRedirectMessage('https://notes.example.com', { redirected: false, url: '' })
    ).toBeNull()
  })

  it('keeps the server’s own plain-text 403', () => {
    const message = requestErrorMessage(
      'https://notes.example.com',
      '/api/fs/browse',
      { status: 403, statusText: 'Forbidden', headers: new Headers({ 'content-type': 'text/plain' }) },
      'path is outside the allowed browse roots'
    )
    expect(message).toContain('path is outside the allowed browse roots')
  })
})
