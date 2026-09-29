import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Electron pages live on file:// and on custom schemes registered through
 * protocol.handle. A browser can load neither, so every URL the main process
 * hands a webContents is mapped onto the web server:
 *
 *   file:///abs/path            → /__fs/abs/path                  (app port)
 *   genoffice-app://docs/x      → /__proto/genoffice-app/docs/x   (app port)
 *   md-asset://…, html-preview:// … → http://host:<content port>/__proto/<scheme>/…
 *
 * The editors' own pages stay on the app origin (they need the bridge). Every
 * other custom scheme carries document content — an HTML file the user opened
 * runs its own scripts — so it is served from a second port, which the
 * browser treats as a different origin, just as Electron kept html-preview://
 * apart from genoffice-app://.
 */

export const APP_SCHEME = 'genoffice-app'

export interface Origins {
  /** '' — app pages are addressed relative to whatever host the browser used */
  app: string
  /** the content port, absolute */
  content: string
  /** how this process reaches itself (headless Chromium loads) */
  internal: string
}

let origins: Origins = { app: '', content: 'http://127.0.0.1:0', internal: 'http://127.0.0.1:0' }

export function setOrigins(next: Origins): void {
  origins = next
}

export function getOrigins(): Origins {
  return origins
}

/** schemes with a protocol.handle handler — filled by the protocol shim */
export const handledSchemes = new Set<string>()

/** directories a page was loaded from via file:// — only these are served under /__fs */
const fsRoots = new Set<string>()

export function allowFsRoot(dir: string): void {
  fsRoots.add(resolve(dir))
}

export function isServableFsPath(path: string): boolean {
  const abs = resolve(path)
  for (const root of fsRoots) {
    if (abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep)) return true
  }
  return false
}

function fsUrlPath(absPath: string): string {
  const normalized = absPath.split(sep).join('/')
  const withSlash = normalized.startsWith('/') ? normalized : '/' + normalized
  return '/__fs' + withSlash.split('/').map(encodeURIComponent).join('/')
}

export function fsPathFromUrlPath(urlPath: string): string | null {
  if (!urlPath.startsWith('/__fs/')) return null
  let decoded: string
  try {
    decoded = urlPath
      .slice('/__fs'.length)
      .split('/')
      .map((part) => decodeURIComponent(part))
      .join('/')
  } catch {
    return null
  }
  // Windows drive paths travel as /C:/Users/…
  if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1)
  return resolve(decoded)
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):(\/\/)?(.*)$/is

/**
 * Where the browser should load `url`. Returns an absolute URL; `http(s):`,
 * `data:`, `blob:` and `about:` pass through untouched.
 */
export function toWebUrl(url: string): string {
  const m = SCHEME_RE.exec(url)
  if (!m) return url
  const scheme = m[1]!.toLowerCase()
  if (scheme === 'file') {
    let path: string
    try {
      path = fileURLToPath(url.replace(/[?#].*$/, ''))
    } catch {
      return url
    }
    const suffix = /[?#].*$/.exec(url)?.[0] ?? ''
    allowFsRoot(dirname(path))
    return origins.app + fsUrlPath(path) + suffix
  }
  if (handledSchemes.has(scheme)) {
    const origin = scheme === APP_SCHEME ? origins.app : origins.content
    return `${origin}/__proto/${scheme}/${m[3]}`
  }
  return url
}

/** inverse of toWebUrl for /__proto requests: the URL the handler expects */
export function protoRequestUrl(pathAndQuery: string): { scheme: string; url: string } | null {
  const m = /^\/__proto\/([a-z][a-z0-9+.-]*)\/(.*)$/is.exec(pathAndQuery)
  if (!m) return null
  const scheme = m[1]!.toLowerCase()
  if (!handledSchemes.has(scheme)) return null
  return { scheme, url: `${scheme}://${m[2]}` }
}

/** add the webContents marker the injected runtime reads on boot */
export function withWebContentsId(webUrl: string, wcId: number): string {
  const relative = webUrl.startsWith('/')
  try {
    const u = new URL(webUrl, 'http://relative.invalid')
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return webUrl
    u.searchParams.set('__wc', String(wcId))
    return relative ? u.pathname + u.search + u.hash : u.toString()
  } catch {
    return webUrl
  }
}

/** headless Chromium has no page to be relative to */
export function absoluteForServer(webUrl: string): string {
  return webUrl.startsWith('/') ? origins.internal + webUrl : webUrl
}
