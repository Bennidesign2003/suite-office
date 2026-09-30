import { EventEmitter } from 'node:events'
import type { MenuItemWire } from '../../shared/protocol'
import { app } from './app'
import { BrowserWindow, notifyRoot, rootConn, state, type WebContents } from './contents'
import { tolerant } from './tolerant'

/**
 * Menus stay on the server (their click handlers are main-process closures);
 * the root page draws popups and reports the chosen item. The application
 * menu has no menu bar on the web — its accelerators are what matters, so
 * every page is told which key combinations to hand back instead of
 * processing them itself, like a native menu bar would.
 */

let nextCommandId = 1
const commands = new Map<number, MenuItem>()
let applicationMenu: Menu | null = null
let nextPopupId = 1
const popups = new Map<number, { menu: Menu; callback?: () => void }>()

const ROLE_LABELS: Record<string, string> = {
  undo: 'Rückgängig',
  redo: 'Wiederholen',
  cut: 'Ausschneiden',
  copy: 'Kopieren',
  paste: 'Einfügen',
  pasteandmatchstyle: 'Einfügen und Stil anpassen',
  delete: 'Löschen',
  selectall: 'Alles auswählen',
  reload: 'Neu laden',
  forcereload: 'Neu laden erzwingen',
  toggledevtools: 'Entwicklerwerkzeuge',
  resetzoom: 'Originalgröße',
  zoomin: 'Vergrößern',
  zoomout: 'Verkleinern',
  togglefullscreen: 'Vollbild',
  minimize: 'Minimieren',
  close: 'Schließen',
  quit: 'Beenden',
  about: 'Über',
  hide: 'Ausblenden',
  hideothers: 'Andere ausblenden',
  unhide: 'Alle einblenden',
  front: 'Alle nach vorne bringen',
  window: 'Fenster',
  help: 'Hilfe',
  editmenu: 'Bearbeiten',
  viewmenu: 'Ansicht',
  windowmenu: 'Fenster',
  filemenu: 'Datei',
  appmenu: 'Suite',
  services: 'Dienste',
  zoom: 'Zoomen',
  spellchecker: 'Rechtschreibung',
  startspeaking: 'Sprachausgabe starten',
  stopspeaking: 'Sprachausgabe stoppen',
}

/** edit roles the browser already performs on its own key presses */
const NATIVE_KEY_ROLES = new Set([
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'pasteandmatchstyle',
  'delete',
  'selectall',
  'reload',
  'forcereload',
  'toggledevtools',
  'quit',
  'close',
  'minimize',
  'hide',
  'hideothers',
])

type ClickFn = (
  item: MenuItem,
  window: BrowserWindow | null,
  event: Record<string, unknown>,
) => void

interface MenuItemOptions {
  id?: string
  label?: string
  sublabel?: string
  type?: MenuItemWire['type']
  role?: string
  enabled?: boolean
  visible?: boolean
  checked?: boolean
  accelerator?: string
  registerAccelerator?: boolean
  submenu?: Menu | MenuItemOptions[]
  click?: ClickFn
  [key: string]: unknown
}

function focusedContents(): WebContents | null {
  const wc = state.focusedContents
  if (wc && !wc.isDestroyed()) return wc
  return state.root?.webContents ?? null
}

function performRole(role: string): void {
  const wc = focusedContents()
  switch (role) {
    case 'undo':
    case 'redo':
    case 'cut':
    case 'copy':
    case 'paste':
    case 'delete':
      wc?.[role]()
      return
    case 'pasteandmatchstyle':
      wc?.pasteAndMatchStyle()
      return
    case 'selectall':
      wc?.selectAll()
      return
    case 'reload':
    case 'forcereload':
      wc?.reload()
      return
    case 'zoomin':
      wc?.setZoomFactor(wc.getZoomFactor() * 1.1)
      return
    case 'zoomout':
      wc?.setZoomFactor(wc.getZoomFactor() / 1.1)
      return
    case 'resetzoom':
      wc?.setZoomFactor(1)
      return
    case 'togglefullscreen': {
      const win = BrowserWindow.getFocusedWindow()
      win?.setFullScreen(!win.isFullScreen())
      return
    }
    case 'close':
      BrowserWindow.getFocusedWindow()?.close()
      return
    case 'quit':
      app.quit()
      return
    default:
      return
  }
}

export class MenuItem {
  readonly commandId: number
  id?: string
  label: string
  sublabel: string
  type: MenuItemWire['type']
  role?: string
  enabled: boolean
  visible: boolean
  checked: boolean
  accelerator?: string
  registerAccelerator: boolean
  submenu?: Menu
  click: (event?: Record<string, unknown>, window?: BrowserWindow | null) => void
  menu: Menu | null = null
  private readonly userClick?: ClickFn

