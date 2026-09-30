/**
 * Electron accelerator strings ("CmdOrCtrl+Shift+S", "F11", "Alt+Up") matched
 * against browser key events, so the application menu's shortcuts keep
 * working without a menu bar.
 */

export const IS_MAC = /mac/i.test(navigator.platform)

interface Parsed {
  raw: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  key: string
}

const KEY_ALIASES: Record<string, string> = {
  plus: '+',
  space: ' ',
  return: 'enter',
  esc: 'escape',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  ins: 'insert',
  pageup: 'pageup',
  pagedown: 'pagedown',
  numadd: '+',
  numsub: '-',
  nummult: '*',
  numdiv: '/',
  numdec: '.',
}

export function parseAccelerator(raw: string): Parsed | null {
  // "CmdOrCtrl++" means CmdOrCtrl and the plus key
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+')
  const out: Parsed = { raw, ctrl: false, meta: false, alt: false, shift: false, key: '' }
  for (const part of parts) {
    const p = part.trim().toLowerCase()
    switch (p) {
      case 'commandorcontrol':
      case 'cmdorctrl':
        if (IS_MAC) out.meta = true
        else out.ctrl = true
        break
      case 'command':
      case 'cmd':
      case 'super':
      case 'meta':
        out.meta = true
        break
      case 'control':
      case 'ctrl':
        out.ctrl = true
        break
      case 'alt':
      case 'option':
      case 'altgr':
        out.alt = true
        break
      case 'shift':
        out.shift = true
        break
      default:
        out.key = KEY_ALIASES[p] ?? p
    }
  }
  return out.key ? out : null
}

const CODE_KEYS: Record<string, string> = {
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadMultiply: '*',
  NumpadDivide: '/',
}

function eventKeys(e: KeyboardEvent): string[] {
  const keys = new Set<string>()
  if (/^Key[A-Z]$/.test(e.code)) keys.add(e.code.slice(3).toLowerCase())
  else if (/^Digit\d$/.test(e.code)) keys.add(e.code.slice(5))
  else if (/^Numpad\d$/.test(e.code)) keys.add(e.code.slice(6))
  else if (CODE_KEYS[e.code]) keys.add(CODE_KEYS[e.code]!)
  keys.add(e.key.toLowerCase())
  return [...keys]
}

export function matches(acc: Parsed, e: KeyboardEvent): boolean {
  if (acc.ctrl !== e.ctrlKey || acc.meta !== e.metaKey || acc.alt !== e.altKey) return false
  const keys = eventKeys(e)
  if (!keys.includes(acc.key)) return false
  // "+" is typed with Shift on most layouts
  if (acc.key === '+' && !acc.shift) return true
  return acc.shift === e.shiftKey
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function installAccelerators(send: (raw: string) => void): (list: string[]) => void {
  let parsed: Parsed[] = []
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing || e.repeat) return
      for (const acc of parsed) {
        if (!matches(acc, e)) continue
        // bare keys (Delete, Enter, arrows …) belong to text fields while typing
        const bare = !acc.ctrl && !acc.meta && !acc.alt && !/^f\d+$/.test(acc.key)
        if (bare && isEditable(e.target)) return
        e.preventDefault()
        e.stopImmediatePropagation()
        send(acc.raw)
        return
      }
    },
    true,
  )
  return (list) => {
    parsed = list.map(parseAccelerator).filter((p): p is Parsed => p !== null)
  }
}

export function acceleratorLabel(raw: string): string {
  const acc = parseAccelerator(raw)
  if (!acc) return raw
  const key =
    acc.key.length === 1
      ? acc.key.toUpperCase()
      : acc.key.replace(/^arrow/, '').replace(/^./, (c) => c.toUpperCase())
  if (IS_MAC) {
    return `${acc.ctrl ? '⌃' : ''}${acc.alt ? '⌥' : ''}${acc.shift ? '⇧' : ''}${acc.meta ? '⌘' : ''}${key}`
  }
  return [acc.ctrl && 'Strg', acc.meta && 'Win', acc.alt && 'Alt', acc.shift && 'Umschalt', key]
    .filter(Boolean)
    .join('+')
}
