/**
 * Wire format for the web bridge. Electron IPC carries structured-clone values
 * (typed arrays, Dates, Maps, undefined in argument lists …); JSON alone would
 * silently flatten them, and base64 would triple the size of every file that
 * crosses the socket. A frame is therefore a JSON header in which each binary
 * value is replaced by a reference, followed by the raw bytes:
 *
 *   u32 headerLength | header (UTF-8 JSON) | { u32 length | bytes }*
 *
 * Tagged objects use the `$t` key; a plain object that already owns `$t` is
 * wrapped so it round-trips unchanged.
 */

type Tagged =
  | { $t: 'u' }
  | { $t: 'b'; k: string; i: number }
  | { $t: 'd'; v: string }
  | { $t: 'm'; v: [unknown, unknown][] }
  | { $t: 's'; v: unknown[] }
  | { $t: 'n'; v: string }
  | { $t: 'f'; v: 'NaN' | 'Infinity' | '-Infinity' }
  | { $t: 'e'; name: string; message: string; stack?: string }
  | { $t: 'o'; v: Record<string, unknown> }

const TYPED_ARRAYS: Record<string, { new (buffer: ArrayBuffer): ArrayBufferView }> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
}

function typedKind(value: ArrayBufferView): string {
  if (value instanceof DataView) return 'DataView'
  for (const name of Object.keys(TYPED_ARRAYS)) {
    if (value instanceof TYPED_ARRAYS[name]!) return name
  }
  return 'Uint8Array'
}

function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) ||
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  )
}

export function encode(value: unknown): Uint8Array {
  const buffers: Uint8Array[] = []
  const seen = new WeakSet<object>()

  const walk = (v: unknown): unknown => {
    if (v === undefined) return { $t: 'u' } satisfies Tagged
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
    if (typeof v === 'number') {
      if (Number.isFinite(v)) return v
      return { $t: 'f', v: Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity' }
    }
    if (typeof v === 'bigint') return { $t: 'n', v: v.toString() }
    // structured clone throws on functions and symbols; dropping them keeps a
    // stray callback in an options bag from failing the whole message
    if (typeof v === 'function' || typeof v === 'symbol') return { $t: 'u' }
    const obj = v as object
    if (isArrayBuffer(obj)) {
      buffers.push(new Uint8Array(obj.slice(0)))
      return { $t: 'b', k: 'ArrayBuffer', i: buffers.length - 1 }
    }
    if (ArrayBuffer.isView(obj)) {
      buffers.push(bytesOf(obj))
      return { $t: 'b', k: typedKind(obj), i: buffers.length - 1 }
    }
    if (obj instanceof Date) return { $t: 'd', v: obj.toISOString() }
    if (obj instanceof Error) {
      return { $t: 'e', name: obj.name, message: obj.message, stack: obj.stack }
    }
    if (seen.has(obj)) throw new Error('An object could not be cloned (circular reference).')
    seen.add(obj)
    try {
      if (obj instanceof Map) return { $t: 'm', v: [...obj].map(([k, x]) => [walk(k), walk(x)]) }
      if (obj instanceof Set) return { $t: 's', v: [...obj].map(walk) }
      if (Array.isArray(obj)) return obj.map(walk)
      if (typeof Blob !== 'undefined' && obj instanceof Blob) {
        throw new Error('Blob values cannot be sent over IPC; read them into an ArrayBuffer first.')
      }
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(obj)) {
        const x = (obj as Record<string, unknown>)[key]
        if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue
        out[key] = walk(x)
      }
      return Object.prototype.hasOwnProperty.call(out, '$t') ? { $t: 'o', v: out } : out
    } finally {
      seen.delete(obj)
    }
  }

  const header = new TextEncoder().encode(JSON.stringify(walk(value)))
  let size = 4 + header.byteLength
  for (const b of buffers) size += 4 + b.byteLength
  const frame = new Uint8Array(size)
  const view = new DataView(frame.buffer)
  view.setUint32(0, header.byteLength)
  frame.set(header, 4)
  let offset = 4 + header.byteLength
  for (const b of buffers) {
    view.setUint32(offset, b.byteLength)
    frame.set(b, offset + 4)
    offset += 4 + b.byteLength
  }
  return frame
}

export interface DecodeOptions {
  /** Node side: materialize Uint8Array payloads as Buffer (a Uint8Array
   * subclass), matching what main-process code gets from Electron's IPC. */
  wrapBytes?: (bytes: Uint8Array) => Uint8Array
}

export function decode(frame: Uint8Array, options: DecodeOptions = {}): unknown {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const headerLength = view.getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + headerLength)))
  const buffers: Uint8Array[] = []
  let offset = 4 + headerLength
  while (offset < frame.byteLength) {
    const length = view.getUint32(offset)
    // copy out: the frame buffer is reused by the socket layer
    buffers.push(frame.slice(offset + 4, offset + 4 + length))
    offset += 4 + length
  }

  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(walk)
    const tagged = v as Tagged
    switch (tagged.$t) {
      case 'u':
        return undefined
      case 'b': {
        const bytes = buffers[tagged.i]!
        if (tagged.k === 'ArrayBuffer') return bytes.buffer
        if (tagged.k === 'Uint8Array') return options.wrapBytes ? options.wrapBytes(bytes) : bytes
        if (tagged.k === 'DataView') return new DataView(bytes.buffer)
        const Ctor = TYPED_ARRAYS[tagged.k] ?? Uint8Array
        return new Ctor(bytes.buffer as ArrayBuffer)
      }
      case 'd':
        return new Date(tagged.v)
      case 'm':
        return new Map(tagged.v.map(([k, x]) => [walk(k), walk(x)]))
      case 's':
        return new Set(tagged.v.map(walk))
      case 'n':
        return BigInt(tagged.v)
      case 'f':
        return Number(tagged.v)
      case 'e': {
        const err = new Error(tagged.message)
        err.name = tagged.name
        if (tagged.stack) err.stack = tagged.stack
        return err
      }
      case 'o':
        return walkPlain(tagged.v)
      default:
        return walkPlain(v as Record<string, unknown>)
    }
  }
  const walkPlain = (o: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(o)) out[key] = walk(o[key])
    return out
  }
  return walk(header)
}