  constructor(options: MenuItemOptions) {
    this.commandId = nextCommandId++
    this.id = options.id
    this.role = options.role?.toLowerCase()
    this.submenu =
      options.submenu instanceof Menu
        ? options.submenu
        : Array.isArray(options.submenu)
          ? Menu.buildFromTemplate(options.submenu)
          : undefined
    this.type = options.type ?? (this.submenu ? 'submenu' : 'normal')
    this.label = options.label ?? (this.role ? (ROLE_LABELS[this.role] ?? this.role) : '')
    this.sublabel = options.sublabel ?? ''
    this.enabled = options.enabled !== false
    this.visible = options.visible !== false
    this.checked = !!options.checked
    this.accelerator = options.accelerator
    this.registerAccelerator = options.registerAccelerator !== false
    this.userClick = options.click
    this.click = (event = {}, window = BrowserWindow.getFocusedWindow()) =>
      this.trigger(event, window)
    commands.set(this.commandId, this)
  }

  hasHandler(): boolean {
    return !!this.userClick || (!!this.role && !NATIVE_KEY_ROLES.has(this.role))
  }

  trigger(event: Record<string, unknown>, window: BrowserWindow | null): void {
    if (!this.enabled) return
    if (this.type === 'checkbox') this.checked = !this.checked
    if (this.type === 'radio') {
      for (const sibling of this.menu?.items ?? []) {
        if (sibling.type === 'radio') sibling.checked = sibling === this
      }
    }
    try {
      if (this.userClick) this.userClick(this, window, event)
      else if (this.role) performRole(this.role)
    } catch (err) {
      console.error('[web] menu item handler threw:', err)
    }
  }

  wire(): MenuItemWire {
    return {
      id: this.commandId,
      label: this.label,
      type: this.type,
      enabled: this.enabled,
      visible: this.visible,
      checked: this.checked,
      accelerator: this.accelerator,
      submenu: this.submenu?.items.map((item) => item.wire()),
    }
  }
}

export class Menu extends EventEmitter {
  items: MenuItem[] = []

  static buildFromTemplate(template: Array<MenuItemOptions | MenuItem>): Menu {
    const menu = new Menu()
    for (const entry of template) {
      menu.append(entry instanceof MenuItem ? entry : new MenuItem(entry))
    }
    return menu
  }

  static setApplicationMenu(menu: Menu | null): void {
    applicationMenu = menu
    broadcastAccelerators()
  }

  static getApplicationMenu(): Menu | null {
    return applicationMenu
  }

  static sendActionToFirstResponder(): void {}

  append(item: MenuItem): void {
    item.menu = this
    this.items.push(item)
    if (this === applicationMenu) broadcastAccelerators()
  }

  insert(position: number, item: MenuItem): void {
    item.menu = this
    this.items.splice(position, 0, item)
    if (this === applicationMenu) broadcastAccelerators()
  }

  getMenuItemById(id: string): MenuItem | null {
    for (const item of this.items) {
      if (item.id === id) return item
      const nested = item.submenu?.getMenuItemById(id)
      if (nested) return nested
    }
    return null
  }

  popup(
    options: { window?: BrowserWindow; x?: number; y?: number; callback?: () => void } = {},
  ): void {
    const id = nextPopupId++
    popups.set(id, { menu: this, callback: options.callback })
    const source = focusedContents()
    void rootConn(5_000).then((conn) => {
      if (!conn) {
        popups.delete(id)
        options.callback?.()
        return
      }
      this.emit('menu-will-show')
      conn.send({
        t: 'menu',
        id,
        items: this.items.map((item) => item.wire()),
        x: options.x,
        y: options.y,
        wc: source?.id ?? 0,
      })
    })
  }

  closePopup(): void {}
}

/** the root page answered a popup */
export function menuChosen(popupId: number, commandId: number | null): void {
  const popup = popups.get(popupId)
  if (!popup) return
  popups.delete(popupId)
  popup.menu.emit('menu-will-close')
  if (commandId !== null) {
    commands
      .get(commandId)
      ?.trigger({ triggeredByAccelerator: false }, BrowserWindow.getFocusedWindow())
  }
  popup.callback?.()
}

function collectAccelerators(menu: Menu | null | undefined, out: MenuItem[]): void {
  for (const item of menu?.items ?? []) {
    if (item.submenu) collectAccelerators(item.submenu, out)
    else if (item.accelerator && item.registerAccelerator) {
      if (!item.hasHandler() || (item.role && NATIVE_KEY_ROLES.has(item.role))) continue
      out.push(item)
    }
  }
}

export function acceleratorList(): string[] {
  const items: MenuItem[] = []
  collectAccelerators(applicationMenu, items)
  return [...new Set(items.map((i) => i.accelerator!))]
}

let broadcastQueued = false
function broadcastAccelerators(): void {
  if (broadcastQueued) return
  broadcastQueued = true
  queueMicrotask(() => {
    broadcastQueued = false
    const list = acceleratorList()
    for (const wc of state.contents.values()) wc.conn?.send({ t: 'accels', list })
  })
}

/** a page caught one of the application menu's key combinations */
export function acceleratorPressed(accelerator: string, from: WebContents): void {
  const items: MenuItem[] = []
  collectAccelerators(applicationMenu, items)
  const item = items.find((i) => i.accelerator === accelerator && i.enabled && i.visible)
  if (!item) return
  state.focusedContents = from
  const window = BrowserWindow.fromWebContents(from) ?? BrowserWindow.getFocusedWindow()
  item.trigger({ triggeredByAccelerator: true }, window)
}

export function menuToast(text: string): void {
  notifyRoot({ t: 'toast', text })
}

export const MenuShim = tolerant(Menu, 'Menu')
