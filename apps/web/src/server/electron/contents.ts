import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerMessage, ViewWire, WindowWire } from '../../shared/protocol'
import type { Conn } from '../hub'
import { HeadlessPage, pdfFromSnapshot, type ElectronPdfOptions } from '../headless'
import { absoluteForServer, toWebUrl, withWebContentsId } from '../urls'
import { NativeImage } from './native-image'
import { tolerant } from './tolerant'

/**
 * webContents / BrowserWindow / WebContentsView for the web.
 *
 * Where a page is shown decides how it is reached:
 *  - the root window (the shell) is the browser tab itself;
 *  - WebContentsView children of the root (editor tabs) and visible secondary
 *    windows are iframes the root page lays out;
 *  - hidden windows (print, export, measuring) run in a headless Chromium.
 * All three talk to this process over the same socket protocol, so IPC works
 * the same everywhere.
 */

type Backend = 'top' | 'frame' | 'headless'

interface LoadWaiter {
  resolve: () => void
  reject: (err: Error) => void
}

export interface WebPreferencesLike {
  preload?: string
  javascript?: boolean
  [key: string]: unknown
}

const MAX_OUTBOX = 5000

export const state = {
  contents: new Map<number, WebContents>(),
  windows: new Map<number, BrowserWindow>(),
  nextWc: 1,
  nextWin: 1,
  root: null as BrowserWindow | null,
  focusedContents: null as WebContents | null,
  focusedWindow: null as BrowserWindow | null,
  /** client viewport / screen of the root page, for screen.* and window bounds */
  screen: { w: 1440, h: 900 },
  dpr: 1,
  appEvents: null as EventEmitter | null,
  /** called when a page connects and the root has none of its own yet */
  onRootConnected: [] as Array<() => void>,
}

let layoutQueued = false

/** push the iframe layout (tabs + floating windows) to the root page */
export function scheduleLayout(): void {
  if (layoutQueued) return
  layoutQueued = true
  queueMicrotask(() => {
    layoutQueued = false
    const root = state.root
    if (!root || root.isDestroyed()) return
    const conn = root.webContents.conn
    if (!conn) return
    const views: ViewWire[] = []
    for (const view of root.contentView.children) {
      const wc = view.webContents
      if (!wc || wc.isDestroyed() || !wc.url) continue
      const b = view.getBounds()
      views.push({
        wc: wc.id,
        src: wc.clientUrl(),
        nav: wc.navSeq,
        x: b.x,
        y: b.y,
        w: b.width,
        h: b.height,
        visible: view.getVisible(),
      })
    }
    const windows: WindowWire[] = []
    for (const win of state.windows.values()) {
      if (win === root || win.isDestroyed() || !win.isVisible()) continue
      const wc = win.webContents
      if (wc.backend !== 'frame' || !wc.url) continue
      windows.push({
        wc: wc.id,
        src: wc.clientUrl(),
        nav: wc.navSeq,
        title: win.getTitle(),
        w: win.bounds.width,
        h: win.bounds.height,
        modal: win.modal,
        transparent: win.transparent,
        frameless: win.frameless,
      })
    }
    conn.send({ t: 'views', list: views })
    conn.send({ t: 'windows', list: windows })
  })
}

/** wait (bounded) for the root page, for requests that need a browser */
export function rootConn(timeoutMs = 0): Promise<Conn | null> {
  const now = state.root?.webContents.conn ?? null
  if (now || timeoutMs <= 0) return Promise.resolve(now)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = state.onRootConnected.indexOf(done)
      if (i >= 0) state.onRootConnected.splice(i, 1)
      resolve(state.root?.webContents.conn ?? null)
    }, timeoutMs)
    const done = (): void => {
      clearTimeout(timer)
      resolve(state.root?.webContents.conn ?? null)
    }
    state.onRootConnected.push(done)
  })
}

