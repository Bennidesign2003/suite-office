import type {
  FileDialogRequest,
  FsListing,
  FsPlace,
  MenuItemWire,
  MessageBoxRequest,
} from '../shared/protocol'
import { acceleratorLabel } from './keys'

/**
 * The native pieces Electron drew for the app — message boxes, open/save
 * dialogs, popup menus — drawn in the root page. Colors are this layer's own
 * tokens (light, dark, and the system-dark fallback), like the suite's.
 */

const STYLE = `
:root {
  --sw-bg: #ffffff;
  --sw-fg: #1f2328;
  --sw-muted: #636c76;
  --sw-border: #d1d9e0;
  --sw-hover: #eef1f4;
  --sw-selected: #dbe7ff;
  --sw-accent: #2f6fed;
  --sw-accent-fg: #ffffff;
  --sw-danger: #cf222e;
  --sw-shadow: rgba(15, 23, 42, 0.22);
  --sw-backdrop: rgba(15, 23, 42, 0.35);
  --sw-toast-bg: #1f2328;
  --sw-toast-fg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --sw-bg: #22262c;
    --sw-fg: #e6e9ee;
    --sw-muted: #9aa4b1;
    --sw-border: #3a4049;
    --sw-hover: #2e333b;
    --sw-selected: #243a63;
    --sw-accent: #4c8dff;
    --sw-accent-fg: #0b1220;
    --sw-danger: #ff7b72;
    --sw-shadow: rgba(0, 0, 0, 0.5);
    --sw-backdrop: rgba(0, 0, 0, 0.5);
    --sw-toast-bg: #e6e9ee;
    --sw-toast-fg: #1f2328;
  }
}
:root[data-theme='dark'] {
  --sw-bg: #22262c;
  --sw-fg: #e6e9ee;
  --sw-muted: #9aa4b1;
  --sw-border: #3a4049;
  --sw-hover: #2e333b;
  --sw-selected: #243a63;
  --sw-accent: #4c8dff;
  --sw-accent-fg: #0b1220;
  --sw-danger: #ff7b72;
  --sw-shadow: rgba(0, 0, 0, 0.5);
  --sw-backdrop: rgba(0, 0, 0, 0.5);
  --sw-toast-bg: #e6e9ee;
  --sw-toast-fg: #1f2328;
}
.sw-layer { position: fixed; inset: 0; z-index: 2147483600; pointer-events: none; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--sw-fg); }
.sw-layer * { box-sizing: border-box; }
.sw-backdrop { position: fixed; inset: 0; background: var(--sw-backdrop); pointer-events: auto; display: grid; place-items: center; }
.sw-card { background: var(--sw-bg); color: var(--sw-fg); border: 1px solid var(--sw-border); border-radius: 10px; box-shadow: 0 18px 50px var(--sw-shadow); pointer-events: auto; }
.sw-msg { width: min(440px, calc(100vw - 32px)); padding: 20px 20px 16px; }
.sw-msg h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.sw-msg p { margin: 0 0 6px; color: var(--sw-muted); white-space: pre-wrap; word-break: break-word; }
.sw-msg label { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
.sw-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.sw-btn { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--sw-border); background: var(--sw-bg); color: var(--sw-fg); cursor: pointer; }
.sw-btn:hover { background: var(--sw-hover); }
.sw-btn.sw-primary { background: var(--sw-accent); border-color: var(--sw-accent); color: var(--sw-accent-fg); }
.sw-btn:focus-visible { outline: 2px solid var(--sw-accent); outline-offset: 2px; }
.sw-file { width: min(760px, calc(100vw - 32px)); height: min(560px, calc(100vh - 32px)); display: grid; grid-template-rows: auto auto 1fr auto; overflow: hidden; }
.sw-file header { padding: 14px 16px 8px; font-weight: 600; font-size: 14px; }
.sw-path { display: flex; gap: 6px; padding: 0 16px 10px; }
.sw-path input { flex: 1; min-width: 0; font: inherit; padding: 5px 8px; border: 1px solid var(--sw-border); border-radius: 6px; background: var(--sw-bg); color: var(--sw-fg); }
.sw-body { display: grid; grid-template-columns: 150px 1fr; min-height: 0; border-top: 1px solid var(--sw-border); border-bottom: 1px solid var(--sw-border); }
.sw-places { border-right: 1px solid var(--sw-border); overflow: auto; padding: 6px 0; }
.sw-places button, .sw-list button { display: flex; width: 100%; gap: 8px; align-items: center; text-align: left; font: inherit; color: inherit; background: none; border: 0; padding: 5px 12px; cursor: pointer; }
.sw-places button:hover, .sw-list button:hover { background: var(--sw-hover); }
.sw-list { overflow: auto; padding: 4px 0; }
.sw-list button[aria-selected='true'] { background: var(--sw-selected); }
.sw-list button[disabled] { opacity: 0.45; cursor: default; }
.sw-list .sw-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-list .sw-meta { color: var(--sw-muted); font-size: 12px; white-space: nowrap; }
.sw-foot { display: flex; gap: 8px; align-items: center; padding: 10px 16px; flex-wrap: wrap; }
.sw-foot input[type=text] { flex: 1; min-width: 160px; font: inherit; padding: 5px 8px; border: 1px solid var(--sw-border); border-radius: 6px; background: var(--sw-bg); color: var(--sw-fg); }
.sw-foot select { font: inherit; padding: 4px 6px; border: 1px solid var(--sw-border); border-radius: 6px; background: var(--sw-bg); color: var(--sw-fg); max-width: 220px; }
.sw-spacer { flex: 1; }
.sw-error { color: var(--sw-danger); padding: 0 16px 6px; min-height: 0; }
.sw-menu { position: fixed; min-width: 200px; max-width: 360px; padding: 4px 0; pointer-events: auto; max-height: calc(100vh - 16px); overflow: auto; }
.sw-menu button { display: flex; width: 100%; gap: 16px; align-items: center; font: inherit; color: inherit; background: none; border: 0; padding: 5px 14px 5px 26px; cursor: pointer; text-align: left; position: relative; }
.sw-menu button:hover, .sw-menu button.sw-open { background: var(--sw-hover); }
.sw-menu button[disabled] { opacity: 0.45; cursor: default; background: none; }
.sw-menu .sw-check { position: absolute; left: 9px; }
.sw-menu .sw-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-menu .sw-accel { color: var(--sw-muted); font-size: 12px; }
.sw-menu hr { border: 0; border-top: 1px solid var(--sw-border); margin: 4px 0; }
.sw-toasts { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: grid; gap: 8px; justify-items: center; }
.sw-toast { background: var(--sw-toast-bg); color: var(--sw-toast-fg); padding: 8px 14px; border-radius: 8px; pointer-events: auto; max-width: min(640px, calc(100vw - 32px)); word-break: break-word; box-shadow: 0 8px 24px var(--sw-shadow); }
.sw-toast a { color: inherit; font-weight: 600; }
.sw-banner { position: fixed; top: 0; left: 50%; transform: translateX(-50%); background: var(--sw-toast-bg); color: var(--sw-toast-fg); padding: 6px 14px; border-radius: 0 0 8px 8px; pointer-events: auto; }
.sw-window { position: fixed; display: grid; grid-template-rows: auto 1fr; overflow: hidden; }
.sw-window.sw-bare { grid-template-rows: 1fr; background: transparent; border: 0; box-shadow: none; }
.sw-window header { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 14px; border-bottom: 1px solid var(--sw-border); font-weight: 600; }
.sw-window header span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-window header button { font: inherit; border: 0; background: none; color: inherit; cursor: pointer; width: 28px; height: 28px; border-radius: 6px; }
.sw-window header button:hover { background: var(--sw-hover); }
.sw-window iframe { width: 100%; height: 100%; border: 0; background: transparent; }
`

