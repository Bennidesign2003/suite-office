import { describe, expect, it } from 'vitest'
import { decode, encode } from '../src/shared/codec'

const roundTrip = (value: unknown): unknown => decode(encode(value))

describe('web bridge codec', () => {
  it('keeps structured-clone values that JSON would flatten', () => {
    const date = new Date('2026-09-29T12:00:00Z')
    const out = roundTrip({
      date,
      map: new Map([['a', 1]]),
      set: new Set([1, 2]),
      big: 12345678901234567890n,
      nan: Number.NaN,
      inf: -Infinity,
    }) as Record<string, unknown>
    expect(out.date).toEqual(date)
    expect(out.map).toEqual(new Map([['a', 1]]))
    expect(out.set).toEqual(new Set([1, 2]))
    expect(out.big).toBe(12345678901234567890n)
    expect(out.nan).toBeNaN()
    expect(out.inf).toBe(-Infinity)
  })

  it('keeps undefined in argument positions', () => {
    expect(roundTrip(['a', undefined, 3])).toEqual(['a', undefined, 3])
  })

  it('carries bytes out of band with their typed-array kind', () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    const floats = new Float32Array([1.5, -2])
    const out = roundTrip({ bytes, floats, buffer: bytes.buffer.slice(1, 3) }) as Record<
      string,
      unknown
    >
    expect(out.bytes).toBeInstanceOf(Uint8Array)
    expect([...(out.bytes as Uint8Array)]).toEqual([1, 2, 3, 250])
    expect(out.floats).toBeInstanceOf(Float32Array)
    expect([...(out.floats as Float32Array)]).toEqual([1.5, -2])
    expect([...new Uint8Array(out.buffer as ArrayBuffer)]).toEqual([2, 3])
  })

  it('does not double the payload for large binaries (no base64)', () => {
    const big = new Uint8Array(1_000_000)
    expect(encode({ big }).byteLength).toBeLessThan(1_000_100)
  })

  it('round-trips objects that own a $t key', () => {
    expect(roundTrip({ $t: 'u', x: 1 })).toEqual({ $t: 'u', x: 1 })
  })

  it('drops functions like a bag of options would lose them', () => {
    expect(roundTrip({ a: 1, f: () => 1 })).toEqual({ a: 1 })
  })

  it('wraps bytes on request (Buffer on the Node side)', () => {
    const out = decode(encode(new Uint8Array([9])), {
      wrapBytes: (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength),
    })
    expect(Buffer.isBuffer(out)).toBe(true)
  })

  it('refuses circular structures', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => encode(a)).toThrow(/circular/)
  })
})
