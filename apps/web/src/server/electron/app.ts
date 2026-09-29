import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { state } from './contents'
import { NativeImage } from './native-image'
import { tolerant } from './tolerant'

export interface AppIdentity {
  name: string
  version: string
  appPath: string
}

let identity: AppIdentity = { name: 'Suite', version: '0.0.0', appPath: process.cwd() }
let ready = false
let quitting = false
let readyResolve: () => void = () => undefined
const readyPromise = new Promise<void>((resolve) => (readyResolve = resolve))
const paths = new Map<string, string>()

function appDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32')
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

function defaultPath(name: string): string {
  const home = homedir()
  switch (name) {
    case 'home':
      return home
    case 'appData':
      return appDataDir()
    case 'userData':
    case 'sessionData':
      return join(appDataDir(), identity.name)
    case 'temp':
      return tmpdir()
    case 'exe':
      return process.execPath
    case 'module':
      return process.execPath
    case 'desktop':
      return join(home, 'Desktop')
    case 'documents':
      return join(home, 'Documents')
    case 'downloads':
      return join(home, 'Downloads')
    case 'music':
      return join(home, 'Music')
    case 'pictures':
      return join(home, 'Pictures')
    case 'videos':
      return join(home, 'Videos')
    case 'recent':
      return join(home, '.recent')
    case 'logs':
      return join(app.getPath('userData'), 'logs')
    case 'crashDumps':
      return join(app.getPath('userData'), 'Crashpad')
    default:
      throw new Error(`Failed to get '${name}' path`)
  }
}

function locale(): string {
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  const fromEnv = env.split('.')[0]?.replace('_', '-')
  if (fromEnv && fromEnv !== 'C' && fromEnv !== 'POSIX') return fromEnv
  return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
}

class App extends EventEmitter {
  readonly isPackaged = false
  readonly commandLine = {
    appendSwitch: (): void => undefined,
    appendArgument: (): void => undefined,
    hasSwitch: (): boolean => false,
    getSwitchValue: (): string => '',
    removeSwitch: (): void => undefined,
  }
  userAgentFallback = 'Suite-Web'
  accessibilitySupportEnabled = false
  runningUnderARM64Translation = false

  constructor() {
    super()
    this.setMaxListeners(0)
  }

  whenReady(): Promise<void> {
    return readyPromise
  }
  isReady(): boolean {
    return ready
  }

  getName(): string {
    return identity.name
  }
  setName(name: string): void {
    identity = { ...identity, name }
  }
  getVersion(): string {
    return identity.version
  }
  getAppPath(): string {
    return identity.appPath
  }

  getPath(name: string): string {
    return paths.get(name) ?? defaultPath(name)
  }
  setPath(name: string, path: string): void {
    paths.set(name, path)
    if (name === 'userData') {
      try {
        mkdirSync(path, { recursive: true })
      } catch {
        // surfaced later by whoever writes there
      }
    }
  }

  getLocale(): string {
    return locale()
  }
  getSystemLocale(): string {
    return locale()
  }
  getPreferredSystemLanguages(): string[] {
    return [locale()]
  }
  getLocaleCountryCode(): string {
    return locale().split('-')[1] ?? ''
  }

  requestSingleInstanceLock(): boolean {
    return true
  }
  hasSingleInstanceLock(): boolean {
    return true
  }
  releaseSingleInstanceLock(): void {}

  quit(): void {
    if (quitting) return
    let prevented = false
    const event = {
      preventDefault: () => {
        prevented = true
      },
    }
    this.emit('before-quit', event)
    if (prevented) return
    quitting = true
    this.emit('will-quit', { preventDefault: () => undefined })
    this.emit('quit', {}, 0)
    for (const wc of state.contents.values()) wc.conn?.send({ t: 'gone', reason: 'quit' })
    setTimeout(() => process.exit(0), 200)
  }

  exit(code = 0): void {
    process.exit(code)
  }

  relaunch(): void {
    console.log('[web] relaunch requested — restart the server to apply')
  }

  focus(): void {}
  hide(): void {}
  show(): void {}
  isHidden(): boolean {
    return false
  }

  setAppUserModelId(): void {}
  setAboutPanelOptions(): void {}
  showAboutPanel(): void {}
  setAsDefaultProtocolClient(): boolean {
    return false
  }
  removeAsDefaultProtocolClient(): boolean {
    return false
  }
  isDefaultProtocolClient(): boolean {
    return false
  }
  addRecentDocument(): void {}
  clearRecentDocuments(): void {}
  setBadgeCount(): boolean {
    return false
  }
  getBadgeCount(): number {
    return 0
  }
  setLoginItemSettings(): void {}
  getLoginItemSettings(): { openAtLogin: boolean } {
    return { openAtLogin: false }
  }
  setAccessibilitySupportEnabled(enabled: boolean): void {
    this.accessibilitySupportEnabled = enabled
  }
  isAccessibilitySupportEnabled(): boolean {
    return this.accessibilitySupportEnabled
  }
  getAppMetrics(): unknown[] {
    return []
  }
  getGPUFeatureStatus(): Record<string, string> {
    return {}
  }
  getGPUInfo(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }
  getFileIcon(): Promise<NativeImage> {
    return Promise.resolve(NativeImage.createEmpty())
  }
  isInApplicationsFolder(): boolean {
    return false
  }
  moveToApplicationsFolder(): boolean {
    return false
  }
  isEmojiPanelSupported(): boolean {
    return false
  }
  disableHardwareAcceleration(): void {}
  enableSandbox(): void {}
  setActivationPolicy(): void {}
}

export const app = tolerant(new App(), 'app')
state.appEvents = app

export function configureApp(next: AppIdentity): void {
  identity = next
}

export function markAppReady(): void {
  if (ready) return
  ready = true
  app.emit('will-finish-launching')
  readyResolve()
  app.emit('ready', {}, {})
}

export function isQuitting(): boolean {
  return quitting
}
