import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { handledSchemes } from '../urls'
import { tolerant } from './tolerant'

type ProtocolHandler = (request: Request) => Response | Promise<Response>

const handlers = new Map<string, ProtocolHandler>()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.emf': 'image/emf',
  '.wmf': 'image/wmf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** a file as a Response, honoring a single byte Range (media seeking) */
export function fileResponse(path: string, request?: Request): Response {
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return new Response(null, { status: 404 })
    size = st.size
  } catch {
    return new Response(null, { status: 404 })
  }
  const type = mimeFor(path)
  const range = request?.headers.get('range')
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (m && size > 0) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2])
    let end = m[1] && m[2] ? Number(m[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(size - 1, end)
    if (start <= end) {
      const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
      return new Response(body, {
        status: 206,
        headers: {
          'content-type': type,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${size}`,
          'accept-ranges': 'bytes',
        },
      })
    }
  }
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream
  return new Response(body, {
    status: 200,
    headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes' },
  })
}

export function schemeHandler(scheme: string): ProtocolHandler | undefined {
  return handlers.get(scheme)
}

export const protocol = tolerant(
  {
    registerSchemesAsPrivileged(_schemes: unknown[]): void {},
    handle(scheme: string, handler: ProtocolHandler): void {
      const key = scheme.toLowerCase()
      if (handlers.has(key)) throw new Error(`Failed to register protocol: ${scheme}`)
      handlers.set(key, handler)
      handledSchemes.add(key)
    },
    unhandle(scheme: string): void {
      handlers.delete(scheme.toLowerCase())
      handledSchemes.delete(scheme.toLowerCase())
    },
    isProtocolHandled(scheme: string): boolean {
      return handlers.has(scheme.toLowerCase())
    },
  },
  'protocol',
)

async function netFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(String(input), init)
  const url = new URL(request.url)
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  if (scheme === 'file') {
    let path: string
    try {
      path = fileURLToPath(url)
    } catch {
      return new Response(null, { status: 404 })
    }
    return fileResponse(path, request)
  }
  const handler = handlers.get(scheme)
  if (handler) return handler(request)
  return fetch(request)
}

export const net = tolerant(
  {
    fetch: netFetch,
    isOnline: () => true,
    online: true,
  },
  'net',
)
