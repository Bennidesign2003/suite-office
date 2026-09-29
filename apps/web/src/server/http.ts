import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientMessage } from '../shared/protocol'
import { app } from './electron/app'
import {
  BrowserWindow,
  rootConn,
  scheduleLayout,
  state,
  type WebContents,
} from './electron/contents'
import { dispatchInvoke, dispatchSend } from './electron/ipc'
import { acceleratorList, acceleratorPressed, menuChosen } from './electron/menu'
import { nativeTheme } from './electron/misc'
import { fileResponse, schemeHandler } from './electron/protocol'
import { Conn, decodeClientMessage } from './hub'
import { runOp, uploadRoot } from './ops'
import {
  APP_SCHEME,
  fsPathFromUrlPath,
  handledSchemes,
  isServableFsPath,
  protoRequestUrl,
} from './urls'

export interface ServerConfig {
  port: number
  contentPort: number
  host: string
  /** hostnames the browser may use to reach us (DNS-rebinding guard) */
  allowedHosts: Set<string>
  clientBundle: string
  shellDir: string
  /** changes on every server start; pages served by an earlier run reload */
  bootId: string
}

function hostOk(req: IncomingMessage, config: ServerConfig): boolean {
  const host = (req.headers.host ?? '')
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  return config.allowedHosts.has(host)
}

function originOk(req: IncomingMessage, config: ServerConfig): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const u = new URL(origin)
    return (
      config.allowedHosts.has(u.hostname.replace(/^\[|\]$/g, '').toLowerCase()) &&
      Number(u.port || 80) === config.port
    )
  } catch {
    return false
  }
}

async function sendResponse(
  res: ServerResponse,
  response: Response,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  res.writeHead(response.status, { ...headers, ...extraHeaders })
  if (!response.body) {
    res.end()
    return
  }
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    res,
  ).catch(() => undefined)
}

function injectRuntime(html: string, wcId: number): string {
  const tags =
    `<script src="/__suite/runtime.js"></script>` +
    `<script src="/__suite/preload.js?wc=${wcId}"></script>`
  const m = /<head[^>]*>/i.exec(html)
  if (m) return html.slice(0, m.index + m[0].length) + tags + html.slice(m.index + m[0].length)
  return tags + html
}

let contentPort = 0

/** a page's CSP names Electron schemes (frame-src html-preview:); the browser
 * reaches those through the content port */
function rewriteCsp(html: string): string {
  return html.replace(/(<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>)/gi, (tag) =>
    tag.replace(/([a-z][a-z0-9+.-]*):(?=[\s;"'])/gi, (token, scheme: string) => {
      const lower = scheme.toLowerCase()
      if (!handledSchemes.has(lower)) return token
      return lower === APP_SCHEME ? "'self'" : `http://*:${contentPort}`
    }),
  )
}

async function maybeInject(response: Response, url: URL): Promise<Response> {
  const wc = Number(url.searchParams.get('__wc'))
  const type = response.headers.get('content-type') ?? ''
  if (!wc || !/text\/html/i.test(type) || response.status !== 200) return response
  const html = injectRuntime(rewriteCsp(await response.text()), wc)
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // the app frames itself (editor tabs); nothing else may
      'content-security-policy': "frame-ancestors 'self'",
    },
  })
}

function requestFromIncoming(req: IncomingMessage, url: string): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key === 'host' || key === 'connection') continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  return new Request(url, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers })
}

function wrapPreload(source: string): string {
  return (
    '(function(){var module={exports:{}},exports=module.exports;' +
    "var require=function(n){if(n==='electron')return window.__suiteElectron;" +
    "throw new Error('preload cannot require '+n)};" +
    'var process=window.__suiteProcess;\n' +
    source +
    '\n})();'
  )
}

