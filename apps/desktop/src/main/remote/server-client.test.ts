import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import {
  RemoteConnectionError,
  RemoteRequestError,
  RemoteServerClient,
  connectionErrorMessage
} from './server-client'

describe('connectionErrorMessage (#481)', () => {
  const url = 'https://zennotes.lan:8443'

  it('names the server and carries the underlying reason', () => {
    const msg = connectionErrorMessage(url, new TypeError('fetch failed'), 'linux')
    expect(msg).toContain(url)
    expect(msg).toContain('Could not reach the server: fetch failed.')
  })

  it('points macOS users at the Local Network permission', () => {
    // macOS 15+ blocks local-network connections outright when the permission
    // is off — no packets, no error beyond "fetch failed" — so the message has
    // to name the setting or the user has nothing to go on.
    const msg = connectionErrorMessage(url, new TypeError('fetch failed'), 'darwin')
    expect(msg).toContain('Privacy & Security → Local Network')
  })

  it('leaves that hint out on platforms without the permission', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(connectionErrorMessage(url, new Error('boom'), platform)).not.toContain(
        'Local Network'
      )
    }
  })

  it('still reads as a sentence when the failure carries no message', () => {
    const msg = connectionErrorMessage(url, {}, 'linux')
    expect(msg).toBe(
      `Could not connect to the ZenNotes server at ${url}. Make sure the server is running and the URL is correct.`
    )
  })
})