export function notifyRoot(msg: ServerMessage): void {
  state.root?.webContents.conn?.send(msg)
}

export class WebContents extends EventEmitter {
  readonly id: number
  readonly preload: string | undefined
  readonly javascript: boolean
  url = ''
  title = ''
  conn: Conn | null = null
  lastPage: string | null = null
  navSeq = 0
  loading = false
  private destroyedFlag = false
  private outbox: ServerMessage[] = []
  private loadWaiters: LoadWaiter[] = []
  private backendChoice: Backend | null = null
  private headless: Promise<HeadlessPage> | null = null
  private openHandler: ((details: Record<string, unknown>) => { action: string }) | null = null
  private zoom = 1
  hostWindow: BrowserWindow | null = null
  view: WebContentsView | null = null
  readonly session = defaultSession

  constructor(prefs: WebPreferencesLike | undefined) {
    super()
    this.setMaxListeners(0)
    this.id = state.nextWc++
    this.preload = typeof prefs?.preload === 'string' ? prefs.preload : undefined
    this.javascript = prefs?.javascript !== false
    const self = tolerant(this, 'webContents')
    state.contents.set(this.id, self)
    queueMicrotask(() => state.appEvents?.emit('web-contents-created', {}, self))
    return self
  }

  // ---- placement ----

  get backend(): Backend {
    if (this.backendChoice) return this.backendChoice
    if (this.view) return 'frame'
    const win = this.hostWindow
    if (win && win === state.root) return 'top'
    if (win && win.presentable()) return 'frame'
    return 'headless'
  }

  /** the URL the browser (or headless page) loads for this webContents */
  clientUrl(): string {
    const web = toWebUrl(this.url)
    if (this.backend === 'headless' && !this.preload) return web
    return withWebContentsId(web, this.id)
  }

  /** a hidden window was shown: move it from headless Chromium to the user's browser */
  promoteToFrame(): void {
    if (this.backendChoice !== 'headless') return
    this.backendChoice = 'frame'
    const pending = this.headless
    this.headless = null
    void pending?.then((h) => h.close()).catch(() => undefined)
    if (this.url) {
      this.navSeq++
      this.loading = true
    }
    scheduleLayout()
  }

  // ---- lifecycle ----

  isDestroyed(): boolean {
    return this.destroyedFlag
  }

  isCrashed(): boolean {
    return false
  }

  destroy(): void {
    if (this.destroyedFlag) return
    this.destroyedFlag = true
    for (const waiter of this.loadWaiters) waiter.reject(new Error('webContents destroyed'))
    this.loadWaiters = []
    this.conn?.send({ t: 'gone', reason: 'closed' })
    this.conn?.close('The page was closed.')
    this.conn = null
    void this.headless?.then((h) => h.close()).catch(() => undefined)
    this.headless = null
    if (state.focusedContents === this) state.focusedContents = null
    this.emit('destroyed')
    state.contents.delete(this.id)
    scheduleLayout()
  }

  close(): void {
    this.destroy()
  }

  // ---- connection ----

  attach(conn: Conn): void {
    const previous = this.conn
    if (previous && previous !== conn) {
      previous.send({ t: 'gone', reason: 'moved' })
      previous.close('The page was replaced.')
    }
    const reloaded = this.lastPage !== null && this.lastPage !== conn.page
    this.conn = conn
    this.lastPage = conn.page
    if (reloaded && !this.loading) {
      this.loading = true
      this.emit('did-start-loading')
    }
    const queued = this.outbox
    this.outbox = []
    for (const msg of queued) conn.send(msg)
  }

  detach(conn: Conn): void {
    if (this.conn !== conn) return
    this.conn = null
    conn.close('The page disconnected.')
  }

  deliver(msg: ServerMessage): void {
    if (this.destroyedFlag) return
    if (this.conn) {
      this.conn.send(msg)
      return
    }
    if (this.backend === 'headless' && !this.preload) return
    if (this.outbox.length >= MAX_OUTBOX) this.outbox.shift()
    this.outbox.push(msg)
  }