let layer: HTMLDivElement | null = null

export function uiLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)
  layer = document.createElement('div')
  layer.className = 'sw-layer'
  document.body.appendChild(layer)
  return layer
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const child of children) node.append(child)
  return node
}

// ---- message box ----

export function showMessageBox(
  req: MessageBoxRequest,
): Promise<{ response: number; checkboxChecked: boolean }> {
  return new Promise((resolve) => {
    const root = uiLayer()
    const checkbox = req.checkboxLabel
      ? el('input', { type: 'checkbox', checked: !!req.checkboxChecked })
      : null
    const finish = (response: number): void => {
      backdrop.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve({ response, checkboxChecked: checkbox?.checked ?? false })
    }
    const buttons = req.buttons.map((label, i) =>
      el('button', {
        className: 'sw-btn' + (i === (req.defaultId ?? 0) ? ' sw-primary' : ''),
        textContent: label,
        onclick: () => finish(i),
      }),
    )
    const card = el(
      'div',
      { className: 'sw-card sw-msg', role: 'alertdialog' } as Partial<HTMLDivElement>,
      el('h2', { textContent: req.message || req.title || '' }),
      ...(req.detail ? [el('p', { textContent: req.detail })] : []),
      ...(checkbox ? [el('label', {}, checkbox, req.checkboxLabel!)] : []),
      el('div', { className: 'sw-actions' }, ...buttons),
    )
    card.setAttribute('aria-modal', 'true')
    const backdrop = el('div', { className: 'sw-backdrop' }, card)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(req.cancelId)
      }
    }
    document.addEventListener('keydown', onKey, true)
    root.appendChild(backdrop)
    ;(buttons[req.defaultId ?? 0] ?? buttons[0])?.focus()
  })
}

