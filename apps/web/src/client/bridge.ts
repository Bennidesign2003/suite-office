import { decode, encode } from '../shared/codec'
import type { ClientMessage, ServerMessage } from '../shared/protocol'

/**
 * The page's end of the socket: request/response bookkeeping, reconnects,
 * and the ordering guarantee Electron IPC gives (messages leave in the order
 * they were sent — including behind files still uploading for
 * webUtils.getPathForFile).
 */

export interface SuiteConfig {
  boot: string
  contentPort: number
  schemes: string[]
  appScheme: string
  platform: string
}

declare global {
  interface Window {
    __SUITE_CFG: SuiteConfig
    __suiteElectron: unknown
    __suiteProcess: unknown
    __suiteBridge?: Bridge
  }
}

type Handler = (msg: ServerMessage) => void

export class Bridge {
  private ws: WebSocket | null = null
  private queue: ClientMessage[] = []
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private readonly handlers: Handler[] = []
  private gone = false
  private retryDelay = 250
  private barrier: Promise<unknown> = Promise.resolve()
  private flushing = false
  readonly page = Math.random().toString(36).slice(2) + Date.now().toString(36)
  onReconnecting: ((on: boolean) => void) | null = null
  onGone: ((reason: string) => void) | null = null

  constructor(
    readonly wcId: number,
    readonly top: boolean,
    readonly cfg: SuiteConfig,
  ) {
    this.connect()
  }

  private hello(): ClientMessage {
    return {
      t: 'hello',
      wc: this.wcId,
      page: this.page,
      boot: this.cfg.boot,
      top: this.top,
      url: location.href,
      size: { w: innerWidth, h: innerHeight },
      screen: { w: screen.width, h: screen.height },
      dpr: devicePixelRatio || 1,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
    }
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/__suite/ws`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.retryDelay = 250
      this.onReconnecting?.(false)
      ws.send(encode(this.hello()))
      this.flush()
    }
    ws.onmessage = (event) => {
      let msg: ServerMessage
      try {
        msg = decode(new Uint8Array(event.data as ArrayBuffer)) as ServerMessage
      } catch (err) {
        console.error('[suite] bad frame', err)
        return
      }
      this.dispatch(msg)
    }
    ws.onclose = () => {
      this.ws = null
      // replies to in-flight requests died with the socket
      for (const waiter of this.pending.values())
        waiter.reject(new Error('Verbindung zum Suite-Server verloren.'))
      this.pending.clear()
      if (this.gone) return
      this.onReconnecting?.(true)
      setTimeout(() => this.connect(), this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 4000)
    }
  }

  private dispatch(msg: ServerMessage): void {
    if (msg.t === 'ret') {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.ok) waiter.resolve(msg.v)
      else waiter.reject(new Error(msg.e ?? 'Fehler'))
      return
    }
    if (msg.t === 'gone') {
      this.gone = true
      this.ws?.close()
      this.onGone?.(msg.reason)
    }
    for (const handler of this.handlers) {
      try {
        handler(msg)
      } catch (err) {
        console.error('[suite] handler failed', err)
      }
    }
  }

  on(handler: Handler): void {
    this.handlers.push(handler)
  }

  /** hold outgoing messages until `work` settles (file uploads) */
  holdUntil(work: Promise<unknown>): void {
    this.barrier = Promise.all([this.barrier, work.catch(() => undefined)])
  }

  post(msg: ClientMessage): void {
    this.queue.push(msg)
    this.flush()
  }

  /** replies to server requests bypass the upload barrier */
  postNow(msg: ClientMessage): void {
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg))
    else this.queue.unshift(msg)
  }

  private flush(): void {
    if (this.flushing) return
    this.flushing = true
    const barrier = this.barrier
    void barrier.then(() => {
      this.flushing = false
      if (barrier !== this.barrier) {
        this.flush()
        return
      }
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const queued = this.queue
      this.queue = []
      for (const msg of queued) {
        try {
          ws.send(encode(msg))
        } catch (err) {
          const id = (msg as { id?: number }).id
          const waiter = id !== undefined ? this.pending.get(id) : undefined
          if (waiter) {
            this.pending.delete(id!)
            waiter.reject(err instanceof Error ? err : new Error(String(err)))
          } else console.error('[suite] could not send', err)
        }
      }
    })
  }

  call(
    msg: { t: 'invoke'; ch: string; args: unknown[] } | { t: 'suite'; op: string; args: unknown[] },
  ): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.post({ ...msg, id } as ClientMessage)
    })
  }

  op<T = unknown>(op: string, ...args: unknown[]): Promise<T> {
    return this.call({ t: 'suite', op, args }) as Promise<T>
  }
}
