/**
 * Suite im Browser: runs the shell's built main process under plain Node,
 * with `electron` answered by the web shims, and serves every editor page to
 * the browser.
 *
 *   npm run web            (builds what is missing, then starts)
 *   SUITE_PORT=4317        app port; the content port is SUITE_PORT + 1
 *   SUITE_HOST=127.0.0.1   listen address (0.0.0.0 to reach it from the LAN)
 *   SUITE_PUBLIC_HOST=…    extra hostname the browser may use (with SUITE_HOST=0.0.0.0)
 *   SUITE_NO_OPEN=1        do not open a browser tab on start
 *   SUITE_CHROMIUM=/path   Chromium/Chrome for PDF export and printing
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import Module from 'node:module'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import electron from './electron/index'
import { configureApp, markAppReady } from './electron/app'
import { setLocalOnly } from './electron/misc'
import { closeHeadless } from './headless'
import { startServers } from './http'
import { setOrigins } from './urls'

const ELECTRON_ID = '\0suite-electron'

function installElectronShim(): void {
  const mod = Module as unknown as {
    _resolveFilename: (request: string, ...rest: unknown[]) => string
    _cache: Record<string, unknown>
  }
  const original = mod._resolveFilename
  mod._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === 'electron' || request === 'electron/main' || request === 'electron/common') {
      return ELECTRON_ID
    }
    return original.call(this, request, ...rest)
  }
  const shim = new Module(ELECTRON_ID) as unknown as {
    exports: unknown
    loaded: boolean
    filename: string
  }
  shim.exports = electron
  shim.loaded = true
  shim.filename = ELECTRON_ID
  mod._cache[ELECTRON_ID] = shim
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  execFile(cmd as string, args as string[], { windowsHide: true }, () => undefined)
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

async function main(): Promise<void> {
  const repo = resolve(__dirname, '..', '..', '..')
  const shellDir = join(repo, 'apps', 'shell')
  const shellMain = join(shellDir, 'out', 'main', 'index.js')
  const clientBundle = join(__dirname, 'client.js')
  if (!existsSync(shellMain)) {
    console.error('Suite ist noch nicht gebaut. Bitte zuerst `npm run build:all` ausführen.')
    process.exit(1)
  }

  const port = Number(process.env.SUITE_PORT) || 4317
  const contentPort = port + 1
  const host = process.env.SUITE_HOST || '127.0.0.1'
  const localOnly = LOOPBACK.has(host)
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1'])
  if (!localOnly) {
    allowedHosts.add(hostname().toLowerCase())
    if (host !== '0.0.0.0' && host !== '::') allowedHosts.add(host.toLowerCase())
  }
  const publicHost = process.env.SUITE_PUBLIC_HOST?.toLowerCase()
  if (publicHost) allowedHosts.add(publicHost)
  setLocalOnly(localOnly)

  const pkg = JSON.parse(readFileSync(join(shellDir, 'package.json'), 'utf8')) as {
    productName?: string
    name: string
    version: string
  }
  configureApp({ name: pkg.productName ?? pkg.name, version: pkg.version, appPath: shellDir })

  // the renderers are served from their build output, never from dev servers
  for (const key of Object.keys(process.env)) {
    if (/_RENDERER_URL$/.test(key)) delete process.env[key]
  }
  process.env.GENOFFICE_NO_SPARE_VIEW ??= '1'

  const browserHost = publicHost ?? (localOnly ? 'localhost' : hostname())
  setOrigins({
    app: '',
    content: `http://${browserHost}:${contentPort}`,
    internal: `http://127.0.0.1:${port}`,
  })

  installElectronShim()
  // Node 25+ defines a localStorage getter that warns on every read without
  // --localstorage-file; bundled browser-flavoured deps feature-test it, which
  // printed a confusing warning on each start. Nothing here needs Web Storage.
  for (const name of ['localStorage', 'sessionStorage']) {
    if (Object.getOwnPropertyDescriptor(globalThis, name)?.configurable) {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        configurable: true,
        writable: true,
      })
    }
  }
  // the shell registers its handlers and app.whenReady() continuation on load;
  // it is CommonJS built output, loaded through the patched resolver above
  Module.createRequire(__filename)(shellMain)

  await startServers({
    port,
    contentPort,
    host,
    allowedHosts,
    clientBundle,
    shellDir,
    bootId: randomUUID(),
  })
  markAppReady()

  const url = `http://${browserHost}:${port}/`
  console.log(`\n  Suite läuft im Browser:  ${url}\n`)
  if (!localOnly) {
    console.log(
      '  Achtung: der Server ist im Netzwerk erreichbar und hat vollen Zugriff auf deine Dateien.\n',
    )
  }
  if (!process.env.SUITE_NO_OPEN && localOnly) openBrowser(url)

  const shutdown = (): void => {
    void closeHeadless().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

process.on('unhandledRejection', (reason) => {
  console.error('[web] unhandled rejection:', reason)
})

main().catch((err) => {
  if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    console.error('Port belegt — läuft Suite schon? Anderen Port mit SUITE_PORT=… wählen.')
  } else {
    console.error(err)
  }
  process.exit(1)
})
