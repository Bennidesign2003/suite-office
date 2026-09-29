import { EventEmitter } from 'node:events'
import type { WebContents } from './contents'

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown

export interface IpcEvent {
  sender: WebContents
  senderFrame: Record<string, unknown>
  frameId: number
  processId: number
  type: 'frame'
  ports: unknown[]
  returnValue: unknown
  defaultPrevented: boolean
  preventDefault(): void
  reply(channel: string, ...args: unknown[]): void
}

class IpcMain extends EventEmitter {
  private readonly handlers = new Map<string, Handler>()

  constructor() {
    super()
    this.setMaxListeners(0)
  }

  handle(channel: string, handler: Handler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, handler)
  }

  handleOnce(channel: string, handler: Handler): void {
    this.handle(channel, (event, ...args) => {
      this.removeHandler(channel)
      return handler(event, ...args)
    })
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  handlerFor(channel: string): Handler | undefined {
    return this.handlers.get(channel)
  }
}

export const ipcMain = new IpcMain()

export function makeEvent(sender: WebContents): IpcEvent {
  let prevented = false
  return {
    sender,
    senderFrame: sender.mainFrame,
    frameId: 1,
    processId: sender.id,
    type: 'frame',
    ports: [],
    returnValue: undefined,
    get defaultPrevented() {
      return prevented
    },
    preventDefault() {
      prevented = true
    },
    reply(channel: string, ...args: unknown[]) {
      sender.send(channel, ...args)
    },
  }
}

/** ipcRenderer.invoke → ipcMain.handle, with Electron's error wording */
export async function dispatchInvoke(
  sender: WebContents,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  const handler = ipcMain.handlerFor(channel)
  if (!handler) throw new Error(`No handler registered for '${channel}'`)
  try {
    return await handler(makeEvent(sender), ...args)
  } catch (err) {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    throw new Error(`Error invoking remote method '${channel}': ${text}`, { cause: err })
  }
}

/** ipcRenderer.send → ipcMain.on */
export function dispatchSend(sender: WebContents, channel: string, args: unknown[]): void {
  try {
    ipcMain.emit(channel, makeEvent(sender), ...args)
  } catch (err) {
    console.error(`[web] ipc listener for '${channel}' threw:`, err)
  }
}