describe('jsonRequest error typing (#499 follow-up)', () => {
  it('a refused connection surfaces as RemoteConnectionError', async () => {
    // Port 1 is never listening; fetch rejects at the network layer.
    const client = new RemoteServerClient({ baseUrl: 'http://127.0.0.1:1' })
    await expect(client.readNote('inbox/x.md')).rejects.toBeInstanceOf(RemoteConnectionError)
  })

  it('a non-2xx answer surfaces as RemoteRequestError carrying the status', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })
      const err = await client.readNote('inbox/x.md').then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(RemoteRequestError)
      expect((err as RemoteRequestError).status).toBe(404)
      expect((err as RemoteRequestError).message).toContain('404')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('watchVaultChanges reconnect', () => {
  type WatchServer = { server: http.Server; wss: WebSocketServer; close: () => Promise<void> }

  async function startWatchServer(port: number, payload: object): Promise<WatchServer> {
    const server = http.createServer()
    const wss = new WebSocketServer({ server, path: '/api/watch' })
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify(payload))
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    return {
      server,
      wss,
      close: async () => {
        for (const socket of wss.clients) socket.terminate()
        await new Promise((resolve) => wss.close(resolve))
        await new Promise((resolve) => server.close(resolve))
      }
    }
  }

  async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  it('survives a server restart: resubscribes and reports the gap', async () => {
    // Grab a free port first so the restarted server can reuse it.
    const probe = http.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise((resolve) => probe.close(resolve))

    let watchServer = await startWatchServer(port, { kind: 'add', path: 'a.md', folder: 'inbox' })
    const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })

    const events: string[] = []
    let reconnects = 0
    const stop = client.watchVaultChanges(
      (ev) => events.push(ev.path),
      { onReconnect: () => (reconnects += 1) }
    )
    try {
      await waitFor(() => events.includes('a.md'), 5_000, 'first event')
      expect(reconnects).toBe(0)

      // Server dies mid-session. The old client crashed the main process
      // here (unhandled 'error') and never resubscribed.
      await watchServer.close()
      watchServer = await startWatchServer(port, { kind: 'add', path: 'b.md', folder: 'inbox' })

      await waitFor(() => events.includes('b.md'), 15_000, 'event after restart')
      expect(reconnects).toBeGreaterThanOrEqual(1)
    } finally {
      stop()
      await watchServer.close()
    }
  }, 30_000)

  it('a peer that accepts the upgrade and instantly drops it backs off instead of hammering', async () => {
    const server = http.createServer()
    const wss = new WebSocketServer({ server, path: '/api/watch' })
    let connections = 0
    wss.on('connection', (socket) => {
      connections += 1
      socket.close()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = (server.address() as AddressInfo)
    const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })

    const stop = client.watchVaultChanges(() => {})
    try {
      // The old client reset the backoff on every 'open', so a handshake
      // that immediately dies reconnected on a flat 1s forever: ~6
      // connections in this window. Growing backoff (1s, 2s, 4s) allows 4
      // at most.
      await new Promise((resolve) => setTimeout(resolve, 6_000))
      expect(connections).toBeGreaterThanOrEqual(2)
      expect(connections).toBeLessThanOrEqual(4)
    } finally {
      stop()
      for (const socket of wss.clients) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
    }
  }, 15_000)

  it('a connection that stays up long enough resets the backoff for the next gap', async () => {
    const server = http.createServer()
    const wss = new WebSocketServer({ server, path: '/api/watch' })
    const connectedAt: number[] = []
    wss.on('connection', () => {
      connectedAt.push(Date.now())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = (server.address() as AddressInfo)
    const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })

    const stop = client.watchVaultChanges(() => {}, { stableAfterMs: 100 })
    try {
      // Three kill/reconnect cycles, each after the socket outlived the
      // stability window. With the reset every gap retries at the base 1s;
      // without it the third gap would wait 4s.
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        await waitFor(() => connectedAt.length === cycle, 5_000, `connection ${cycle}`)
        await new Promise((resolve) => setTimeout(resolve, 400))
        for (const socket of wss.clients) socket.terminate()
      }
      await waitFor(() => connectedAt.length === 4, 5_000, 'connection 4')
      expect(connectedAt[3] - connectedAt[2]).toBeLessThan(3_000)
    } finally {
      stop()
      for (const socket of wss.clients) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
    }
  }, 30_000)

  it('a stopped watch does not keep reconnecting', async () => {
    const watchServer = await startWatchServer(0, { kind: 'add', path: 'x.md', folder: 'inbox' })
    const { port } = watchServer.server.address() as AddressInfo
    const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })

    const events: string[] = []
    const stop = client.watchVaultChanges((ev) => events.push(ev.path))
    try {
      await waitFor(() => events.length > 0, 5_000, 'first event')
      stop()
      const connectionsAfterStop = () =>
        [...watchServer.wss.clients].filter((s) => s.readyState === s.OPEN).length
      // The backoff starts at 1s; give a runaway reconnect time to show up.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(connectionsAfterStop()).toBe(0)
    } finally {
      stop()
      await watchServer.close()
    }
  }, 15_000)

  it('a proxy that refuses the upgrade falls back to polling, and stop ends the polling (#734)', async () => {
    // A reverse proxy without WebSocket support answers the handshake with a
    // plain HTTP error every time. The feed is not briefly down, it is
    // unavailable, and the old client left the vault frozen at connect time.
    const server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end('not found')
    })
    server.on('upgrade', (_req, socket) => {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nnot found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })

    let resyncs = 0
    const stop = client.watchVaultChanges(() => {}, {
      onReconnect: () => (resyncs += 1),
      pollWhileDownMs: 100
    })
    try {
      await waitFor(() => resyncs >= 3, 5_000, 'polling resyncs')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('/api/watch')
    } finally {
      stop()
      warn.mockRestore()
    }
    const afterStop = resyncs
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(resyncs).toBe(afterStop)
    await new Promise((resolve) => server.close(resolve))
  }, 10_000)

  it('an unreachable server neither throws nor crashes, and stop cancels the retry loop', async () => {
    // Port 1 is never listening. The connection error must stay inside the
    // client (an unhandled ws 'error' event would crash the process, which
    // vitest would surface as an unhandled exception).
    const client = new RemoteServerClient({ baseUrl: 'http://127.0.0.1:1' })
    const stop = client.watchVaultChanges(() => {})
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }, 10_000)
})


