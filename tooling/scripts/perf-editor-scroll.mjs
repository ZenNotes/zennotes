#!/usr/bin/env node
/**
 * Editor scroll + typing performance harness (#472).
 *
 * Seeds a long note containing several images, opens it in the real desktop
 * build, then drives two scroll patterns and a typing burst while recording:
 *   - every zen-asset:// request (are images refetched when scrolled back in?)
 *   - image widget DOM churn, and how much of it reuses a cached element
 *   - frame intervals for a deliberate read-through and for a fast flick
 *   - keystroke-to-paint latency mid-document
 *   - long tasks
 *
 * Images are generated from real random bytes on purpose: a flat-colour PNG
 * compresses to nothing and decodes instantly, which would make this benchmark
 * far easier than any real screenshot or photo.
 *
 *   npm run perf:editor-scroll
 *   ZEN_EDITOR_PERF_LINES=1500 ZEN_EDITOR_PERF_IMAGES=20 npm run perf:editor-scroll
 *   ZEN_EDITOR_PERF_OUT=/tmp/after.json npm run perf:editor-scroll
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { randomFillSync } from 'node:crypto'
import WebSocket from 'ws'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
// electron is a dependency of the desktop workspace, not of the repo root;
// hoisting is not a contract, so resolve it from where it is declared.
const requireDesktop = createRequire(resolve(repoRoot, 'apps/desktop/package.json'))
const electronPath = requireDesktop('electron')
const desktopOutMain = resolve(repoRoot, 'apps/desktop/out/main/index.js')
const outPath = process.argv[2] || process.env.ZEN_EDITOR_PERF_OUT || join(scriptDir, 'perf-editor-scroll.json')
const LINES = Number(process.env.ZEN_EDITOR_PERF_LINES || 700)
const IMAGES = Number(process.env.ZEN_EDITOR_PERF_IMAGES || 10)
const IMG_W = Number(process.env.ZEN_EDITOR_PERF_IMG_W || 1600)
const IMG_H = Number(process.env.ZEN_EDITOR_PERF_IMG_H || 1200)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => res(a.port)) })
    s.on('error', rej)
  })
}
function httpGetJson(url) {
  return new Promise((res, rej) => {
    const req = http.get(url, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) })
    req.on('error', rej); req.setTimeout(2000, () => req.destroy(new Error('timeout')))
  })
}
class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); this.listeners = new Map() }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url, { maxPayload: 256 * 1024 * 1024 })
      this.ws.on('open', res); this.ws.on('error', rej)
      this.ws.on('message', (raw) => {
        const m = JSON.parse(String(raw))
        if (m.id && this.pending.has(m.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(m.id); this.pending.delete(m.id)
          m.error ? rj(new Error(m.error.message)) : rs(m.result ?? {})
        } else if (m.method) for (const l of this.listeners.get(m.method) ?? []) l(m.params ?? {})
      })
    })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  on(method, l) { const a = this.listeners.get(method) ?? []; a.push(l); this.listeners.set(method, a) }
  close() { this.ws?.terminate?.() }
}
async function connectPage(port) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`)
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (String(t.url).startsWith('file:') || String(t.url).includes('index.html')))
      if (page) { const c = new Cdp(page.webSocketDebuggerUrl); await c.connect(); return c }
    } catch {}
    await sleep(150)
  }
  throw new Error('no CDP page')
}

function png(w, h, tint) {
  const chunk = (t, d) => {
    const c = Buffer.concat([Buffer.from(t), d])
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(c) >>> 0 : crc32(c))
    return Buffer.concat([len, c, crc])
  }
  // Minimal CRC32 for older node
  function crc32(buf) {
    let c, crc = 0xffffffff
    for (let n = 0; n < buf.length; n++) {
      c = (crc ^ buf[n]) & 0xff
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crc = (crc >>> 8) ^ c
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  // Noise, not flat colour: a flat image deflates to almost nothing and decodes
  // instantly, which would make this benchmark far easier than a real
  // screenshot or photo.
  const rows = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(w * 3 + 1)
    randomFillSync(row, 1)
    row[1] = tint
    rows.push(row)
  }
  const raw = Buffer.concat(rows)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ])
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'zen472-'))
  const vaultRoot = join(tempRoot, 'vault')
  const userDataRoot = join(tempRoot, 'user-data')
  const configRoot = join(tempRoot, 'config')
  await mkdir(join(vaultRoot, 'inbox'), { recursive: true })
  await mkdir(join(vaultRoot, 'assets'), { recursive: true })
  for (const d of ['quick', 'archive', 'trash']) await mkdir(join(vaultRoot, d), { recursive: true })
  await mkdir(configRoot, { recursive: true })
  await mkdir(userDataRoot, { recursive: true })

  // Real-ish images: 900x600 each, a few hundred KB decoded.
  for (let i = 0; i < IMAGES; i++) {
    await writeFile(join(vaultRoot, 'assets', `shot-${i}.png`), png(IMG_W, IMG_H, (i * 23) % 256))
  }

  // A long note: prose + headings + code + the images spread through it.
  const out = []
  let imgIdx = 0
  for (let i = 0; i < LINES; i++) {
    if (i % 40 === 0) out.push(`## Section ${i / 40 + 1}`)
    if (i % 70 === 0 && imgIdx < IMAGES) out.push(`![shot ${imgIdx}](assets/shot-${imgIdx++}.png)`)
    if (i % 25 === 0) out.push('```js\nconst x = compute(' + i + ')\n```')
    out.push(
      `Paragraph ${i} with **bold**, *italic*, \`code\`, a [link](https://example.com/${i}) and #tag${i % 7} ` +
      'plus filler text to push this note past the 48k character mark described in the issue.'
    )
  }
  const body = `# Long note\n\n${out.join('\n')}\n`
  await writeFile(join(vaultRoot, 'inbox', 'Long.md'), body)
  await writeFile(join(vaultRoot, 'inbox', 'Small.md'), '# Small\n\nshort\n')
  await writeFile(join(userDataRoot, 'zennotes.config.json'), JSON.stringify({
    workspaceMode: 'local', vaultRoot, remoteWorkspace: null, remoteWorkspaceProfileId: null,
    remoteWorkspaceProfiles: [], windowState: { x: 40, y: 40, width: 1400, height: 900, isMaximized: false },
    zoomFactor: 1, quickCaptureHotkey: ''
  }, null, 2))

  const port = await getFreePort()
  const child = spawn(electronPath, [`--remote-debugging-port=${port}`, desktopOutMain], {
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ZENNOTES_USER_DATA_PATH: userDataRoot, ZENNOTES_CONFIG_DIR: configRoot },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {})

  const result = { doc: { lines: body.split('\n').length, chars: body.length, images: IMAGES } }
  let client
  try {
    client = await connectPage(port)
    await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable')])

    const assetRequests = []
    client.on('Network.requestWillBeSent', (p) => {
      if (String(p.request?.url || '').startsWith('zen-asset://')) assetRequests.push({ url: p.request.url, ts: p.timestamp })
    })
    const served = []
    const reqIds = new Set()
    client.on('Network.responseReceived', (p) => {
      if (String(p.response?.url || '').startsWith('zen-asset://')) {
        reqIds.add(p.requestId)
        served.push({ url: p.response.url, status: p.response.status, fromCache: !!p.response.fromDiskCache || !!p.response.fromPrefetchCache })
      }
    })
    let assetBytes = 0
    client.on('Network.loadingFinished', (p) => {
      if (reqIds.has(p.requestId)) assetBytes += p.encodedDataLength || 0
    })

    const evaluate = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result?.value
    }
    const until = async (expr, ms = 40000) => {
      const dl = Date.now() + ms
      while (Date.now() < dl) { const v = await evaluate(expr); if (v) return v; await sleep(200) }
      return null
    }

    // Real mouse events at the element centre: these sidebar rows are divs whose
    // handlers don't always fire for a synthetic .click().
    const clickEl = async (selectorExpr) => {
      const rect = await evaluate(`(() => {
        const el = ${selectorExpr};
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)
      if (!rect) return false
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
        await sleep(40)
      }
      await sleep(400)
      return true
    }

    await until(`(() => {
      const skip = [...document.querySelectorAll('button')].find(b => /skip setup/i.test((b.textContent||'').trim()));
      if (skip) { skip.click(); return false }
      const f = [...document.querySelectorAll('[data-sidebar-type="folder"][data-sidebar-collapsed="true"]')];
      if (f.length) { f.forEach(x => x.click()); return false }
      return [...document.querySelectorAll('[data-sidebar-type="note"]')].some(e => (e.textContent||'').includes('Long'));
    })()`)
    await clickEl(`[...document.querySelectorAll('[data-sidebar-type="note"]')].find(e => (e.textContent||'').includes('Long'))`)
    const editorUp = await until(`!!document.querySelector('.cm-content') && !!document.querySelector('.cm-scroller')`)
    if (!editorUp) {
      const dump = await evaluate(`(() => ({
        sidebar: [...document.querySelectorAll('[data-sidebar-type]')].map(e => e.getAttribute('data-sidebar-type') + ':' + (e.textContent||'').trim().slice(0,25)),
        body: (document.body.innerText || '').slice(0, 700)
      }))()`)
      throw new Error('editor never mounted: ' + JSON.stringify(dump, null, 2))
    }
    await sleep(2500)

    // Instrument: count img creations/removals in the editor, and frame gaps.
    await evaluate(`(() => {
      window.__m = { imgAdded: 0, imgRemoved: 0, frames: [], longTasks: [] };
      const sc = document.querySelector('.cm-scroller');
      window.__sc = sc;
      // Count only the editor's own image-embed widgets, and tag each element
      // with an id so re-adding the *same* node is distinguishable from
      // building a brand new one.
      window.__m.figAdded = 0; window.__m.figRemoved = 0; window.__m.freshNodes = 0;
      let seq = 0;
      const countImgs = (n, key) => {
        if (n.nodeType !== 1) return;
        const imgs = [];
        if (n.matches && n.matches('img.local-image-embed-image')) imgs.push(n);
        if (n.querySelectorAll) imgs.push(...n.querySelectorAll('img.local-image-embed-image'));
        for (const img of imgs) {
          window.__m[key] += 1;
          if (key === 'figAdded') {
            if (!img.__zid) { img.__zid = ++seq; window.__m.freshNodes += 1 }
          }
        }
      };
      const mo = new MutationObserver((recs) => {
        for (const r of recs) {
          r.addedNodes.forEach(n => countImgs(n, 'figAdded'));
          r.removedNodes.forEach(n => countImgs(n, 'figRemoved'));
        }
      });
      mo.observe(document.querySelector('.cm-content'), { childList: true, subtree: true });
      window.__mo = mo;
      window.__m.loadMs = [];
      const timeInsert = (n) => {
        if (n.nodeType !== 1) return;
        const imgs = [];
        if (n.matches && n.matches('img.local-image-embed-image')) imgs.push(n);
        if (n.querySelectorAll) imgs.push(...n.querySelectorAll('img.local-image-embed-image'));
        for (const img of imgs) {
          if (img.__ztimed) continue;
          img.__ztimed = true;
          const t0 = performance.now();
          if (img.complete && img.naturalWidth > 0) { window.__m.loadMs.push(0); continue }
          img.addEventListener('load', () => window.__m.loadMs.push(Math.round(performance.now() - t0)), { once: true });
        }
      };
      const mo2 = new MutationObserver((recs) => { for (const r of recs) r.addedNodes.forEach(timeInsert) });
      mo2.observe(document.querySelector('.cm-content'), { childList: true, subtree: true });
      window.__mo2 = mo2;
      try {
        const po = new PerformanceObserver(list => { for (const e of list.getEntries()) window.__m.longTasks.push(Math.round(e.duration)) });
        po.observe({ entryTypes: ['longtask'] });
      } catch {}
      let last = performance.now();
      window.__raf = () => { const t = performance.now(); window.__m.frames.push(t - last); last = t; window.__rafId = requestAnimationFrame(window.__raf) };
      window.__rafId = requestAnimationFrame(window.__raf);
      return true;
    })()`)

    const baseline = { assetRequests: assetRequests.length }

    // Scroll to the bottom in steps, then back to the top, like a read-through.
    const stats = await evaluate(`(async () => {
      const sc = window.__sc;
      const max = sc.scrollHeight - sc.clientHeight;
      const step = Math.max(200, Math.round(sc.clientHeight * 0.8));
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const t0 = performance.now();
      for (let y = 0; y <= max; y += step) { sc.scrollTop = y; await wait(60); }
      for (let y = max; y >= 0; y -= step) { sc.scrollTop = y; await wait(60); }
      const t1 = performance.now();
      return { wallMs: Math.round(t1 - t0), scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, steps: Math.ceil(max/step)*2 };
    })()`)

    // Fast flick: no settle between steps, the trackpad-flick case where
    // viewport churn and decoration rebuilds bunch into the same frames.
    await evaluate(`(() => { window.__m.frames.length = 0; window.__sc.scrollTop = 0; return true })()`)
    await sleep(500)
    await evaluate(`(() => { window.__m.frames.length = 0; window.__flickT0 = performance.now(); return true })()`)
    const flick = await evaluate(`(async () => {
      const sc = window.__sc;
      const max = sc.scrollHeight - sc.clientHeight;
      const step = Math.max(120, Math.round(sc.clientHeight * 0.35));
      const raf = () => new Promise(r => requestAnimationFrame(r));
      const t0 = performance.now();
      for (let y = 0; y <= max; y += step) { sc.scrollTop = y; await raf(); }
      for (let y = max; y >= 0; y -= step) { sc.scrollTop = y; await raf(); }
      const f = window.__m.frames.filter(x => x > 0).sort((a,b)=>a-b);
      const pct = (p) => f.length ? Math.round(f[Math.floor(f.length*p)]*10)/10 : 0;
      return { wallMs: Math.round(performance.now()-t0), frameCount: f.length,
        p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
        worst: Math.round((f[f.length-1]||0)*10)/10, janky: f.filter(x => x > 33).length };
    })()`)
    result.flick = flick
    await evaluate(`(() => { window.__m.frames.length = 0; return true })()`)

    // Typing latency: click into the middle of the doc and time keystroke -> paint.
    const typing = await (async () => {
      await evaluate(`(() => {
        const sc = window.__sc;
        sc.scrollTop = Math.round(sc.scrollHeight / 2);
        return true;
      })()`)
      await sleep(600)
      await evaluate(`(() => {
        const line = [...document.querySelectorAll('.cm-line')][8];
        if (!line) return false;
        const r = line.getBoundingClientRect();
        window.__typeTarget = { x: r.left + 40, y: r.top + r.height / 2 };
        return true;
      })()`)
      const t = await evaluate(`window.__typeTarget`)
      if (t) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await client.send('Input.dispatchMouseEvent', { type, x: t.x, y: t.y, button: 'left', clickCount: 1 })
          await sleep(40)
        }
      }
      await sleep(400)
      const samples = []
      for (const ch of 'performance benchmark typing sample text here') {
        const t0 = Date.now()
        await client.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch })
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
        await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => 1)`)
        samples.push(Date.now() - t0)
        await sleep(15)
      }
      samples.sort((a, b) => a - b)
      return {
        keys: samples.length,
        p50: samples[Math.floor(samples.length * 0.5)],
        p95: samples[Math.floor(samples.length * 0.95)],
        max: samples[samples.length - 1]
      }
    })()
    result.typing = typing

    await sleep(800)
    const m = await evaluate(`(() => { cancelAnimationFrame(window.__rafId); window.__mo.disconnect(); window.__mo2.disconnect();
      const f = window.__m.frames.filter(x => x > 0).sort((a,b)=>a-b);
      const pct = (p) => f.length ? Math.round(f[Math.floor(f.length*p)] * 10)/10 : 0;
      const L = window.__m.loadMs.slice().sort((a,b)=>a-b);
      const lp = (p) => L.length ? L[Math.floor(L.length*p)] : 0;
      return { imgReusedFromCache: window.__m.figAdded - window.__m.freshNodes,
        imgLoads: L.length, imgLoadP50: lp(0.5), imgLoadP95: lp(0.95), imgLoadMax: L[L.length-1] || 0,
        imgLoadInstant: L.filter(x => x === 0).length,
        imgWidgetAdds: window.__m.figAdded, imgWidgetRemoves: window.__m.figRemoved,
        freshImgNodes: window.__m.freshNodes,
        liveImgNow: document.querySelectorAll('img.local-image-embed-image').length,
        frameCount: f.length, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), worst: Math.round((f[f.length-1]||0)*10)/10,
        janky: f.filter(x => x > 33).length, longTasks: window.__m.longTasks };
    })()`)

    result.scroll = stats
    result.frames = m
    result.assetRequestsDuringScroll = assetRequests.length - baseline.assetRequests
    result.assetRequestsTotal = assetRequests.length
    result.assetResponses = served.length
    result.assetFromCache = served.filter((s) => s.fromCache).length
    result.assetStatus200 = served.filter((s) => s.status === 200).length
    result.assetStatus304 = served.filter((s) => s.status === 304).length
    result.assetBytesTransferred = assetBytes
    result.uniqueAssets = new Set(assetRequests.map((a) => a.url)).size
    const perAsset = {}
    for (const a of assetRequests) {
      const k = a.url.split('/').pop()
      perAsset[k] = (perAsset[k] || 0) + 1
    }
    result.requestsPerAsset = perAsset
  } finally {
    client?.close()
    child.kill('SIGTERM')
    await sleep(500)
    try { child.kill('SIGKILL') } catch {}
  }
  await writeFile(outPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
