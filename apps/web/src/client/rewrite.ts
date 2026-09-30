import type { SuiteConfig } from './bridge'

/**
 * Editor code builds URLs on schemes only Electron knew (md-asset://,
 * html-preview://, genoffice-docx-media:// …). The browser refuses to even
 * request those, so every place such a URL can enter a request — element
 * src/href, setAttribute, fetch, XHR, and markup parsed from strings — is
 * mapped onto the server's /__proto route.
 */

export function installUrlRewriting(cfg: SuiteConfig): (url: string) => string {
  const schemes = new Set(cfg.schemes.map((s) => s.toLowerCase()))
  const contentOrigin = `${location.protocol}//${location.hostname}:${cfg.contentPort}`
  const re = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is

  const map = (value: string): string => {
    const m = re.exec(value)
    if (!m) return value
    const scheme = m[1]!.toLowerCase()
    if (!schemes.has(scheme)) return value
    const origin = scheme === cfg.appScheme ? location.origin : contentOrigin
    return `${origin}/__proto/${scheme}/${m[2]}`
  }
  const mapAny = (value: unknown): unknown => (typeof value === 'string' ? map(value) : value)
  const mapSrcset = (value: string): string =>
    value
      .split(',')
      .map((part) => {
        const trimmed = part.trim()
        const space = trimmed.search(/\s/)
        return space < 0 ? map(trimmed) : map(trimmed.slice(0, space)) + trimmed.slice(space)
      })
      .join(', ')

  const patchProperty = (proto: object | undefined, prop: string): void => {
    if (!proto) return
    const desc = Object.getOwnPropertyDescriptor(proto, prop)
    if (!desc?.set || !desc.get) return
    Object.defineProperty(proto, prop, {
      ...desc,
      set(this: unknown, value: unknown) {
        desc.set!.call(
          this,
          prop === 'srcset' && typeof value === 'string' ? mapSrcset(value) : mapAny(value),
        )
      },
    })
  }

  patchProperty(HTMLImageElement.prototype, 'src')
  patchProperty(HTMLImageElement.prototype, 'srcset')
  patchProperty(HTMLSourceElement.prototype, 'src')
  patchProperty(HTMLSourceElement.prototype, 'srcset')
  patchProperty(HTMLMediaElement.prototype, 'src')
  patchProperty(HTMLVideoElement.prototype, 'poster')
  patchProperty(HTMLIFrameElement.prototype, 'src')
  patchProperty(HTMLScriptElement.prototype, 'src')
  patchProperty(HTMLLinkElement.prototype, 'href')
  patchProperty(HTMLEmbedElement.prototype, 'src')
  patchProperty(HTMLObjectElement.prototype, 'data')
  patchProperty(HTMLTrackElement.prototype, 'src')

  const URL_ATTRS = new Set(['src', 'href', 'poster', 'data', 'xlink:href'])
  const setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name: string, value: string) {
    const lower = name.toLowerCase()
    if (URL_ATTRS.has(lower) && !(this instanceof HTMLAnchorElement)) value = map(String(value))
    else if (lower === 'srcset') value = mapSrcset(String(value))
    return setAttribute.call(this, name, value)
  }
  const setAttributeNS = Element.prototype.setAttributeNS
  Element.prototype.setAttributeNS = function (ns: string | null, name: string, value: string) {
    if (/(^|:)href$/i.test(name)) value = map(String(value))
    return setAttributeNS.call(this, ns, name, value)
  }

  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return nativeFetch(map(input), init)
    if (input instanceof URL) return nativeFetch(map(input.href), init)
    if (input instanceof Request) {
      const mapped = map(input.url)
      if (mapped !== input.url) return nativeFetch(new Request(mapped, input), init)
    }
    return nativeFetch(input, init)
  }

  const xhrOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    return (xhrOpen as (...a: unknown[]) => void).call(this, method, map(String(url)), ...rest)
  } as typeof XMLHttpRequest.prototype.open

  // markup parsed from strings (innerHTML, DOMParser imports) never calls the setters
  const fix = (el: Element): void => {
    for (const attr of ['src', 'poster', 'data'] as const) {
      const v = el.getAttribute(attr)
      if (v && re.test(v)) {
        const mapped = map(v)
        if (mapped !== v) setAttribute.call(el, attr, mapped)
      }
    }
    if (!(el instanceof HTMLAnchorElement)) {
      const href = el.getAttribute('href')
      if (href && re.test(href)) {
        const mapped = map(href)
        if (mapped !== href) setAttribute.call(el, 'href', mapped)
      }
    }
    const srcset = el.getAttribute('srcset')
    if (srcset && srcset.includes('://')) {
      const mapped = mapSrcset(srcset)
      if (mapped !== srcset) setAttribute.call(el, 'srcset', mapped)
    }
  }
  const selector = '[src*="://"],[href*="://"],[poster*="://"],[srcset*="://"],[data*="://"]'
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(selector)) fix(node)
        if (node.firstElementChild) for (const el of node.querySelectorAll(selector)) fix(el)
      }
    }
  })
  const start = (): void =>
    observer.observe(document.documentElement, { childList: true, subtree: true })
  if (document.documentElement) start()
  else document.addEventListener('readystatechange', start, { once: true })

  return map
}