  send(channel: string, ...args: unknown[]): void {
    this.deliver({ t: 'ipc', ch: channel, args })
  }

  /** page lifecycle, reported by the injected runtime or by headless Chromium */
  pageEvent(name: 'dom-ready' | 'load', fromHeadless: boolean): void {
    if (this.destroyedFlag) return
    if ((this.backend === 'headless') !== fromHeadless) return
    if (name === 'dom-ready') {
      this.emit('dom-ready')
      return
    }
    this.loading = false
    this.emit('did-stop-loading')
    this.emit('did-finish-load')
    const waiters = this.loadWaiters
    this.loadWaiters = []
    for (const waiter of waiters) waiter.resolve()
    this.hostWindow?.contentsLoaded()
  }

  private failLoad(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.loading = false
    this.emit('did-fail-load', {}, -2, message, this.url, true)
    const waiters = this.loadWaiters
    this.loadWaiters = []
    for (const waiter of waiters) waiter.reject(new Error(message))
  }

  // ---- navigation ----

  loadURL(url: string, _options?: unknown): Promise<void> {
    if (this.destroyedFlag) return Promise.reject(new Error('webContents destroyed'))
    this.url = url
    this.navSeq++
    this.loading = true
    if (!this.backendChoice) this.backendChoice = this.backend
    this.emit('did-start-loading')
    const done = new Promise<void>((resolve, reject) => this.loadWaiters.push({ resolve, reject }))
    this.navigate()
    return done
  }

