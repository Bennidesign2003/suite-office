import type { ViewWire, WindowWire } from '../shared/protocol'
import type { Bridge } from './bridge'
import { el, uiLayer } from './ui'

/**
 * The root page hosts what Electron layered over the shell window: editor
 * tabs (WebContentsView → iframe at the bounds the tab manager sets) and
 * secondary windows (floating panels). It also tracks the pointer inside
 * those iframes so popup menus open where the user clicked.
 */

interface FrameRecord {
  iframe: HTMLIFrameElement
  nav: number
}

export class Host {
  private readonly viewLayer: HTMLDivElement
  private readonly views = new Map<number, FrameRecord>()
  private readonly windows = new Map<
    number,
    FrameRecord & { panel: HTMLElement; backdrop: HTMLElement | null }
  >()
  lastPointer = { x: 120, y: 60 }

  constructor(private readonly bridge: Bridge) {
    this.viewLayer = document.createElement('div')
    Object.assign(this.viewLayer.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483000',
    })
    const mount = (): void => {
      document.body.appendChild(this.viewLayer)
    }
    if (document.body) mount()
    else document.addEventListener('DOMContentLoaded', mount, { once: true })

    window.addEventListener(
      'pointerdown',
      (e) => (this.lastPointer = { x: e.clientX, y: e.clientY }),
      true,
    )
    window.addEventListener(
      'contextmenu',
      (e) => (this.lastPointer = { x: e.clientX, y: e.clientY }),
      true,
    )
    window.addEventListener('message', (e) => {
      const data = e.data as { suitePointer?: { x: number; y: number } } | null
      if (!data?.suitePointer) return
      const source = this.frameFor(e.source)
      if (!source) return
      const r = source.getBoundingClientRect()
      this.lastPointer = { x: r.left + data.suitePointer.x, y: r.top + data.suitePointer.y }
    })
  }

  private frameFor(source: MessageEventSource | null): HTMLIFrameElement | null {
    for (const rec of this.views.values())
      if (rec.iframe.contentWindow === source) return rec.iframe
    for (const rec of this.windows.values())
      if (rec.iframe.contentWindow === source) return rec.iframe
    return null
  }

  private makeFrame(wc: number): HTMLIFrameElement {
    const iframe = document.createElement('iframe')
    iframe.name = `__suite_wc:${wc}`
    iframe.setAttribute(
      'allow',
      'fullscreen; clipboard-read; clipboard-write; autoplay; microphone; camera; display-capture',
    )
    Object.assign(iframe.style, {
      border: '0',
      display: 'block',
      background: 'transparent',
      colorScheme: 'normal',
    })
    return iframe
  }

  setViews(list: ViewWire[]): void {
    const keep = new Set(list.map((v) => v.wc))
    for (const [wc, rec] of this.views) {
      if (!keep.has(wc)) {
        rec.iframe.remove()
        this.views.delete(wc)
      }
    }
    list.forEach((view, index) => {
      let rec = this.views.get(view.wc)
      if (!rec) {
        rec = { iframe: this.makeFrame(view.wc), nav: -1 }
        this.views.set(view.wc, rec)
      }
      const { iframe } = rec
      Object.assign(iframe.style, {
        position: 'absolute',
        left: `${view.x}px`,
        top: `${view.y}px`,
        width: `${view.w}px`,
        height: `${view.h}px`,
        visibility: view.visible ? 'visible' : 'hidden',
        pointerEvents: view.visible ? 'auto' : 'none',
        zIndex: String(index + 1),
      })
      if (iframe.parentNode !== this.viewLayer) this.viewLayer.appendChild(iframe)
      if (rec.nav !== view.nav) {
        rec.nav = view.nav
        iframe.src = view.src
      }
    })
  }

  setWindows(list: WindowWire[]): void {
    const keep = new Set(list.map((w) => w.wc))
    for (const [wc, rec] of this.windows) {
      if (!keep.has(wc)) {
        ;(rec.backdrop ?? rec.panel).remove()
        this.windows.delete(wc)
      }
    }
    for (const win of list) {
      let rec = this.windows.get(win.wc)
      if (!rec) {
        const iframe = this.makeFrame(win.wc)
        const bare = win.frameless || win.transparent
        const panel = el('div', { className: 'sw-card sw-window' + (bare ? ' sw-bare' : '') })
        if (!bare) {
          const close = el('button', { type: 'button', textContent: '✕', title: 'Schließen' })
          close.onclick = () => this.bridge.post({ t: 'ev', name: 'window-close', wc: win.wc })
          panel.append(el('header', {}, el('span', { textContent: win.title }), close))
        }
        panel.append(iframe)
        let backdrop: HTMLElement | null = null
        if (win.modal || bare) {
          backdrop = el('div', { className: 'sw-backdrop' }, panel)
          if (bare) backdrop.style.background = 'transparent'
        }
        uiLayer().appendChild(backdrop ?? panel)
        rec = { iframe, nav: -1, panel, backdrop }
        this.windows.set(win.wc, rec)
      }
      const header = rec.panel.querySelector('header span')
      if (header) header.textContent = win.title
      const chrome = win.frameless || win.transparent ? 0 : 41
      const w = Math.min(win.w, innerWidth - 24)
      const h = Math.min(win.h + chrome, innerHeight - 24)
      Object.assign(rec.panel.style, {
        width: `${w}px`,
        height: `${h}px`,
        ...(rec.backdrop
          ? { position: 'relative' }
          : {
              left: `${Math.max(12, (innerWidth - w) / 2)}px`,
              top: `${Math.max(12, (innerHeight - h) / 2)}px`,
            }),
      })
      if (rec.nav !== win.nav) {
        rec.nav = win.nav
        rec.iframe.src = win.src
      }
    }
  }

  focusFrame(wc: number): void {
    const rec = this.views.get(wc) ?? this.windows.get(wc)
    if (!rec) {
      window.focus()
      return
    }
    rec.iframe.focus()
    try {
      rec.iframe.contentWindow?.focus()
    } catch {
      // cross-origin frames refuse
    }
  }

  hasOpenTabs(): boolean {
    return this.views.size > 0
  }
}
