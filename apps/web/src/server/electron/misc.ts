import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toWebUrl } from '../urls'
import { notifyRoot, rootConn, state, WebContents } from './contents'
import { NativeImage } from './native-image'
import { tolerant } from './tolerant'

/** true when the server only listens on this machine, so OS actions
 * (reveal in folder, open with the default app) reach the user */
let localOnly = true

export function setLocalOnly(value: boolean): void {
  localOnly = value
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  })
}

function openWithOs(target: string): Promise<void> {
  if (process.platform === 'darwin') return run('open', [target])
  if (process.platform === 'win32') return run('cmd', ['/c', 'start', '', target])
  return run('xdg-open', [target])
}

export const shell = tolerant(
  {
    async openExternal(url: string): Promise<void> {
      notifyRoot({ t: 'open', url })
    },
    async openPath(path: string): Promise<string> {
      if (!existsSync(path)) return `File not found: ${path}`
      if (!localOnly) {
        notifyRoot({ t: 'open', url: toWebUrl(pathToFileURL(path).toString()) })
        return ''
      }
      try {
        await openWithOs(path)
        return ''
      } catch (err) {
        // no desktop session (server, container): hand it to the browser
        notifyRoot({ t: 'open', url: toWebUrl(pathToFileURL(path).toString()) })
        return err instanceof Error && !state.root ? err.message : ''
      }
    },
    showItemInFolder(path: string): void {
      const reveal = async (): Promise<void> => {
        if (!localOnly) throw new Error('remote')
        if (process.platform === 'darwin') await run('open', ['-R', path])
        else if (process.platform === 'win32') await run('explorer', [`/select,${path}`])
        else await openWithOs(dirname(path))
      }
      reveal().catch(() => notifyRoot({ t: 'toast', text: path }))
    },
    async trashItem(path: string): Promise<void> {
      if (process.platform === 'darwin') {
        const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        await run('osascript', [
          '-e',
          `tell application "Finder" to delete POSIX file "${escaped}"`,
        ])
      } else if (process.platform === 'win32') {
        const escaped = path.replace(/'/g, "''")
        await run('powershell', [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
            `if (Test-Path -LiteralPath '${escaped}' -PathType Container) ` +
            `{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${escaped}','OnlyErrorDialogs','SendToRecycleBin') } ` +
            `else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}','OnlyErrorDialogs','SendToRecycleBin') }`,
        ])
      } else {
        await run('gio', ['trash', path])
      }
    },
    beep(): void {},
    writeShortcutLink(): boolean {
      return false
    },
  },
  'shell',
)

// ---- clipboard ----

interface ClipboardData {
  text?: string
  html?: string
  rtf?: string
  image?: NativeImage
  buffers: Map<string, Buffer>
}

let board: ClipboardData = { buffers: new Map() }

function pushToBrowser(data: { text?: string; html?: string }): void {
  void rootConn().then((conn) => conn?.request('clipboard-write', data).catch(() => undefined))
}

export const clipboard = tolerant(
  {
    readText: (): string => board.text ?? '',
    writeText(text: string): void {
      board = { text, buffers: new Map() }
      pushToBrowser({ text })
    },
    readHTML: (): string => board.html ?? '',
    writeHTML(html: string): void {
      board = { html, buffers: new Map() }
      pushToBrowser({ html })
    },
    readRTF: (): string => board.rtf ?? '',
    writeRTF(rtf: string): void {
      board = { rtf, buffers: new Map() }
    },
    readImage: (): NativeImage => board.image ?? NativeImage.createEmpty(),
    writeImage(image: NativeImage): void {
      board = { image, buffers: new Map() }
    },
    readBookmark: () => ({ title: '', url: '' }),
    writeBookmark(): void {},
    readFindText: (): string => '',
    writeFindText(): void {},
    readBuffer: (format: string): Buffer => board.buffers.get(format) ?? Buffer.alloc(0),
    writeBuffer(format: string, buffer: Buffer): void {
      board = { buffers: new Map([[format, Buffer.from(buffer)]]) }
    },
    write(data: { text?: string; html?: string; rtf?: string; image?: NativeImage }): void {
      board = { ...data, buffers: new Map() }
      pushToBrowser({ text: data.text, html: data.html })
    },
    clear(): void {
      board = { buffers: new Map() }
    },
    availableFormats(): string[] {
      const out: string[] = []
      if (board.text) out.push('text/plain')
      if (board.html) out.push('text/html')
      if (board.rtf) out.push('text/rtf')
      if (board.image) out.push('image/png')
      out.push(...board.buffers.keys())
      return out
    },
    has(format: string): boolean {
      return this.availableFormats().includes(format)
    },
    read(format: string): string {
      return board.buffers.get(format)?.toString('utf8') ?? ''
    },
  },
  'clipboard',
)

// ---- screen ----

function display() {
  const { w, h } = state.screen
  return {
    id: 1,
    label: 'Browser',
    bounds: { x: 0, y: 0, width: w, height: h },
    workArea: { x: 0, y: 0, width: w, height: h },
    size: { width: w, height: h },
    workAreaSize: { width: w, height: h },
    scaleFactor: state.dpr,
    rotation: 0,
    internal: false,
    monochrome: false,
    colorDepth: 24,
    colorSpace: 'srgb',
    depthPerComponent: 8,
    displayFrequency: 60,
    touchSupport: 'unknown',
    accelerometerSupport: 'unknown',
    detected: true,
  }
}

const screenEvents = new EventEmitter()
export const screen = tolerant(
  Object.assign(screenEvents, {
    getPrimaryDisplay: display,
    getAllDisplays: () => [display()],
    getDisplayMatching: display,
    getDisplayNearestPoint: display,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    screenToDipPoint: (p: { x: number; y: number }) => p,
    dipToScreenPoint: (p: { x: number; y: number }) => p,
  }),
  'screen',
)

// ---- theme ----

type ThemeSource = 'system' | 'light' | 'dark'

class NativeTheme extends EventEmitter {
  private source: ThemeSource = 'system'
  /** the browser's prefers-color-scheme, reported by the root page */
  systemDark = false
  readonly shouldUseHighContrastColors = false
  readonly shouldUseInvertedColorScheme = false
  readonly inForcedColorsMode = false
  readonly prefersReducedTransparency = false

  get themeSource(): ThemeSource {
    return this.source
  }

  set themeSource(value: ThemeSource) {
    this.source = value
    for (const wc of state.contents.values()) wc.conn?.send({ t: 'theme', source: value })
    this.emit('updated')
  }

  get shouldUseDarkColors(): boolean {
    return this.source === 'dark' || (this.source === 'system' && this.systemDark)
  }

  setSystemDark(dark: boolean): void {
    if (this.systemDark === dark) return
    this.systemDark = dark
    this.emit('updated')
  }
}

export const nativeTheme = new NativeTheme()

export const systemPreferences = tolerant(
  Object.assign(new EventEmitter(), {
    getMediaAccessStatus: () => 'granted',
    askForMediaAccess: () => Promise.resolve(true),
    getAccentColor: () => '0a84ffff',
    getColor: () => '#000000',
    getSystemColor: () => '#000000',
    isDarkMode: () => nativeTheme.shouldUseDarkColors,
    isTrustedAccessibilityClient: () => false,
    getUserDefault: () => '',
    getAnimationSettings: () => ({
      shouldRenderRichAnimation: true,
      scrollAnimationsEnabledBySystem: true,
      prefersReducedMotion: false,
    }),
    canPromptTouchID: () => false,
  }),
  'systemPreferences',
)

export const desktopCapturer = tolerant(
  { getSources: () => Promise.resolve([]) },
  'desktopCapturer',
)

let blockerId = 1
export const powerSaveBlocker = tolerant(
  { start: () => blockerId++, stop: () => undefined, isStarted: () => false },
  'powerSaveBlocker',
)

export const powerMonitor = tolerant(
  Object.assign(new EventEmitter(), {
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => 'active',
    isOnBatteryPower: () => false,
    onBatteryPower: false,
  }),
  'powerMonitor',
)

export const globalShortcut = tolerant(
  {
    register: () => false,
    registerAll: () => undefined,
    isRegistered: () => false,
    unregister: () => undefined,
    unregisterAll: () => undefined,
  },
  'globalShortcut',
)

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return true
  }
  constructor(private readonly options: { title?: string; body?: string } = {}) {
    super()
  }
  show(): void {
    const text = [this.options.title, this.options.body].filter(Boolean).join(' — ')
    if (text) notifyRoot({ t: 'toast', text })
    this.emit('show')
  }
  close(): void {
    this.emit('close')
  }
}