  loadFile(
    filePath: string,
    options?: { query?: Record<string, string>; search?: string; hash?: string },
  ): Promise<void> {
    const url = pathToFileURL(filePath)
    if (options?.query)
      for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v)
    if (options?.search) url.search = options.search
    if (options?.hash) url.hash = options.hash
    return this.loadURL(url.toString())
  }

  private navigate(): void {
    const backend = this.backend
    if (backend === 'headless') {
      void this.ensureHeadless()
        .then((h) => h.goto(absoluteForServer(this.clientUrl())))
        .catch((err) => this.failLoad(err))
      return
    }
    if (backend === 'top') {
      this.conn?.send({ t: 'nav', url: this.clientUrl() })
      return
    }
    scheduleLayout()
  }

  private ensureHeadless(): Promise<HeadlessPage> {
    if (!this.headless) {
      const bounds = this.hostWindow?.bounds ?? { width: 1280, height: 800 }
      this.headless = HeadlessPage.open({
        width: bounds.width,
        height: bounds.height,
        javascript: this.javascript,
        onLoad: () => this.pageEvent('load', true),
        onDomReady: () => this.pageEvent('dom-ready', true),
        onFail: (e) => this.failLoad(e),
      })
    }
    return this.headless
  }

  resizeHeadless(width: number, height: number): void {
    void this.headless?.then((h) => h.setSize(width, height)).catch(() => undefined)
  }

  reload(): void {
    if (this.destroyedFlag || !this.url) return
    this.loading = true
    this.emit('did-start-loading')
    const backend = this.backend
    if (backend === 'top') this.conn?.send({ t: 'reload' })
    else if (backend === 'frame') {
      this.navSeq++
      scheduleLayout()
    } else this.navigate()
  }

  reloadIgnoringCache(): void {
    this.reload()
  }

  forcefullyCrashRenderer(): void {
    this.reload()
  }

  stop(): void {}

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  isLoading(): boolean {
    return this.loading
  }

  isLoadingMainFrame(): boolean {
    return this.loading
  }

  isWaitingForResponse(): boolean {
    return false
  }

  get mainFrame(): Record<string, unknown> {
    return frameOf(this)
  }

  getType(): string {
    return this.view ? 'browserView' : 'window'
  }

  getOSProcessId(): number {
    return process.pid
  }

  getProcessId(): number {
    return this.id
  }

  getOwnerBrowserWindow(): BrowserWindow | null {
    return this.hostWindow ?? this.view?.parentWindow ?? null
  }

  get hostWebContents(): null {
    return null
  }

  // ---- focus ----

  focus(): void {
    state.focusedContents = this
    const root = state.root
    if (this.backend === 'headless' || !root) return
    root.webContents.conn?.send({ t: 'req', id: 0, kind: 'focus-frame', data: this.id })
  }

  isFocused(): boolean {
    return state.focusedContents === this
  }

  // ---- windows opened by the page ----

  setWindowOpenHandler(handler: (details: Record<string, unknown>) => { action: string }): void {
    this.openHandler = handler
  }

  handleWindowOpen(url: string, frameName: string, features: string): void {
    const result = this.openHandler?.({
      url,
      frameName,
      features,
      disposition: 'new-window',
      referrer: { url: this.url, policy: 'strict-origin-when-cross-origin' },
    }) ?? { action: 'allow' }
    if (result.action === 'allow') notifyRoot({ t: 'open', url: toWebUrl(url) })
  }

  // ---- scripting ----

  async executeJavaScript(code: string, _userGesture?: boolean): Promise<unknown> {
    if (this.backend === 'headless') {
      const page = await this.ensureHeadless()
      return page.evaluate(code)
    }
    const conn = await this.waitForConn(30_000)
    return conn.request('eval', code)
  }

  private async waitForConn(timeoutMs: number): Promise<Conn> {
    const deadline = Date.now() + timeoutMs
    while (!this.conn) {
      if (this.destroyedFlag) throw new Error('webContents destroyed')
      if (Date.now() > deadline) throw new Error('The page is not open in a browser.')
      await new Promise((r) => setTimeout(r, 100))
    }
    return this.conn
  }

  insertCSS(css: string): Promise<string> {
    return this.waitForConn(30_000).then((conn) => conn.request<string>('insert-css', css))
  }

  removeInsertedCSS(key: string): Promise<void> {
    return this.waitForConn(30_000).then((conn) => conn.request<void>('remove-css', key))
  }

  private editCommand(command: string): void {
    void this.conn?.request('edit', command).catch(() => undefined)
  }

  undo(): void {
    this.editCommand('undo')
  }
  redo(): void {
    this.editCommand('redo')
  }
  cut(): void {
    this.editCommand('cut')
  }
  copy(): void {
    this.editCommand('copy')
  }
  paste(): void {
    this.editCommand('paste')
  }
  pasteAndMatchStyle(): void {
    this.editCommand('paste')
  }
  delete(): void {
    this.editCommand('delete')
  }
  selectAll(): void {
    this.editCommand('selectAll')
  }
  unselect(): void {
    this.editCommand('unselect')
  }
  replaceMisspelling(word: string): void {
    void this.conn?.request('edit', ['insertText', word]).catch(() => undefined)
  }

  // ---- output ----

  async printToPDF(options: ElectronPdfOptions = {}): Promise<Buffer> {
    if (this.backend === 'headless') {
      const page = await this.ensureHeadless()
      return page.pdf(options)
    }
    const conn = await this.waitForConn(30_000)
    const snap = await conn.request<{ html: string; width: number; height: number }>(
      'snapshot',
      null,
    )
    return pdfFromSnapshot(snap.html, { width: snap.width, height: snap.height }, options)
  }

  print(
    options?: ElectronPdfOptions & { silent?: boolean },
    callback?: (success: boolean, failureReason: string) => void,
  ): void {
    const finish = (ok: boolean, reason = ''): void => callback?.(ok, reason)
    if (this.backend !== 'headless' && this.conn) {
      this.conn.request('print', null).then(
        () => finish(true),
        (err: Error) => finish(false, err.message),
      )
      return
    }
    // a hidden print window: render the PDF and let the browser print that
    this.printToPDF({ printBackground: true, ...options })
      .then((pdf) => {
        const dir = mkdtempSync(join(tmpdir(), 'suite-print-'))
        const file = join(dir, 'print.pdf')
        writeFileSync(file, pdf)
        notifyRoot({ t: 'open', url: toWebUrl(pathToFileURL(file).toString()) })
        finish(true)
      })
      .catch((err: Error) => finish(false, err.message))
  }

  async capturePage(rect?: {
    x: number
    y: number
    width: number
    height: number
  }): Promise<NativeImage> {
    if (this.backend === 'headless') {
      const page = await this.ensureHeadless()
      return NativeImage.fromBuffer(await page.capture(rect))
    }
    // a visible page: render its snapshot headlessly at the same size
    const conn = await this.waitForConn(30_000)
    const snap = await conn.request<{ html: string; width: number; height: number }>(
      'snapshot',
      null,
    )
    const page = await HeadlessPage.open({
      width: snap.width,
      height: snap.height,
      javascript: true,
      onLoad: () => undefined,
      onDomReady: () => undefined,
      onFail: () => undefined,
    })
    try {
      await page.page.setContent(snap.html, { waitUntil: 'load' })
      return NativeImage.fromBuffer(await page.capture(rect))
    } finally {
      await page.close()
    }
  }

  downloadURL(url: string): void {
    notifyRoot({ t: 'download', url: toWebUrl(url), name: '' })
  }

  // ---- zoom & misc ----

  setZoomFactor(factor: number): void {
    this.zoom = factor
    void this.conn?.request('zoom', factor).catch(() => undefined)
  }
  getZoomFactor(): number {
    return this.zoom
  }
  setZoomLevel(level: number): void {
    this.setZoomFactor(Math.pow(1.2, level))
  }
  getZoomLevel(): number {
    return Math.log(this.zoom) / Math.log(1.2)
  }
  setVisualZoomLevelLimits(): Promise<void> {
    return Promise.resolve()
  }
  isDevToolsOpened(): boolean {
    return false
  }
  isDevToolsFocused(): boolean {
    return false
  }
  getUserAgent(): string {
    return 'Suite-Web'
  }
  isAudioMuted(): boolean {
    return false
  }
  isCurrentlyAudible(): boolean {
    return false
  }
  isBeingCaptured(): boolean {
    return false
  }
  isOffscreen(): boolean {
    return this.backend === 'headless'
  }
  getBackgroundThrottling(): boolean {
    return false
  }
}

