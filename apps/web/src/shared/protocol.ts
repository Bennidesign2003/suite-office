/**
 * Messages between the Node server (standing in for Electron's main process)
 * and every page it hosts (standing in for renderer processes). One socket per
 * page; the page names the webContents it renders in its hello.
 */

export interface Size {
  w: number
  h: number
}

/** a menu as the browser draws it — click handlers stay on the server */
export interface MenuItemWire {
  id: number
  label: string
  type: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  enabled: boolean
  visible: boolean
  checked: boolean
  accelerator?: string
  submenu?: MenuItemWire[]
}

/** a WebContentsView child of the root window, drawn as an iframe */
export interface ViewWire {
  wc: number
  src: string
  /** bumps on every loadURL/reload so the iframe navigates even to the same URL */
  nav: number
  x: number
  y: number
  w: number
  h: number
  visible: boolean
}

/** a secondary visible BrowserWindow, drawn as a floating panel over the root page */
export interface WindowWire {
  wc: number
  src: string
  nav: number
  title: string
  w: number
  h: number
  modal: boolean
  transparent: boolean
  frameless: boolean
}

export type ClientMessage =
  | {
      t: 'hello'
      wc: number
      /** random per page load: a new one means the page reloaded */
      page: string
      /** the server run the page was served by */
      boot: string
      top: boolean
      url: string
      size: Size
      screen: Size
      dpr: number
      dark: boolean
    }
  | { t: 'invoke'; id: number; ch: string; args: unknown[] }
  | { t: 'send'; ch: string; args: unknown[] }
  | { t: 'res'; id: number; ok: boolean; v?: unknown; e?: string }
  | { t: 'suite'; id: number; op: string; args: unknown[] }
  | { t: 'ev'; name: 'dom-ready' | 'load' | 'focus' | 'blur' | 'unload' }
  | { t: 'ev'; name: 'resize'; size: Size }
  | { t: 'ev'; name: 'fullscreen'; on: boolean }
  | { t: 'ev'; name: 'title'; title: string }
  | { t: 'ev'; name: 'window-open'; url: string; frameName: string; features: string }
  | { t: 'ev'; name: 'window-close'; wc: number }
  | { t: 'accel'; accel: string }
  | { t: 'menu'; id: number; item: number | null }

export type ServerMessage =
  | { t: 'ipc'; ch: string; args: unknown[] }
  | { t: 'ret'; id: number; ok: boolean; v?: unknown; e?: string }
  | { t: 'req'; id: number; kind: string; data: unknown }
  | { t: 'views'; list: ViewWire[] }
  | { t: 'windows'; list: WindowWire[] }
  | { t: 'accels'; list: string[] }
  | { t: 'menu'; id: number; items: MenuItemWire[]; x?: number; y?: number; wc: number }
  | { t: 'nav'; url: string }
  | { t: 'reload' }
  | { t: 'focus' }
  | { t: 'open'; url: string }
  | { t: 'toast'; text: string }
  | { t: 'download'; url: string; name: string }
  | { t: 'title'; title: string }
  | { t: 'theme'; source: 'system' | 'light' | 'dark' }
  | { t: 'gone'; reason: string }

export interface MessageBoxRequest {
  type?: string
  title?: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId: number
  checkboxLabel?: string
  checkboxChecked?: boolean
}

export interface FileFilterWire {
  name: string
  extensions: string[]
}

export interface FileDialogRequest {
  mode: 'open' | 'save'
  title?: string
  buttonLabel?: string
  defaultPath?: string
  filters?: FileFilterWire[]
  directory?: boolean
  multi?: boolean
  showHidden?: boolean
  createDirectory?: boolean
}

export interface FsEntry {
  name: string
  dir: boolean
  size: number
  mtime: number
}

export interface FsListing {
  dir: string
  parent: string | null
  sep: string
  entries: FsEntry[]
}

export interface FsPlace {
  label: string
  path: string
}
