import type { Bridge } from './bridge'

/**
 * What a preload script gets from `require('electron')` in the browser:
 * ipcRenderer over the bridge, contextBridge as plain window properties, and
 * webUtils.getPathForFile backed by an upload to the server (the browser
 * never reveals where a dropped file lives).
 */

type Listener = (event: unknown, ...args: unknown[]) => void

export function createElectron(bridge: Bridge, uploadDir: () => Promise<string>) {
  const listeners = new Map<string, Set<Listener>>()
  const onceWrappers = new WeakMap<Listener, Listener>()

  const ipcRenderer = {
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      return bridge.call({ t: 'invoke', ch: channel, args })
    },
    send(channel: string, ...args: unknown[]): void {
      bridge.post({ t: 'send', ch: channel, args })
    },
    sendSync(channel: string): never {
      throw new Error(`ipcRenderer.sendSync('${channel}') is not available on the web`)
    },
    sendToHost(): void {},
    postMessage(channel: string, message: unknown): void {
      bridge.post({ t: 'send', ch: channel, args: [message] })
    },
    on(channel: string, listener: Listener) {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener)
      return ipcRenderer
    },
    addListener(channel: string, listener: Listener) {
      return ipcRenderer.on(channel, listener)
    },
    once(channel: string, listener: Listener) {
      const wrapper: Listener = (event, ...args) => {
        ipcRenderer.removeListener(channel, wrapper)
        listener(event, ...args)
      }
      onceWrappers.set(listener, wrapper)
      return ipcRenderer.on(channel, wrapper)
    },
    removeListener(channel: string, listener: Listener) {
      const set = listeners.get(channel)
      set?.delete(listener)
      const wrapper = onceWrappers.get(listener)
      if (wrapper) set?.delete(wrapper)
      return ipcRenderer
    },
    off(channel: string, listener: Listener) {
      return ipcRenderer.removeListener(channel, listener)
    },
    removeAllListeners(channel?: string) {
      if (channel) listeners.delete(channel)
      else listeners.clear()
      return ipcRenderer
    },
    listenerCount(channel: string): number {
      return listeners.get(channel)?.size ?? 0
    },
  }

  bridge.on((msg) => {
    if (msg.t !== 'ipc') return
    const set = listeners.get(msg.ch)
    if (!set) return
    const event = { sender: ipcRenderer, senderId: 0, ports: [] }
    for (const listener of [...set]) {
      try {
        listener(event, ...msg.args)
      } catch (err) {
        console.error(`[suite] listener for '${msg.ch}' threw`, err)
      }
    }
  })

  const contextBridge = {
    exposeInMainWorld(key: string, api: unknown): void {
      ;(window as unknown as Record<string, unknown>)[key] = api
    },
    exposeInIsolatedWorld(_worldId: number, key: string, api: unknown): void {
      ;(window as unknown as Record<string, unknown>)[key] = api
    },
    executeInMainWorld(options: { func: (...a: unknown[]) => unknown; args?: unknown[] }): unknown {
      return options.func(...(options.args ?? []))
    },
  }

  const uploaded = new WeakMap<File, string>()
  const webUtils = {
    getPathForFile(file: File): string {
      const known = uploaded.get(file)
      if (known !== undefined) return known
      if (!(file instanceof File) || !file.name) return ''
      const folder = Math.random().toString(36).slice(2, 10)
      // the path must be known synchronously; the bytes follow, and every IPC
      // message waits behind them so the main process never reads early
      const base = cachedUploadDir
      if (!base) return ''
      const sep = base.includes('\\') ? '\\' : '/'
      const dir = base + sep + folder
      const path = dir + sep + file.name
      uploaded.set(file, path)
      const upload = fetch(
        `/__suite/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}&mkdir=1`,
        { method: 'POST', body: file },
      ).then((r) => {
        if (!r.ok) throw new Error(`upload failed (${r.status})`)
      })
      bridge.holdUntil(upload)
      return path
    },
  }

  let cachedUploadDir = ''
  void uploadDir().then((dir) => {
    cachedUploadDir = dir
  })

  const webFrame = {
    setZoomFactor(factor: number) {
      document.body.style.zoom = String(factor)
    },
    getZoomFactor: () => Number(document.body.style.zoom || 1),
    setZoomLevel: () => undefined,
    getZoomLevel: () => 0,
    setVisualZoomLevelLimits: () => Promise.resolve(),
    setSpellCheckProvider: () => undefined,
    insertCSS(css: string) {
      const style = document.createElement('style')
      style.textContent = css
      document.head.appendChild(style)
      return ''
    },
    clearCache: () => undefined,
  }

  return { ipcRenderer, contextBridge, webUtils, webFrame }
}