function frameOf(wc: WebContents): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    get url() {
      return wc.url
    },
    get origin() {
      try {
        return new URL(wc.url).origin
      } catch {
        return 'null'
      }
    },
    name: '',
    routingId: 1,
    processId: wc.id,
    frameTreeNodeId: wc.id,
    parent: null,
    frames: [],
    framesInSubtree: [],
    visibilityState: 'visible',
    detached: false,
    isDestroyed: () => wc.isDestroyed(),
    executeJavaScript: (code: string) => wc.executeJavaScript(code),
    send: (channel: string, ...args: unknown[]) => wc.send(channel, ...args),
    reload: () => wc.reload(),
  }
  frame.top = frame
  return frame
}

// ---- session ----

const defaultSessionTarget = {
  resolveProxy: (_url: string) => Promise.resolve('DIRECT'),
  setProxy: () => Promise.resolve(),
  clearCache: () => Promise.resolve(),
  clearStorageData: () => Promise.resolve(),
  getCacheSize: () => Promise.resolve(0),
  setPermissionRequestHandler: () => undefined,
  setPermissionCheckHandler: () => undefined,
  setDisplayMediaRequestHandler: () => undefined,
  setSpellCheckerEnabled: () => undefined,
  isSpellCheckerEnabled: () => true,
  setSpellCheckerLanguages: () => undefined,
  getSpellCheckerLanguages: () => [],
  availableSpellCheckerLanguages: [] as string[],
  addWordToSpellCheckerDictionary: () => true,
  removeWordFromSpellCheckerDictionary: () => true,
  listWordsInSpellCheckerDictionary: () => Promise.resolve([] as string[]),
  getUserAgent: () => 'Suite-Web',
  setUserAgent: () => undefined,
  protocol: null as unknown,
  webRequest: {
    onBeforeRequest: () => undefined,
    onBeforeSendHeaders: () => undefined,
    onHeadersReceived: () => undefined,
    onCompleted: () => undefined,
    onErrorOccurred: () => undefined,
  },
  cookies: {
    get: () => Promise.resolve([]),
    set: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    flushStore: () => Promise.resolve(),
    on: () => undefined,
  },
  on: () => undefined,
  once: () => undefined,
  off: () => undefined,
  removeListener: () => undefined,
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  storagePath: null,
  isPersistent: () => true,
}