describe('a 404 for a path this app asked to change (#734)', () => {
  async function serverAnswering(status: number, body: string): Promise<{ port: number; close: () => Promise<void>; requests: string[] }> {
    const requests: string[] = []
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`)
      res.writeHead(status)
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return { port, requests, close: () => new Promise((resolve) => server.close(() => resolve())) }
  }

  it('names the path, keeps the 404 status, and asks the host to re-pull the list', async () => {
    const { port, close } = await serverAnswering(404, 'not found')
    const stale: string[] = []
    const client = new RemoteServerClient({
      baseUrl: `http://127.0.0.1:${port}`,
      onStalePath: (path) => stale.push(path)
    })
    try {
      const error = await client.moveToTrash('inbox/Renamed elsewhere.md').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(RemoteRequestError)
      expect((error as RemoteRequestError).status).toBe(404)
      expect((error as Error).message).toContain('nothing at inbox/Renamed elsewhere.md any more')
      expect((error as Error).message).toContain('refreshed')
      expect(stale).toEqual(['inbox/Renamed elsewhere.md'])
    } finally {
      await close()
    }
  })

  it('leaves a 404 on a read alone: absent is a valid answer there (#556)', async () => {
    const { port, close } = await serverAnswering(404, 'not found')
    const stale: string[] = []
    const client = new RemoteServerClient({
      baseUrl: `http://127.0.0.1:${port}`,
      onStalePath: (path) => stale.push(path)
    })
    try {
      const error = await client.readNote('inbox/Absent.md').catch((e: unknown) => e)
      expect((error as RemoteRequestError).status).toBe(404)
      expect((error as Error).message).toContain('404')
      expect(stale).toEqual([])
    } finally {
      await close()
    }
  })
})

describe('custom templates on a remote vault (#723)', () => {
  interface TemplateServer {
    port: number
    close: () => Promise<void>
    requests: Array<{ method: string; url: string; body: string }>
  }

  async function templateServer(capabilities: Record<string, unknown>): Promise<TemplateServer> {
    const requests: TemplateServer['requests'] = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body })
        const send = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(payload))
        }
        if (req.url === '/api/capabilities') return send(200, capabilities)
        if (req.url === '/api/templates') {
          return send(200, [{ sourcePath: '.zennotes/templates/adr.md', raw: '---\nname: ADR\n---\n' }])
        }
        if (req.url?.startsWith('/api/templates/read?')) return send(200, { raw: '# raw body' })
        if (req.url === '/api/templates/write') {
          const input = JSON.parse(body) as { slug: string; raw: string }
          return send(200, { sourcePath: `.zennotes/templates/${input.slug}.md`, raw: input.raw })
        }
        if (req.url === '/api/templates/delete') return send(200, { ok: true })
        res.writeHead(404)
        res.end('not found')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return { port, requests, close: () => new Promise((resolve) => server.close(() => resolve())) }
  }

  it('reads the capability flag, and its absence means an older server', async () => {
    const supporting = await templateServer({ supportsCustomTemplates: true })
    const older = await templateServer({ supportsWorkflows: true })
    try {
      const withRoutes = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${supporting.port}` })
      const without = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${older.port}` })
      expect(await withRoutes.supportsCustomTemplates()).toBe(true)
      expect(await without.supportsCustomTemplates()).toBe(false)
    } finally {
      await supporting.close()
      await older.close()
    }
  })

  it('drives the four template routes with the bridge contract shapes', async () => {
    const server = await templateServer({ supportsCustomTemplates: true })
    try {
      const client = new RemoteServerClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        authToken: 'tok'
      })
      const listed = await client.listTemplates()
      expect(listed).toEqual([{ sourcePath: '.zennotes/templates/adr.md', raw: '---\nname: ADR\n---\n' }])

      expect(await client.readTemplate('.zennotes/templates/adr.md')).toBe('# raw body')

      const written = await client.writeTemplate({
        slug: 'weekly',
        raw: '# weekly',
        previousSourcePath: '.zennotes/templates/adr.md'
      })
      expect(written).toEqual({ sourcePath: '.zennotes/templates/weekly.md', raw: '# weekly' })

      await client.deleteTemplate('.zennotes/templates/weekly.md')

      expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        'GET /api/templates',
        'GET /api/templates/read?path=.zennotes%2Ftemplates%2Fadr.md',
        'POST /api/templates/write',
        'POST /api/templates/delete'
      ])
      expect(JSON.parse(server.requests[2].body)).toEqual({
        slug: 'weekly',
        raw: '# weekly',
        previousSourcePath: '.zennotes/templates/adr.md'
      })
      expect(JSON.parse(server.requests[3].body)).toEqual({ sourcePath: '.zennotes/templates/weekly.md' })
    } finally {
      await server.close()
    }
  })
})
