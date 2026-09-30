import type { WebSocket } from 'ws'
import { decode, encode } from '../shared/codec'
import type { ClientMessage, ServerMessage } from '../shared/protocol'

/** One browser page's socket. Requests from the server (dialogs, eval …)
 * resolve through `res` messages; a dropped socket fails them all. */
export class Conn {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  closed = false

  constructor(
    readonly ws: WebSocket,
    readonly wcId: number,
    readonly page: string,
    readonly top: boolean,
  ) {}

  send(msg: ServerMessage): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return
    try {
      this.ws.send(encode(msg))
    } catch (err) {
      console.warn('[web] could not send to page:', err)
    }
  }

  request<T = unknown>(kind: string, data: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The page went away.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.send({ t: 'req', id, kind, data })
    })
  }

  settle(msg: Extract<ClientMessage, { t: 'res' }>): void {
    const waiter = this.pending.get(msg.id)
    if (!waiter) return
    this.pending.delete(msg.id)
    if (msg.ok) waiter.resolve(msg.v)
    else waiter.reject(new Error(msg.e ?? 'request failed'))
  }

  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason))
    this.pending.clear()
  }
}

export function decodeClientMessage(data: Buffer | ArrayBuffer | Buffer[]): ClientMessage {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data
  return decode(bytes, {
    wrapBytes: (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  }) as ClientMessage
}