export const defaultSession = tolerant(defaultSessionTarget, 'session')

export const session = tolerant(
  {
    defaultSession,
    fromPartition: () => defaultSession,
    fromPath: () => defaultSession,
  },
  'session',
)

// ---- WebContentsView ----

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export class WebContentsView extends EventEmitter {
  readonly webContents: WebContents
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private visible = true
  parentWindow: BrowserWindow | null = null

  constructor(options?: { webPreferences?: WebPreferencesLike; webContents?: WebContents }) {
    super()
    const self = tolerant(this, 'WebContentsView')
    this.webContents = options?.webContents ?? new WebContents(options?.webPreferences)
    this.webContents.view = self
    return self
  }

  setBounds(bounds: Rect): void {
    this.bounds = { ...bounds }
    scheduleLayout()
  }
  getBounds(): Rect {
    return { ...this.bounds }
  }
  setVisible(visible: boolean): void {
    this.visible = visible
    scheduleLayout()
  }
  getVisible(): boolean {
    return this.visible
  }
  setBackgroundColor(): void {}
  setBorderRadius(): void {}
  get children(): WebContentsView[] {
    return []
  }
}

// ---- BrowserWindow ----

export interface BrowserWindowOptions {
  width?: number
  height?: number
  x?: number
  y?: number
  show?: boolean
  title?: string
  parent?: BrowserWindow
  modal?: boolean
  transparent?: boolean
  frame?: boolean
  webPreferences?: WebPreferencesLike
  [key: string]: unknown
}

export class BrowserWindow extends EventEmitter {
  readonly id: number
  readonly webContents: WebContents
  bounds: Rect
  private title: string
  private visible: boolean
  /** show() was called, or the window was created visible */
  private shownIntent: boolean
  /** the first load decided whether this window is shown in the browser */
  private presentableAtLoad: boolean | null = null
  private destroyedFlag = false
  private readyToShowSent = false
  private fullScreen = false
  private simpleFullScreen = false
  private parent: BrowserWindow | null
  readonly modal: boolean
  readonly transparent: boolean
  readonly frameless: boolean
  private readonly childViews: WebContentsView[] = []
  readonly contentView: {
    addChildView: (view: WebContentsView, index?: number) => void
    removeChildView: (view: WebContentsView) => void
    readonly children: WebContentsView[]
  }

  static getAllWindows(): BrowserWindow[] {
    return [...state.windows.values()].filter((w) => !w.isDestroyed())
  }

  static getFocusedWindow(): BrowserWindow | null {
    const focused = state.focusedWindow
    if (focused && !focused.isDestroyed() && focused.isVisible()) return focused
    return state.root && !state.root.isDestroyed() ? state.root : null
  }

  static fromWebContents(wc: WebContents | null | undefined): BrowserWindow | null {
    if (!wc) return null
    return wc.hostWindow ?? wc.view?.parentWindow ?? null
  }