// ---- file dialog ----

type Op = <T>(op: string, ...args: unknown[]) => Promise<T>

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function splitPath(path: string, sep: string): { dir: string; name: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (i < 0) return { dir: '', name: path }
  return { dir: path.slice(0, i) || sep, name: path.slice(i + 1) }
}

function join(dir: string, name: string, sep: string): string {
  return dir.endsWith(sep) || dir.endsWith('/') ? dir + name : dir + sep + name
}

export function showFileDialog(
  req: FileDialogRequest,
  op: Op,
): Promise<{ canceled: boolean; filePaths: string[] }> {
  return new Promise((resolve) => {
    const root = uiLayer()
    const save = req.mode === 'save'
    const filters = (req.filters ?? []).filter((f) => f.extensions.length > 0)
    let filterIndex = 0
    let listing: FsListing | null = null
    let selected = new Set<string>()
    const initial = req.defaultPath ?? ''

    const title =
      req.title || (save ? 'Speichern unter' : req.directory ? 'Ordner wählen' : 'Öffnen')
    const pathInput = el('input', { type: 'text', spellcheck: false })
    const upBtn = el('button', {
      className: 'sw-btn',
      textContent: '↑',
      title: 'Übergeordneter Ordner',
    })
    const newFolderBtn = el('button', { className: 'sw-btn', textContent: 'Neuer Ordner' })
    const placesBox = el('div', { className: 'sw-places' })
    const list = el('div', { className: 'sw-list', role: 'listbox' } as Partial<HTMLDivElement>)
    const errorBox = el('div', { className: 'sw-error' })
    const nameInput = el('input', { type: 'text', spellcheck: false, placeholder: 'Dateiname' })
    const filterSelect = el('select')
    for (const [i, f] of filters.entries()) {
      filterSelect.append(
        el('option', {
          value: String(i),
          textContent: `${f.name} (${f.extensions.map((x) => (x === '*' ? '*' : '.' + x)).join(', ')})`,
        }),
      )
    }
    const uploadInput = el('input', { type: 'file', multiple: true })
    uploadInput.style.display = 'none'
    const uploadBtn = el('button', { className: 'sw-btn', textContent: 'Vom Computer hochladen …' })
    const cancelBtn = el('button', { className: 'sw-btn', textContent: 'Abbrechen' })
    const okBtn = el('button', {
      className: 'sw-btn sw-primary',
      textContent: req.buttonLabel || (save ? 'Speichern' : req.directory ? 'Auswählen' : 'Öffnen'),
    })

    const foot = el('div', { className: 'sw-foot' })
    if (save) foot.append(nameInput)
    if (filters.length > 1 || (filters.length === 1 && !save)) foot.append(filterSelect)
    if (!save && !req.directory) foot.append(uploadBtn, uploadInput)
    foot.append(el('span', { className: 'sw-spacer' }), cancelBtn, okBtn)

    const card = el(
      'div',
      { className: 'sw-card sw-file', role: 'dialog' } as Partial<HTMLDivElement>,
      el('header', { textContent: title }),
      el(
        'div',
        { className: 'sw-path' },
        upBtn,
        pathInput,
        ...(req.createDirectory || save ? [newFolderBtn] : []),
      ),
      el('div', { className: 'sw-body' }, placesBox, list),
      el('div', {}, errorBox, foot),
    )
    const backdrop = el('div', { className: 'sw-backdrop' }, card)

    const finish = (paths: string[] | null): void => {
      backdrop.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(
        paths && paths.length
          ? { canceled: false, filePaths: paths }
          : { canceled: true, filePaths: [] },
      )
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(null)
      }
    }

    const accepts = (name: string): boolean => {
      const f = filters[filterIndex]
      if (!f || f.extensions.includes('*')) return true
      const lower = name.toLowerCase()
      return f.extensions.some((ext) => lower.endsWith('.' + ext.toLowerCase()))
    }

    const render = (): void => {
      list.replaceChildren()
      if (!listing) return
      for (const entry of listing.entries) {
        if (!entry.dir && (req.directory || !accepts(entry.name))) continue
        const full = join(listing.dir, entry.name, listing.sep)
        const btn = el(
          'button',
          { type: 'button' },
          el('span', { textContent: entry.dir ? '📁' : '📄' }),
          el('span', { className: 'sw-name', textContent: entry.name }),
          el('span', {
            className: 'sw-meta',
            textContent: entry.dir ? '' : formatSize(entry.size),
          }),
          el('span', {
            className: 'sw-meta',
            textContent: new Date(entry.mtime).toLocaleDateString(),
          }),
        )
        btn.setAttribute('aria-selected', String(selected.has(full)))
        btn.onclick = (e) => {
          if (entry.dir && !req.directory) {
            selected = new Set([full])
            render()
            return
          }
          if (req.multi && (e.metaKey || e.ctrlKey)) {
            if (selected.has(full)) selected.delete(full)
            else selected.add(full)
          } else selected = new Set([full])
          if (save && !entry.dir) nameInput.value = entry.name
          render()
        }
        btn.ondblclick = () => {
          if (entry.dir) void load(full)
          else if (save) {
            nameInput.value = entry.name
            void confirm()
          } else finish([full])
        }
        list.append(btn)
      }
    }

    const load = async (dir: string): Promise<void> => {
      errorBox.textContent = ''
      try {
        listing = await op<FsListing>('fs.list', dir, !!req.showHidden)
        pathInput.value = listing.dir
        selected = new Set()
        render()
      } catch (err) {
        errorBox.textContent = err instanceof Error ? err.message : String(err)
      }
    }

    const withExtension = (name: string): string => {
      const f = filters[filterIndex]
      if (!f || f.extensions.includes('*') || accepts(name)) return name
      return `${name}.${f.extensions[0]}`
    }

    const confirm = async (): Promise<void> => {
      if (!listing) return
      if (save) {
        const typed = nameInput.value.trim()
        if (!typed) {
          nameInput.focus()
          return
        }
        const target = /[\\/]/.test(typed)
          ? typed
          : join(listing.dir, withExtension(typed), listing.sep)
        const kind = await op<string | null>('fs.exists', target).catch(() => null)
        if (kind === 'dir') {
          nameInput.value = ''
          await load(target)
          return
        }
        if (kind === 'file') {
          const answer = await showMessageBox({
            type: 'question',
            message: `„${splitPath(target, listing.sep).name}“ existiert bereits. Ersetzen?`,
            buttons: ['Ersetzen', 'Abbrechen'],
            defaultId: 1,
            cancelId: 1,
          })
          if (answer.response !== 0) return
        }
        finish([target])
        return
      }
      if (req.directory) {
        finish([selected.size ? [...selected][0]! : listing.dir])
        return
      }
      const files = [...selected].filter((p) =>
        listing!.entries.some((e) => !e.dir && join(listing!.dir, e.name, listing!.sep) === p),
      )
      if (files.length) finish(files)
      else if (selected.size === 1) await load([...selected][0]!)
    }

    upBtn.onclick = () => {
      if (listing?.parent) void load(listing.parent)
    }
    pathInput.onkeydown = (e) => {
      if (e.key === 'Enter') void load(pathInput.value)
    }
    newFolderBtn.onclick = async () => {
      if (!listing) return
      const name = prompt('Name des neuen Ordners:')
      if (!name) return
      try {
        const created = await op<string>('fs.mkdir', listing.dir, name)
        await load(created)
      } catch (err) {
        errorBox.textContent = err instanceof Error ? err.message : String(err)
      }
    }
    filterSelect.onchange = () => {
      filterIndex = Number(filterSelect.value)
      render()
    }
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter') void confirm()
    }
    uploadBtn.onclick = () => uploadInput.click()
    uploadInput.onchange = async () => {
      if (!listing || !uploadInput.files?.length) return
      const paths: string[] = []
      errorBox.textContent = 'Wird hochgeladen …'
      try {
        for (const file of Array.from(uploadInput.files)) {
          const r = await fetch(
            `/__suite/upload?dir=${encodeURIComponent(listing.dir)}&name=${encodeURIComponent(file.name)}`,
            {
              method: 'POST',
              body: file,
            },
          )
          if (!r.ok) throw new Error(`Hochladen fehlgeschlagen (${r.status})`)
          paths.push(((await r.json()) as { path: string }).path)
        }
        finish(req.multi ? paths : paths.slice(0, 1))
      } catch (err) {
        errorBox.textContent = err instanceof Error ? err.message : String(err)
      }
    }
    cancelBtn.onclick = () => finish(null)
    okBtn.onclick = () => void confirm()

    document.addEventListener('keydown', onKey, true)
    root.appendChild(backdrop)

    void op<FsPlace[]>('fs.places').then((places) => {
      for (const place of places) {
        placesBox.append(
          el('button', {
            type: 'button',
            textContent: place.label,
            title: place.path,
            onclick: () => void load(place.path),
          }),
        )
      }
    })
    void (async () => {
      let startDir = initial
      if (initial) {
        const kind = await op<string | null>('fs.exists', initial).catch(() => null)
        if (kind !== 'dir') {
          const parts = splitPath(initial, '/')
          startDir = parts.dir
          if (save) nameInput.value = parts.name
        }
      }
      await load(startDir)
      if (save) {
        nameInput.focus()
        const dot = nameInput.value.lastIndexOf('.')
        nameInput.setSelectionRange(0, dot > 0 ? dot : nameInput.value.length)
      } else okBtn.focus()
    })()
  })
}