async function waitForRoot(timeoutMs: number): Promise<BrowserWindow | null> {
  const deadline = Date.now() + timeoutMs
  let activated = false
  while (Date.now() < deadline) {
    const root = state.root
    if (root && !root.isDestroyed() && root.webContents.url) return root
    if (app.isReady() && !activated && !root) {
      activated = true
      app.emit('activate', {}, false)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

const STARTING_PAGE = `<!doctype html><html lang="de"><meta charset="utf-8"><title>Suite</title>
<meta http-equiv="refresh" content="1"><body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>Suite startet …</p></body></html>`

async function handleApp(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local')
  const path = url.pathname

  if (path === '/' || path === '/index.html') {
    const root = await waitForRoot(15_000)
    if (!root) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
      res.end(STARTING_PAGE)
      return
    }
    res.writeHead(302, { location: root.webContents.clientUrl(), 'cache-control': 'no-store' })
    res.end()
    return
  }

  if (path === '/favicon.ico') {
    const icon = join(config.shellDir, 'build', 'icon.png')
    if (!existsSync(icon)) {
      res.writeHead(204).end()
      return
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' })
    res.end(readFileSync(icon))
    return
  }

  if (path === '/__suite/runtime.js') {
    const cfg = {
      boot: config.bootId,
      contentPort: config.contentPort,
      schemes: [...handledSchemes],
      appScheme: APP_SCHEME,
      platform: process.platform,
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(
      `window.__SUITE_CFG=${JSON.stringify(cfg)};\n` + readFileSync(config.clientBundle, 'utf8'),
    )
    return
  }

  if (path === '/__suite/preload.js') {
    const wc = state.contents.get(Number(url.searchParams.get('wc')))
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    })
    if (!wc?.preload || !existsSync(wc.preload)) {
      res.end('')
      return
    }
    res.end(wrapPreload(readFileSync(wc.preload, 'utf8')))
    return
  }

  if (path === '/__suite/upload' && req.method === 'POST') {
    if (!originOk(req, config)) {
      res.writeHead(403).end()
      return
    }
    const dir = resolve(url.searchParams.get('dir') ?? '')
    const name = basename(url.searchParams.get('name') ?? '')
    const root = uploadRoot()
    if (url.searchParams.get('mkdir') === '1' && dir.startsWith(root + sep)) {
      mkdirSync(dir, { recursive: true })
    }
    if (!name || !existsSync(dir) || !statSync(dir).isDirectory()) {
      res.writeHead(400).end()
      return
    }
    const target = join(dir, name)
    await pipeline(req, createWriteStream(target))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: target }))
    return
  }

  if (path.startsWith('/__fs/')) {
    const file = fsPathFromUrlPath(path)
    if (!file || !isServableFsPath(file)) {
      res.writeHead(404).end()
      return
    }
    const response = await maybeInject(
      fileResponse(file, requestFromIncoming(req, 'file://' + file)),
      url,
    )
    await sendResponse(res, response)
    return
  }

  if (path.startsWith(`/__proto/${APP_SCHEME}/`)) {
    await serveProto(req, res, url, true)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
}

async function serveProto(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  appPort: boolean,
  cors?: string,
): Promise<void> {
  const target = protoRequestUrl(url.pathname + url.search)
  if (!target || (target.scheme === APP_SCHEME) !== appPort) {
    res.writeHead(404).end()
    return
  }
  const handler = schemeHandler(target.scheme)
  if (!handler) {
    res.writeHead(404).end()
    return
  }
  // the marker belongs to the bridge, not to the page's own URL
  const handlerUrl = new URL(target.url)
  handlerUrl.searchParams.delete('__wc')
  let response: Response
  try {
    response = await handler(requestFromIncoming(req, handlerUrl.toString().replace(/\?$/, '')))
  } catch (err) {
    console.warn(`[web] ${target.scheme} handler failed:`, err)
    response = new Response(null, { status: 500 })
  }
  if (appPort) response = await maybeInject(response, url)
  await sendResponse(
    res,
    response,
    cors ? { 'access-control-allow-origin': cors, vary: 'origin' } : {},
  )
}

function handleContent(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local')
  const origin = req.headers.origin
  let cors: string | undefined
  if (origin) {
    try {
      const u = new URL(origin)
      if (config.allowedHosts.has(u.hostname) && Number(u.port || 80) === config.port) cors = origin
    } catch {
      cors = undefined
    }
  }
  if (!url.pathname.startsWith('/__proto/')) {
    res.writeHead(404).end()
    return Promise.resolve()
  }
  return serveProto(req, res, url, false, cors)
}

// ---- sockets ----