  static fromId(id: number): BrowserWindow | null {
    return state.windows.get(id) ?? null
  }

  static fromBrowserView(): null {
    return null
  }

  constructor(options: BrowserWindowOptions = {}) {
    super()
    this.setMaxListeners(0)
    this.id = state.nextWin++
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 800,
      height: options.height ?? 600,
    }
    this.title = options.title ?? ''
    this.visible = options.show !== false
    this.shownIntent = options.show !== false
    this.parent = options.parent ?? null
    this.modal = !!options.modal
    this.transparent = !!options.transparent
    this.frameless = options.frame === false
    const self = tolerant(this, 'BrowserWindow')
    this.webContents = new WebContents(options.webPreferences)
    this.webContents.hostWindow = self
    const children = this.childViews
    this.contentView = {
      addChildView(view: WebContentsView, index?: number) {
        const at = children.indexOf(view)
        if (at >= 0) children.splice(at, 1)
        if (index === undefined || index < 0 || index > children.length) children.push(view)
        else children.splice(index, 0, view)
        view.parentWindow = self
        scheduleLayout()
      },
      removeChildView(view: WebContentsView) {
        const at = children.indexOf(view)
        if (at >= 0) children.splice(at, 1)
        if (view.parentWindow === self) view.parentWindow = null
        scheduleLayout()
      },
      get children() {
        return children.slice()
      },
    }
    state.windows.set(this.id, self)
    if (!state.root && options.show !== false && !options.parent) {
      state.root = self
      state.focusedWindow = self
      this.bounds.width = state.screen.w
      this.bounds.height = state.screen.h
    }
    return self
  }

  /** shown in the user's browser (as opposed to headless Chromium) */
  presentable(): boolean {
    if (this.presentableAtLoad === null) {
      this.presentableAtLoad = this.shownIntent || this.listenerCount('ready-to-show') > 0
    }
    return this.presentableAtLoad || this.shownIntent
  }

  contentsLoaded(): void {
    if (this.readyToShowSent) return
    this.readyToShowSent = true
    this.emit('ready-to-show')
  }

  isRoot(): boolean {
    return state.root === this
  }

  // ---- loading ----

  loadURL(url: string, options?: unknown): Promise<void> {
    return this.webContents.loadURL(url, options)
  }

  loadFile(
    filePath: string,
    options?: { query?: Record<string, string>; hash?: string },
  ): Promise<void> {
    return this.webContents.loadFile(filePath, options)
  }

  reload(): void {
    this.webContents.reload()
  }

  // ---- visibility ----

  show(): void {
    if (this.destroyedFlag) return
    this.shownIntent = true
    this.visible = true
    this.webContents.promoteToFrame()
    this.focus()
    scheduleLayout()
    this.emit('show')
  }

  showInactive(): void {
    this.show()
  }

  hide(): void {
    if (this.destroyedFlag || this.isRoot()) return
    this.visible = false
    scheduleLayout()
    this.emit('hide')
  }

  isVisible(): boolean {
    if (this.destroyedFlag) return false
    return this.isRoot() ? true : this.visible && this.shownIntent
  }

  focus(): void {
    if (this.destroyedFlag) return
    const previous = state.focusedWindow
    state.focusedWindow = this
    if (previous && previous !== this && !previous.isDestroyed()) previous.emit('blur')
    this.emit('focus')
  }

  blur(): void {
    if (state.focusedWindow === this) state.focusedWindow = state.root
    this.emit('blur')
  }

  isFocused(): boolean {
    return BrowserWindow.getFocusedWindow() === this
  }

  isFocusable(): boolean {
    return true
  }

  // ---- closing ----

  close(): void {
    if (this.destroyedFlag) return
    let prevented = false
    const event = {
      preventDefault() {
        prevented = true
      },
      get defaultPrevented() {
        return prevented
      },
    }
    this.emit('close', event)
    if (!prevented) this.destroy()
  }

  destroy(): void {
    if (this.destroyedFlag) return
    this.destroyedFlag = true
    const wasRoot = this.isRoot()
    for (const view of this.childViews) if (view.parentWindow === this) view.parentWindow = null
    this.childViews.length = 0
    if (wasRoot) {
      // keep the browser tab: it shows a "closed" note and reopens on reload
      this.webContents.conn?.send({ t: 'gone', reason: 'window-closed' })
    }
    this.webContents.destroy()
    state.windows.delete(this.id)
    if (state.focusedWindow === this) state.focusedWindow = null
    if (wasRoot) state.root = null
    this.emit('closed')
    scheduleLayout()
  }

  isDestroyed(): boolean {
    return this.destroyedFlag
  }

  // ---- geometry ----

  getBounds(): Rect {
    return { ...this.bounds }
  }

  setBounds(bounds: Partial<Rect>): void {
    this.bounds = { ...this.bounds, ...bounds }
    this.webContents.resizeHeadless(this.bounds.width, this.bounds.height)
    scheduleLayout()
  }

  getContentBounds(): Rect {
    return { ...this.bounds }
  }

  setContentBounds(bounds: Partial<Rect>): void {
    this.setBounds(bounds)
  }

  getSize(): [number, number] {
    return [this.bounds.width, this.bounds.height]
  }

  setSize(width: number, height: number): void {
    this.setBounds({ width, height })
  }

  getContentSize(): [number, number] {
    return this.getSize()
  }

  setContentSize(width: number, height: number): void {
    this.setBounds({ width, height })
  }

  getPosition(): [number, number] {
    return [this.bounds.x, this.bounds.y]
  }

  setPosition(x: number, y: number): void {
    this.bounds.x = x
    this.bounds.y = y
  }

  center(): void {}

  getNormalBounds(): Rect {
    return this.getBounds()
  }

  /** the root page reports its viewport */
  clientResized(width: number, height: number): void {
    if (width === this.bounds.width && height === this.bounds.height) return
    this.bounds.width = width
    this.bounds.height = height
    this.emit('resize')
    this.emit('resized')
  }

  // ---- title & state ----

  setTitle(title: string): void {
    this.title = title
    if (!this.isRoot()) scheduleLayout()
  }

  getTitle(): string {
    return this.title
  }

  isMinimized(): boolean {
    return false
  }
  isMaximized(): boolean {
    return this.isRoot()
  }
  isNormal(): boolean {
    return true
  }
  minimize(): void {}
  maximize(): void {}
  unmaximize(): void {}
  restore(): void {}
  isModal(): boolean {
    return this.modal
  }
  isResizable(): boolean {
    return true
  }
  isAlwaysOnTop(): boolean {
    return false
  }
  isKiosk(): boolean {
    return false
  }
  isMenuBarVisible(): boolean {
    return false
  }

  isFullScreen(): boolean {
    return this.fullScreen
  }

  setFullScreen(flag: boolean): void {
    if (this.fullScreen === flag) return
    this.fullScreen = flag
    void this.webContents.conn?.request('fullscreen', flag).catch(() => undefined)
    this.emit(flag ? 'enter-full-screen' : 'leave-full-screen')
  }

  isSimpleFullScreen(): boolean {
    return this.simpleFullScreen
  }

  setSimpleFullScreen(flag: boolean): void {
    this.simpleFullScreen = flag
    const root = state.root
    void root?.webContents.conn?.request('fullscreen', flag).catch(() => undefined)
  }

  getParentWindow(): BrowserWindow | null {
    return this.parent
  }

  setParentWindow(parent: BrowserWindow | null): void {
    this.parent = parent
  }

  getChildWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows().filter((w) => w.getParentWindow() === this)
  }

  getNativeWindowHandle(): Buffer {
    return Buffer.alloc(8)
  }

  getMediaSourceId(): string {
    return `window:${this.id}:0`
  }
}
