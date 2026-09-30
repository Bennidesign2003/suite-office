/**
 * The editors call well over a hundred Electron members, many of them purely
 * cosmetic on the web (dock badges, vibrancy, taskbar progress …). Instead of
 * stubbing each by hand, shim objects are wrapped so an unknown member reads
 * as a no-op function and is reported once. Anything that matters for
 * behavior is implemented explicitly; this only keeps the long tail from
 * crashing startup.
 */

const reported = new Set<string>()

export function reportMissing(owner: string, key: string): void {
  const id = `${owner}.${key}`
  if (reported.has(id)) return
  reported.add(id)
  if (process.env.SUITE_WEB_DEBUG)
    console.warn(`[web] electron ${id} is not available on the web; ignored`)
}

const PASSTHROUGH = new Set<PropertyKey>([
  'then',
  'toJSON',
  'constructor',
  'prototype',
  'inspect',
  'asymmetricMatch',
  '$$typeof',
  '__esModule',
  'default',
  'nodeType',
])

export function tolerant<T extends object>(target: T, owner: string): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (key in obj || typeof key === 'symbol' || PASSTHROUGH.has(key)) {
        return Reflect.get(obj, key, receiver)
      }
      reportMissing(owner, String(key))
      return inert
    },
  })
}

/** callable, and every member is itself: `app.dock?.setBadge('')` and
 * `wc.session.webRequest.onBeforeRequest(…)` both quietly do nothing */
const inert: any = new Proxy(function inert() {}, {
  get(_target, key) {
    if (key === 'then' || key === 'toJSON') return undefined
    if (key === Symbol.toPrimitive) return () => ''
    return inert
  },
  apply() {
    return undefined
  },
})