function handleSocket(ws: WebSocket, config: ServerConfig): void {
  let conn: Conn | null = null
  let wc: WebContents | null = null

  const reply = (id: number, work: () => unknown): void => {
    Promise.resolve()
      .then(work)
      .then(
        (v) => conn?.send({ t: 'ret', id, ok: true, v }),
        (err: unknown) =>
          conn?.send({
            t: 'ret',
            id,
            ok: false,
            e: err instanceof Error ? err.message : String(err),
          }),
      )
  }

  ws.on('message', (data) => {
    let msg: ClientMessage
    try {
      msg = decodeClientMessage(data as Buffer)
    } catch (err) {
      console.warn('[web] bad frame:', err)
      return
    }
    if (msg.t === 'hello') {
      wc = state.contents.get(msg.wc) ?? null
      if (!wc || wc.isDestroyed() || msg.boot !== config.bootId) {
        // a page from before a server restart, or of a closed tab
        const stale = new Conn(ws, msg.wc, msg.page, msg.top)
        stale.send({ t: 'gone', reason: msg.top ? 'restart' : 'closed' })
        ws.close()
        return
      }
      conn = new Conn(ws, wc.id, msg.page, msg.top)
      wc.attach(conn)
      conn.send({ t: 'accels', list: acceleratorList() })
      conn.send({ t: 'theme', source: nativeTheme.themeSource })
      if (state.root && wc === state.root.webContents) {
        state.screen = { ...msg.screen }
        state.dpr = msg.dpr
        nativeTheme.setSystemDark(msg.dark)
        state.root.clientResized(msg.size.w, msg.size.h)
        state.focusedContents ??= wc
        const waiting = state.onRootConnected.splice(0)
        for (const done of waiting) done()
        scheduleLayout()
      } else if (wc.hostWindow && wc.backend !== 'headless') {
        wc.hostWindow.clientResized(msg.size.w, msg.size.h)
      }
      return
    }
    if (!conn || !wc) return
    const sender = wc
    switch (msg.t) {
      case 'invoke':
        reply(msg.id, () => dispatchInvoke(sender, msg.ch, msg.args))
        return
      case 'send':
        dispatchSend(sender, msg.ch, msg.args)
        return
      case 'res':
        conn.settle(msg)
        return
      case 'suite':
        reply(msg.id, () => runOp(msg.op, msg.args))
        return
      case 'accel':
        acceleratorPressed(msg.accel, sender)
        return
      case 'menu':
        menuChosen(msg.id, msg.item)
        return
      case 'ev':
        handleEvent(sender, msg)
        return
      default:
        return
    }
  })

  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping()
  }, 30_000)
  ws.on('close', () => {
    clearInterval(ping)
    if (conn && wc) wc.detach(conn)
  })
  ws.on('error', () => undefined)
}

function handleEvent(wc: WebContents, msg: Extract<ClientMessage, { t: 'ev' }>): void {
  switch (msg.name) {
    case 'dom-ready':
    case 'load':
      wc.pageEvent(msg.name, false)
      return
    case 'focus': {
      state.focusedContents = wc
      const win = BrowserWindow.fromWebContents(wc)
      if (win && state.focusedWindow !== win) win.focus()
      wc.emit('focus')
      return
    }
    case 'blur':
      wc.emit('blur')
      return
    case 'resize':
      if (state.root && wc === state.root.webContents) {
        state.root.clientResized(msg.size.w, msg.size.h)
        scheduleLayout()
      }
      return
    case 'fullscreen':
      wc.emit(msg.on ? 'enter-html-full-screen' : 'leave-html-full-screen')
      return
    case 'title':
      wc.title = msg.title
      wc.emit('page-title-updated', { preventDefault: () => undefined }, msg.title, true)
      return
    case 'window-open':
      wc.handleWindowOpen(msg.url, msg.frameName, msg.features)
      return
    case 'window-close': {
      const target = state.contents.get(msg.wc)
      target?.hostWindow?.close()
      return
    }
    case 'unload':
      return
    default:
      return
  }
}

export interface RunningServer {
  app: Server
  content: Server
}

export function startServers(config: ServerConfig): Promise<RunningServer> {
  contentPort = config.contentPort
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 * 1024 })
  wss.on('connection', (ws: WebSocket) => handleSocket(ws, config))

  const appServer = createServer((req, res) => {
    if (!hostOk(req, config)) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end('unknown host')
      return
    }
    handleApp(req, res, config).catch((err) => {
      console.error('[web] request failed:', req.url, err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  appServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname !== '/__suite/ws' || !hostOk(req, config) || !originOk(req, config)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  const contentServer = createServer((req, res) => {
    if (!hostOk(req, config)) {
      res.writeHead(421).end()
      return
    }
    handleContent(req, res, config).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  const listen = (server: Server, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, config.host, () => resolve())
    })

  return listen(appServer, config.port)
    .then(() => listen(contentServer, config.contentPort))
    .then(() => ({ app: appServer, content: contentServer }))
}

export { rootConn }