// ---- popup menu ----

export function showMenu(items: MenuItemWire[], x: number, y: number): Promise<number | null> {
  return new Promise((resolve) => {
    const root = uiLayer()
    const opened: HTMLDivElement[] = []
    const shield = el('div', { className: 'sw-backdrop' })
    shield.style.background = 'transparent'
    let done = false
    const finish = (id: number | null): void => {
      if (done) return
      done = true
      shield.remove()
      for (const m of opened) m.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(id)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(null)
      }
    }
    shield.onmousedown = () => finish(null)
    shield.oncontextmenu = (e) => {
      e.preventDefault()
      finish(null)
    }

    const build = (entries: MenuItemWire[], left: number, top: number, depth: number): void => {
      while (opened.length > depth) opened.pop()!.remove()
      const menu = el('div', {
        className: 'sw-card sw-menu',
        role: 'menu',
      } as Partial<HTMLDivElement>)
      for (const item of entries) {
        if (!item.visible) continue
        if (item.type === 'separator') {
          menu.append(el('hr'))
          continue
        }
        const btn = el(
          'button',
          { type: 'button', disabled: !item.enabled },
          el('span', {
            className: 'sw-check',
            textContent: item.checked ? (item.type === 'radio' ? '•' : '✓') : '',
          }),
          el('span', { className: 'sw-label', textContent: item.label.replace(/&(&?)/g, '$1') }),
          el('span', {
            className: 'sw-accel',
            textContent: item.submenu
              ? '›'
              : item.accelerator
                ? acceleratorLabel(item.accelerator)
                : '',
          }),
        )
        btn.setAttribute('role', 'menuitem')
        if (item.submenu) {
          const open = (): void => {
            for (const b of menu.querySelectorAll('.sw-open')) b.classList.remove('sw-open')
            btn.classList.add('sw-open')
            const r = btn.getBoundingClientRect()
            build(item.submenu!, r.right - 2, r.top - 4, depth + 1)
          }
          btn.onmouseenter = open
          btn.onclick = open
        } else {
          btn.onmouseenter = () => {
            while (opened.length > depth + 1) opened.pop()!.remove()
            for (const b of menu.querySelectorAll('.sw-open')) b.classList.remove('sw-open')
          }
          btn.onclick = () => finish(item.id)
        }
        menu.append(btn)
      }
      root.appendChild(menu)
      opened.push(menu)
      const rect = menu.getBoundingClientRect()
      const maxX = innerWidth - rect.width - 8
      const maxY = innerHeight - rect.height - 8
      menu.style.left = `${Math.max(8, Math.min(left, depth > 0 && left > maxX ? left - rect.width - 180 : maxX))}px`
      menu.style.top = `${Math.max(8, Math.min(top, maxY))}px`
    }

    root.appendChild(shield)
    document.addEventListener('keydown', onKey, true)
    build(items, x, y, 0)
  })
}