export class Tray extends EventEmitter {
  setToolTip(): void {}
  setContextMenu(): void {}
  setImage(): void {}
  setTitle(): void {}
  destroy(): void {}
  isDestroyed(): boolean {
    return false
  }
}

export const crashReporter = tolerant(
  { start: () => undefined, getParameters: () => ({}), addExtraParameter: () => undefined },
  'crashReporter',
)

export const autoUpdater = tolerant(
  Object.assign(new EventEmitter(), {
    setFeedURL: () => undefined,
    getFeedURL: () => '',
    checkForUpdates: () => undefined,
    quitAndInstall: () => undefined,
  }),
  'autoUpdater',
)

export const safeStorage = tolerant(
  {
    isEncryptionAvailable: () => false,
    encryptString: (): Buffer => {
      throw new Error('safeStorage is not available on the web')
    },
    decryptString: (): string => {
      throw new Error('safeStorage is not available on the web')
    },
    getSelectedStorageBackend: () => 'basic_text',
  },
  'safeStorage',
)

export const webContentsModule = tolerant(
  {
    fromId: (id: number): WebContents | undefined => state.contents.get(id),
    getAllWebContents: (): WebContents[] => [...state.contents.values()],
    getFocusedWebContents: (): WebContents | null => state.focusedContents,
    fromFrame: (): undefined => undefined,
    fromDevToolsTargetId: (): undefined => undefined,
    create: (options?: { webPreferences?: Record<string, unknown> }) =>
      new WebContents(options?.webPreferences),
  },
  'webContents',
)

export const webFrameMain = tolerant({ fromId: () => undefined }, 'webFrameMain')
