import type { FileDialogRequest, MessageBoxRequest, ServerMessage } from '../shared/protocol'
import { Bridge } from './bridge'
import { createElectron } from './electron'
import { Host } from './host'
import { installAccelerators } from './keys'
import { installUrlRewriting } from './rewrite'
import { takeSnapshot } from './snapshot'
import { linkToast, setBanner, showFileDialog, showMenu, showMessageBox, toast } from './ui'

/**
 * Injected ahead of every page the Suite server hosts (the shell, each editor
 * tab, secondary and hidden windows). It stands in for what Electron gave a
 * renderer: the preload's `electron` module, main-process requests (run
 * script, print, snapshot …) and window chrome. The root page additionally
 * hosts the editor tabs and draws dialogs and menus.
 */

;(function boot() {
  if (window.__suiteBridge) return
  const cfg = window.__SUITE_CFG
  const params = new URLSearchParams(location.search)
  const fromName = /^__suite_wc:(\d+)$/.exec(window.name)?.[1]
  const wcId = Number(params.get('__wc') ?? fromName ?? 0)
  if (!wcId) return
  window.name = `__suite_wc:${wcId}`
  const top = window.parent === window

  const bridge = new Bridge(wcId, top, cfg)
  window.__suiteBridge = bridge
  window.__suiteProcess = {
    env: {},
    platform: cfg.platform,
    versions: {},
    type: 'renderer',
    argv: [],
    cwd: () => '/',
  }
  document.documentElement.dataset.suiteWeb = '1'

  let uploadDir: Promise<string> | null = null
  window.__suiteElectron = createElectron(
    bridge,
    () => (uploadDir ??= bridge.op<string>('uploadDir')),
  )

  installUrlRewriting(cfg)
  const setAccelerators = installAccelerators((accel) => bridge.post({ t: 'accel', accel }))
  const host = top ? new Host(bridge) : null

  // ---- page lifecycle → webContents events ----
  const ready = (): void => bridge.post({ t: 'ev', name: 'dom-ready' })
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', ready, { once: true })
  else ready()
  const loaded = (): void => bridge.post({ t: 'ev', name: 'load' })
  if (document.readyState === 'complete') loaded()
  else window.addEventListener('load', loaded, { once: true })

  window.addEventListener('focus', () => bridge.post({ t: 'ev', name: 'focus' }))
  window.addEventListener('pointerdown', () => bridge.post({ t: 'ev', name: 'focus' }), true)
  window.addEventListener('blur', () => bridge.post({ t: 'ev', name: 'blur' }))
  if (top) {
    let pending = 0
    window.addEventListener('resize', () => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() =>
        bridge.post({ t: 'ev', name: 'resize', size: { w: innerWidth, h: innerHeight } }),
      )
    })
    window.addEventListener('beforeunload', (e) => {
      if (!host?.hasOpenTabs()) return
      e.preventDefault()
      e.returnValue = ''
    })
  } else {
    const report = (e: MouseEvent): void => {
      try {
        window.parent.postMessage({ suitePointer: { x: e.clientX, y: e.clientY } }, '*')
      } catch {
        // detached
      }
    }
    window.addEventListener('pointerdown', report, true)
    window.addEventListener('contextmenu', report, true)
  }
  document.addEventListener('fullscreenchange', () =>
    bridge.post({ t: 'ev', name: 'fullscreen', on: !!document.fullscreenElement }),
  )
  let lastTitle = ''
  const reportTitle = (): void => {
    if (document.title === lastTitle) return
    lastTitle = document.title
    bridge.post({ t: 'ev', name: 'title', title: lastTitle })
  }
  new MutationObserver(reportTitle).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  })

  // ---- leaving the page: links and window.open ----
  const nativeOpen = window.open.bind(window)
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const href = url === undefined ? '' : String(url)
    if (!href || href === 'about:blank') return nativeOpen(href, target, features)
    let parsed: URL | null
    try {
      parsed = new URL(href, location.href)
    } catch {
      parsed = null
    }
    if (parsed && /^(https?|mailto):$/.test(parsed.protocol) && parsed.origin !== location.origin) {
      return nativeOpen(parsed.href, '_blank', 'noopener')
    }
    bridge.post({
      t: 'ev',
      name: 'window-open',
      url: href,
      frameName: target ?? '',
      features: features ?? '',
    })
    return null
  }) as typeof window.open

  window.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || a.hasAttribute('download')) return
    let url: URL
    try {
      url = new URL(a.href, location.href)
    } catch {
      return
    }
    if (!/^(https?|mailto):$/.test(url.protocol) || url.origin === location.origin) return
    e.preventDefault()
    nativeOpen(url.href, '_blank', 'noopener')
  })

  // ---- requests from the main process ----
  const insertedCss = new Map<string, HTMLStyleElement>()

  const handleRequest = async (kind: string, data: unknown): Promise<unknown> => {
    switch (kind) {
      case 'eval': {
        const result = (0, eval)(String(data)) as unknown
        return await result
      }
      case 'insert-css': {
        const key = Math.random().toString(36).slice(2)
        const style = document.createElement('style')
        style.textContent = String(data)
        document.head.appendChild(style)
        insertedCss.set(key, style)
        return key
      }
      case 'remove-css':
        insertedCss.get(String(data))?.remove()
        insertedCss.delete(String(data))
        return undefined
      case 'edit': {
        const [command, value] = Array.isArray(data) ? data : [data]
        if (command === 'unselect') window.getSelection()?.removeAllRanges()
        else document.execCommand(String(command), false, value as string | undefined)
        return undefined
      }
      case 'zoom':
        document.documentElement.style.zoom = String(data)
        return undefined
      case 'snapshot':
        return takeSnapshot()
      case 'print':
        window.print()
        return undefined
      case 'fullscreen':
        if (data) await document.documentElement.requestFullscreen?.().catch(() => undefined)
        else if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined)
        return undefined
      case 'clipboard-write': {
        const { text, html } = (data ?? {}) as { text?: string; html?: string }
        if (html && typeof ClipboardItem !== 'undefined') {
          const item = new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([text ?? html.replace(/<[^>]+>/g, '')], { type: 'text/plain' }),
          })
          await navigator.clipboard.write([item]).catch(() => undefined)
        } else if (text !== undefined) {
          await navigator.clipboard.writeText(text).catch(() => undefined)
        }
        return undefined
      }
      case 'focus-frame':
        host?.focusFrame(Number(data))
        return undefined
      case 'message-box':
        return showMessageBox(data as MessageBoxRequest)
      case 'file-dialog':
        return showFileDialog(data as FileDialogRequest, (op, ...args) => bridge.op(op, ...args))
      default:
        throw new Error(`unsupported request ${kind}`)
    }
  }

  const onMessage = (msg: ServerMessage): void => {
    switch (msg.t) {
      case 'req':
        handleRequest(msg.kind, msg.data).then(
          (v) => {
            if (msg.id) bridge.postNow({ t: 'res', id: msg.id, ok: true, v })
          },
          (err: unknown) => {
            if (msg.id) {
              bridge.postNow({
                t: 'res',
                id: msg.id,
                ok: false,
                e: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
              })
            }
          },
        )
        return
      case 'accels':
        setAccelerators(msg.list)
        return
      case 'views':
        host?.setViews(msg.list)
        return
      case 'windows':
        host?.setWindows(msg.list)
        return
      case 'menu': {
        const x = msg.x ?? host?.lastPointer.x ?? 100
        const y = msg.y ?? host?.lastPointer.y ?? 60
        void showMenu(msg.items, x, y).then((item) => bridge.post({ t: 'menu', id: msg.id, item }))
        return
      }
      case 'nav':
        location.replace(msg.url)
        return
      case 'reload':
        location.reload()
        return
      case 'focus':
        window.focus()
        return
      case 'open': {
        const win = nativeOpen(msg.url, '_blank', 'noopener')
        if (!win) linkToast('Der Browser hat ein neues Fenster blockiert.', msg.url, 'Öffnen')
        return
      }
      case 'toast':
        toast(msg.text)
        return
      case 'download': {
        const a = document.createElement('a')
        a.href = msg.url
        a.download = msg.name
        document.body.appendChild(a)
        a.click()
        a.remove()
        return
      }
      case 'title':
        document.title = msg.title
        return
      default:
        return
    }
  }
  bridge.on(onMessage)

  if (top) {
    bridge.onReconnecting = (on) =>
      setBanner(on ? 'Verbindung zum Suite-Server unterbrochen – verbinde neu …' : null)
    bridge.onGone = (reason) => {
      if (reason === 'restart') {
        location.href = '/'
        return
      }
      if (reason === 'moved') {
        setBanner('Suite ist in einem anderen Browser-Tab geöffnet.', {
          label: 'Hierher holen',
          run: () => location.reload(),
        })
        return
      }
      if (reason === 'quit') {
        setBanner('Suite wurde beendet.')
        return
      }
      setBanner('Das Fenster wurde geschlossen.', {
        label: 'Neu öffnen',
        run: () => (location.href = '/'),
      })
    }
  }
})()