// ---- toasts & banners ----

export function toast(content: string | Node, ms = 6000): void {
  const root = uiLayer()
  let box = root.querySelector<HTMLDivElement>('.sw-toasts')
  if (!box) {
    box = el('div', { className: 'sw-toasts' })
    root.appendChild(box)
  }
  const item = el('div', { className: 'sw-toast' }, content)
  box.appendChild(item)
  setTimeout(() => item.remove(), ms)
}

export function linkToast(text: string, href: string, label: string): void {
  const frag = document.createDocumentFragment()
  frag.append(text + ' ')
  const a = el('a', { href, target: '_blank', rel: 'noopener', textContent: label })
  a.onclick = () => a.closest('.sw-toast')?.remove()
  frag.append(a)
  toast(frag, 15000)
}

let banner: HTMLDivElement | null = null
export function setBanner(text: string | null, action?: { label: string; run: () => void }): void {
  banner?.remove()
  banner = null
  if (!text) return
  banner = el('div', { className: 'sw-banner', textContent: text + (action ? ' ' : '') })
  if (action) {
    const btn = el('button', {
      className: 'sw-btn',
      textContent: action.label,
      onclick: action.run,
    })
    btn.style.marginLeft = '8px'
    banner.append(btn)
  }
  uiLayer().appendChild(banner)
}

export { el }
